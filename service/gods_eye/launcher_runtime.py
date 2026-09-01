"""Demo Runtime start/readiness/browser/container behavior."""

import hashlib
import json
import os
import shlex
import socket
import subprocess
import sys
import time
from pathlib import Path

from .launcher_common import EXIT_OK, EXIT_PREPARATION_FAILED, PREPARED_STAGES, RuntimeLayout
from .launcher_lifecycle import mutation_lock, write_operation_log


def _compose_command(layout: RuntimeLayout, *, offline: bool = False) -> list[str]:
    files = (
        os.getenv("COMPOSE_FILE")
        or os.getenv("GODS_EYE_COMPOSE_FILE")
        or "/workspace/compose.yaml"
    )
    compose_files = [item for item in files.split(os.pathsep) if item]
    compose_root = next(
        (Path(item).parent for item in compose_files if Path(item).name == "compose.yaml"),
        layout.root,
    )
    offline_file = str(compose_root / "compose.offline.yaml")
    if offline and offline_file not in compose_files:
        compose_files.append(offline_file)
    command = [
        "docker",
        "compose",
        "--project-directory",
        str(layout.root),
        "--project-name",
        _compose_project_name(_host_project_root(layout)),
    ]
    for compose_file in compose_files:
        command.extend(("-f", compose_file))
    return command


def prepared_missing(layout: RuntimeLayout) -> list[str]:
    preparation = layout.read_state().get("preparation", {})
    return [
        stage
        for stage, expected in PREPARED_STAGES.items()
        if preparation.get(stage, {}).get("status") != expected
    ]


def _registry() -> dict:
    return json.loads(Path(__file__).with_name("dataset_registry.json").read_text())


def _offline_assets_missing(layout: RuntimeLayout) -> list[str]:
    missing = []
    for source in _registry()["sources"]:
        receipt = layout.root / "data/install-state" / f"{source['name']}.json"
        installation = layout.root / "data/datasets" / source["name"]
        if not receipt.is_file() or not installation.is_dir():
            missing.append(f"Dataset Installation: {source['name']}")
    model_cache = layout.root / ".cache/huggingface"
    if not model_cache.is_dir() or not any(model_cache.iterdir()):
        missing.append("CLIP ViT-B/16 model cache")
    if not (layout.root / "indexes/gallery-manifest.json").is_file():
        missing.append("Gallery Manifest: indexes/gallery-manifest.json")
    if not (layout.root / "indexes/active").exists():
        missing.append("active retrieval index: indexes/active")
    return missing


def _available_port(preferred: int, *, exclude: set[int] | None = None) -> int:
    excluded = exclude or set()
    while preferred in excluded:
        preferred += 1
    if os.getenv("GODS_EYE_RUNTIME_PORTS_AVAILABLE") == "1":
        return preferred
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", preferred))
        return preferred
    except OSError:
        fallback = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            fallback.bind(("127.0.0.1", 0))
            selected = int(fallback.getsockname()[1])
            return (
                _available_port(preferred + 1, exclude=excluded)
                if selected in excluded
                else selected
            )
        finally:
            fallback.close()
    finally:
        probe.close()


def _runtime_env(web_port: int, api_port: int, offline: bool) -> dict[str, str]:
    return {
        **os.environ,
        "GODS_EYE_WEB_PORT": str(web_port),
        "GODS_EYE_BIND_PORT": str(api_port),
        "GODS_EYE_OFFLINE": "true" if offline else "false",
        "HF_HUB_OFFLINE": "1" if offline else os.getenv("HF_HUB_OFFLINE", "0"),
        "TRANSFORMERS_OFFLINE": "1" if offline else os.getenv("TRANSFORMERS_OFFLINE", "0"),
    }


def _host_project_root(layout: RuntimeLayout) -> Path:
    """Return the host path namespace used by the Docker daemon.

    The Launcher runs from ``/workspace`` inside its container while the
    nested Compose process talks to the host Docker daemon.  Relative volume
    sources would therefore resolve against the container-only path.  The
    shell wrapper supplies the actual checkout root; direct Launcher use
    falls back to its project root.
    """

    configured = os.getenv("GODS_EYE_HOST_PROJECT_ROOT")
    return Path(configured or layout.root).expanduser().resolve()


def _compose_project_name(host_root: Path) -> str:
    """Return a stable Compose project identity for this host checkout.

    Compose derives a default project name from its project-directory.  The
    nested Compose process runs from ``/workspace``, however, so that default
    would make every checkout share one project.  A path-derived name keeps
    multiple checkouts isolated and remains valid when the checkout path
    contains spaces.  Explicit project names remain supported for advanced
    Compose workflows and fixture tests.
    """

    configured = os.getenv("GODS_EYE_COMPOSE_PROJECT_NAME") or os.getenv("COMPOSE_PROJECT_NAME")
    if configured:
        return configured
    digest = hashlib.sha256(str(host_root).encode("utf-8")).hexdigest()[:16]
    return f"gods-eye-{digest}"


def _prepared_asset_env(host_root: Path) -> dict[str, str]:
    """Make every persistent Prepared Demo bind source explicit and absolute."""

    return {
        "GODS_EYE_DATA_HOME": str(host_root / "data"),
        "GODS_EYE_DATASET_ROOT": str(host_root / "data" / "datasets"),
        "GODS_EYE_INDEX_ROOT": str(host_root / "indexes"),
        "GODS_EYE_HF_CACHE": str(host_root / ".cache" / "huggingface"),
    }


def _runtime_compose_env(layout: RuntimeLayout, *, offline: bool | None = None) -> dict[str, str]:
    """Apply the common host-path and Compose identity contract to an environment."""

    host_root = _host_project_root(layout)
    project_name = _compose_project_name(host_root)
    environment = {
        **_prepared_asset_env(host_root),
        "COMPOSE_PROJECT_NAME": project_name,
        "GODS_EYE_COMPOSE_PROJECT_NAME": project_name,
    }
    if offline is not None:
        environment.update(
            {
                "GODS_EYE_OFFLINE": "true" if offline else "false",
                "HF_HUB_OFFLINE": "1" if offline else os.getenv("HF_HUB_OFFLINE", "0"),
                "TRANSFORMERS_OFFLINE": "1"
                if offline
                else os.getenv("TRANSFORMERS_OFFLINE", "0"),
            }
        )
    return environment


def _asset_visibility_root(layout: RuntimeLayout, host_root: Path) -> Path:
    """Return the checkout tree visible to this Launcher process.

    A Launcher container can see its project bind mount at ``/workspace`` but
    usually cannot stat the host-only path that the nested Docker daemon uses
    for bind sources.  When the configured host root is visible (for example
    in direct operation and the fake-Docker integration harness), inspect it
    directly; otherwise inspect the equivalent ``/workspace`` tree.
    """

    resolved_host = host_root.resolve()
    resolved_layout = layout.root.expanduser().resolve()
    return resolved_host if resolved_host.is_dir() else resolved_layout


def _contained(path: Path, root: Path) -> bool:
    try:
        return path.resolve(strict=False).is_relative_to(root.resolve(strict=False))
    except (OSError, RuntimeError):
        return False


def _active_index_target(
    pointer: Path,
    index_root: Path,
    host_index_root: Path,
) -> tuple[Path | None, str | None]:
    """Resolve an active pointer while keeping it inside the runtime index root."""

    try:
        reference = pointer.read_text().strip()
    except (OSError, UnicodeError):
        return None, "active retrieval index pointer is not readable"
    if not reference:
        return None, "active retrieval index pointer is empty"

    try:
        stored = Path(reference)
    except (OSError, ValueError):
        return None, "active retrieval index pointer contains an invalid reference"
    target: Path | None = None
    if stored.is_absolute():
        # The first two roots cover the Launcher/container and host namespaces
        # used by older prepared state and by the nested Compose invocation.
        for legacy_root in (Path("/workspace/indexes"), host_index_root, index_root):
            try:
                target = index_root / stored.relative_to(legacy_root)
                break
            except ValueError:
                continue
        if target is None:
            target = stored
    else:
        target = index_root / stored

    try:
        resolved_index_root = index_root.resolve(strict=False)
        resolved_target = target.resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        return (
            None,
            "active retrieval index version is not reachable beneath the configured index root",
        )
    if not resolved_target.is_relative_to(resolved_index_root):
        return None, "Active index reference escapes the configured index root"
    if resolved_target == resolved_index_root or not resolved_target.is_dir():
        return (
            None,
            "active retrieval index version is not reachable beneath the configured index root",
        )
    return resolved_target, None


def _prepared_asset_errors(layout: RuntimeLayout, host_root: Path) -> list[str]:
    """Report Prepared Demo assets that the runtime bind sources cannot expose.

    This is intentionally a reachability check, not full index validation.
    Service health and search readiness remain responsible for rejecting
    corrupt or incompatible artifacts after containers start.
    """

    visible_root = _asset_visibility_root(layout, host_root)
    dataset_root = visible_root / "data" / "datasets"
    index_root = visible_root / "indexes"
    model_cache = visible_root / ".cache" / "huggingface"
    errors: list[str] = []

    configured_host_root = os.getenv("GODS_EYE_HOST_PROJECT_ROOT")
    if (
        configured_host_root
        and not host_root.is_dir()
        and visible_root != Path("/workspace")
    ):
        errors.append(
            "Configured host project root is not visible to the Launcher; "
            "Prepared Demo assets cannot be validated"
        )
        return errors

    if not _contained(dataset_root, visible_root):
        errors.append("Dataset Installation root escapes the configured host project root")
    elif not dataset_root.is_dir():
        errors.append(
            "Dataset Installation root is not visible under the configured host project root "
            "(expected data/datasets)"
        )
    else:
        for source in _registry().get("sources", []):
            name = str(source["name"])
            installation = dataset_root / name
            if not _contained(installation, dataset_root):
                errors.append(f"Dataset Installation: {name} escapes the configured root")
            elif not installation.is_dir():
                errors.append(
                    f"Dataset Installation: {name} is not visible under the configured host "
                    "project root (expected data/datasets/" + name + ")"
                )

    if not _contained(index_root, visible_root):
        errors.append("Retrieval index root escapes the configured host project root")
    elif not index_root.is_dir():
        errors.append(
            "Retrieval index root is not visible under the configured host project root "
            "(expected indexes)"
        )
    else:
        manifest = index_root / "gallery-manifest.json"
        if not _contained(manifest, index_root) or not manifest.is_file():
            errors.append(
                "Gallery Manifest: indexes/gallery-manifest.json is not visible under the "
                "configured host project root"
            )

        pointer = index_root / "active"
        if not _contained(pointer, index_root) or not pointer.exists():
            errors.append(
                "active retrieval index pointer: indexes/active is not visible under the "
                "configured host project root"
            )
        elif pointer.is_dir():
            if os.getenv("GODS_EYE_USE_FIXTURES") != "true":
                errors.append("active retrieval index pointer: indexes/active must be a file")
        else:
            target, error = _active_index_target(
                pointer,
                index_root,
                host_root.resolve() / "indexes",
            )
            if error:
                errors.append(error)
            elif target is None:
                errors.append(
                    "active retrieval index version is not reachable beneath the configured "
                    "index root"
                )

    if not _contained(model_cache, visible_root):
        errors.append("CLIP ViT-B/16 model cache escapes the configured host project root")
    elif not model_cache.is_dir():
        errors.append(
            "CLIP ViT-B/16 model cache is not visible under the configured host project root "
            "(expected .cache/huggingface)"
        )
    else:
        try:
            next(model_cache.iterdir())
        except (OSError, StopIteration):
            errors.append(
                "CLIP ViT-B/16 model cache is empty or not readable under the configured host "
                "project root"
            )
    return errors


def _print_preflight_failure(errors: list[str]) -> None:
    print(
        "Prepared Demo asset preflight failed; no Demo Runtime containers were started.",
        file=sys.stderr,
    )
    for error in errors:
        print(f"- {error}.", file=sys.stderr)
    print(
        "Check GODS_EYE_HOST_PROJECT_ROOT and ensure the prepared Dataset Installations, "
        "active retrieval index, Gallery Manifest, and model cache are visible there.",
        file=sys.stderr,
    )


def _run(command: list[str], environment: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, check=False, env=environment)


def _wait_for_readiness(
    command: list[str], environment: dict[str, str], timeout_seconds: float
) -> tuple[bool, str]:
    deadline = time.monotonic() + timeout_seconds
    detail = "search readiness did not respond"
    check = [
        *command,
        "exec",
        "-T",
        "service",
        "python",
        "-c",
        "import json,sys,urllib.request; health=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health')); ready=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/readiness')); failure=None if health.get('status') == 'ok' and ready.get('ready') else ready.get('guidance') or 'search readiness is unavailable'; print(failure, file=sys.stderr) if failure else print(json.dumps(ready)); raise SystemExit(1 if failure else 0)",
    ]
    while True:
        result = _run(check, environment)
        if result.returncode == 0:
            return True, result.stdout.strip()
        detail = result.stderr.strip() or result.stdout.strip() or detail
        if time.monotonic() >= deadline:
            return False, detail
        time.sleep(min(1, max(0, deadline - time.monotonic())))


def _can_open_browser(no_open: bool) -> bool:
    return not (no_open or os.getenv("SSH_CONNECTION") or os.getenv("SSH_TTY")) and bool(
        os.getenv("DISPLAY") or os.getenv("WAYLAND_DISPLAY")
    )


def start_runtime(
    layout: RuntimeLayout,
    *,
    detach: bool,
    offline: bool,
    no_open: bool,
    web_port: int,
    api_port: int,
) -> int:
    missing = prepared_missing(layout)
    if missing:
        print("Full Demo is not prepared; missing: " + ", ".join(missing) + ".", file=sys.stderr)
        print("Run './gods-eye prepare'. No downloads were started.", file=sys.stderr)
        return EXIT_PREPARATION_FAILED
    if offline and (missing_assets := _offline_assets_missing(layout)):
        print("Offline start requires these local assets:", file=sys.stderr)
        for asset in missing_assets:
            print(f"- {asset}", file=sys.stderr)
        print("No network access or downloads were attempted.", file=sys.stderr)
        return EXIT_PREPARATION_FAILED
    web_port = _available_port(web_port)
    api_port = _available_port(api_port, exclude={web_port})
    compose = _compose_command(layout, offline=offline)
    host_root = _host_project_root(layout)
    environment = _runtime_env(web_port, api_port, offline)
    environment.update(_runtime_compose_env(layout, offline=offline))
    if asset_errors := _prepared_asset_errors(layout, host_root):
        _print_preflight_failure(asset_errors)
        return EXIT_PREPARATION_FAILED
    compose_check = _run(["docker", "compose", "version", "--short"], environment)
    if compose_check.returncode != 0:
        print(
            "Docker Compose is unusable inside the Launcher environment. "
            "Run './gods-eye doctor' for diagnostics before starting the Demo Runtime.",
            file=sys.stderr,
        )
        return EXIT_PREPARATION_FAILED
    with mutation_lock(layout, "start"):
        started = _run([*compose, "up", "-d", "service", "web"], environment)
        if started.returncode != 0:
            print(started.stderr.strip() or "Could not start the Demo Runtime.", file=sys.stderr)
            return EXIT_PREPARATION_FAILED
        ready, detail = _wait_for_readiness(
            compose, environment, float(os.getenv("GODS_EYE_READINESS_TIMEOUT_SECONDS", "120"))
        )
        if not ready:
            _run([*compose, "down"], environment)
            print(
                f"Health/search readiness failed: {detail}. Run './gods-eye logs' for diagnostics.",
                file=sys.stderr,
            )
            return EXIT_PREPARATION_FAILED
        url = f"http://127.0.0.1:{web_port}"
        print(f"God's Eye Full Demo is ready: {url}")
        if _can_open_browser(no_open):
            try:
                subprocess.Popen(
                    [*shlex.split(os.getenv("GODS_EYE_BROWSER_OPEN_COMMAND", "xdg-open")), url],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except OSError as error:
                print(f"Could not open a browser automatically: {error}. Open {url} manually.")
        write_operation_log(layout, "start", {"web_port": web_port, "offline": offline})
        if detach:
            return EXIT_OK
        print("Press Ctrl+C to stop the Demo Runtime.")
        try:
            subprocess.run([*compose, "logs", "--follow"], env=environment, check=False)
        except KeyboardInterrupt:
            pass
        finally:
            _run([*compose, "down"], environment)
    return EXIT_OK


def runtime_passthrough(layout: RuntimeLayout, command: str) -> int:
    compose = _compose_command(layout)
    action = (
        [*compose, "down"]
        if command == "stop"
        else [*compose, "logs", "--tail", "200"]
        if command == "logs"
        else [*compose, "ps", "--format", "json"]
    )
    result = _run(action, {**os.environ, **_runtime_compose_env(layout)})
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.returncode != 0 and result.stderr:
        print(result.stderr.strip(), file=sys.stderr)
    return result.returncode
