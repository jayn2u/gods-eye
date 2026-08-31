import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path

EXIT_OK = 0
EXIT_PREREQUISITE = 2
EXIT_CONFIRMATION = 3
EXIT_TERMS_REQUIRED = 3
EXIT_PREPARATION_FAILED = 4
EXIT_USAGE = 64
EXIT_PREPARATION = 1
EXIT_BUSY = 75
STATE_SCHEMA_VERSION = 1
MINIMUM_VRAM_MIB = 8 * 1024
MODEL_RESERVE_BYTES = 2 * 1024**3
INDEX_RESERVE_BYTES = 2 * 1024**3
SAFETY_RESERVE_BYTES = 2 * 1024**3


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    detail: str
    guidance: str | None = None


@dataclass(frozen=True)
class RuntimeLayout:
    root: Path

    @property
    def runtime_dir(self) -> Path:
        return self.root / ".gods-eye"

    @property
    def logs_dir(self) -> Path:
        return self.runtime_dir / "logs"

    @property
    def state_path(self) -> Path:
        return self.runtime_dir / "state.json"

    @property
    def lock_path(self) -> Path:
        return self.runtime_dir / "lock"

    def initialize(self) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        if not self.state_path.exists():
            self.state_path.write_text(
                json.dumps(
                    {
                        "schema_version": STATE_SCHEMA_VERSION,
                        "terms_acceptance": None,
                        "preparation": {},
                        "compatibility": current_compatibility(),
                    },
                    indent=2,
                )
                + "\n"
            )

    def read_state(self) -> dict:
        self.initialize()
        return json.loads(self.state_path.read_text())

    def write_state(self, state: dict) -> None:
        temporary = self.state_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
        temporary.replace(self.state_path)


class LauncherArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, f"{self.prog}: error: {message}\n")


def _run(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, check=False)


def _utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def current_compatibility() -> dict[str, str]:
    registry = json.loads(Path(__file__).with_name("dataset_registry.json").read_text())
    return {
        "application": os.getenv("GODS_EYE_TARGET_APPLICATION_VERSION", "0.1.0"),
        "registry": os.getenv("GODS_EYE_TARGET_REGISTRY_VERSION", str(registry["schema_version"])),
        "model": os.getenv("GODS_EYE_TARGET_MODEL", "openai/clip-vit-base-patch16"),
        "manifest_schema": os.getenv("GODS_EYE_TARGET_MANIFEST_SCHEMA", "1"),
        "index_schema": os.getenv("GODS_EYE_TARGET_INDEX_SCHEMA", "1"),
    }


class LauncherBusyError(RuntimeError):
    def __init__(self, active_operation: dict):
        super().__init__("another state-changing Launcher command is active")
        self.active_operation = active_operation


@contextmanager
def mutation_lock(layout: RuntimeLayout, command: str) -> Iterator[None]:
    layout.initialize()
    operation = {"command": command, "pid": os.getpid(), "started_at": _utc_now()}
    descriptor = os.open(layout.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        try:
            active = json.loads(layout.lock_path.read_text())
        except (OSError, json.JSONDecodeError):
            active = {"command": "unknown", "pid": None, "started_at": None}
        os.close(descriptor)
        raise LauncherBusyError(active) from error
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.seek(0)
            stream.truncate()
            json.dump(operation, stream)
            stream.flush()
            yield
    finally:
        # Closing the descriptor releases the advisory lock. The metadata file stays
        # in place so a crashed process cannot race unlink against a new lock owner.
        pass


def _write_operation_log(layout: RuntimeLayout, command: str, detail: dict) -> None:
    layout.initialize()
    safe_detail = {
        key: value
        for key, value in detail.items()
        if key not in {"token", "query", "path", "user", "home"}
    }
    record = {"at": _utc_now(), "command": command, "detail": safe_detail}
    timestamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%S.%fZ")
    (layout.logs_dir / f"{timestamp}-{command}.log").write_text(
        json.dumps(record, sort_keys=True) + "\n"
    )


def _check_platform() -> Check:
    system = os.getenv("GODS_EYE_DOCTOR_SYSTEM", platform.system())
    machine = os.getenv("GODS_EYE_DOCTOR_MACHINE", platform.machine())
    supported = system == "Linux" and machine in {"x86_64", "amd64"}
    return Check(
        "platform",
        "pass" if supported else "fail",
        f"{system} {machine}",
        None if supported else "Use an Ubuntu/Linux amd64 workstation.",
    )


def _check_docker() -> tuple[Check, Check]:
    daemon = _run("docker", "info", "--format", "{{.ServerVersion}}")
    daemon_ok = daemon.returncode == 0
    daemon_check = Check(
        "docker-daemon",
        "pass" if daemon_ok else "fail",
        daemon.stdout.strip() if daemon_ok else "Docker daemon is unavailable",
        None if daemon_ok else "Start Docker Engine and ensure your user can access it.",
    )
    compose_version = os.getenv("GODS_EYE_HOST_COMPOSE_VERSION")
    if compose_version is None:
        compose = _run("docker", "compose", "version", "--short")
        compose_version = compose.stdout.strip() if compose.returncode == 0 else ""
    compose_ok = bool(compose_version)
    compose_check = Check(
        "compose",
        "pass" if compose_ok else "fail",
        compose_version if compose_ok else "Docker Compose v2 is unavailable",
        None if compose_ok else "Install the Docker Compose v2 plugin.",
    )
    return daemon_check, compose_check


def _check_gpu() -> tuple[Check, Check, Check]:
    image = os.getenv("GODS_EYE_LAUNCHER_IMAGE", "gods-eye-launcher:local")
    result = _run(
        "docker",
        "run",
        "--rm",
        "--gpus",
        "all",
        "--pull",
        "never",
        "--entrypoint",
        "nvidia-smi",
        image,
        "--query-gpu=name,memory.total,driver_version",
        "--format=csv,noheader,nounits",
    )
    if result.returncode != 0:
        guidance = "Install a compatible NVIDIA driver and NVIDIA Container Toolkit."
        return (
            Check("nvidia-driver", "fail", "NVIDIA driver unavailable", guidance),
            Check("container-gpu", "fail", "Docker cannot access an NVIDIA GPU", guidance),
            Check("vram", "fail", "GPU memory could not be measured", guidance),
        )

    rows = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    parsed: list[tuple[str, int, str]] = []
    try:
        for row in rows:
            name, memory, driver = (part.strip() for part in row.rsplit(",", 2))
            parsed.append((name, int(memory), driver))
    except (ValueError, TypeError):
        parsed = []
    if not parsed:
        guidance = "Verify nvidia-smi works inside a Docker container."
        return (
            Check("nvidia-driver", "fail", "NVIDIA driver details are unreadable", guidance),
            Check("container-gpu", "fail", "No NVIDIA GPU was reported", guidance),
            Check("vram", "fail", "GPU memory could not be measured", guidance),
        )
    name, memory, driver = max(parsed, key=lambda item: item[1])
    enough_memory = memory >= MINIMUM_VRAM_MIB
    return (
        Check("nvidia-driver", "pass", f"driver {driver}"),
        Check("container-gpu", "pass", name),
        Check(
            "vram",
            "pass" if enough_memory else "fail",
            f"{memory} MiB available; {MINIMUM_VRAM_MIB} MiB required",
            None if enough_memory else "Use an NVIDIA GPU with at least 8 GB VRAM.",
        ),
    )


def required_capacity_bytes() -> int:
    registry = _registry()
    archive_bytes = sum(source["size"] for source in registry["sources"])
    return archive_bytes * 3 + MODEL_RESERVE_BYTES + INDEX_RESERVE_BYTES + SAFETY_RESERVE_BYTES


def _registry() -> dict[str, object]:
    return json.loads(Path(__file__).with_name("dataset_registry.json").read_text())


def _source_fingerprints(registry: dict[str, object]) -> dict[str, str]:
    return {
        source["name"]: hashlib.sha256(
            json.dumps(source, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        for source in registry["sources"]
    }


def _check_storage(layout: RuntimeLayout) -> tuple[Check, Check]:
    try:
        layout.initialize()
        probe = layout.runtime_dir / ".write-probe"
        probe.write_text("ok")
        probe.unlink()
        writable = True
    except OSError:
        writable = False
    writable_check = Check(
        "storage-writable",
        "pass" if writable else "fail",
        str(layout.runtime_dir),
        None if writable else "Make the project directory writable by the current user.",
    )
    required = required_capacity_bytes()
    override = os.getenv("GODS_EYE_DOCTOR_FREE_BYTES")
    free = int(override) if override is not None else shutil.disk_usage(layout.root).free
    enough = free >= required
    capacity_check = Check(
        "storage-capacity",
        "pass" if enough else "fail",
        f"{free} bytes free; {required} bytes required",
        None if enough else "Free project-disk space, then rerun doctor.",
    )
    return writable_check, capacity_check


def _check_port(name: str, port: int) -> Check:
    override = os.getenv("GODS_EYE_DOCTOR_PORTS_AVAILABLE")
    if override is not None:
        available = override == "1"
        return Check(
            name,
            "pass" if available else "warn",
            f"127.0.0.1:{port} is {'available' if available else 'occupied'}",
            None if available else "The Launcher will select another loopback port at start.",
        )
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", port))
        available = True
    except OSError:
        available = False
    finally:
        probe.close()
    return Check(
        name,
        "pass" if available else "warn",
        f"127.0.0.1:{port} is {'available' if available else 'occupied'}",
        None if available else "The Launcher will select another loopback port at start.",
    )


def doctor(layout: RuntimeLayout) -> list[Check]:
    checks = [_check_platform()]
    checks.extend(_check_docker())
    checks.extend(_check_gpu())
    checks.extend(_check_storage(layout))
    checks.extend((_check_port("web-port", 5173), _check_port("api-port", 8000)))
    return checks


def _preparation_vram_mib() -> int:
    override = os.getenv("GODS_EYE_GPU_VRAM_MIB")
    if override is not None:
        return int(override)
    check = _check_gpu()[2]
    if check.status != "pass":
        raise ValueError(check.detail)
    return int(check.detail.split()[0])


RESET_PATHS = {
    "index": Path("indexes"),
    "model_cache": Path(".cache/huggingface"),
    "installed_datasets": Path("data/datasets"),
    "archives": Path("data/archives"),
}

RESET_INVALIDATION = {
    "index": {"index", "smoke_test"},
    "model_cache": {"model", "index", "smoke_test"},
    "installed_datasets": {"dataset_acquisition", "manifest", "index", "smoke_test"},
    "archives": set(),
}


def _path_size(path: Path) -> int:
    if path.is_symlink() or path.is_file():
        return path.lstat().st_size
    if not path.exists():
        return 0
    return sum(item.lstat().st_size for item in path.rglob("*") if item.is_file())


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)


def reset_assets(
    layout: RuntimeLayout, targets: list[str], *, confirmed: bool, as_json: bool
) -> int:
    paths = {target: layout.root / RESET_PATHS[target] for target in targets}
    sizes = {target: _path_size(path) for target, path in paths.items()}
    if not as_json:
        print("Reset plan")
        for target in targets:
            print(f"- {target.replace('_', ' ')} ({sizes[target]} bytes)")
    if not confirmed:
        if as_json:
            print(json.dumps({"status": "confirmation_required"}, sort_keys=True))
            return EXIT_CONFIRMATION
        try:
            answer = input("Delete these local assets? [y/N] ")
        except EOFError:
            print("Reset requires confirmation; rerun with --yes.", file=sys.stderr)
            return EXIT_CONFIRMATION
        if answer.strip().lower() not in {"y", "yes"}:
            if as_json:
                print(json.dumps({"deleted": [], "status": "cancelled"}, sort_keys=True))
            else:
                print("Reset cancelled; no assets were deleted.")
            return EXIT_OK

    with mutation_lock(layout, "reset"):
        state = layout.read_state()
        for path in paths.values():
            _remove_path(path)
        invalidated = set().union(*(RESET_INVALIDATION[target] for target in targets))
        preparation = state.setdefault("preparation", {})
        for stage in invalidated:
            preparation.pop(stage, None)
        layout.write_state(state)
        _write_operation_log(layout, "reset", {"targets": targets, "sizes": sizes})
    if as_json:
        print(json.dumps({"deleted": targets, "status": "ok"}, sort_keys=True))
    else:
        print("Reset complete.")
    return EXIT_OK


COMPATIBILITY_INVALIDATION = {
    "application": set(),
    "registry": {"dataset_acquisition", "manifest", "index", "smoke_test"},
    "model": {"model", "index", "smoke_test"},
    "manifest_schema": {"manifest", "index", "smoke_test"},
    "index_schema": {"index", "smoke_test"},
}
STAGE_ORDER = ["dataset_acquisition", "model", "manifest", "index", "smoke_test"]


def compatibility_plan(state: dict) -> tuple[dict[str, str], list[str], list[str]]:
    target = current_compatibility()
    previous = state.get("compatibility")
    if previous is None:
        changed = list(target) if state.get("preparation") else []
    else:
        changed = [key for key, value in target.items() if previous.get(key) != value]
    invalidated = set().union(*(COMPATIBILITY_INVALIDATION[key] for key in changed))
    return target, changed, [stage for stage in STAGE_ORDER if stage in invalidated]


def update_state(layout: RuntimeLayout, *, apply: bool, as_json: bool) -> int:
    state = layout.read_state()
    target, changed, invalidated = compatibility_plan(state)
    report = {
        "status": "applied" if apply else "planned",
        "changes": changed,
        "invalidate": invalidated,
        "reuse": [stage for stage in state.get("preparation", {}) if stage not in invalidated],
        "target": target,
    }
    if apply:
        with mutation_lock(layout, "update"):
            # Re-read under the lock so a plan can never overwrite newer preparation state.
            state = layout.read_state()
            target, changed, invalidated = compatibility_plan(state)
            preparation = state.setdefault("preparation", {})
            for stage in invalidated:
                preparation.pop(stage, None)
            if "registry" in changed:
                state["terms_acceptance"] = None
            state["compatibility"] = target
            layout.write_state(state)
            _write_operation_log(layout, "update", {"changes": changed, "invalidated": invalidated})
            report.update(
                changes=changed,
                invalidate=invalidated,
                reuse=[stage for stage in preparation if stage not in invalidated],
            )
    if as_json:
        print(json.dumps(report, sort_keys=True))
    else:
        heading = "Migration applied" if apply else "Migration plan"
        print(heading)
        print(f"Compatibility changes: {', '.join(changed) if changed else 'none'}")
        print(f"Rebuild required: {', '.join(invalidated) if invalidated else 'none'}")
        print(
            f"Verified stages reused: {', '.join(report['reuse']) if report['reuse'] else 'none'}"
        )
        if not apply:
            print("Run './gods-eye update --yes' to apply this plan.")
    return EXIT_OK


def _print_dataset_terms(registry: dict[str, object]) -> None:
    print("Dataset terms acknowledgement")
    for source in registry["sources"]:
        print(f"- {source['name']} ({source['size'] / 1024**3:.2f} GiB)")
        print(f"  Official source: {source['official_source']}")
        print(f"  Terms/license: {source['terms_url']}")
        print(f"  Mirror: Google Drive file {source['drive_id']}")
        print(f"  Restriction: {source['usage_restrictions']}")
    print(
        "Sensitive-data warning: these person-image research datasets may contain "
        "identifiable people."
    )


def _stage(number: int, label: str, started: float, estimate: str) -> None:
    elapsed = time.monotonic() - started
    print(f"Stage {number}/7 — {label} (elapsed {elapsed:.1f}s; estimated {estimate})")


def _safe_log_output(value: str) -> str:
    value = re.sub(
        r"(?i)(token|access_token|api_key)=([^\s&]+)",
        lambda match: f"{match.group(1)}=[REDACTED]",
        value,
    )
    return re.sub(r"(?i)Bearer\s+\S+", "Bearer [REDACTED]", value)


def prepare_datasets(layout: RuntimeLayout, *, accept_data_terms: bool, assume_yes: bool) -> int:
    """Acquire and verify Dataset Sources. Caller owns the Launcher mutation lock."""
    started = time.monotonic()
    _stage(1, "Preflight and storage calculation", started, "under 1 minute")
    print(f"Calculated storage requirement: {required_capacity_bytes()} bytes")
    checks = doctor(layout)
    if any(check.status == "fail" for check in checks):
        _print_human(checks)
        return EXIT_PREREQUISITE

    registry = _registry()
    _stage(2, "Dataset terms acknowledgement", started, "operator decision")
    _print_dataset_terms(registry)
    state = layout.read_state()
    expected_acceptance = {
        "registry_version": registry["schema_version"],
        "source_fingerprints": _source_fingerprints(registry),
    }
    saved_acceptance = state.get("terms_acceptance") or {}
    acceptance_is_compatible = all(
        saved_acceptance.get(key) == value for key, value in expected_acceptance.items()
    )
    if saved_acceptance and not acceptance_is_compatible:
        state["preparation"].pop("dataset_acquisition", None)
        layout.write_state(state)
    if acceptance_is_compatible:
        accept_data_terms = True
        print("Using dataset terms acceptance for the unchanged Dataset Registry sources.")
    if not accept_data_terms and not assume_yes and sys.stdin.isatty():
        accept_data_terms = (
            input("Type 'yes' to accept the displayed dataset terms: ").strip().lower() == "yes"
        )
    if not accept_data_terms:
        print(
            "Dataset terms require explicit acceptance; rerun with --accept-data-terms.",
            file=sys.stderr,
        )
        return EXIT_TERMS_REQUIRED
    if not acceptance_is_compatible:
        state["terms_acceptance"] = {
            "accepted_at": _utc_now(),
            **expected_acceptance,
        }
        layout.write_state(state)

    _stage(3, "Dataset Acquisition", started, "depends on network throughput")
    state["preparation"].pop("dataset_acquisition", None)
    layout.write_state(state)
    host_root = Path(os.getenv("GODS_EYE_HOST_PROJECT_ROOT", str(layout.root)))
    service_image = os.getenv("GODS_EYE_SERVICE_IMAGE", "gods-eye-service:local")
    if _run("docker", "image", "inspect", service_image).returncode != 0:
        build = _run(
            "docker",
            "build",
            "--file",
            str(host_root / "Dockerfile.service"),
            "--tag",
            service_image,
            str(host_root),
        )
        if build.returncode != 0:
            print(
                "Could not build the local service image for Dataset Acquisition.", file=sys.stderr
            )
            return EXIT_PREPARATION_FAILED
    result = _run(
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "gods-eye-datasets",
        "--volume",
        f"{host_root / 'data'}:/data:rw",
        "--volume",
        f"{host_root / 'indexes'}:/indexes:rw",
        service_image,
        "--data-root",
        "/data",
        "--index-root",
        "/indexes",
        "install",
        "--accept-data-terms",
        "--skip-manifest",
    )
    log_path = (
        layout.logs_dir / f"prepare-{dt.datetime.now(dt.UTC).strftime('%Y%m%dT%H%M%S%fZ')}.log"
    )
    log_path.write_text(
        "Stage 3/7 — Dataset Acquisition\n"
        + _safe_log_output(result.stdout)
        + _safe_log_output(result.stderr)
        + (
            "Dataset Acquisition completed\n"
            if result.returncode == 0
            else "Dataset Acquisition interrupted\n"
        )
    )
    if result.returncode != 0:
        print(
            f"Dataset Acquisition did not complete; rerun prepare to resume. Log: {log_path}",
            file=sys.stderr,
        )
        return result.returncode if result.returncode > 0 else EXIT_PREPARATION_FAILED
    state = layout.read_state()
    state["preparation"]["dataset_acquisition"] = {
        "status": "verified",
        "registry_version": registry["schema_version"],
        "selected_sources": [source["name"] for source in registry["sources"]],
        "completed_at": _utc_now(),
    }
    layout.write_state(state)
    print(f"Dataset Acquisition completed. Detailed log: {log_path}")
    return EXIT_OK


def _print_human(checks: list[Check]) -> None:
    print("God's Eye Full Demo doctor")
    print("STATUS  CHECK               DETAILS")
    for check in checks:
        print(f"{check.status.upper():<7} {check.name:<19} {check.detail}")
        if check.guidance:
            print(f"        Fix: {check.guidance}")


def main(argv: list[str] | None = None) -> int:
    parser = LauncherArgumentParser(prog="gods-eye")
    subparsers = parser.add_subparsers(dest="command", required=True)
    doctor_parser = subparsers.add_parser("doctor")
    doctor_parser.add_argument("--json", action="store_true")
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--batch-size", type=int)
    prepare_parser.add_argument("--yes", action="store_true")
    prepare_parser.add_argument("--accept-data-terms", action="store_true")
    reset_parser = subparsers.add_parser("reset")
    reset_parser.add_argument("--index", action="store_true")
    reset_parser.add_argument("--model-cache", action="store_true")
    reset_parser.add_argument("--installed-datasets", action="store_true")
    reset_parser.add_argument("--archives", action="store_true")
    reset_parser.add_argument("--all", action="store_true")
    reset_parser.add_argument("--yes", action="store_true")
    reset_parser.add_argument("--json", action="store_true")
    update_parser = subparsers.add_parser("update")
    update_parser.add_argument("--yes", action="store_true")
    update_parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    root = Path(os.getenv("GODS_EYE_PROJECT_ROOT", "/workspace"))
    layout = RuntimeLayout(root)
    if args.command == "prepare":
        from .preparation import PreparationError, prepare_model_index

        try:
            with mutation_lock(layout, "prepare"):
                result = prepare_datasets(
                    layout,
                    accept_data_terms=args.accept_data_terms,
                    assume_yes=args.yes,
                )
                if result != EXIT_OK:
                    return result
                acquisition = (
                    layout.read_state().get("preparation", {}).get("dataset_acquisition", {})
                )
                if acquisition.get("status") != "verified":
                    print(
                        "Dataset Acquisition must be verified before model and index preparation.",
                        file=sys.stderr,
                    )
                    return EXIT_PREPARATION_FAILED
                prepare_model_index(
                    root,
                    layout.state_path,
                    vram_mib=_preparation_vram_mib(),
                    batch_override=args.batch_size,
                )
        except LauncherBusyError as error:
            print(
                "Launcher is busy: "
                f"{error.active_operation.get('command', 'unknown')} is already running.",
                file=sys.stderr,
            )
            return EXIT_BUSY
        except (PreparationError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return EXIT_PREPARATION
        return EXIT_OK
    if args.command == "reset":
        targets = (
            list(RESET_PATHS)
            if args.all
            else [target for target in RESET_PATHS if getattr(args, target)]
        )
        if not targets:
            reset_parser.error(
                "Choose at least one reset target: --index, --model-cache, "
                "--installed-datasets, --archives, or --all"
            )
        try:
            return reset_assets(layout, targets, confirmed=args.yes, as_json=args.json)
        except LauncherBusyError as error:
            report = {"status": "busy", "active_operation": error.active_operation}
            if args.json:
                print(json.dumps(report, sort_keys=True))
            else:
                print(
                    "Launcher is busy: "
                    f"{error.active_operation.get('command', 'unknown')} is already running.",
                    file=sys.stderr,
                )
            return EXIT_BUSY
    if args.command == "update":
        try:
            return update_state(layout, apply=args.yes, as_json=args.json)
        except LauncherBusyError as error:
            report = {"status": "busy", "active_operation": error.active_operation}
            if args.json:
                print(json.dumps(report, sort_keys=True))
            else:
                print(
                    "Launcher is busy: "
                    f"{error.active_operation.get('command', 'unknown')} is already running.",
                    file=sys.stderr,
                )
            return EXIT_BUSY
    checks = doctor(layout)
    failed = any(check.status == "fail" for check in checks)
    if args.json:
        print(
            json.dumps(
                {
                    "status": "fail" if failed else "pass",
                    "checks": [asdict(check) for check in checks],
                },
                sort_keys=True,
            )
        )
    else:
        _print_human(checks)
    return EXIT_PREREQUISITE if failed else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
