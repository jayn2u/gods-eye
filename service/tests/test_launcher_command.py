import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[2]


def _fake_docker(bin_dir: Path) -> None:
    executable = bin_dir / "docker"
    executable.write_text(
        f"#!{sys.executable}\n"
        + """
import os
import subprocess
import sys

args = sys.argv[1:]
failures = set(os.getenv("GODS_EYE_FAKE_DOCKER_FAILURES", "").split(","))
if args == ["--version"]:
    print("Docker version 27.5.1")
elif args[:1] == ["info"]:
    if "info" in failures:
        raise SystemExit(1)
    print("27.5.1")
elif args[:2] == ["compose", "version"]:
    if "compose" in failures:
        raise SystemExit(1)
    print("2.32.4")
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
else:
    raise SystemExit(64)
if operation == "build-index":
    path.mkdir(parents=True, exist_ok=True)
elif operation in {"validate-index", "verify-index", "verify-model", "verify-manifest"}:
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
    }
    return env, log


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
        [str(ROOT / "gods-eye"), "prepare"],
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
    assert "Step 4/7 - CLIP ViT-B/16 model" in first.stdout
    assert "Step 5/7 - Gallery Manifest" in first.stdout
    assert "Step 6/7 - GPU index build, validation, and activation" in first.stdout
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
        "verify-model",
        "verify-manifest",
        "verify-index",
    ]
    state = json.loads((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/state.json").read_text())
    assert state["preparation"]["model"]["model_id"] == "openai/clip-vit-base-patch16"
    assert state["preparation"]["gallery_manifest"]["status"] == "verified"
    assert state["preparation"]["index"]["status"] == "active"


def test_prepare_halves_batch_after_gpu_oom_and_reuses_checkpoint(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)
    plan = tmp_path / "failures.json"
    plan.write_text(json.dumps({"build-index": ["oom"]}))
    env["GODS_EYE_FAKE_PREPARE_PLAN"] = str(plan)

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--batch-size", "64"],
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
        [str(ROOT / "gods-eye"), "prepare"],
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
