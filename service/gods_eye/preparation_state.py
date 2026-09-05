"""Schema normalization and per-model access for Demo Preparation state."""

from __future__ import annotations

from copy import deepcopy
from typing import Final, TypeAlias

from .clip_models import DEFAULT_MODEL_ID, get_clip_model

STATE_SCHEMA_VERSION: Final = 2
MODEL_STAGES: Final = ("model", "index", "smoke_test")
JsonValue: TypeAlias = (
    None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
)
StateDictionary: TypeAlias = dict[str, JsonValue]


def normalize_preparation_state(state: dict) -> StateDictionary:
    """Return schema-2 state while preserving schema-1 B/16 aliases."""
    normalized = deepcopy(state)
    normalized["schema_version"] = STATE_SCHEMA_VERSION
    preparation = normalized.setdefault("preparation", {})
    models = preparation.setdefault("models", {})
    if DEFAULT_MODEL_ID not in models:
        legacy = {
            stage: _normalize_legacy_stage(stage, preparation[stage])
            for stage in MODEL_STAGES
            if stage in preparation
        }
        if legacy:
            models[DEFAULT_MODEL_ID] = legacy
    return normalized


def model_preparation(preparation: dict, model_id: str) -> StateDictionary:
    """Return one supported model's canonical preparation record, if present."""
    get_clip_model(model_id)
    models = preparation.get("models", {})
    record = models.get(model_id, {})
    return record if isinstance(record, dict) else {}


def ensure_model_preparation(preparation: dict, model_id: str) -> StateDictionary:
    """Return a mutable canonical record for one supported model."""
    get_clip_model(model_id)
    models = preparation.setdefault("models", {})
    return models.setdefault(model_id, {})


def set_model_stage(preparation: dict, model_id: str, stage: str, value: dict) -> None:
    """Store a canonical stage and maintain the B/16 rollback alias."""
    if stage not in MODEL_STAGES:
        raise KeyError(stage)
    ensure_model_preparation(preparation, model_id)[stage] = value
    if model_id == DEFAULT_MODEL_ID:
        preparation[stage] = deepcopy(value)


def _normalize_legacy_stage(stage: str, value: dict) -> StateDictionary:
    normalized = deepcopy(value)
    revision_key = "revision" if stage == "model" else "model_revision"
    revision = normalized.get(revision_key)
    if stage == "model":
        normalized.setdefault("resolved_revision", revision)
    if revision is None:
        normalized["legacy_revision_unresolved"] = True
    return normalized
