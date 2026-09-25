"""Small, network-free preparation adapter used only by the Compose smoke profile."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from .clip_models import ModelRegistry, checkpoint_root_for
from .models import SUPPORTED_DATASETS
from .preparation import PreparationPaths
from .preparation_state import normalize_preparation_state, set_model_stage


def prepare_fixture(root: Path, state_path: Path, *, model_ids: list[str]) -> None:
    now = datetime.now(UTC).isoformat()
    for name in SUPPORTED_DATASETS:
        installation = root / "data" / "datasets" / name
        installation.mkdir(parents=True, exist_ok=True)
        receipt = root / "data" / "install-state" / f"{name}.json"
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps({"dataset": name, "fixture": True}) + "\n")
    model_cache = root / ".cache" / "huggingface"
    model_cache.mkdir(parents=True, exist_ok=True)
    registry = ModelRegistry(checkpoint_root_for(model_cache))
    manifest = root / "indexes" / "gallery-manifest.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps({"schema_version": 1, "fixture": True}) + "\n")
    state = normalize_preparation_state(json.loads(state_path.read_text()))
    preparation = state.setdefault("preparation", {})
    preparation["dataset_acquisition"] = {"status": "verified", "fixture": True}
    preparation["gallery_manifest"] = {"status": "verified", "fixture": True}
    paths = PreparationPaths(root)
    for model_id in model_ids:
        spec = registry.get(model_id)
        revision = f"fixture-{spec.storage_key}"
        (model_cache / f"{spec.storage_key}.ready").write_text("fixture\n")
        model_paths = paths.for_model(model_id)
        active = model_paths.active
        active.mkdir(parents=True, exist_ok=True)
        (active / "fixture.ready").write_text("fixture\n")
        set_model_stage(
            preparation,
            model_id,
            "model",
            {
                "status": "verified",
                "fixture": True,
                "model_id": model_id,
                "resolved_revision": revision,
            },
        )
        set_model_stage(
            preparation,
            model_id,
            "index",
            {
                "status": "active",
                "fixture": True,
                "model_id": model_id,
                "model_revision": revision,
            },
        )
        set_model_stage(
            preparation,
            model_id,
            "evaluation",
            {
                "status": "verified",
                "fixture": True,
                "model_id": model_id,
                "model_revision": revision,
                "index_version": "fixture",
                "completed_at": now,
            },
        )
        set_model_stage(
            preparation,
            model_id,
            "smoke_test",
            {
                "status": "verified",
                "fixture": True,
                "model_id": model_id,
                "model_revision": revision,
                "completed_at": now,
            },
        )
    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    temporary.replace(state_path)
    labels = ", ".join(registry.get(model_id).label for model_id in model_ids)
    print(f"Fixture-backed synthetic Demo Preparation completed for {labels}.")
