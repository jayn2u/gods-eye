from __future__ import annotations

import json
import os
import shlex
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .clip import DEFAULT_MODEL_ID

OOM_EXIT_CODE = 75


class PreparationError(RuntimeError):
    """A model/index Demo Preparation stage could not be completed."""

    def __init__(self, message: str, *, out_of_memory: bool = False):
        super().__init__(message)
        self.out_of_memory = out_of_memory


@dataclass(frozen=True)
class PreparationPaths:
    root: Path

    @property
    def model_cache(self) -> Path:
        return self.root / ".cache" / "huggingface"

    @property
    def manifest(self) -> Path:
        return self.root / "indexes" / "gallery-manifest.json"

    @property
    def versions(self) -> Path:
        return self.root / "indexes" / "versions"

    @property
    def checkpoint(self) -> Path:
        return self.root / "indexes" / ".checkpoints" / "clip-vit-b-16"

    @property
    def active(self) -> Path:
        return self.root / "indexes" / "active"


class PreparationRunner:
    def __init__(self, command: str | None = None):
        if command:
            self.command = shlex.split(command)
        else:
            host_root = os.getenv("GODS_EYE_HOST_PROJECT_ROOT")
            if host_root:
                image = os.getenv("GODS_EYE_LAUNCHER_IMAGE", "gods-eye-launcher:local")
                self.command = [
                    "docker",
                    "run",
                    "--rm",
                    "--gpus",
                    "all",
                    "--pull",
                    "never",
                    "--entrypoint",
                    "python",
                    "--volume",
                    f"{host_root}:/workspace",
                    "--workdir",
                    "/workspace",
                    image,
                    "-m",
                    "gods_eye.preparation_worker",
                ]
            else:
                self.command = ["python", "-m", "gods_eye.preparation_worker"]

    def run(self, operation: str, *arguments: str) -> str:
        result = subprocess.run(
            [*self.command, operation, *arguments], text=True, capture_output=True, check=False
        )
        if result.returncode != 0:
            message = result.stderr.strip() or result.stdout.strip() or f"{operation} failed"
            raise PreparationError(message, out_of_memory=result.returncode == OOM_EXIT_CODE)
        return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""


def select_batch_size(vram_mib: int, override: int | None = None) -> int:
    if override is not None:
        if override < 1:
            raise PreparationError("--batch-size must be greater than zero")
        return override
    if vram_mib >= 24 * 1024:
        return 128
    if vram_mib >= 16 * 1024:
        return 64
    if vram_mib >= 12 * 1024:
        return 48
    return 32


def _save_state(path: Path, state: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    os.replace(temporary, path)


def _arguments(
    paths: PreparationPaths, model_id: str, revision: str | None
) -> dict[str, list[str]]:
    revision_args = ["--revision", revision] if revision else []
    return {
        "model": ["--model-id", model_id, "--cache-dir", str(paths.model_cache), *revision_args],
        "manifest": ["--data-root", str(paths.root / "data"), "--output", str(paths.manifest)],
        "index": [
            "--manifest",
            str(paths.manifest),
            "--versions-dir",
            str(paths.versions),
            "--model-id",
            model_id,
            "--cache-dir",
            str(paths.model_cache),
            *revision_args,
        ],
    }


def prepare_model_index(
    root: Path,
    state_path: Path,
    *,
    vram_mib: int,
    batch_override: int | None = None,
    runner: PreparationRunner | None = None,
    model_id: str = DEFAULT_MODEL_ID,
    model_revision: str | None = None,
) -> None:
    adapter = runner or PreparationRunner(os.getenv("GODS_EYE_PREPARATION_RUNNER"))
    paths = PreparationPaths(root)
    state = json.loads(state_path.read_text())
    preparation = state.setdefault("preparation", {})
    args = _arguments(paths, model_id, model_revision)
    now = lambda: datetime.now(UTC).isoformat()

    print("Step 4/7 - CLIP ViT-B/16 model")
    model_state = preparation.get("model", {})
    compatible_model = (
        model_state.get("model_id") == model_id and model_state.get("revision") == model_revision
    )
    if compatible_model:
        try:
            adapter.run("verify-model", *args["model"])
            print("  reused (verified)")
        except PreparationError:
            compatible_model = False
    if not compatible_model:
        adapter.run("prepare-model", *args["model"])
        preparation["model"] = {
            "status": "verified",
            "model_id": model_id,
            "revision": model_revision,
            "completed_at": now(),
        }
        _save_state(state_path, state)

    print("Step 5/7 - Gallery Manifest")
    manifest_state = preparation.get("gallery_manifest", {})
    manifest_compatible = manifest_state.get("path") == str(paths.manifest)
    if manifest_compatible:
        try:
            adapter.run("verify-manifest", str(paths.manifest))
            print("  reused (verified)")
        except PreparationError:
            manifest_compatible = False
    if not manifest_compatible:
        adapter.run("build-manifest", *args["manifest"])
        adapter.run("verify-manifest", str(paths.manifest))
        preparation["gallery_manifest"] = {
            "status": "verified",
            "schema_version": 1,
            "path": str(paths.manifest),
            "completed_at": now(),
        }
        _save_state(state_path, state)

    print("Step 6/7 - GPU index build, validation, and activation")
    index_state = preparation.get("index", {})
    index_compatible = (
        index_state.get("model_id") == model_id
        and index_state.get("model_revision") == model_revision
        and index_state.get("gallery_manifest_completed_at")
        == preparation["gallery_manifest"]["completed_at"]
        and index_state.get("status") == "active"
    )
    if index_compatible:
        try:
            adapter.run(
                "verify-index",
                str(paths.active),
                "--model-id",
                model_id,
                *(["--revision", model_revision] if model_revision else []),
            )
            print("  reused (verified)")
            return
        except PreparationError:
            index_compatible = False

    batch_size = select_batch_size(vram_mib, batch_override)
    paths.checkpoint.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            version = adapter.run(
                "build-index",
                *args["index"],
                "--batch-size",
                str(batch_size),
                "--checkpoint-dir",
                str(paths.checkpoint),
            )
            break
        except PreparationError as exc:
            if not exc.out_of_memory or batch_size == 1:
                raise
            batch_size = max(1, batch_size // 2)
            print(f"  GPU memory exhausted; retrying index stage with batch size {batch_size}")
    adapter.run(
        "validate-index",
        version,
        "--model-id",
        model_id,
        *(["--revision", model_revision] if model_revision else []),
    )
    adapter.run(
        "activate-index", version, "--active-pointer", str(paths.active), "--model-id", model_id
    )
    preparation["index"] = {
        "status": "active",
        "model_id": model_id,
        "model_revision": model_revision,
        "version_path": version,
        "batch_size": batch_size,
        "gallery_manifest_completed_at": preparation["gallery_manifest"]["completed_at"],
        "completed_at": now(),
    }
    _save_state(state_path, state)
