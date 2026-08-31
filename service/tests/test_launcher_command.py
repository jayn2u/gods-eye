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
