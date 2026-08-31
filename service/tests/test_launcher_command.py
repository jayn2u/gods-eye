import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]


def _fake_docker(bin_dir: Path) -> None:
    executable = bin_dir / "docker"
    executable.write_text(
        f"#!{sys.executable}\n"
        + """
import os
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
failures = set(os.getenv("GODS_EYE_FAKE_DOCKER_FAILURES", "").split(","))
docker_log = os.getenv("GODS_EYE_FAKE_DOCKER_LOG")
if docker_log:
    with Path(docker_log).open("a") as stream:
        stream.write(__import__("json").dumps(args) + "\\n")
if args == ["--version"]:
    print("Docker version 27.5.1")
elif args[:2] == ["info", "--format"] and "ClientInfo.Plugins" in args[2]:
    print("/plugins/docker-compose")
elif args[:1] == ["info"]:
    if "info" in failures:
        raise SystemExit(1)
    print("27.5.1")
elif args[:2] == ["compose", "version"]:
    if "compose" in failures:
        raise SystemExit(1)
    print("2.32.4")
elif "build" in args and args[-1] == "launcher":
    raise SystemExit(0)
elif args[:2] == ["image", "inspect"]:
    raise SystemExit(1 if os.getenv("GODS_EYE_FAKE_SERVICE_IMAGE_MISSING") == "1" else 0)
elif args[:1] == ["build"]:
    print(os.getenv("GODS_EYE_FAKE_SERVICE_BUILD_ERROR", ""), file=sys.stderr)
    raise SystemExit(int(os.getenv("GODS_EYE_FAKE_SERVICE_BUILD_EXIT", "0")))
elif args[:1] == ["run"] and "gods-eye-datasets" in args:
    if "--skip-manifest" not in args:
        raise SystemExit(98)
    project = Path(os.environ["GODS_EYE_PROJECT_ROOT"])
    marker = project / ".fake-installer-interrupted"
    part = project / "data/archives/CUHK-PEDES.zip.part"
    if os.getenv("GODS_EYE_FAKE_INSTALLER_INTERRUPT_ONCE") == "1" and not marker.exists():
        marker.write_text("interrupted")
        part.parent.mkdir(parents=True, exist_ok=True)
        part.write_bytes(b"resumable")
        raise SystemExit(130)
    if part.exists():
        part.unlink()
    print(os.getenv("GODS_EYE_FAKE_INSTALLER_OUTPUT", ""))
    raise SystemExit(int(os.getenv("GODS_EYE_FAKE_INSTALLER_EXIT", "0")))
elif args[:1] == ["run"]:
    if "gpu" in failures:
        raise SystemExit(1)
    print(os.getenv("GODS_EYE_FAKE_GPU", "NVIDIA RTX 4090, 24564, 555.42.02"))
elif "run" in args and "launcher" in args:
    command = args[args.index("launcher") + 1 :]
    raise SystemExit(subprocess.call(
        [sys.executable, "-m", "gods_eye.launcher", *command], env=os.environ
    ))
else:
    print(f"unexpected fake docker invocation: {args}", file=sys.stderr)
    raise SystemExit(97)
"""
    )
    executable.chmod(0o755)


def _fake_preparation_runner(bin_dir: Path) -> Path:
    executable = bin_dir / "prepare-runner"
    executable.write_text(
        f"#!{sys.executable}\n"
        + """
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
log = Path(os.environ["GODS_EYE_FAKE_PREPARE_LOG"])
with log.open("a") as stream:
    stream.write(json.dumps(args) + "\\n")
operation = args[0]
root = Path(os.environ["GODS_EYE_PROJECT_ROOT"])
plan = Path(os.getenv("GODS_EYE_FAKE_PREPARE_PLAN", ""))
failures = json.loads(plan.read_text()) if plan.is_file() else {}
remaining = failures.get(operation, [])
if remaining:
    outcome = remaining.pop(0)
    failures[operation] = remaining
    # Persist outcomes because each invocation is a fresh process.
    plan.write_text(json.dumps(failures))
    if outcome == "oom":
        print("CUDA out of memory", file=sys.stderr)
        raise SystemExit(75)
    if outcome == "fail":
        print("terminal adapter failure", file=sys.stderr)
        raise SystemExit(1)
if operation == "prepare-model":
    path = root / ".cache/huggingface/model.ready"
elif operation == "verify-model":
    path = root / ".cache/huggingface/model.ready"
elif operation == "build-manifest":
    path = root / "indexes/gallery-manifest.json"
elif operation == "verify-manifest":
    path = Path(args[1])
elif operation == "build-index":
    path = root / "indexes/versions/test-version"
elif operation == "validate-index":
    path = Path(args[1])
elif operation == "activate-index":
    path = root / "indexes/active"
elif operation == "verify-index":
    path = Path(args[1])
elif operation == "smoke-search":
    path = Path(args[1])
else:
    raise SystemExit(64)
if operation == "build-index":
    path.mkdir(parents=True, exist_ok=True)
elif operation in {"validate-index", "verify-index", "verify-model", "verify-manifest", "smoke-search"}:
    if not path.exists():
        raise SystemExit(1)
else:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("ok")
print(path)
"""
    )
    executable.chmod(0o755)
    return executable


def _prepare_env(tmp_path: Path) -> tuple[dict[str, str], Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    runner = _fake_preparation_runner(bin_dir)
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    log = tmp_path / "prepare-calls.jsonl"
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(project_dir),
        "GODS_EYE_PREPARATION_RUNNER": str(runner),
        "GODS_EYE_FAKE_PREPARE_LOG": str(log),
        "GODS_EYE_GPU_VRAM_MIB": "24564",
        "GODS_EYE_DOCTOR_SYSTEM": "Linux",
        "GODS_EYE_DOCTOR_MACHINE": "x86_64",
        "GODS_EYE_DOCTOR_FREE_BYTES": str(40 * 1024**3),
        "GODS_EYE_DOCTOR_PORTS_AVAILABLE": "1",
    }
    return env, log


def test_prepare_requires_separate_dataset_terms_acceptance(tmp_path: Path) -> None:
    env, log = _prepare_env(tmp_path)

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 3
    assert "official source" in result.stdout.lower()
    assert "mirror" in result.stdout.lower()
    assert "sensitive" in result.stdout.lower()
    assert "--accept-data-terms" in result.stderr
    assert not log.exists()


def test_prepare_acquires_datasets_without_building_the_manifest(tmp_path: Path) -> None:
    env, log = _prepare_env(tmp_path)

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    state = json.loads((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/state.json").read_text())
    assert state["preparation"]["dataset_acquisition"]["status"] == "verified"
    assert state["preparation"]["gallery_manifest"]["status"] == "verified"
    assert state["preparation"]["smoke_test"]["status"] == "verified"
    operations = [json.loads(line)[0] for line in log.read_text().splitlines()]
    assert operations[-1] == "smoke-search"
    assert "Stage 3/7" in result.stdout
    assert log.exists()


def test_prepare_builds_from_container_project_and_mounts_host_storage(tmp_path: Path) -> None:
    env, _ = _prepare_env(tmp_path)
    docker_log = tmp_path / "docker-calls.jsonl"
    host_root = ROOT
    env.update(
        GODS_EYE_FAKE_DOCKER_LOG=str(docker_log),
        GODS_EYE_FAKE_SERVICE_IMAGE_MISSING="1",
    )

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    calls = [json.loads(line) for line in docker_log.read_text().splitlines()]
    service_build = next(call for call in calls if call[:1] == ["build"])
    container_root = Path(env["GODS_EYE_PROJECT_ROOT"])
    assert service_build == [
        "build",
        "--file",
        str(container_root / "Dockerfile.service"),
        "--tag",
        "gods-eye-service:local",
        str(container_root),
    ]
    acquisition = next(call for call in calls if "gods-eye-datasets" in call)
    assert f"{host_root / 'data'}:/data:rw" in acquisition
    assert f"{host_root / 'indexes'}:/indexes:rw" in acquisition


def test_prepare_service_build_failure_preserves_safe_diagnostic_log(tmp_path: Path) -> None:
    env, _ = _prepare_env(tmp_path)
    secret = "hf_private-value"
    env.update(
        GODS_EYE_FAKE_SERVICE_IMAGE_MISSING="1",
        GODS_EYE_FAKE_SERVICE_BUILD_EXIT="9",
        GODS_EYE_FAKE_SERVICE_BUILD_ERROR=f"access_token={secret} build context rejected",
    )

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 4
    assert "Log:" in result.stderr
    logs = list((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/logs").glob("prepare-*.log"))
    assert len(logs) == 1
    diagnostic = logs[0].read_text()
    assert "docker build" in diagnostic
    assert "build context rejected" in diagnostic
    assert "[REDACTED]" in diagnostic
    assert secret not in diagnostic


@pytest.mark.integration
def test_real_launcher_builds_service_from_container_project_path() -> None:
    if os.getenv("RUN_PREPARATION_BUILD_SMOKE") != "1":
        pytest.skip("set RUN_PREPARATION_BUILD_SMOKE=1 to build through the Launcher container")
    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")
    identity = uuid.uuid4().hex
    image = f"gods-eye-service:path-smoke-{identity}"
    container = f"gods-eye-path-smoke-{identity}"
    try:
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--profile",
                "tools",
                "run",
                "--rm",
                "--no-deps",
                "--name",
                container,
                "--entrypoint",
                "docker",
                "launcher",
                "build",
                "--file",
                "/workspace/Dockerfile.service",
                "--tag",
                image,
                "/workspace",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=600,
        )
        assert result.returncode == 0, result.stderr
    finally:
        subprocess.run(
            ["docker", "rm", "-f", container], check=False, capture_output=True, text=True
        )
        subprocess.run(
            ["docker", "image", "rm", "-f", image],
            check=False,
            capture_output=True,
            text=True,
        )


def test_prepare_does_not_declare_prepared_when_real_search_smoke_fails(tmp_path: Path) -> None:
    env, log = _prepare_env(tmp_path)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"smoke-search": ["fail"]}))
    env["GODS_EYE_FAKE_PREPARE_PLAN"] = str(plan)

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    state = json.loads((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/state.json").read_text())
    assert result.returncode == 1
    assert "smoke" in result.stderr.lower() or "adapter failure" in result.stderr.lower()
    assert "smoke_test" not in state["preparation"]
    assert json.loads(log.read_text().splitlines()[-1])[0] == "smoke-search"


def test_cancelled_dataset_acquisition_resumes_with_saved_acceptance(tmp_path: Path) -> None:
    env, _ = _prepare_env(tmp_path)
    env["GODS_EYE_FAKE_INSTALLER_INTERRUPT_ONCE"] = "1"

    interrupted = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert interrupted.returncode == 130
    project = Path(env["GODS_EYE_PROJECT_ROOT"])
    assert (project / "data/archives/CUHK-PEDES.zip.part").read_bytes() == b"resumable"

    resumed = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert resumed.returncode == 0, resumed.stderr
    assert "Using dataset terms acceptance" in resumed.stdout
    assert not (project / "data/archives/CUHK-PEDES.zip.part").exists()


def test_prepare_does_not_run_downstream_without_verified_acquisition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gods_eye import launcher

    project = tmp_path / "project"
    project.mkdir()
    runner_log = tmp_path / "runner.log"
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(project))
    monkeypatch.setenv("GODS_EYE_FAKE_PREPARE_LOG", str(runner_log))
    monkeypatch.setattr(launcher, "prepare_datasets", lambda *args, **kwargs: launcher.EXIT_OK)

    result = launcher.main(["prepare", "--yes", "--accept-data-terms"])

    assert result == launcher.EXIT_PREPARATION_FAILED
    assert not runner_log.exists()


def test_operator_can_verify_a_supported_workstation_as_json(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(project_dir),
        "GODS_EYE_DOCTOR_SYSTEM": "Linux",
        "GODS_EYE_DOCTOR_MACHINE": "x86_64",
        "GODS_EYE_DOCTOR_FREE_BYTES": str(40 * 1024**3),
        "GODS_EYE_DOCTOR_PORTS_AVAILABLE": "1",
    }

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "doctor", "--json"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["status"] == "pass"
    assert {check["name"] for check in report["checks"]} == {
        "platform",
        "docker-daemon",
        "compose",
        "nvidia-driver",
        "container-gpu",
        "vram",
        "storage-writable",
        "storage-capacity",
        "web-port",
        "api-port",
    }
    assert (project_dir / ".gods-eye/logs").is_dir()
    assert (project_dir / ".gods-eye/state.json").is_file()


def test_doctor_reports_all_prerequisite_failures_with_guidance(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(project_dir),
        "GODS_EYE_DOCTOR_SYSTEM": "Darwin",
        "GODS_EYE_DOCTOR_MACHINE": "arm64",
        "GODS_EYE_DOCTOR_FREE_BYTES": "1",
        "GODS_EYE_DOCTOR_PORTS_AVAILABLE": "0",
        "GODS_EYE_FAKE_DOCKER_FAILURES": "info,compose,gpu",
    }

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "doctor"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    for check_name in (
        "platform",
        "docker-daemon",
        "compose",
        "nvidia-driver",
        "container-gpu",
        "vram",
        "storage-capacity",
        "web-port",
        "api-port",
    ):
        assert check_name in result.stdout
    assert result.stdout.count("Fix:") >= 7


def test_doctor_enforces_the_eight_gibibyte_vram_floor(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(project_dir),
        "GODS_EYE_DOCTOR_SYSTEM": "Linux",
        "GODS_EYE_DOCTOR_MACHINE": "x86_64",
        "GODS_EYE_DOCTOR_FREE_BYTES": str(40 * 1024**3),
        "GODS_EYE_DOCTOR_PORTS_AVAILABLE": "1",
        "GODS_EYE_FAKE_GPU": "NVIDIA RTX A2000, 6144, 555.42.02",
    }

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "doctor", "--json"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    checks = {check["name"]: check for check in json.loads(result.stdout)["checks"]}
    assert checks["container-gpu"]["status"] == "pass"
    assert checks["nvidia-driver"]["status"] == "pass"
    assert checks["vram"] == {
        "name": "vram",
        "status": "fail",
        "detail": "6144 MiB available; 8192 MiB required",
        "guidance": "Use an NVIDIA GPU with at least 8 GB VRAM.",
    }


def test_launcher_uses_a_stable_exit_code_for_an_unknown_command(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(tmp_path),
    }

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "unknown-command"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 64
    assert "invalid choice" in result.stderr


def test_prepare_builds_and_reuses_compatible_model_manifest_and_index(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)

    first = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    second = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert first.returncode == 0, first.stderr
    assert "Stage 4/7 — CLIP ViT-B/16 model preparation (elapsed" in first.stdout
    assert "Stage 5/7 — Gallery Manifest generation (elapsed" in first.stdout
    assert "Stage 6/7 — GPU index build and atomic activation (elapsed" in first.stdout
    assert "Stage 7/7 — real-search smoke test (elapsed" in first.stdout
    assert "estimate measuring" in first.stdout
    assert "Detailed preparation log:" in first.stdout
    assert second.returncode == 0, second.stderr
    assert second.stdout.count("reused (verified)") == 3
    calls = [json.loads(line) for line in call_log.read_text().splitlines()]
    first_build = next(call for call in calls if call[0] == "build-index")
    assert first_build[first_build.index("--batch-size") + 1] == "64"
    assert [call[0] for call in calls] == [
        "prepare-model",
        "build-manifest",
        "verify-manifest",
        "build-index",
        "validate-index",
        "activate-index",
        "smoke-search",
        "verify-model",
        "verify-manifest",
        "verify-index",
        "smoke-search",
    ]
    state = json.loads((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/state.json").read_text())
    assert state["preparation"]["model"]["model_id"] == "openai/clip-vit-base-patch16"
    assert state["preparation"]["gallery_manifest"]["status"] == "verified"
    assert state["preparation"]["index"]["status"] == "active"
    detailed_logs = list(
        (Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/logs").glob("prepare-model-index-*.log")
    )
    assert len(detailed_logs) == 2
    assert "raw natural-language" not in detailed_logs[0].read_text()


def test_prepare_halves_batch_after_gpu_oom_and_reuses_checkpoint(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)
    plan = tmp_path / "failures.json"
    plan.write_text(json.dumps({"build-index": ["oom"]}))
    env["GODS_EYE_FAKE_PREPARE_PLAN"] = str(plan)

    result = subprocess.run(
        [
            str(ROOT / "gods-eye"),
            "prepare",
            "--batch-size",
            "64",
            "--accept-data-terms",
        ],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    calls = [json.loads(line) for line in call_log.read_text().splitlines()]
    builds = [call for call in calls if call[0] == "build-index"]
    assert [call[call.index("--batch-size") + 1] for call in builds] == ["64", "32"]
    assert (
        builds[0][builds[0].index("--checkpoint-dir") + 1]
        == builds[1][builds[1].index("--checkpoint-dir") + 1]
    )
    assert "GPU memory exhausted; retrying index stage with batch size 32" in result.stdout


def test_prepare_reports_terminal_index_failure_without_activation(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)
    plan = tmp_path / "failures.json"
    plan.write_text(json.dumps({"build-index": ["fail"]}))
    env["GODS_EYE_FAKE_PREPARE_PLAN"] = str(plan)

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "terminal adapter failure" in result.stderr
    calls = [json.loads(line) for line in call_log.read_text().splitlines()]
    assert "activate-index" not in [call[0] for call in calls]
