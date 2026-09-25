from __future__ import annotations

import json
import math
import os
import re
import shutil
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from .clip_models import (
    PRETRAINED_SOURCES,
    ClipModelSpec,
    OpenClipArch,
)

REGISTRATION_SCHEMA_VERSION = 1
_REGISTRATION_FILENAME = "registration.json"
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
_REQUIRED_LABCLIP_ARGS = (
    "dataset",
    "train_split",
    "val_split",
    "eval_split",
    "model_name",
    "pretrained",
    "img_height",
    "img_width",
    "preprocess_mode",
)


class CheckpointValidationError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Registration:
    model_id: str
    label: str
    weights_sha256: str
    source_sha256: str
    source_filename: str
    arch: OpenClipArch
    verified: bool
    registered_at: str
    provenance: dict
    reference_metrics: dict | None

    def __post_init__(self) -> None:
        if not isinstance(self.weights_sha256, str):
            raise CheckpointValidationError("weights_sha256 must be a lowercase SHA-256 digest")
        if _SHA256_PATTERN.fullmatch(self.weights_sha256) is None:
            raise CheckpointValidationError("weights_sha256 must be a lowercase SHA-256 digest")
        if not isinstance(self.source_sha256, str):
            raise CheckpointValidationError("source_sha256 must be a lowercase SHA-256 digest")
        if _SHA256_PATTERN.fullmatch(self.source_sha256) is None:
            raise CheckpointValidationError("source_sha256 must be a lowercase SHA-256 digest")
        if self.model_id != checkpoint_model_id(self.weights_sha256):
            raise CheckpointValidationError("model_id must match the weights SHA-256 digest")
        if not isinstance(self.label, str) or not self.label:
            raise CheckpointValidationError("label and source_filename must not be empty")
        if not isinstance(self.source_filename, str) or not self.source_filename:
            raise CheckpointValidationError("label and source_filename must not be empty")
        if not isinstance(self.arch, OpenClipArch):
            raise CheckpointValidationError("arch must be an OpenClipArch")
        if not isinstance(self.verified, bool):
            raise CheckpointValidationError("verified must be a boolean")
        _validate_registered_at(self.registered_at)
        if not isinstance(self.provenance, dict):
            raise CheckpointValidationError("provenance must be a dictionary")
        if self.reference_metrics is not None and not isinstance(self.reference_metrics, dict):
            raise CheckpointValidationError("reference_metrics must be a dictionary or null")

    @property
    def paired_baseline_id(self) -> str:
        return self.arch.baseline_model_id

    def to_spec(self, checkpoint_dir: Path) -> ClipModelSpec:
        return ClipModelSpec(
            model_id=self.model_id,
            label=self.label,
            storage_key=f"labclip-{self.weights_sha256[:12]}",
            backend="openclip",
            group="fine-tuned",
            arch=self.arch,
            paired_baseline_id=self.paired_baseline_id,
            checkpoint_dir=checkpoint_dir,
            verified=self.verified,
            registered_at=self.registered_at,
        )


def validate_labclip_args(args: Mapping[str, object]) -> OpenClipArch:
    missing = [key for key in _REQUIRED_LABCLIP_ARGS if key not in args]
    if missing:
        raise CheckpointValidationError(f"Missing required lab_clip argument: {missing[0]}")

    if args["dataset"] != "cuhk-pedes":
        raise CheckpointValidationError("dataset must be 'cuhk-pedes'")
    if args["train_split"] != "train":
        raise CheckpointValidationError("The train split must be 'train'")
    if not isinstance(args["val_split"], str) or not isinstance(args["eval_split"], str):
        raise CheckpointValidationError("Validation and evaluation split metadata must be strings")
    if args["val_split"] == "test" or args["eval_split"] == "test":
        raise CheckpointValidationError("Validation and evaluation cannot be selected on the test split")

    model_name = args["model_name"]
    pretrained = args["pretrained"]
    if not isinstance(model_name, str) or not isinstance(pretrained, str):
        raise CheckpointValidationError("model_name and pretrained must be strings")
    if (model_name, pretrained) not in PRETRAINED_SOURCES:
        raise CheckpointValidationError(
            f"There is no pinned pretrained source for {model_name!r}/{pretrained!r}"
        )

    preprocess_mode = args["preprocess_mode"]
    if not isinstance(preprocess_mode, str) or preprocess_mode not in {"reid", "model_reid"}:
        raise CheckpointValidationError("Unsupported preprocess_mode")

    height = args["img_height"]
    width = args["img_width"]
    if (
        not isinstance(height, int)
        or isinstance(height, bool)
        or not isinstance(width, int)
        or isinstance(width, bool)
        or height < 1
        or width < 1
    ):
        raise CheckpointValidationError("image size must use positive integer img_height and img_width")

    return OpenClipArch(model_name, pretrained, height, width, preprocess_mode)  # type: ignore[arg-type]


def checkpoint_model_id(weights_sha256: str) -> str:
    if _SHA256_PATTERN.fullmatch(weights_sha256) is None:
        raise CheckpointValidationError("weights_sha256 must be a lowercase SHA-256 digest")
    return f"labclip:cuhk-pedes:{weights_sha256[:12]}"


def default_label(registration_fields: Mapping[str, object]) -> str:
    provenance = registration_fields.get("provenance", registration_fields)
    if not isinstance(provenance, Mapping):
        provenance = {}

    wandb = provenance.get("wandb", registration_fields.get("wandb"))
    run_id = wandb.get("run_id") if isinstance(wandb, Mapping) else None
    source_filename = registration_fields.get("source_filename", "checkpoint")
    identity = str(run_id) if run_id is not None and str(run_id) else Path(str(source_filename)).stem
    label = f"FT · {identity}"

    score = provenance.get("best_val_score", registration_fields.get("best_val_score"))
    if isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score):
        label += f" · val R@1 {score * 100:.1f}"
    return label


def write_registration(root: Path, registration: Registration) -> Path:
    checkpoint_dir = root / registration.weights_sha256
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    destination = checkpoint_dir / _REGISTRATION_FILENAME
    temporary_path: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".registration-", suffix=".tmp", dir=checkpoint_dir
        )
        temporary_path = Path(temporary_name)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(
                _registration_to_dict(registration),
                stream,
                indent=2,
                ensure_ascii=False,
                allow_nan=False,
            )
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, destination)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return destination


def read_registrations(root: Path) -> tuple[tuple[Registration, Path], ...]:
    try:
        entries = sorted(root.iterdir(), key=lambda path: path.name)
    except OSError:
        return ()

    registrations: list[tuple[Registration, Path]] = []
    for checkpoint_dir in entries:
        if (
            not checkpoint_dir.is_dir()
            or checkpoint_dir.is_symlink()
            or _SHA256_PATTERN.fullmatch(checkpoint_dir.name) is None
        ):
            continue
        try:
            raw = json.loads((checkpoint_dir / _REGISTRATION_FILENAME).read_text(encoding="utf-8"))
            registration = _registration_from_dict(raw)
            if registration.weights_sha256 != checkpoint_dir.name:
                continue
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            continue
        registrations.append((registration, checkpoint_dir))
    return tuple(registrations)


def find_registration(root: Path, model_id: str) -> tuple[Registration, Path] | None:
    return next(
        (item for item in read_registrations(root) if item[0].model_id == model_id),
        None,
    )


def remove_registration(root: Path, model_id: str) -> Registration:
    found = find_registration(root, model_id)
    if found is None:
        raise CheckpointValidationError(f"No checkpoint registration found for {model_id!r}")
    registration, checkpoint_dir = found
    shutil.rmtree(checkpoint_dir)
    return registration


def _registration_to_dict(registration: Registration) -> dict[str, object]:
    arch = registration.arch
    return {
        "schema_version": REGISTRATION_SCHEMA_VERSION,
        "model_id": registration.model_id,
        "label": registration.label,
        "weights_sha256": registration.weights_sha256,
        "source_sha256": registration.source_sha256,
        "source_filename": registration.source_filename,
        "arch": {
            "model_name": arch.model_name,
            "pretrained": arch.pretrained,
            "img_height": arch.img_height,
            "img_width": arch.img_width,
            "preprocess_mode": arch.preprocess_mode,
        },
        "verified": registration.verified,
        "registered_at": registration.registered_at,
        "provenance": registration.provenance,
        "reference_metrics": registration.reference_metrics,
    }


def _registration_from_dict(raw: object) -> Registration:
    if (
        not isinstance(raw, dict)
        or type(raw.get("schema_version")) is not int
        or raw.get("schema_version") != REGISTRATION_SCHEMA_VERSION
    ):
        raise CheckpointValidationError("Unsupported checkpoint registration schema")
    arch_fields = raw["arch"]
    if not isinstance(arch_fields, dict):
        raise CheckpointValidationError("arch must be an object")
    arch = OpenClipArch(
        model_name=arch_fields["model_name"],
        pretrained=arch_fields["pretrained"],
        img_height=arch_fields["img_height"],
        img_width=arch_fields["img_width"],
        preprocess_mode=arch_fields["preprocess_mode"],
    )
    return Registration(
        model_id=raw["model_id"],
        label=raw["label"],
        weights_sha256=raw["weights_sha256"],
        source_sha256=raw["source_sha256"],
        source_filename=raw["source_filename"],
        arch=arch,
        verified=raw["verified"],
        registered_at=raw["registered_at"],
        provenance=raw["provenance"],
        reference_metrics=raw["reference_metrics"],
    )


def _validate_registered_at(registered_at: str) -> None:
    try:
        timestamp = datetime.fromisoformat(registered_at)
    except (AttributeError, ValueError) as exc:
        raise CheckpointValidationError("registered_at must be an ISO-8601 UTC timestamp") from exc
    if timestamp.tzinfo is None or timestamp.utcoffset() != timedelta(0):
        raise CheckpointValidationError("registered_at must be an ISO-8601 UTC timestamp")
