import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from runtime_http_server import loopback_http_server

ROOT = Path(__file__).parents[2]


def _fake_docker(tmp_path: Path, *, mode: str = "basic") -> tuple[Path, Path]:
    """Create one configurable fake Docker CLI for root-launcher tests."""

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / f"docker-{mode}.log"
    docker = bin_dir / "docker"
    docker.write_text(
        f"#!{sys.executable}\n"
        f"MODE = {mode!r}\n"
        + """
import json
import os
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
log = Path(os.environ["GODS_EYE_FAKE_DOCKER_LOG"])
with log.open("a") as stream:
    if MODE == "basic":
        line = " ".join(args)
        if args[:2] == ["image", "inspect"]:
            line += " fingerprint=" + os.environ.get("GODS_EYE_SOURCE_FINGERPRINT", "")
        stream.write(line + "\\n")
    else:
        stream.write(json.dumps({
            "args": args,
            "project_name": os.getenv("COMPOSE_PROJECT_NAME"),
            "compose_project_name": os.getenv("GODS_EYE_COMPOSE_PROJECT_NAME"),
            "data_home": os.getenv("GODS_EYE_DATA_HOME"),
            "dataset_root": os.getenv("GODS_EYE_DATASET_ROOT"),
            "index_root": os.getenv("GODS_EYE_INDEX_ROOT"),
            "hf_cache": os.getenv("GODS_EYE_HF_CACHE"),
        }) + "\\n")
if args[:3] == ["compose", "version", "--short"]:
    if os.getenv("GODS_EYE_FAKE_COMPOSE_AVAILABLE", "1") == "1":
        print("2.32.4")
    else:
        raise SystemExit(1)
elif args[:2] == ["info", "--format"]:
    if os.getenv("GODS_EYE_FAKE_DAEMON_AVAILABLE", "1") != "1":
        print("daemon unavailable", file=sys.stderr)
        raise SystemExit(1)
    if os.getenv("GODS_EYE_FAKE_COMPOSE_AVAILABLE", "1") == "1":
        print("/plugins/docker-compose")
elif args[:2] == ["image", "inspect"]:
    state = os.getenv("GODS_EYE_FAKE_LAUNCHER_IMAGE_STATE", "absent")
    if state == "absent":
        print("No such image", file=sys.stderr)
        raise SystemExit(1)
    print(os.environ["GODS_EYE_SOURCE_FINGERPRINT"] if state == "current" else "stale-fingerprint")
elif "build" in args and args[-1] == "launcher":
    # Real Buildx writes its progress to stdout; the wrapper must keep that
    # noise away from a command's machine-readable output.
    print("#1 [internal] load local bake definitions")
    print("#1 DONE 0.0s")
    raise SystemExit(int(os.getenv("GODS_EYE_FAKE_BUILD_EXIT", "0")))
elif "run" in args and "launcher" in args:
    command = args[args.index("launcher") + 1:]
    if MODE == "basic":
        child_env = os.environ
    else:
        host_root = Path(args[args.index("--project-directory") + 1]).resolve()
        workspace_root = Path(os.environ["GODS_EYE_FAKE_WORKSPACE_ROOT"])
        compose_file = workspace_root / "compose.yaml"
        if os.getenv("GODS_EYE_IMAGE_MODE") == "release":
            compose_file = f"{compose_file}:{workspace_root / 'compose.release.yaml'}"
        child_env = {
            **os.environ,
            "GODS_EYE_PROJECT_ROOT": str(workspace_root),
            "GODS_EYE_HOST_PROJECT_ROOT": str(host_root),
            "GODS_EYE_COMPOSE_FILE": str(compose_file),
        }
    raise SystemExit(subprocess.call(
        [sys.executable, "-m", "gods_eye.launcher", *command], env=child_env
    ))
elif MODE != "basic" and "compose" in args and "exec" in args:
    workspace = Path(os.environ["GODS_EYE_PROJECT_ROOT"])
    index_root = Path(os.getenv("GODS_EYE_INDEX_ROOT", str(workspace / "indexes")))
    if (index_root / "active").exists():
        print(json.dumps({"ready": True, "gallery_count": 1}))
    else:
        print(
            "No active retrieval index. Build and activate the active retrieval index first.",
            file=sys.stderr,
        )
        raise SystemExit(1)
elif MODE != "basic" and "compose" in args and "ps" in args:
    print(json.dumps([
        {"Service": "service", "State": "running"},
        {"Service": "web", "State": "running"},
    ]))
elif MODE != "basic" and "compose" in args and "logs" in args:
    print("service | ready")
elif MODE != "basic" and "compose" in args and ("up" in args or "down" in args):
    pass
else:
    raise SystemExit(97)
"""
    )
    docker.chmod(0o755)
    return bin_dir, log


def _prepared_state(root: Path) -> None:
    prepared = root / ".gods-eye"
    prepared.mkdir(parents=True, exist_ok=True)
    (prepared / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "terms_acceptance": {},
                "compatibility": {},
                "preparation": {
                    "dataset_acquisition": {"status": "verified"},
                    "model": {"status": "verified"},
                    "gallery_manifest": {"status": "verified"},
                    "index": {"status": "active"},
                    "smoke_test": {"status": "verified"},
                },
            }
        )
    )


def _prepared_assets(
    root: Path, *, active_reference: str = "versions/prepared", active_is_directory: bool = False
) -> None:
    for name in ("CUHK-PEDES",):
        (root / "data" / "datasets" / name).mkdir(parents=True, exist_ok=True)
        receipt = root / "data" / "install-state" / f"{name}.json"
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text("{}")

    model_cache = root / ".cache" / "huggingface"
    model_cache.mkdir(parents=True, exist_ok=True)
    (model_cache / "model.ready").write_text("ready")

    indexes = root / "indexes"
    indexes.mkdir(parents=True, exist_ok=True)
    (indexes / "gallery-manifest.json").write_text("{}")
    active = indexes / "active"
    if active_is_directory:
        active.mkdir(parents=True, exist_ok=True)
    else:
        (indexes / "versions" / "prepared").mkdir(parents=True, exist_ok=True)
        active.write_text(active_reference + "\n")


def _prepared(root: Path, **asset_options: object) -> None:
    _prepared_state(root)
    _prepared_assets(root, **asset_options)


def _run(
    tmp_path: Path, *args: str, **overrides: str
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    bin_dir, log = _fake_docker(tmp_path)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_FAKE_DOCKER_LOG": str(log),
        **overrides,
    }
    result = subprocess.run(
        [str(ROOT / "gods-eye"), *args],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    return result, log.read_text().splitlines()


@pytest.mark.parametrize("command", ["prepare", "start"])
def test_local_root_command_builds_launcher_before_preserving_help(
    command: str, tmp_path: Path
) -> None:
    result, calls = _run(tmp_path, command, "--help")

    assert result.returncode == 0, result.stderr
    command_calls = [
        call
        for call in calls
        if call != "compose version --short"
        and not call.startswith("info --format")
        and not call.startswith("image inspect")
    ]
    assert command_calls[0].endswith("--profile tools build launcher")
    assert command_calls[1].endswith(f"--profile tools run --rm launcher {command} --help")
    assert "Building the local Launcher image" in result.stderr
    assert "Building service and web images" not in result.stderr


def test_local_launcher_build_failure_never_runs_cached_image(tmp_path: Path) -> None:
    result, calls = _run(tmp_path, "prepare", "--help", GODS_EYE_FAKE_BUILD_EXIT="42")

    assert result.returncode == 42
    command_calls = [
        call
        for call in calls
        if call != "compose version --short"
        and not call.startswith("info --format")
        and not call.startswith("image inspect")
    ]
    assert len(command_calls) == 1
    assert command_calls[0].endswith("--profile tools build launcher")
    assert "Could not build the local Launcher image" in result.stderr


def test_root_launcher_mounts_the_active_compose_plugin_before_running(tmp_path: Path) -> None:
    result, calls = _run(tmp_path, "prepare", "--help")

    assert result.returncode == 0, result.stderr
    assert any(call.startswith("info --format") for call in calls)
    build = next(call for call in calls if call.endswith("--profile tools build launcher"))
    run = next(call for call in calls if "--profile tools run --rm launcher" in call)
    assert calls.index(build) < calls.index(run)


def test_root_launcher_stops_when_compose_plugin_cannot_be_mounted(tmp_path: Path) -> None:
    result, calls = _run(
        tmp_path,
        "prepare",
        "--help",
        GODS_EYE_FAKE_COMPOSE_AVAILABLE="0",
    )

    assert result.returncode == 2
    assert "Compose plugin" in result.stderr
    assert not any("build launcher" in call or "run --rm launcher" in call for call in calls)


def test_root_launcher_reuses_prepared_assets_from_actual_checkout_root(tmp_path: Path) -> None:
    host_root = tmp_path / "checkout with spaces"
    host_root.mkdir()
    shutil.copy2(ROOT / "gods-eye", host_root / "gods-eye")
    workspace_root = tmp_path / "launcher-workspace"
    workspace_root.mkdir()

    _prepared_state(workspace_root)
    _prepared_assets(host_root)

    bin_dir, log = _fake_docker(tmp_path, mode="runtime")
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_FAKE_DOCKER_LOG": str(log),
        "GODS_EYE_FAKE_WORKSPACE_ROOT": str(workspace_root),
        "GODS_EYE_RUNTIME_PORTS_AVAILABLE": "1",
        "GODS_EYE_READINESS_TIMEOUT_SECONDS": "0",
    }
    for variable in ("GODS_EYE_DATASET_ROOT", "GODS_EYE_INDEX_ROOT", "GODS_EYE_HF_CACHE"):
        env.pop(variable, None)

    with loopback_http_server() as web_port:
        result = subprocess.run(
            [
                str(host_root / "gods-eye"),
                "start",
                "--detach",
                "--no-open",
                "--web-port",
                str(web_port),
            ],
            cwd=host_root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
    calls = [json.loads(line) for line in log.read_text().splitlines()]

    assert result.returncode == 0, result.stderr
    assert f"http://127.0.0.1:{web_port}" in result.stdout
    runtime_up = next(call for call in calls if "up" in call["args"])
    assert runtime_up["dataset_root"] == str(host_root / "data" / "datasets")
    assert runtime_up["index_root"] == str(host_root / "indexes")
    assert runtime_up["hf_cache"] == str(host_root / ".cache" / "huggingface")
    assert all(
        "/workspace" not in runtime_up[key] for key in ("dataset_root", "index_root", "hf_cache")
    )


@pytest.mark.parametrize("image_mode", ["development", "release"])
def test_root_launcher_reuses_one_runtime_contract_across_lifecycle_commands(
    tmp_path: Path, image_mode: str
) -> None:
    host_root = tmp_path / "checkout with spaces"
    host_root.mkdir()
    shutil.copy2(ROOT / "gods-eye", host_root / "gods-eye")
    workspace_root = tmp_path / "launcher-workspace"
    workspace_root.mkdir()

    _prepared_state(workspace_root)
    _prepared_assets(workspace_root, active_is_directory=True)
    _prepared_assets(host_root)
    if image_mode == "release":
        (host_root / "release-images.env").write_text(
            "GODS_EYE_RELEASE_VERSION=v1.2.3\n"
            "GODS_EYE_SERVICE_IMAGE=ghcr.io/jayn2u/gods-eye-service@sha256:" + "a" * 64 + "\n"
            "GODS_EYE_WEB_IMAGE=ghcr.io/jayn2u/gods-eye-web@sha256:" + "b" * 64 + "\n"
        )

    bin_dir, log = _fake_docker(tmp_path, mode="runtime")
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_FAKE_DOCKER_LOG": str(log),
        "GODS_EYE_FAKE_WORKSPACE_ROOT": str(workspace_root),
        "GODS_EYE_RUNTIME_PORTS_AVAILABLE": "1",
        "GODS_EYE_READINESS_TIMEOUT_SECONDS": "0",
    }
    for variable in (
        "COMPOSE_PROJECT_NAME",
        "GODS_EYE_COMPOSE_PROJECT_NAME",
        "GODS_EYE_DATA_HOME",
        "GODS_EYE_DATASET_ROOT",
        "GODS_EYE_INDEX_ROOT",
        "GODS_EYE_HF_CACHE",
    ):
        env.pop(variable, None)

    results = []
    with loopback_http_server() as web_port:
        commands = (
            ("start", "--detach", "--offline", "--no-open", "--web-port", str(web_port)),
            ("status",),
            ("logs",),
            ("stop",),
        )
        for command in commands:
            results.append(
                subprocess.run(
                    [str(host_root / "gods-eye"), *command],
                    cwd=host_root,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
            )
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    runtime_calls = [
        call
        for call in calls
        if "compose" in call["args"]
        and "--project-name" in call["args"]
        and "exec" not in call["args"]
        and any(action in call["args"] for action in ("up", "ps", "logs", "down"))
    ]

    assert all(result.returncode == 0 for result in results), [
        (result.returncode, result.stdout, result.stderr) for result in results
    ]
    assert len(runtime_calls) == 4
    project_names = {call["project_name"] for call in runtime_calls}
    assert len(project_names) == 1
    project_name = project_names.pop()
    assert project_name and " " not in project_name
    assert all("--project-name" in call["args"] for call in runtime_calls)
    assert all(
        call["args"][call["args"].index("--project-name") + 1] == project_name
        for call in runtime_calls
    )
    expected_assets = {
        "data_home": str(host_root / "data"),
        "dataset_root": str(host_root / "data" / "datasets"),
        "index_root": str(host_root / "indexes"),
        "hf_cache": str(host_root / ".cache" / "huggingface"),
    }
    assert all(
        {key: call[key] for key in expected_assets} == expected_assets for call in runtime_calls
    )
    start_call = next(call for call in runtime_calls if "up" in call["args"])
    assert str(workspace_root / "compose.offline.yaml") in start_call["args"]
    assert all(
        str(workspace_root / "compose.offline.yaml") not in call["args"]
        for call in runtime_calls
        if call is not start_call
    )
    if image_mode == "release":
        assert "--build" not in start_call["args"]
        assert all(
            str(workspace_root / "compose.release.yaml") in call["args"] for call in runtime_calls
        )
    else:
        assert "--build" in start_call["args"]
        assert all(
            str(workspace_root / "compose.release.yaml") not in call["args"]
            for call in runtime_calls
        )


def test_root_launcher_reports_daemon_failure_without_claiming_compose_is_missing(
    tmp_path: Path,
) -> None:
    result, calls = _run(
        tmp_path,
        "doctor",
        GODS_EYE_FAKE_DAEMON_AVAILABLE="0",
    )

    assert result.returncode == 2
    assert "Docker daemon" in result.stderr
    assert "Compose plugin could not be located" not in result.stderr
    assert not any("build launcher" in call or "run --rm launcher" in call for call in calls)


def _build_calls(calls: list[str]) -> list[str]:
    return [call for call in calls if "build" in call and call.endswith("launcher")]


def test_absent_launcher_image_is_built_with_a_cold_build_warning(tmp_path: Path) -> None:
    result, calls = _run(tmp_path, "doctor", GODS_EYE_FAKE_LAUNCHER_IMAGE_STATE="absent")

    assert _build_calls(calls)
    assert "no local Launcher image is present" in result.stderr
    assert "takes many minutes" in result.stderr


def test_unchanged_checkout_reuses_the_existing_launcher_image(tmp_path: Path) -> None:
    """A start attempt must not pay a full image build to fail fast."""

    result, calls = _run(tmp_path, "doctor", GODS_EYE_FAKE_LAUNCHER_IMAGE_STATE="current")

    assert not _build_calls(calls)
    assert "Building the local Launcher image" not in result.stderr
    assert any("run --rm launcher" in call for call in calls)


def test_changed_checkout_rebuilds_the_launcher_image(tmp_path: Path) -> None:
    result, calls = _run(tmp_path, "doctor", GODS_EYE_FAKE_LAUNCHER_IMAGE_STATE="stale")

    assert _build_calls(calls)
    assert "the checkout changed" in result.stderr


def test_launcher_image_fingerprint_tracks_the_copied_sources(tmp_path: Path) -> None:
    """The fingerprint must move when anything the image copies moves."""

    before = _launcher_fingerprint(tmp_path / "before")
    scratch = ROOT / "service" / "gods_eye" / "_fingerprint_probe.py"
    scratch.write_text("# temporary probe\n")
    try:
        after = _launcher_fingerprint(tmp_path / "after")
    finally:
        scratch.unlink()
    restored = _launcher_fingerprint(tmp_path / "restored")

    assert before != after
    assert before == restored


def test_launcher_image_fingerprint_ignores_uncopied_bytecode(tmp_path: Path) -> None:
    """.dockerignore keeps bytecode out of the image, so it must not force a rebuild."""

    cache = ROOT / "service" / "gods_eye" / "__pycache__"
    cache.mkdir(exist_ok=True)
    probe = cache / "fingerprint_probe.cpython-999.pyc"
    before = _launcher_fingerprint(tmp_path / "before")
    probe.write_bytes(b"\x00bytecode that never reaches the build context\n")
    try:
        assert _launcher_fingerprint(tmp_path / "after") == before
    finally:
        probe.unlink()


def _launcher_fingerprint(root: Path) -> str:
    root.mkdir(parents=True, exist_ok=True)
    _, calls = _run(root, "doctor", GODS_EYE_FAKE_LAUNCHER_IMAGE_STATE="current")
    fingerprints = {call.split("fingerprint=", 1)[1] for call in calls if "fingerprint=" in call}
    assert len(fingerprints) == 1, calls
    return fingerprints.pop()


def test_local_image_preparation_keeps_machine_readable_output_clean(tmp_path: Path) -> None:
    """Launcher image build progress is diagnostics, not command output."""

    result, _ = _run(tmp_path, "doctor", "--json")

    checks = json.loads(result.stdout)["checks"]
    assert {check["name"] for check in checks}
    assert "Building the local Launcher image" in result.stderr
    assert "load local bake definitions" in result.stderr


@pytest.mark.integration
def test_real_docker_replaces_isolated_stale_launcher_image(tmp_path: Path) -> None:
    if os.getenv("RUN_STALE_LAUNCHER_SMOKE") != "1":
        pytest.skip("set RUN_STALE_LAUNCHER_SMOKE=1 to exercise real Docker image replacement")
    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")

    image = f"gods-eye-launcher:stale-test-{uuid.uuid4().hex}"
    _run_real_docker_stale_image_smoke(tmp_path, image)


def _run_real_docker_stale_image_smoke(tmp_path: Path, image: str) -> None:
    try:
        subprocess.run(
            [
                "docker",
                "compose",
                "--project-directory",
                str(ROOT),
                "--profile",
                "tools",
                "build",
                "launcher",
            ],
            cwd=ROOT,
            env={**os.environ, "GODS_EYE_LAUNCHER_IMAGE": image},
            check=True,
            capture_output=True,
            text=True,
        )
        dockerfile = tmp_path / "Dockerfile"
        dockerfile.write_text(
            f"FROM {image}\n"
            "RUN printf '%s\\n' 'import argparse' 'p=argparse.ArgumentParser()' "
            '\'p.add_subparsers(dest="command", required=True).add_parser("doctor")\' '
            "'p.parse_args()' > /stale.py\n"
            'ENTRYPOINT ["python", "/stale.py"]\n'
        )
        subprocess.run(
            ["docker", "build", "-t", image, str(tmp_path)],
            check=True,
            capture_output=True,
            text=True,
        )
        stale = subprocess.run(
            ["docker", "run", "--rm", image, "prepare", "--help"],
            check=False,
            capture_output=True,
            text=True,
        )
        assert stale.returncode != 0
        assert "invalid choice: 'prepare'" in stale.stderr

        for command in ("prepare", "start"):
            result = subprocess.run(
                [str(ROOT / "gods-eye"), command, "--help"],
                cwd=ROOT,
                env={**os.environ, "GODS_EYE_LAUNCHER_IMAGE": image},
                check=False,
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0, result.stderr
            assert "invalid choice" not in result.stderr
    finally:
        subprocess.run(["docker", "image", "rm", "-f", image], check=False, capture_output=True)


def test_real_docker_smoke_cleans_image_when_initial_build_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    image = "gods-eye-launcher:stale-test-setup-failure"
    calls: list[list[str]] = []

    def fail_then_clean(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        if len(calls) == 1:
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fail_then_clean)

    with pytest.raises(subprocess.CalledProcessError):
        _run_real_docker_stale_image_smoke(tmp_path, image)

    assert calls[-1] == ["docker", "image", "rm", "-f", image]


@pytest.mark.integration
def test_real_root_doctor_uses_compose_inside_launcher() -> None:
    if os.getenv("RUN_LAUNCHER_COMPOSE_SMOKE") != "1":
        pytest.skip("set RUN_LAUNCHER_COMPOSE_SMOKE=1 to exercise Launcher Compose mounting")
    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "doctor", "--json"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    checks = __import__("json").loads(result.stdout)["checks"]
    compose = next(check for check in checks if check["name"] == "compose")
    assert compose["status"] == "pass"
