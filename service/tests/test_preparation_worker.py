from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from gods_eye.benchmark import evaluation_path, read_benchmark_queries, read_evaluation
from gods_eye.checkpoint_registry import (
    Registration,
    checkpoint_model_id,
    write_registration,
)
from gods_eye.clip_models import OpenClipArch, checkpoint_root_for
from gods_eye.gallery import GalleryManifest, GalleryRecord
from gods_eye.index_store import activate_version, build_index, load_active
from gods_eye.models import SUPPORTED_DATASETS
from gods_eye.preparation_worker import OOM_EXIT_CODE, ModelRevisionError, main
from PIL import Image

MODEL_ID = "openai/clip-vit-base-patch16"
MODEL_REVISION = "a" * 40


def _index_fixture(
    root: Path,
    *,
    model_id: str = MODEL_ID,
    model_revision: str = MODEL_REVISION,
) -> tuple[Path, Path, Path, str]:
    dataset_root = root / "data" / "datasets"
    dataset = SUPPORTED_DATASETS[0]
    image_root = dataset_root / dataset
    image = image_root / "imgs" / "test-image.png"
    image.parent.mkdir(parents=True)
    Image.new("RGB", (8, 8), (12, 34, 56)).save(image)
    manifest = GalleryManifest(
        roots={dataset: image_root},
        records=[
            GalleryRecord(
                id="image-1",
                dataset=dataset,
                split="test",
                relative_path="imgs/test-image.png",
                source_person_id="person-1",
                content_sha256="c" * 64,
            )
        ],
        report={},
    )
    manifest_path = root / "indexes" / "gallery-manifest.json"
    manifest.write(manifest_path)
    metadata = image_root / "reid_raw.json"
    metadata.write_text(
        json.dumps(
            [
                {
                    "split": "train",
                    "file_path": "train.jpg",
                    "id": "train-person",
                    "captions": ["private train caption"],
                },
                {
                    "split": "test",
                    "file_path": "imgs/test-image.png",
                    "id": "person-1",
                    "captions": ["a person wearing a blue jacket"],
                },
            ]
        ),
        encoding="utf-8",
    )
    index_root = root / "indexes" / "models" / "clip-test"
    version = build_index(
        manifest_path,
        index_root / "versions",
        model_id=model_id,
        backend="numpy",
        model_revision=model_revision,
        dataset_root=dataset_root,
    )
    activate_version(version, index_root / "active", model_id, dataset_root)
    return manifest_path, metadata, index_root / "active", str(version.name)


def test_worker_builds_benchmark_queries_and_writes_evaluation(tmp_path: Path, monkeypatch) -> None:
    manifest, metadata, active, version_id = _index_fixture(tmp_path)
    cache_dir = tmp_path / ".cache" / "huggingface"
    query_path = tmp_path / "indexes" / "benchmark-queries.json"
    output = evaluation_path(active.parent, version_id)
    loaded = load_active(active, MODEL_ID, MODEL_REVISION, tmp_path / "data" / "datasets")
    calls: list[tuple[list[str], dict]] = []

    class FakeEmbedder:
        def embed_texts(self, texts: list[str], batch_size: int = 256) -> np.ndarray:
            assert batch_size == 256
            return np.repeat(loaded.vectors[:1], len(texts), axis=0)

        def close(self) -> None:
            pass

    def create_fake(model_id: str, **options):
        calls.append(([], {"model_id": model_id, **options}))
        return FakeEmbedder()

    monkeypatch.setattr("gods_eye.preparation_worker.create_embedder", create_fake)

    assert (
        main(
            [
                "build-benchmark-queries",
                "--manifest",
                str(manifest),
                "--metadata",
                str(metadata),
                "--output",
                str(query_path),
            ]
        )
        == 0
    )
    queries = read_benchmark_queries(query_path)
    assert len(queries) == 1
    assert queries[0].caption == "a person wearing a blue jacket"
    assert (
        main(
            [
                "evaluate",
                str(active),
                "--model-id",
                MODEL_ID,
                "--revision",
                MODEL_REVISION,
                "--cache-dir",
                str(cache_dir),
                "--dataset-root",
                str(tmp_path / "data" / "datasets"),
                "--metadata",
                str(metadata),
                "--benchmark-queries",
                str(query_path),
                "--output",
                str(output),
            ]
        )
        == 0
    )

    evaluation = read_evaluation(output)
    assert evaluation.model_id == MODEL_ID
    assert evaluation.index_version == version_id
    assert evaluation.model_revision == MODEL_REVISION
    assert evaluation.metrics["top1"] == 1.0
    assert evaluation.benchmark_query_ranks[queries[0].id] == 1
    assert calls == [
        (
            [],
            {
                "model_id": MODEL_ID,
                "revision": MODEL_REVISION,
                "device": "cuda",
                "offline": True,
                "cache_dir": cache_dir,
                "text_only": True,
            },
        )
    ]


def test_worker_returns_existing_oom_exit_code_for_evaluation(tmp_path: Path, monkeypatch) -> None:
    manifest, metadata, active, version_id = _index_fixture(tmp_path)
    cache_dir = tmp_path / ".cache" / "huggingface"
    query_path = tmp_path / "indexes" / "benchmark-queries.json"
    output = evaluation_path(active.parent, version_id)

    class OutOfMemoryEmbedder:
        def embed_texts(self, texts: list[str], batch_size: int = 256) -> np.ndarray:
            raise RuntimeError("CUDA out of memory")

        def close(self) -> None:
            pass

    monkeypatch.setattr(
        "gods_eye.preparation_worker.create_embedder",
        lambda model_id, **options: OutOfMemoryEmbedder(),
    )
    assert (
        main(
            [
                "build-benchmark-queries",
                "--manifest",
                str(manifest),
                "--metadata",
                str(metadata),
                "--output",
                str(query_path),
            ]
        )
        == 0
    )

    result = main(
        [
            "evaluate",
            str(active),
            "--model-id",
            MODEL_ID,
            "--revision",
            MODEL_REVISION,
            "--cache-dir",
            str(cache_dir),
            "--dataset-root",
            str(tmp_path / "data" / "datasets"),
            "--metadata",
            str(metadata),
            "--benchmark-queries",
            str(query_path),
            "--output",
            str(output),
        ]
    )
    assert result == OOM_EXIT_CODE


def test_worker_prepares_and_verifies_openclip_baseline_without_torch(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    revision = "b" * 40
    weights = tmp_path / revision / "open_clip_model.safetensors"
    weights.parent.mkdir()
    weights.write_bytes(b"pinned baseline")
    offline_values: list[bool] = []

    def baseline_path(arch, *, revision, cache_dir, offline):
        offline_values.append(offline)
        assert revision == revision_value or revision is None
        return weights

    revision_value = revision
    monkeypatch.setattr("gods_eye.preparation_worker.baseline_weights_path", baseline_path)
    baseline_id = "openclip/ViT-B-16@openai:384x128-reid"
    cache_dir = tmp_path / ".cache" / "huggingface"

    assert main(["prepare-model", "--model-id", baseline_id, "--cache-dir", str(cache_dir)]) == 0
    assert (
        main(
            [
                "verify-model",
                "--model-id",
                baseline_id,
                "--revision",
                revision,
                "--cache-dir",
                str(cache_dir),
            ]
        )
        == 0
    )

    assert offline_values == [False, True]
    assert capsys.readouterr().out.splitlines() == [
        json.dumps({"model_id": baseline_id, "resolved_revision": revision}, separators=(",", ":")),
        json.dumps({"model_id": baseline_id, "resolved_revision": revision}, separators=(",", ":")),
    ]


def _registered_checkpoint(
    cache_dir: Path,
    weights: bytes,
    *,
    reference_metrics: dict | None = None,
) -> tuple[str, str, Path]:
    digest = hashlib.sha256(weights).hexdigest()
    model_id = checkpoint_model_id(digest)
    checkpoint_root = checkpoint_root_for(cache_dir)
    registration = Registration(
        model_id=model_id,
        label="FT · worker test",
        weights_sha256=digest,
        source_sha256="e" * 64,
        source_filename="checkpoint_best.pth",
        arch=OpenClipArch("ViT-B-16", "openai", 384, 128, "reid"),
        verified=True,
        registered_at="2026-09-25T00:00:00Z",
        provenance={},
        reference_metrics=reference_metrics,
    )
    checkpoint_dir = write_registration(checkpoint_root, registration).parent
    weights_path = checkpoint_dir / "model.safetensors"
    weights_path.write_bytes(weights)
    return model_id, f"sha256:{digest}", weights_path


def test_worker_checks_registered_checkpoint_weights_for_both_model_operations(
    tmp_path: Path, capsys
) -> None:
    cache_dir = tmp_path / ".cache" / "huggingface"
    model_id, revision, _weights_path = _registered_checkpoint(cache_dir, b"safetensors bytes")

    assert main(["prepare-model", "--model-id", model_id, "--cache-dir", str(cache_dir)]) == 0
    assert (
        main(
            [
                "verify-model",
                "--model-id",
                model_id,
                "--revision",
                revision,
                "--cache-dir",
                str(cache_dir),
            ]
        )
        == 0
    )
    lines = capsys.readouterr().out.splitlines()
    assert [json.loads(line) for line in lines] == [
        {"model_id": model_id, "resolved_revision": revision},
        {"model_id": model_id, "resolved_revision": revision},
    ]


@pytest.mark.parametrize("operation", ["prepare-model", "verify-model"])
def test_worker_rejects_registered_checkpoint_weight_mismatch(
    tmp_path: Path, operation: str
) -> None:
    cache_dir = tmp_path / ".cache" / "huggingface"
    model_id, revision, weights_path = _registered_checkpoint(cache_dir, b"original weights")
    weights_path.write_bytes(b"modified weights")
    argv = [operation, "--model-id", model_id, "--cache-dir", str(cache_dir)]
    if operation == "verify-model":
        argv.extend(["--revision", revision])

    with pytest.raises(ModelRevisionError, match="registered SHA-256"):
        main(argv)


def test_worker_passes_checkpoint_reference_metrics_into_evaluation(
    tmp_path: Path, monkeypatch
) -> None:
    reference_metrics = {
        "metrics": {"top1": 0.7, "top5": 0.88, "top10": 0.93, "mAP": 0.64, "mINP": 0.48},
        "gallery": {"images": 3074},
        "queries": {"captions": 6156},
    }
    cache_dir = tmp_path / ".cache" / "huggingface"
    model_id, revision, _weights_path = _registered_checkpoint(
        cache_dir,
        b"checkpoint weights",
        reference_metrics=reference_metrics,
    )
    manifest, metadata, active, version_id = _index_fixture(
        tmp_path,
        model_id=model_id,
        model_revision=revision,
    )
    loaded = load_active(active, model_id, revision, tmp_path / "data" / "datasets")
    query_path = tmp_path / "indexes" / "benchmark-queries.json"
    output = evaluation_path(active.parent, version_id)

    class FakeEmbedder:
        def embed_texts(self, texts: list[str], batch_size: int = 256) -> np.ndarray:
            assert batch_size == 256
            return np.repeat(loaded.vectors[:1], len(texts), axis=0)

        def close(self) -> None:
            pass

    monkeypatch.setattr(
        "gods_eye.preparation_worker.create_embedder",
        lambda requested_model_id, **options: FakeEmbedder(),
    )
    assert (
        main(
            [
                "build-benchmark-queries",
                "--manifest",
                str(manifest),
                "--metadata",
                str(metadata),
                "--output",
                str(query_path),
            ]
        )
        == 0
    )

    assert (
        main(
            [
                "evaluate",
                str(active),
                "--model-id",
                model_id,
                "--revision",
                revision,
                "--cache-dir",
                str(cache_dir),
                "--dataset-root",
                str(tmp_path / "data" / "datasets"),
                "--metadata",
                str(metadata),
                "--benchmark-queries",
                str(query_path),
                "--output",
                str(output),
            ]
        )
        == 0
    )

    evaluation = read_evaluation(output)
    assert evaluation.reference is not None
    assert evaluation.reference["source"] == "lab_clip"
    assert evaluation.reference["metrics"] == reference_metrics["metrics"]
    assert evaluation.reference["gallery"] == reference_metrics["gallery"]
    assert evaluation.reference["queries"] == reference_metrics["queries"]
