"""Small, network-free preparation adapter used only by the Compose smoke profile."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path


def prepare_fixture(root: Path, state_path: Path) -> None:
    now = datetime.now(UTC).isoformat()
    for name in ("CUHK-PEDES", "ICFG-PEDES", "RSTPReid"):
        installation = root / "data" / "datasets" / name
        installation.mkdir(parents=True, exist_ok=True)
        receipt = root / "data" / "install-state" / f"{name}.json"
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps({"dataset": name, "fixture": True}) + "\n")
    model = root / ".cache" / "huggingface" / "fixture-model.ready"
    model.parent.mkdir(parents=True, exist_ok=True)
    model.write_text("fixture\n")
    manifest = root / "indexes" / "gallery-manifest.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps({"schema_version": 1, "fixture": True}) + "\n")
    active = root / "indexes" / "active"
    active.mkdir(parents=True, exist_ok=True)
    (active / "fixture.ready").write_text("fixture\n")
    state = json.loads(state_path.read_text())
    state["preparation"] = {
        "dataset_acquisition": {"status": "verified", "fixture": True},
        "model": {"status": "verified", "fixture": True},
        "gallery_manifest": {"status": "verified", "fixture": True},
        "index": {"status": "active", "fixture": True},
        "smoke_test": {"status": "verified", "fixture": True, "completed_at": now},
    }
    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    temporary.replace(state_path)
    print("Fixture-backed Demo Preparation completed (stages 1-7 verified).")
