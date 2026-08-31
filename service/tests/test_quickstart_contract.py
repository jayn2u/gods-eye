import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
README = ROOT / "README.md"


def test_readme_leads_with_the_executable_three_command_quickstart() -> None:
    text = README.read_text()
    quickstart = text[text.index("## Quickstart") : text.index("## What preparation does")]

    assert "./gods-eye doctor\n./gods-eye prepare\n./gods-eye start" in quickstart
    assert "uv run" not in quickstart
    assert "pnpm" not in quickstart
    assert "docker compose" not in quickstart

    help_result = subprocess.run(
        [sys.executable, "-m", "gods_eye.launcher", "--help"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "PYTHONPATH": str(ROOT / "service")},
    )
    assert help_result.returncode == 0
    for command in ("doctor", "prepare", "start"):
        assert command in help_result.stdout


def test_readme_setup_links_resolve_and_advanced_commands_are_not_in_quickstart() -> None:
    text = README.read_text()
    expected = (
        "docs/setup/full-demo.md",
        "docs/setup/local-development.md",
        "docs/setup/datasets.md",
        "docs/setup/model-and-index.md",
        "docs/setup/offline-and-validation.md",
    )
    for relative in expected:
        assert f"]({relative})" in text
        assert (ROOT / relative).is_file()


def test_fixture_smoke_compose_override_is_valid_and_loopback_only() -> None:
    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")
    result = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            str(ROOT / "compose.yaml"),
            "-f",
            str(ROOT / "compose.smoke.yaml"),
            "config",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "GODS_EYE_SOURCE_ROOT": str(ROOT)},
    )

    assert result.returncode == 0, result.stderr
    assert 'GODS_EYE_USE_FIXTURES: "true"' in result.stdout
    assert "127.0.0.1" in result.stdout


def test_fixture_preparation_command_produces_runtime_state_and_local_assets(
    tmp_path: Path,
) -> None:
    environment = {
        **os.environ,
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(tmp_path),
        "GODS_EYE_USE_FIXTURES": "true",
    }

    result = subprocess.run(
        [sys.executable, "-m", "gods_eye.launcher", "prepare", "--yes"],
        text=True,
        capture_output=True,
        check=False,
        env=environment,
    )

    assert result.returncode == 0, result.stderr
    state = json.loads((tmp_path / ".gods-eye/state.json").read_text())
    assert state["preparation"]["gallery_manifest"]["status"] == "verified"
    assert state["preparation"]["smoke_test"]["fixture"] is True
    assert (tmp_path / "indexes/gallery-manifest.json").is_file()
    assert (tmp_path / "indexes/active").is_dir()


@pytest.mark.integration
def test_launcher_starts_fixture_compose_from_a_prepared_state(tmp_path: Path) -> None:
    if os.getenv("RUN_LAUNCHER_COMPOSE_SMOKE") != "1":
        pytest.skip("set RUN_LAUNCHER_COMPOSE_SMOKE=1 to build the fixture Compose smoke stack")
    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")

    environment = {
        **os.environ,
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(tmp_path),
        "GODS_EYE_SOURCE_ROOT": str(ROOT),
        "GODS_EYE_RUNTIME_PORTS_AVAILABLE": "1",
        "COMPOSE_FILE": f"{ROOT / 'compose.yaml'}:{ROOT / 'compose.smoke.yaml'}",
        "COMPOSE_PROJECT_NAME": f"gods-eye-smoke-{tmp_path.name}",
        "GODS_EYE_USE_FIXTURES": "true",
    }
    prepare = subprocess.run(
        [sys.executable, "-m", "gods_eye.launcher", "prepare", "--yes"],
        text=True,
        capture_output=True,
        check=False,
        env=environment,
    )
    assert prepare.returncode == 0, prepare.stderr
    produced = json.loads((tmp_path / ".gods-eye/state.json").read_text())
    assert produced["preparation"]["smoke_test"]["fixture"] is True
    start = subprocess.run(
        [
            sys.executable,
            "-m",
            "gods_eye.launcher",
            "start",
            "--detach",
            "--no-open",
            "--web-port",
            "15173",
            "--api-port",
            "18000",
        ],
        text=True,
        capture_output=True,
        check=False,
        env=environment,
    )
    try:
        assert start.returncode == 0, start.stderr
        assert "http://127.0.0.1:15173" in start.stdout
        assert urllib.request.urlopen("http://127.0.0.1:15173", timeout=5).status == 200
        ready = json.load(urllib.request.urlopen("http://127.0.0.1:18000/api/readiness", timeout=5))
        assert ready["ready"] is True
        assert ready["gallery_count"] == 3
    finally:
        subprocess.run(
            [sys.executable, "-m", "gods_eye.launcher", "stop"],
            check=False,
            env=environment,
            capture_output=True,
        )
