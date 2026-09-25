from __future__ import annotations

import json
from pathlib import Path

import pytest
from gods_eye.checkpoint_registry import (
    REGISTRATION_SCHEMA_VERSION,
    CheckpointValidationError,
    Registration,
    checkpoint_model_id,
    default_label,
    find_registration,
    read_registrations,
    remove_registration,
    validate_labclip_args,
    write_registration,
)
from gods_eye.clip_models import CLIP_MODELS, ModelRegistry, UnsupportedClipModelError

VALID = {
    "dataset": "cuhk-pedes",
    "train_split": "train",
    "val_split": "val",
    "eval_split": "val",
    "model_name": "ViT-B-16",
    "pretrained": "openai",
    "img_height": 384,
    "img_width": 128,
    "preprocess_mode": "reid",
}


def _registration(
    weights_sha256: str,
    registered_at: str,
    *,
    source_filename: str = "run/checkpoint_best.pth",
    best_val_score: float | None = 0.78,
    run_id: str | None = None,
) -> Registration:
    provenance = {
        "epoch": 12,
        "global_step": 1200,
        "best_val_score": best_val_score,
        "ema_enabled": True,
        "train_split": "train",
        "val_split": "val",
        "eval_split": "val",
        "wandb": {"run_id": run_id} if run_id is not None else None,
    }
    label_fields = {"source_filename": source_filename, "provenance": provenance}
    return Registration(
        model_id=checkpoint_model_id(weights_sha256),
        label=default_label(label_fields),
        weights_sha256=weights_sha256,
        source_sha256="cd" * 32,
        source_filename=source_filename,
        arch=validate_labclip_args(VALID),
        verified=True,
        registered_at=registered_at,
        provenance=provenance,
        reference_metrics=None,
    )


def test_valid_args_produce_arch() -> None:
    arch = validate_labclip_args(VALID)
    assert arch.baseline_model_id == "openclip/ViT-B-16@openai:384x128-reid"


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("dataset", "icfg-pedes", "cuhk-pedes"),
        ("train_split", "trainval", "train split"),
        ("val_split", "test", "selected on the test split"),
        ("eval_split", "test", "selected on the test split"),
        ("preprocess_mode", "model", "preprocess_mode"),
        ("img_height", 0, "image size"),
    ],
)
def test_invalid_args_are_rejected(key: str, value: object, message: str) -> None:
    with pytest.raises(CheckpointValidationError, match=message):
        validate_labclip_args({**VALID, key: value})


def test_missing_split_metadata_is_rejected() -> None:
    args = dict(VALID)
    del args["train_split"]

    with pytest.raises(CheckpointValidationError, match="train_split"):
        validate_labclip_args(args)


def test_unknown_pretrained_pair_is_rejected() -> None:
    with pytest.raises(CheckpointValidationError, match="no pinned pretrained source"):
        validate_labclip_args({**VALID, "model_name": "ViT-L-14"})


def test_checkpoint_model_id_uses_weights_digest_prefix() -> None:
    assert checkpoint_model_id("ab" * 32) == "labclip:cuhk-pedes:abababababab"


def test_default_label_uses_wandb_run_and_validation_score() -> None:
    fields = {
        "source_filename": "runs/checkpoint_best.pth",
        "provenance": {"best_val_score": 0.78, "wandb": {"run_id": "r7abc"}},
    }

    assert default_label(fields) == "FT · r7abc · val R@1 78.0"


def test_default_label_falls_back_to_file_stem_and_omits_missing_score() -> None:
    fields = {"source_filename": "runs/epoch-12.pth", "provenance": {"wandb": None}}

    assert default_label(fields) == "FT · epoch-12"


def test_registration_round_trips_and_can_be_found_and_removed(tmp_path: Path) -> None:
    registration = _registration("ab" * 32, "2026-09-25T07:00:00Z")

    path = write_registration(tmp_path, registration)

    assert path == tmp_path / registration.weights_sha256 / "registration.json"
    stored = json.loads(path.read_text())
    assert stored["schema_version"] == REGISTRATION_SCHEMA_VERSION
    records = read_registrations(tmp_path)
    assert records == ((registration, path.parent),)
    assert find_registration(tmp_path, registration.model_id) == (registration, path.parent)
    assert remove_registration(tmp_path, registration.model_id) == registration
    assert not path.parent.exists()
    assert read_registrations(tmp_path) == ()


def test_unreadable_registration_directories_are_skipped(tmp_path: Path) -> None:
    broken = tmp_path / ("ef" * 32)
    broken.mkdir(parents=True)
    (broken / "registration.json").write_text("not json")

    assert read_registrations(tmp_path) == ()


def test_model_registry_orders_builtins_baseline_and_checkpoints(tmp_path: Path) -> None:
    older = _registration("ab" * 32, "2026-09-24T07:00:00Z")
    newer = _registration("cd" * 32, "2026-09-25T07:00:00Z", run_id="r-new")
    write_registration(tmp_path, older)
    write_registration(tmp_path, newer)

    models = ModelRegistry(tmp_path).all()
    ids = [spec.model_id for spec in models]

    assert ids[:4] == [spec.model_id for spec in CLIP_MODELS]
    assert ids[4] == "openclip/ViT-B-16@openai:384x128-reid"
    assert ids[5:] == [newer.model_id, older.model_id]
    assert [spec.group for spec in models[4:]] == ["baseline", "fine-tuned", "fine-tuned"]
    assert [spec.registered_at for spec in models[5:]] == [
        "2026-09-25T07:00:00Z",
        "2026-09-24T07:00:00Z",
    ]


def test_model_registry_gets_registered_checkpoint_and_pairs_baseline(tmp_path: Path) -> None:
    registration = _registration("ab" * 32, "2026-09-25T07:00:00Z")
    directory = write_registration(tmp_path, registration).parent

    checkpoint = ModelRegistry(tmp_path).get(registration.model_id)

    assert checkpoint.checkpoint_dir == directory
    assert checkpoint.backend == "openclip"
    assert checkpoint.group == "fine-tuned"
    assert checkpoint.storage_key == "labclip-abababababab"
    assert checkpoint.paired_baseline_id == registration.paired_baseline_id


def test_unregistered_checkpoint_id_is_unsupported(tmp_path: Path) -> None:
    with pytest.raises(UnsupportedClipModelError):
        ModelRegistry(tmp_path).get("labclip:cuhk-pedes:012345abcdef")
