from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .checkpoint_registry import (
    CheckpointValidationError,
    Registration,
    checkpoint_model_id,
    default_label,
    find_registration,
    validate_labclip_args,
    write_registration,
)
from .clip_models import VERIFIED_ARCHS, OpenClipArch

if TYPE_CHECKING:
    import torch

_WANDB_METADATA_KEYS = (
    "run_id",
    "project",
    "entity",
    "group",
    "pipeline_result_uri",
)
_PROVENANCE_KEYS = ("epoch", "global_step", "best_val_score")


@dataclass(frozen=True, slots=True)
class ImportResult:
    registration: Registration
    directory: Path
    reused: bool


def import_checkpoint(
    source: Path,
    *,
    checkpoint_root: Path,
    label: str | None = None,
    reference_metrics: Path | None = None,
    now: datetime | None = None,
    build_model: Callable[[OpenClipArch], torch.nn.Module] | None = None,
) -> ImportResult:
    source_sha256 = _sha256_file(source)

    try:
        import torch
    except ImportError as exc:
        raise CheckpointValidationError(
            "PyTorch is required to import lab_clip checkpoints."
        ) from exc

    try:
        checkpoint = torch.load(source, map_location="cpu", weights_only=True)
    except Exception as exc:
        raise CheckpointValidationError(
            f"Checkpoint {source} cannot be read without unpickling code."
        ) from exc

    if not isinstance(checkpoint, dict):
        raise CheckpointValidationError("Checkpoint must be a dictionary.")
    state = checkpoint.get("model_state_dict")
    args = checkpoint.get("args")
    if not isinstance(state, Mapping) or not all(
        isinstance(key, str) and isinstance(value, torch.Tensor) for key, value in state.items()
    ):
        raise CheckpointValidationError("model_state_dict must be a mapping of tensor values.")
    if not isinstance(args, Mapping):
        raise CheckpointValidationError("Checkpoint args must be a mapping.")

    arch = validate_labclip_args(args)
    try:
        model = (build_model or _build_openclip)(arch)
    except Exception as exc:
        raise CheckpointValidationError(
            f"Could not build OpenCLIP model {arch.model_name!r}."
        ) from exc
    try:
        model.load_state_dict(state, strict=True)
    except Exception as exc:
        raise CheckpointValidationError(
            f"Checkpoint state dict does not match the OpenCLIP model {arch.model_name!r}."
        ) from exc

    args_copy = _json_safe_copy(args, "args")
    provenance = _json_safe_copy(
        {key: checkpoint[key] for key in _PROVENANCE_KEYS if key in checkpoint},
        "provenance",
    )
    # Keep only training provenance in registration.json; labclip_args.json retains all args.
    del checkpoint, state

    return _stage_registration(
        source,
        checkpoint_root=checkpoint_root,
        source_sha256=source_sha256,
        state_dict=model.state_dict(),
        args_copy=args_copy,
        arch=arch,
        label=label,
        reference_metrics=reference_metrics,
        now=now,
        provenance=provenance,
    )


def load_reference_metrics(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CheckpointValidationError(f"Could not read reference metrics from {path}.") from exc
    if not isinstance(value, dict):
        raise CheckpointValidationError("Reference metrics must be a JSON object.")
    if value.get("dataset") != "cuhk-pedes":
        raise CheckpointValidationError("Reference metrics dataset must be 'cuhk-pedes'.")
    if value.get("split") != "test":
        raise CheckpointValidationError("Reference metrics split must be 'test'.")
    if value.get("direction") != "text-to-image":
        raise CheckpointValidationError("Reference metrics direction must be 'text-to-image'.")
    return value


def _build_openclip(arch: OpenClipArch):
    from .openclip_embedder import build_openclip_model

    return build_openclip_model(arch, device="cpu")


def _stage_registration(
    source: Path,
    *,
    checkpoint_root: Path,
    source_sha256: str,
    state_dict: Mapping[str, object],
    args_copy: dict,
    arch: OpenClipArch,
    label: str | None,
    reference_metrics: Path | None,
    now: datetime | None,
    provenance: dict,
) -> ImportResult:
    created_directories = _create_checkpoint_root(checkpoint_root)
    try:
        with tempfile.TemporaryDirectory(prefix=".checkpoint-import-", dir=checkpoint_root) as name:
            staging_root = Path(name)
            try:
                from safetensors.torch import save_file
            except ImportError as exc:
                raise CheckpointValidationError(
                    "PyTorch and safetensors are required to write checkpoint registrations."
                ) from exc

            staged_state = {
                key: value.detach().to(device="cpu").contiguous().clone()
                for key, value in state_dict.items()
            }
            staged_dir = staging_root / "registration"
            staged_dir.mkdir()
            weights_path = staged_dir / "model.safetensors"
            try:
                save_file(staged_state, str(weights_path))
            except Exception as exc:
                raise CheckpointValidationError("Could not write checkpoint safetensors.") from exc
            del staged_state

            weights_sha256 = _sha256_file(weights_path)
            model_id = checkpoint_model_id(weights_sha256)
            existing = find_registration(checkpoint_root, model_id)
            if existing is not None:
                return _reuse_registration(
                    existing,
                    checkpoint_root=checkpoint_root,
                    label=label,
                )

            wandb_metadata = _read_wandb_metadata(source.with_name("wandb_meta.json"))
            resolved_provenance = dict(provenance)
            if wandb_metadata is not None:
                resolved_provenance["wandb"] = wandb_metadata
            registration = Registration(
                model_id=model_id,
                label=label
                if label is not None
                else default_label(
                    {"source_filename": source.name, "provenance": resolved_provenance}
                ),
                weights_sha256=weights_sha256,
                source_sha256=source_sha256,
                source_filename=source.name,
                arch=arch,
                verified=(arch.model_name, arch.pretrained) in VERIFIED_ARCHS,
                registered_at=_registered_at(now),
                provenance=resolved_provenance,
                reference_metrics=(
                    load_reference_metrics(reference_metrics)
                    if reference_metrics is not None
                    else None
                ),
            )

            staged_dir = staging_root / weights_sha256
            staged_dir.mkdir()
            os.replace(weights_path, staged_dir / "model.safetensors")
            (staged_dir / "labclip_args.json").write_text(
                json.dumps(args_copy, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
                encoding="utf-8",
            )
            write_registration(staging_root, registration)

            destination = checkpoint_root / weights_sha256
            try:
                os.replace(staged_dir, destination)
            except OSError as exc:
                concurrent = find_registration(checkpoint_root, model_id)
                if concurrent is not None:
                    return _reuse_registration(
                        concurrent,
                        checkpoint_root=checkpoint_root,
                        label=label,
                    )
                raise CheckpointValidationError(
                    "Could not publish checkpoint registration."
                ) from exc
            return ImportResult(registration, destination, False)
    except Exception:
        _remove_created_directories(created_directories)
        raise


def _read_wandb_metadata(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise CheckpointValidationError(f"Could not read W&B metadata from {path}.") from exc
    if not isinstance(value, dict):
        raise CheckpointValidationError("wandb_meta.json must contain a JSON object.")
    return {key: value[key] for key in _WANDB_METADATA_KEYS if key in value}


def _reuse_registration(
    existing: tuple[Registration, Path],
    *,
    checkpoint_root: Path,
    label: str | None,
) -> ImportResult:
    registration, directory = existing
    if label is not None:
        registration = replace(registration, label=label)
        write_registration(checkpoint_root, registration)
    return ImportResult(registration, directory, True)


def _json_safe_copy(value: object, name: str) -> dict:
    try:
        normalized = _normalize_json_value(value)
        json.dumps(normalized, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise CheckpointValidationError(f"{name} must contain only JSON-safe values.") from exc
    if not isinstance(normalized, dict):
        raise CheckpointValidationError(f"{name} must be a mapping.")
    return normalized


def _normalize_json_value(value: object) -> object:
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings")
        return {key: _normalize_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_json_value(item) for item in value]
    if value is None or type(value) in {str, bool, int, float}:
        return value
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}")


def _registered_at(now: datetime | None) -> str:
    value = datetime.now(UTC) if now is None else now
    if value.tzinfo is None or value.utcoffset() is None:
        raise CheckpointValidationError("now must be a timezone-aware datetime")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _create_checkpoint_root(root: Path) -> list[Path]:
    missing: list[Path] = []
    current = root
    while not current.exists():
        missing.append(current)
        parent = current.parent
        if parent == current:
            break
        current = parent
    if current.exists() and not current.is_dir():
        raise CheckpointValidationError("checkpoint_root must be a directory.")
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        _remove_created_directories(missing)
        raise CheckpointValidationError("Could not create checkpoint_root.") from exc
    return missing


def _remove_created_directories(directories: list[Path]) -> None:
    for directory in directories:
        try:
            directory.rmdir()
        except OSError:
            pass


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise CheckpointValidationError(f"Could not read checkpoint file {path}.") from exc
    return digest.hexdigest()
