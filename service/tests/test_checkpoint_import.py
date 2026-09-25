from __future__ import annotations

import hashlib
import json
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType

import pytest
from gods_eye import checkpoint_import
from gods_eye.checkpoint_import import _build_openclip, import_checkpoint, load_reference_metrics
from gods_eye.checkpoint_registry import CheckpointValidationError, validate_labclip_args

torch = pytest.importorskip("torch")
safetensors_torch = pytest.importorskip("safetensors.torch")

VALID_ARGS = {
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
REFERENCE_METRICS = {
    "dataset": "cuhk-pedes",
    "split": "test",
    "direction": "text-to-image",
    "queries": 6156,
    "gallery": 3074,
    "metrics": {"top1": 0.6, "top5": 0.8, "top10": 0.9, "mAP": 0.4, "mINP": 0.3},
}


def _build_model(arch):
    return torch.nn.Linear(2, 2)


def _save_checkpoint(
    path: Path,
    *,
    model: object | None = None,
    args: dict[str, object] | None = None,
) -> None:
    module = model or torch.nn.Linear(2, 2)
    torch.save(
        {
            "model_state_dict": module.state_dict(),
            "args": args or VALID_ARGS,
            "epoch": 9,
            "global_step": 302,
            "best_val_score": 0.78,
        },
        path,
    )


def _assert_no_files(root: Path) -> None:
    assert not root.exists() or list(root.iterdir()) == []


def test_import_writes_weights_args_and_registration(tmp_path: Path) -> None:
    source = tmp_path / "best_t2i_eval_compat.pt"
    _save_checkpoint(source)
    metrics_path = tmp_path / "reference.json"
    metrics_path.write_text(json.dumps(REFERENCE_METRICS), encoding="utf-8")
    checkpoint_root = tmp_path / "registrations"

    result = import_checkpoint(
        source,
        checkpoint_root=checkpoint_root,
        reference_metrics=metrics_path,
        now=datetime(2026, 9, 25, 7, 0, tzinfo=UTC),
        build_model=_build_model,
    )

    registration = result.registration
    assert result.reused is False
    assert result.directory == checkpoint_root / registration.weights_sha256
    assert {path.name for path in result.directory.iterdir()} == {
        "model.safetensors",
        "labclip_args.json",
        "registration.json",
    }
    assert registration.model_id == f"labclip:cuhk-pedes:{registration.weights_sha256[:12]}"
    assert registration.source_sha256 == hashlib.sha256(source.read_bytes()).hexdigest()
    assert registration.source_filename == source.name
    assert registration.arch.baseline_model_id == "openclip/ViT-B-16@openai:384x128-reid"
    assert registration.paired_baseline_id == registration.arch.baseline_model_id
    assert registration.verified is True
    assert registration.registered_at == "2026-09-25T07:00:00Z"
    assert registration.provenance["epoch"] == 9
    assert registration.provenance["global_step"] == 302
    assert registration.provenance["best_val_score"] == 0.78
    assert registration.reference_metrics == REFERENCE_METRICS
    assert registration.label == "FT · best_t2i_eval_compat · val R@1 78.0"
    assert json.loads((result.directory / "labclip_args.json").read_text()) == VALID_ARGS
    assert json.loads((result.directory / "registration.json").read_text())["model_id"] == (
        registration.model_id
    )
    saved_state = safetensors_torch.load_file(str(result.directory / "model.safetensors"))
    checkpoint_state = torch.load(source, map_location="cpu", weights_only=True)["model_state_dict"]
    assert saved_state.keys() == checkpoint_state.keys()
    assert all(torch.equal(saved_state[key], checkpoint_state[key]) for key in saved_state)


def test_reimport_is_idempotent_and_new_label_preserves_registered_at(tmp_path: Path) -> None:
    source = tmp_path / "checkpoint.pt"
    _save_checkpoint(source)
    checkpoint_root = tmp_path / "registrations"
    first = import_checkpoint(source, checkpoint_root=checkpoint_root, build_model=_build_model)

    reused = import_checkpoint(source, checkpoint_root=checkpoint_root, build_model=_build_model)
    renamed = import_checkpoint(
        source,
        checkpoint_root=checkpoint_root,
        label="Reviewed checkpoint",
        build_model=_build_model,
    )

    assert reused.reused is True
    assert reused.registration == first.registration
    assert reused.directory == first.directory
    assert renamed.reused is True
    assert renamed.registration.label == "Reviewed checkpoint"
    assert renamed.registration.registered_at == first.registration.registered_at
    stored = json.loads((first.directory / "registration.json").read_text())
    assert stored["label"] == "Reviewed checkpoint"
    assert stored["registered_at"] == first.registration.registered_at


def test_import_captures_sibling_wandb_metadata(tmp_path: Path) -> None:
    source = tmp_path / "best.pt"
    _save_checkpoint(source)
    wandb = {
        "run_id": "r7abc",
        "project": "lab-clip",
        "entity": "research",
        "group": "cuhk-pedes",
        "pipeline_result_uri": "wandb://run/summary",
        "ignored": "value",
    }
    source.with_name("wandb_meta.json").write_text(json.dumps(wandb), encoding="utf-8")

    result = import_checkpoint(
        source,
        checkpoint_root=tmp_path / "registrations",
        build_model=_build_model,
    )

    assert result.registration.provenance["wandb"] == {
        key: wandb[key] for key in ("run_id", "project", "entity", "group", "pipeline_result_uri")
    }
    assert result.registration.label == "FT · r7abc · val R@1 78.0"


def test_registration_verified_flag_uses_shared_arch_gate(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(checkpoint_import, "VERIFIED_ARCHS", frozenset())
    source = tmp_path / "checkpoint.pt"
    _save_checkpoint(source)

    result = import_checkpoint(
        source,
        checkpoint_root=tmp_path / "registrations",
        build_model=_build_model,
    )

    assert result.registration.verified is False


def test_default_builder_delegates_to_cpu_openclip_builder(monkeypatch) -> None:
    arch = validate_labclip_args(VALID_ARGS)
    calls = []
    model = torch.nn.Linear(2, 2)

    def build(actual_arch, *, device):
        calls.append((actual_arch, device))
        return model

    embedder_module = ModuleType("gods_eye.openclip_embedder")
    embedder_module.build_openclip_model = build
    monkeypatch.setitem(sys.modules, "gods_eye.openclip_embedder", embedder_module)

    assert _build_openclip(arch) is model
    assert calls == [(arch, "cpu")]


def test_concurrent_publish_reuses_registration_published_first(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "checkpoint.pt"
    _save_checkpoint(source)
    checkpoint_root = tmp_path / "registrations"
    published = import_checkpoint(source, checkpoint_root=checkpoint_root, build_model=_build_model)
    concurrent_copy = tmp_path / "concurrent-copy"
    shutil.copytree(published.directory, concurrent_copy)
    shutil.rmtree(published.directory)

    real_replace = checkpoint_import.os.replace
    simulated_race = False

    def publish_concurrently(source_path, destination_path):
        nonlocal simulated_race
        if Path(destination_path) == published.directory and not simulated_race:
            shutil.copytree(concurrent_copy, destination_path)
            simulated_race = True
            raise FileExistsError("another importer published this digest first")
        return real_replace(source_path, destination_path)

    monkeypatch.setattr(checkpoint_import.os, "replace", publish_concurrently)

    result = import_checkpoint(source, checkpoint_root=checkpoint_root, build_model=_build_model)

    assert simulated_race is True
    assert result.reused is True
    assert result.registration == published.registration
    assert result.directory == published.directory
    assert list(checkpoint_root.iterdir()) == [published.directory]


def test_import_rejects_test_split_args_without_writing(tmp_path: Path) -> None:
    source = tmp_path / "checkpoint.pt"
    _save_checkpoint(source, args={**VALID_ARGS, "eval_split": "test"})
    checkpoint_root = tmp_path / "registrations"

    with pytest.raises(CheckpointValidationError, match="cannot be selected on the test split"):
        import_checkpoint(source, checkpoint_root=checkpoint_root, build_model=_build_model)

    _assert_no_files(checkpoint_root)


def test_import_rejects_a_mismatched_state_dict_without_writing(tmp_path: Path) -> None:
    source = tmp_path / "checkpoint.pt"
    _save_checkpoint(source, model=torch.nn.Linear(3, 3))
    checkpoint_root = tmp_path / "registrations"

    with pytest.raises(CheckpointValidationError, match="state dict does not match"):
        import_checkpoint(source, checkpoint_root=checkpoint_root, build_model=_build_model)

    _assert_no_files(checkpoint_root)


class _Custom:
    pass


def test_import_rejects_pickle_requiring_code_without_writing(tmp_path: Path) -> None:
    source = tmp_path / "unsafe.pt"
    torch.save({"x": _Custom()}, source)
    checkpoint_root = tmp_path / "registrations"

    with pytest.raises(CheckpointValidationError, match="cannot be read without unpickling code"):
        import_checkpoint(source, checkpoint_root=checkpoint_root, build_model=_build_model)

    _assert_no_files(checkpoint_root)


def test_reference_metrics_require_labclip_test_to_image_protocol(tmp_path: Path) -> None:
    path = tmp_path / "reference.json"
    path.write_text(json.dumps(REFERENCE_METRICS), encoding="utf-8")

    assert load_reference_metrics(path) == REFERENCE_METRICS

    for key, invalid in (("dataset", "other"), ("split", "val"), ("direction", "image-to-text")):
        path.write_text(json.dumps({**REFERENCE_METRICS, key: invalid}), encoding="utf-8")
        with pytest.raises(CheckpointValidationError):
            load_reference_metrics(path)


def test_safetensors_write_failure_cleans_temporary_registration(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "checkpoint.pt"
    _save_checkpoint(source)
    checkpoint_root = tmp_path / "registrations"

    def fail_write(state, destination):
        raise OSError("simulated disk failure")

    monkeypatch.setattr(safetensors_torch, "save_file", fail_write)

    with pytest.raises(CheckpointValidationError, match="safetensors"):
        import_checkpoint(source, checkpoint_root=checkpoint_root, build_model=_build_model)

    _assert_no_files(checkpoint_root)
