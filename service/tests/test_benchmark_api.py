import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import ClassVar

import numpy as np
from fastapi.testclient import TestClient
from gods_eye.app import app, use_model_runtime, use_retrieval_engine
from gods_eye.benchmark import BenchmarkQuery, write_benchmark_queries
from gods_eye.clip_models import DEFAULT_MODEL_ID
from gods_eye.gallery import GalleryManifest, build_manifest
from gods_eye.index_store import activate_version, build_index, manifest_digest
from gods_eye.model_runtime import FixtureModelRuntime, ModelRuntimeManager
from gods_eye.retrieval import FixtureRetrievalEngine
from PIL import Image

client = TestClient(app)

_TRAIN_CAPTION = "TRAIN_ONLY_CAPTION_MUST_NEVER_BE_RETURNED"
_SAMPLE_CAPTION = "A test visitor wears a gray jacket and carries a canvas tote."
_REVISION = "a" * 40


class _ImageEmbedder:
    dimension = 2

    _vectors: ClassVar[dict[tuple[int, int, int], np.ndarray]] = {
        (230, 20, 20): np.asarray([0.0, 1.0], dtype=np.float32),
        (20, 230, 20): np.asarray([1.0, 0.0], dtype=np.float32),
        (20, 20, 230): np.asarray([0.8, 0.6], dtype=np.float32),
    }

    def embed_images(self, images: list[Image.Image]) -> np.ndarray:
        return np.stack([self._vectors[image.getpixel((0, 0))] for image in images])


class _QueryEmbedder:
    def embed_text(self, text: str) -> np.ndarray:
        del text
        return np.asarray([1.0, 0.0], dtype=np.float32)

    def close(self) -> None:
        pass


class _QueryEmbedderFactory:
    def __call__(
        self,
        model_id: str,
        *,
        revision: str | None,
        device: str,
        offline: bool,
        cache_dir: Path | None,
        text_only: bool = False,
    ) -> _QueryEmbedder:
        del model_id, revision, device, offline, cache_dir
        assert text_only is True
        return _QueryEmbedder()


def _indexed_runtime(tmp_path: Path) -> ModelRuntimeManager:
    dataset_root = tmp_path / "datasets"
    image_root = dataset_root / "CUHK-PEDES" / "images"
    image_root.mkdir(parents=True)
    colors = {
        "target.png": (230, 20, 20),
        "closest.png": (20, 230, 20),
        "second.png": (20, 20, 230),
        "train.png": (200, 200, 20),
    }
    for name, color in colors.items():
        Image.new("RGB", (4, 5), color).save(image_root / name)

    metadata = tmp_path / "metadata.json"
    metadata.write_text(
        json.dumps(
            [
                {"split": "test", "file_path": "target.png", "id": 1},
                {"split": "test", "file_path": "closest.png", "id": 2},
                {"split": "test", "file_path": "second.png", "id": 3},
                {
                    "split": "train",
                    "file_path": "train.png",
                    "id": 900,
                    "caption": _TRAIN_CAPTION,
                },
            ]
        )
    )
    manifest = build_manifest({"CUHK-PEDES": (image_root, metadata)})
    target_person_id = next(
        record.source_person_id
        for record in manifest.records
        if record.relative_path == "target.png"
    )
    index_root = tmp_path / "indexes"
    source_path = tmp_path / "source-manifest.json"
    manifest.write(source_path)
    manifest.serialized_roots = {"CUHK-PEDES": "CUHK-PEDES/images"}
    manifest_path = index_root / "gallery-manifest.json"
    manifest.write(manifest_path)
    version = build_index(
        source_path,
        index_root / "versions",
        model_id=DEFAULT_MODEL_ID,
        dimension=2,
        backend="numpy",
        now=datetime(2026, 9, 25, tzinfo=UTC),
        embedder=_ImageEmbedder(),
        model_revision=_REVISION,
        dataset_root=dataset_root,
    )
    activate_version(version, index_root / "active", DEFAULT_MODEL_ID, dataset_root)
    hf_cache = tmp_path / "huggingface"
    (hf_cache / "models--openai--clip-vit-base-patch16" / "snapshots" / _REVISION).mkdir(
        parents=True
    )
    loaded_manifest = GalleryManifest.read(manifest_path, dataset_root=dataset_root)
    write_benchmark_queries(
        index_root / "benchmark-queries.json",
        (BenchmarkQuery("bq_sample", _SAMPLE_CAPTION, target_person_id),),
        manifest_sha256=manifest_digest(loaded_manifest),
    )
    return ModelRuntimeManager(
        index_root,
        dataset_root,
        hf_cache,
        embedder_factory=_QueryEmbedderFactory(),
    )


def test_fixture_benchmark_compares_paired_models_and_returns_rank_examples(caplog) -> None:
    runtime = FixtureModelRuntime()
    with (
        caplog.at_level(logging.INFO, logger="gods_eye.operations"),
        use_model_runtime(runtime),
    ):
        comparison = client.get("/api/benchmark")
        queries = client.get("/api/benchmark/queries")
        improved_base = client.post(
            "/api/benchmark/search",
            json={
                "query_id": "bq_improved",
                "model_id": "openclip/ViT-B-16@openai:384x128-reid",
            },
        )
        improved_ft = client.post(
            "/api/benchmark/search",
            json={
                "query_id": "bq_improved",
                "model_id": "labclip:cuhk-pedes:0123456789ab",
            },
        )
        same_ft = client.post(
            "/api/benchmark/search",
            json={
                "query_id": "bq_same",
                "model_id": "labclip:cuhk-pedes:0123456789ab",
            },
        )
        worse_base = client.post(
            "/api/benchmark/search",
            json={
                "query_id": "bq_worse",
                "model_id": "openclip/ViT-B-16@openai:384x128-reid",
            },
        )
        unknown_query = client.post(
            "/api/benchmark/search",
            json={
                "query_id": "bq_not_in_the_sample",
                "model_id": "openclip/ViT-B-16@openai:384x128-reid",
            },
        )
        unregistered_model = client.post(
            "/api/benchmark/search",
            json={
                "query_id": "bq_improved",
                "model_id": "labclip:cuhk-pedes:ffffffffffff",
            },
        )

    assert comparison.status_code == 200
    models = {model["model_id"]: model for model in comparison.json()["models"]}
    baseline = models["openclip/ViT-B-16@openai:384x128-reid"]
    fine_tuned = models["labclip:cuhk-pedes:0123456789ab"]
    assert baseline["metrics"]["top1"] == 0.31
    assert fine_tuned["metrics"]["top1"] == 0.7
    assert fine_tuned["delta_vs_baseline_pp"]["top1"] == 39.0
    assert fine_tuned["delta_vs_baseline_pp"] == {
        "top1": 39.0,
        "top5": 35.0,
        "top10": 32.0,
        "mAP": 28.0,
        "mINP": 27.0,
    }
    assert baseline["benchmark_query_ranks"] == {
        "bq_improved": 3,
        "bq_same": 2,
        "bq_worse": 1,
    }
    assert fine_tuned["benchmark_query_ranks"] == {
        "bq_improved": 1,
        "bq_same": 2,
        "bq_worse": 4,
    }
    assert [query["id"] for query in queries.json()["queries"]] == [
        "bq_improved",
        "bq_same",
        "bq_worse",
    ]
    assert improved_base.json()["first_match_rank"] == 3
    assert improved_base.json()["results"][0]["is_match"] is False
    assert improved_ft.json()["first_match_rank"] == 1
    assert improved_ft.json()["results"][0]["is_match"] is True
    assert same_ft.json()["first_match_rank"] == 2
    assert same_ft.json()["results"][0]["is_match"] is False
    assert worse_base.json()["first_match_rank"] == 1
    assert worse_base.json()["results"][0]["is_match"] is True
    assert unknown_query.status_code == 404
    assert unregistered_model.status_code == 409
    captions = [query.caption for query in runtime.benchmark_queries()]
    assert all(caption not in record.message for caption in captions for record in caplog.records)


def test_benchmark_search_does_not_map_unrelated_key_errors_to_not_found() -> None:
    class InternalKeyErrorRuntime(FixtureModelRuntime):
        def benchmark_search(self, model_id: str, query_id: str, top_k: int):
            del model_id, query_id, top_k
            raise KeyError("internal runtime lookup")

    with use_model_runtime(InternalKeyErrorRuntime()), TestClient(
        app, raise_server_exceptions=False
    ) as non_raising_client:
        response = non_raising_client.post(
            "/api/benchmark/search",
            json={
                "query_id": "bq_improved",
                "model_id": "openclip/ViT-B-16@openai:384x128-reid",
            },
        )

    assert response.status_code == 500


def test_retrieval_adapter_returns_empty_benchmark_and_no_benchmark_queries() -> None:
    with use_retrieval_engine(FixtureRetrievalEngine()):
        comparison = client.get("/api/benchmark")
        queries = client.get("/api/benchmark/queries")
        search = client.post(
            "/api/benchmark/search",
            json={
                "query_id": "bq_adapter",
                "model_id": "openai/clip-vit-base-patch16",
            },
        )

    assert comparison.status_code == 200
    assert comparison.json()["models"] == []
    assert comparison.json()["protocol"]["query_count"] is None
    assert queries.status_code == 200
    assert queries.json() == {"queries": []}
    assert search.status_code == 404


def test_benchmark_search_ranks_manifest_person_ids_beyond_top_k_and_never_exposes_train_caption(
    tmp_path: Path,
) -> None:
    runtime = _indexed_runtime(tmp_path)
    with use_model_runtime(runtime):
        queries = client.get("/api/benchmark/queries")
        comparison = client.get("/api/benchmark")
        first_page = client.post(
            "/api/benchmark/search",
            json={"query_id": "bq_sample", "model_id": DEFAULT_MODEL_ID, "top_k": 1},
        )
        full_page = client.post(
            "/api/benchmark/search",
            json={"query_id": "bq_sample", "model_id": DEFAULT_MODEL_ID, "top_k": 3},
        )
        regular_search = client.post(
            "/api/search", json={"query": "user-written description", "model_id": DEFAULT_MODEL_ID}
        )
    runtime.close()

    assert queries.status_code == 200
    assert queries.json()["queries"] == [{"id": "bq_sample", "caption": _SAMPLE_CAPTION}]
    assert first_page.status_code == 200
    assert first_page.json()["first_match_rank"] == 3
    assert [result["is_match"] for result in first_page.json()["results"]] == [False]
    assert full_page.status_code == 200
    assert full_page.json()["first_match_rank"] == 3
    assert [result["is_match"] for result in full_page.json()["results"]] == [False, False, True]
    assert [result["rank"] for result in full_page.json()["results"]] == [1, 2, 3]
    assert regular_search.status_code == 200
    assert "caption" not in regular_search.text
    assert _TRAIN_CAPTION not in queries.text + comparison.text + first_page.text + full_page.text
