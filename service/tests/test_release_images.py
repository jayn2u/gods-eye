import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).parents[2]


def _fake_docker(tmp_path: Path) -> tuple[Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "docker.log"
    docker = bin_dir / "docker"
    docker.write_text(
        "#!/bin/sh\n"
        'printf "mode=%s service=%s web=%s compose_file=%s args=%s\\n" '
        '"${GODS_EYE_IMAGE_MODE:-}" "${GODS_EYE_SERVICE_IMAGE:-}" '
        '"${GODS_EYE_WEB_IMAGE:-}" "${GODS_EYE_COMPOSE_FILE:-}" '
        '"$*" >> "$GODS_EYE_FAKE_DOCKER_LOG"\n'
        'if [ "$1 $2 $3" = "compose version --short" ]; then printf "2.32.4\\n"; fi\n'
        'if [ "$1" = "info" ]; then printf "/usr/libexec/docker/cli-plugins/docker-compose\\n"; fi\n'
    )
    docker.chmod(0o755)
    return bin_dir, log


def _run_launcher(tmp_path: Path, manifest: str | None = None) -> subprocess.CompletedProcess[str]:
    bin_dir, log = _fake_docker(tmp_path)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "GODS_EYE_FAKE_DOCKER_LOG": str(log),
    }
    if manifest is not None:
        path = tmp_path / "release-images.env"
        path.write_text(manifest)
        env["GODS_EYE_RELEASE_MANIFEST"] = str(path)
    result = subprocess.run(
        [str(ROOT / "gods-eye"), "doctor"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    result.docker_log = log.read_text()  # type: ignore[attr-defined]
    return result


def test_development_checkout_clearly_selects_local_builds(tmp_path: Path) -> None:
    result = _run_launcher(tmp_path)

    assert result.returncode == 0
    assert "Preparing the local Launcher image from the current checkout" in result.stderr
    assert " build launcher" in result.docker_log  # type: ignore[attr-defined]
    assert result.docker_log.index(" build launcher") < result.docker_log.index(
        " run --rm launcher"
    )  # type: ignore[attr-defined]
    assert "mode=local" in result.docker_log  # type: ignore[attr-defined]
    assert "compose_file=/workspace/compose.yaml" in result.docker_log  # type: ignore[attr-defined]
    assert "compose.release.yaml" not in result.docker_log  # type: ignore[attr-defined]


def test_release_manifest_selects_only_digest_pinned_images(tmp_path: Path) -> None:
    service_digest = "a" * 64
    web_digest = "b" * 64
    result = _run_launcher(
        tmp_path,
        f"GODS_EYE_RELEASE_VERSION=v1.2.3\n"
        f"GODS_EYE_SERVICE_IMAGE=ghcr.io/jayn2u/gods-eye-service@sha256:{service_digest}\n"
        f"GODS_EYE_WEB_IMAGE=ghcr.io/jayn2u/gods-eye-web@sha256:{web_digest}\n",
    )

    assert result.returncode == 0
    assert "Using immutable release images for v1.2.3" in result.stderr
    assert "mode=release" in result.docker_log  # type: ignore[attr-defined]
    assert (
        "compose_file=/workspace/compose.yaml:/workspace/compose.release.yaml" in result.docker_log  # type: ignore[attr-defined]
    )
    assert f"service=ghcr.io/jayn2u/gods-eye-service@sha256:{service_digest}" in result.docker_log  # type: ignore[attr-defined]
    assert f"web=ghcr.io/jayn2u/gods-eye-web@sha256:{web_digest}" in result.docker_log  # type: ignore[attr-defined]
    assert "compose.release.yaml" in result.docker_log  # type: ignore[attr-defined]
    assert " build launcher" not in result.docker_log  # type: ignore[attr-defined]


def test_release_manifest_rejects_mutable_or_untrusted_images(tmp_path: Path) -> None:
    result = _run_launcher(
        tmp_path,
        "GODS_EYE_RELEASE_VERSION=v1.2.3\n"
        "GODS_EYE_SERVICE_IMAGE=ghcr.io/jayn2u/gods-eye-service:latest\n"
        f"GODS_EYE_WEB_IMAGE=example.com/web@sha256:{'b' * 64}\n",
    )

    assert result.returncode == 65
    assert "invalid immutable image reference" in result.stderr
    assert " run " not in result.docker_log  # type: ignore[attr-defined]


def test_release_workflow_contract_is_tagged_amd64_and_asset_free() -> None:
    workflow = (ROOT / ".github/workflows/release-images.yml").read_text()
    dockerignore = (ROOT / ".dockerignore").read_text().splitlines()

    assert "tags:" in workflow
    assert "linux/amd64" in workflow
    assert "ghcr.io/jayn2u/gods-eye-service" in workflow
    assert "ghcr.io/jayn2u/gods-eye-web" in workflow
    assert "@sha256:" in workflow
    assert "release-images.env" in workflow
    assert "docker logout ghcr.io" in workflow
    assert {"data", "indexes", ".cache", ".gods-eye"}.issubset(set(dockerignore))
