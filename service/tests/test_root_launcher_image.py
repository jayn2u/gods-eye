import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]


def _fake_docker(tmp_path: Path) -> tuple[Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "docker.log"
    docker = bin_dir / "docker"
    docker.write_text(
        f"#!{sys.executable}\n"
        + """
import os
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
log = Path(os.environ["GODS_EYE_FAKE_DOCKER_LOG"])
with log.open("a") as stream:
    stream.write(" ".join(args) + "\\n")
if args[:3] == ["compose", "version", "--short"]:
    print("2.32.4")
elif "build" in args and args[-1] == "launcher":
    raise SystemExit(int(os.getenv("GODS_EYE_FAKE_BUILD_EXIT", "0")))
elif "run" in args and "launcher" in args:
    command = args[args.index("launcher") + 1:]
    raise SystemExit(subprocess.call(
        [sys.executable, "-m", "gods_eye.launcher", *command], env=os.environ
    ))
else:
    raise SystemExit(97)
"""
    )
    docker.chmod(0o755)
    return bin_dir, log


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
    command_calls = [call for call in calls if call != "compose version --short"]
    assert command_calls[0].endswith("--profile tools build launcher")
    assert command_calls[1].endswith(f"--profile tools run --rm launcher {command} --help")
    assert "Preparing the local Launcher image from the current checkout." in result.stderr
    assert "Building service and web images" not in result.stderr


def test_local_launcher_build_failure_never_runs_cached_image(tmp_path: Path) -> None:
    result, calls = _run(tmp_path, "prepare", "--help", GODS_EYE_FAKE_BUILD_EXIT="42")

    assert result.returncode == 42
    command_calls = [call for call in calls if call != "compose version --short"]
    assert len(command_calls) == 1
    assert command_calls[0].endswith("--profile tools build launcher")
    assert "Could not build the local Launcher image" in result.stderr


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
