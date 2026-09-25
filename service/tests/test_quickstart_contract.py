import json
import os
import re
import shutil
import socket
import subprocess
import sys
import urllib.request
import uuid
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


def _rendered_compose(*overrides: str) -> dict:
    files: list[str] = ["-f", str(ROOT / "compose.yaml")]
    for override in overrides:
        files.extend(("-f", str(ROOT / override)))
    result = subprocess.run(
        ["docker", "compose", *files, "config", "--format", "json"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        env={
            **os.environ,
            "GODS_EYE_RELEASE_VERSION": "v9.9.9",
            "GODS_EYE_SERVICE_IMAGE": "ghcr.io/jayn2u/gods-eye-service@sha256:" + "0" * 64,
            "GODS_EYE_WEB_IMAGE": "ghcr.io/jayn2u/gods-eye-web@sha256:" + "1" * 64,
        },
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_local_mode_demo_runtime_services_always_build_from_the_checkout() -> None:
    """A development checkout must never serve a previously tagged local image."""

    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")
    configuration = _rendered_compose()

    for name in ("service", "web"):
        definition = configuration["services"][name]
        assert definition.get("build"), f"{name} must be buildable in local mode"
        assert definition.get("pull_policy") == "build", (
            f"{name} must rebuild from the checkout; without an always-build pull policy "
            "Compose reuses whatever image already carries the tag, so source fixes never "
            "reach the Demo Runtime"
        )


def test_normal_service_requests_all_gpus() -> None:
    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")

    service = _rendered_compose()["services"]["service"]

    assert service.get("gpus") == [{"count": -1}]
    assert service["environment"]["GODS_EYE_RESIDENT_MODELS"] == "4"


@pytest.mark.parametrize("override", ["compose.release.yaml", "compose.offline.yaml"])
def test_resident_model_capacity_reaches_service_in_compose_modes(
    monkeypatch, override: str
) -> None:
    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")
    monkeypatch.setenv("GODS_EYE_RESIDENT_MODELS", "2")
    monkeypatch.setenv("COMPOSE_PROFILES", "tools")

    configuration = _rendered_compose(override)

    assert (
        configuration["services"]["service"]["environment"]["GODS_EYE_RESIDENT_MODELS"]
        == "2"
    )
    assert (
        configuration["services"]["launcher"]["environment"]["GODS_EYE_RESIDENT_MODELS"]
        == "2"
    )


def test_release_mode_pins_immutable_digests_and_never_builds() -> None:
    """Release mode runs published images and must not build anything."""

    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")
    configuration = _rendered_compose("compose.release.yaml")

    for name in ("service", "web"):
        definition = configuration["services"][name]
        assert not definition.get("build"), f"{name} must not build in release mode"
        assert definition.get("pull_policy") != "build"
        assert re.fullmatch(
            r"ghcr\.io/jayn2u/gods-eye-(service|web)@sha256:[0-9a-f]{64}",
            definition["image"],
        ), definition["image"]


@pytest.mark.integration
@pytest.mark.parametrize(
    "reference_format", ["portable", "legacy", "missing", "unsafe", "unsafe-gallery"]
)
def test_prepared_index_is_portable_across_launcher_and_runtime_mounts(
    tmp_path: Path, reference_format: str
) -> None:
    if os.getenv("RUN_PORTABLE_INDEX_SMOKE") != "1":
        pytest.skip("set RUN_PORTABLE_INDEX_SMOKE=1 to exercise portable Prepared Demo assets")
    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")

    image = os.getenv("GODS_EYE_SERVICE_IMAGE", "gods-eye-service:local")
    project = tmp_path / "project"
    project.mkdir()
    builder = r"""
import hashlib
import json
import os
from pathlib import Path
from PIL import Image
from gods_eye.gallery import GalleryManifest, GalleryRecord, stable_id
from gods_eye.index_store import activate_version, build_index

root = Path('/workspace')
images = root / 'data/datasets/CUHK-PEDES/imgs'
images.mkdir(parents=True)
relative = 'fixture/person.png'
path = images / relative
path.parent.mkdir(parents=True)
Image.new('RGB', (8, 16), 'blue').save(path)
record = GalleryRecord(
    id=stable_id('CUHK-PEDES', 'test', relative),
    dataset='CUHK-PEDES', split='test', relative_path=relative,
    source_person_id='fixture-person', content_sha256='fixture-content',
)
manifest = GalleryManifest(
    roots={'CUHK-PEDES': images}, records=[record],
    report={'source_rows': 1, 'records': 1, 'errors': 0},
)
manifest_path = root / 'indexes/gallery-manifest.json'
manifest.write(manifest_path)
version = build_index(
    manifest_path, root / 'indexes/versions',
    model_id='fixture/deterministic-v1', dimension=8, backend='numpy',
    dataset_root=root / 'data/datasets',
)
activate_version(
    version, root / 'indexes/active', 'fixture/deterministic-v1',
    dataset_root=root / 'data/datasets',
)
reference_format = os.environ['REFERENCE_FORMAT']
if reference_format == 'legacy':
    (root / 'indexes/active').write_text(str(version) + '\n')
    linked = version / 'manifest.json'
    raw = json.loads(linked.read_text())
    raw['roots']['CUHK-PEDES'] = '/workspace/data/datasets/CUHK-PEDES/imgs'
    linked.write_text(json.dumps(raw, indent=2) + '\n')
    canonical = json.dumps(raw, sort_keys=True, separators=(',', ':')).encode()
    metadata_path = version / 'metadata.json'
    metadata = json.loads(metadata_path.read_text())
    metadata['manifest_sha256'] = hashlib.sha256(canonical).hexdigest()
    metadata_path.write_text(json.dumps(metadata, indent=2) + '\n')
elif reference_format == 'unsafe':
    (root / 'indexes/active').write_text('/etc\n')
elif reference_format == 'missing':
    (root / 'indexes/active').write_text('versions/missing\n')
elif reference_format == 'unsafe-gallery':
    linked = version / 'manifest.json'
    raw = json.loads(linked.read_text())
    raw['roots']['CUHK-PEDES'] = '/etc'
    linked.write_text(json.dumps(raw, indent=2) + '\n')
    canonical = json.dumps(raw, sort_keys=True, separators=(',', ':')).encode()
    metadata_path = version / 'metadata.json'
    metadata = json.loads(metadata_path.read_text())
    metadata['manifest_sha256'] = hashlib.sha256(canonical).hexdigest()
    metadata_path.write_text(json.dumps(metadata, indent=2) + '\n')
"""
    build = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "-v",
            f"{project}:/workspace",
            "-v",
            f"{ROOT}:/source:ro",
            "-e",
            "PYTHONPATH=/source/service",
            "-e",
            f"REFERENCE_FORMAT={reference_format}",
            image,
            "python",
            "-c",
            builder,
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert build.returncode == 0, build.stderr

    version_id = next((project / "indexes/versions").iterdir()).name
    runtime = project / ".gods-eye"
    runtime.mkdir()
    runtime.joinpath("state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "terms_acceptance": {},
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
    override = project / "compose.portable.yaml"
    override.write_text(
        """services:
  service:
    environment:
      GODS_EYE_MODEL_ID: fixture/deterministic-v1
      GODS_EYE_USE_FIXTURES: "false"
      PYTHONPATH: /source/service
    volumes:
      - ${GODS_EYE_SOURCE_ROOT}:/source:ro
    command: ["python", "-m", "uvicorn", "gods_eye.app:app", "--host", "0.0.0.0", "--port", "8000"]
"""
    )
    ports = []
    for _ in range(2):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        ports.append(probe.getsockname()[1])
        probe.close()
    web_port, api_port = ports
    environment = {
        **os.environ,
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(project),
        "GODS_EYE_SOURCE_ROOT": str(ROOT),
        "GODS_EYE_INDEX_ROOT": str(project / "indexes"),
        "GODS_EYE_DATASET_ROOT": str(project / "data/datasets"),
        "GODS_EYE_MODEL_ID": "fixture/deterministic-v1",
        "GODS_EYE_RUNTIME_PORTS_AVAILABLE": "1",
        "GODS_EYE_READINESS_TIMEOUT_SECONDS": "5",
        "COMPOSE_FILE": f"{ROOT / 'compose.yaml'}:{override}",
        "COMPOSE_PROJECT_NAME": f"gods-eye-portable-{uuid.uuid4().hex}",
    }
    started = subprocess.run(
        [
            sys.executable,
            "-m",
            "gods_eye.launcher",
            "start",
            "--detach",
            "--no-open",
            "--web-port",
            str(web_port),
            "--api-port",
            str(api_port),
        ],
        text=True,
        capture_output=True,
        check=False,
        env=environment,
    )
    try:
        if reference_format in {"missing", "unsafe", "unsafe-gallery"}:
            assert started.returncode == 4
            if reference_format == "unsafe":
                assert "escapes the configured index root" in started.stderr
            elif reference_format == "unsafe-gallery":
                assert "outside the configured root" in started.stderr
            else:
                assert "metadata.json" in started.stderr
            return
        assert started.returncode == 0, started.stderr
        health = json.load(
            urllib.request.urlopen(f"http://127.0.0.1:{api_port}/api/health", timeout=5)
        )
        readiness = json.load(
            urllib.request.urlopen(f"http://127.0.0.1:{api_port}/api/readiness", timeout=5)
        )
        assert health == {"status": "ok"}
        assert readiness["ready"] is True, readiness.get("guidance")
        assert readiness["model_id"] == "fixture/deterministic-v1"
        assert readiness["active_index_version"] == version_id
        assert readiness["gallery_count"] == 1
        request = urllib.request.Request(
            f"http://127.0.0.1:{api_port}/api/search",
            data=json.dumps(
                {"query": "a person in blue", "top_k": 1, "datasets": ["CUHK-PEDES"]}
            ).encode(),
            headers={"Content-Type": "application/json"},
        )
        response = json.load(urllib.request.urlopen(request, timeout=5))
        assert len(response["results"]) == 1
        assert (
            urllib.request.urlopen(
                f"http://127.0.0.1:{api_port}{response['results'][0]['image_url']}", timeout=5
            ).status
            == 200
        )
    finally:
        subprocess.run(
            [sys.executable, "-m", "gods_eye.launcher", "stop"],
            env=environment,
            capture_output=True,
            check=False,
        )
