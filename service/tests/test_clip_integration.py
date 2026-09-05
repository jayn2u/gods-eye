"""Opt-in real-model smoke test: RUN_CLIP_INTEGRATION=1 uv run pytest -m integration."""

import json
import os
import sys
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest
from gods_eye.clip import HuggingFaceClipEmbedder
from gods_eye.clip_models import CLIP_MODELS
from gods_eye.gallery import build_manifest
from gods_eye.index_store import activate_version, build_index, deterministic_embedding
from gods_eye.model_runtime import FixtureModelRuntime, ModelRuntimeManager
from PIL import Image


def test_fixture_runtime_routes_all_four_models_without_external_assets() -> None:
    runtime = FixtureModelRuntime()
    executions = [runtime.search(spec.model_id, "coat", 1, ["CUHK-PEDES"]) for spec in CLIP_MODELS]
    assert [item.model_id for item in executions] == [spec.model_id for spec in CLIP_MODELS]
    assert len({item.active_index_version for item in executions}) == 4
    assert all(item.results[0].image_url.startswith("/api/images/") for item in executions)


def test_hf_adapter_forwards_runtime_offline_options_to_both_loaders(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = []

    class FakeTensor:
        def to(self, device: str):
            return self

    class FakeFeatures:
        def detach(self):
            return self

        def cpu(self):
            return self

        def float(self):
            return self

        def numpy(self):
            return deterministic_embedding("red coat", 8)[None]

    class FakeProcessor:
        def __call__(self, **options):
            return {"input_ids": FakeTensor()}

    class FakeModel:
        config = SimpleNamespace(projection_dim=8)

        def to(self, device: str):
            return self

        def eval(self):
            return self

        def get_text_features(self, **inputs):
            return FakeFeatures()

    class ProcessorLoader:
        @staticmethod
        def from_pretrained(model_id: str, **options):
            calls.append(("processor", model_id, options))
            return FakeProcessor()

    class ModelLoader:
        @staticmethod
        def from_pretrained(model_id: str, **options):
            calls.append(("model", model_id, options))
            return FakeModel()

    torch = ModuleType("torch")
    torch.inference_mode = nullcontext
    torch.nn = SimpleNamespace(functional=SimpleNamespace(normalize=lambda features, dim: features))
    transformers = ModuleType("transformers")
    transformers.AutoProcessor = ProcessorLoader
    transformers.CLIPModel = ModelLoader
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "transformers", transformers)
    revision = "a" * 40
    dataset_root = tmp_path / "datasets"
    image_root = dataset_root / "CUHK-PEDES" / "images"
    image_root.mkdir(parents=True)
    Image.new("RGB", (4, 5), "red").save(image_root / "person.png")
    metadata = tmp_path / "metadata.json"
    metadata.write_text(json.dumps([{"split": "test", "file_path": "person.png", "id": 1}]))
    manifest = build_manifest({"CUHK-PEDES": (image_root, metadata)})
    source = tmp_path / "source.json"
    manifest.write(source)
    index_root = tmp_path / "indexes"
    version = build_index(
        source,
        index_root / "versions",
        model_id="openai/clip-vit-base-patch16",
        dimension=8,
        backend="numpy",
        now=datetime(2026, 9, 5, tzinfo=UTC),
        model_revision=revision,
        dataset_root=dataset_root,
    )
    activate_version(version, index_root / "active", "openai/clip-vit-base-patch16", dataset_root)
    manifest.serialized_roots = {"CUHK-PEDES": "CUHK-PEDES/images"}
    manifest.write(index_root / "gallery-manifest.json")
    cache = tmp_path / "hf"
    (cache / "models--openai--clip-vit-base-patch16" / "snapshots" / revision).mkdir(parents=True)

    runtime = ModelRuntimeManager(index_root, dataset_root, cache, device="cpu")
    execution = runtime.search("openai/clip-vit-base-patch16", "red coat", 1, ["CUHK-PEDES"])
    runtime.close()

    options = {"revision": revision, "local_files_only": True, "cache_dir": str(cache)}
    assert calls == [
        ("processor", "openai/clip-vit-base-patch16", options),
        ("model", "openai/clip-vit-base-patch16", options),
    ]
    assert execution.active_index_version == version.name


@pytest.mark.integration
@pytest.mark.skipif(
    os.environ.get("RUN_CLIP_INTEGRATION") != "1"
    or os.environ.get("GODS_EYE_REAL_MODEL_MATRIX") != "1",
    reason="opt-in all-four real-checkpoint matrix",
)
def test_real_clip_embeds_all_four_models_sequentially_from_local_cache() -> None:
    import torch

    assert os.environ.get("GODS_EYE_OFFLINE") == "1"
    assert torch.cuda.is_available(), "all-four matrix requires a CUDA GPU"
    images = [Image.new("RGB", (64, 96), color) for color in ((220, 20, 20), (20, 20, 220))]
    configured_cache = os.environ.get("GODS_EYE_HF_CACHE")
    cache_dir = Path(configured_cache) if configured_cache else None
    completed = []
    for spec in CLIP_MODELS:
        embedder = HuggingFaceClipEmbedder(
            spec.model_id,
            device="cuda",
            offline=True,
            cache_dir=cache_dir,
        )
        try:
            image_features = embedder.embed_images(images)
            text_feature = embedder.embed_text("a person wearing a red top")
            assert image_features.shape == (2, embedder.dimension)
            assert text_feature.shape == (embedder.dimension,)
            assert np.allclose(np.linalg.norm(image_features, axis=1), 1, atol=1e-5)
            assert np.isclose(np.linalg.norm(text_feature), 1, atol=1e-5)
            assert np.all(np.isfinite(image_features @ text_feature))
            completed.append(spec.model_id)
        finally:
            embedder.close()
    assert completed == [spec.model_id for spec in CLIP_MODELS]
