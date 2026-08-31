"""Shared Launcher process primitives; domain behavior belongs in sibling modules."""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

EXIT_OK = 0
EXIT_PREPARATION = 1
EXIT_PREREQUISITE = 2
EXIT_CONFIRMATION = 3
EXIT_TERMS_REQUIRED = 3
EXIT_PREPARATION_FAILED = 4
EXIT_USAGE = 64
EXIT_BUSY = 75
STATE_SCHEMA_VERSION = 1
PREPARED_STAGES = {
    "dataset_acquisition": "verified",
    "model": "verified",
    "gallery_manifest": "verified",
    "index": "active",
    "smoke_test": "verified",
}


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def run(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, check=False)


def current_compatibility() -> dict[str, str]:
    registry = json.loads(Path(__file__).with_name("dataset_registry.json").read_text())
    return {
        "application": os.getenv("GODS_EYE_TARGET_APPLICATION_VERSION", "0.1.0"),
        "registry": os.getenv("GODS_EYE_TARGET_REGISTRY_VERSION", str(registry["schema_version"])),
        "model": os.getenv("GODS_EYE_TARGET_MODEL", "openai/clip-vit-base-patch16"),
        "manifest_schema": os.getenv("GODS_EYE_TARGET_MANIFEST_SCHEMA", "1"),
        "index_schema": os.getenv("GODS_EYE_TARGET_INDEX_SCHEMA", "1"),
    }


@dataclass(frozen=True)
class RuntimeLayout:
    root: Path

    @property
    def runtime_dir(self) -> Path:
        return self.root / ".gods-eye"

    @property
    def logs_dir(self) -> Path:
        return self.runtime_dir / "logs"

    @property
    def state_path(self) -> Path:
        return self.runtime_dir / "state.json"

    @property
    def lock_path(self) -> Path:
        return self.runtime_dir / "lock"

    def initialize(self) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        if not self.state_path.exists():
            self.state_path.write_text(
                json.dumps(
                    {
                        "schema_version": STATE_SCHEMA_VERSION,
                        "terms_acceptance": None,
                        "preparation": {},
                        "compatibility": current_compatibility(),
                    },
                    indent=2,
                )
                + "\n"
            )

    def read_state(self) -> dict:
        self.initialize()
        return json.loads(self.state_path.read_text())

    def write_state(self, state: dict) -> None:
        temporary = self.state_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
        temporary.replace(self.state_path)
