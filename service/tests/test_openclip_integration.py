import os
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

pytestmark = pytest.mark.integration

from gods_eye.clip_models import PRETRAINED_SOURCES, ClipModelSpec, OpenClipArch
from gods_eye.openclip_embedder import OpenClipEmbedder

_FIXTURES = Path(__file__).parent / "fixtures" / "openclip_golden"
_CAPTIONS = (
    "a woman in a red coat carrying a black bag",
    "a man wearing a white shirt and blue jeans",
    "person with a yellow backpack",
)
_IMAGE_FILENAMES = (
    "gradient_64x160.png",
    "stripes_128x384.png",
    "gradient_97x211.png",
    "stripes_square_rgba.png",
)


def _cached_snapshot() -> tuple[Path, str] | None:
    source = PRETRAINED_SOURCES[("ViT-B-16", "openai")]
    roots = []
    configured_cache = os.environ.get("GODS_EYE_HF_CACHE")
    if configured_cache:
        roots.append(Path(configured_cache).expanduser())
    roots.append(Path.home() / ".cache" / "huggingface" / "hub")
    for cache_root in roots:
        snapshot = (
            cache_root
            / "models--timm--vit_base_patch16_clip_224.openai"
            / "snapshots"
            / source.revision
            / source.filename
        )
        if snapshot.is_file():
            return cache_root, source.revision
    return None


def _row_cosines(actual: np.ndarray, expected: np.ndarray) -> np.ndarray:
    actual = actual / np.linalg.norm(actual, axis=1, keepdims=True)
    expected = expected / np.linalg.norm(expected, axis=1, keepdims=True)
    return actual @ expected.T


def test_openclip_embedder_matches_labclip_cpu_golden_embeddings() -> None:
    pytest.importorskip("open_clip")
    cached = _cached_snapshot()
    if cached is None:
        pytest.skip("Pinned OpenCLIP safetensors snapshot is not cached")
    cache_root, revision = cached
    arch = OpenClipArch("ViT-B-16", "openai", 384, 128, "reid")
    spec = ClipModelSpec(
        model_id=arch.baseline_model_id,
        label=arch.baseline_label,
        storage_key=arch.baseline_storage_key,
        backend="openclip",
        group="baseline",
        arch=arch,
    )
    images = [Image.open(_FIXTURES / "images" / name) for name in _IMAGE_FILENAMES]
    expected = np.load(_FIXTURES / "embeddings.npz")
    embedder = OpenClipEmbedder(
        spec,
        revision=revision,
        device="cpu",
        offline=True,
        cache_dir=cache_root,
    )
    try:
        image_embeddings = embedder.embed_images(images)
        text_embeddings = embedder.embed_texts(_CAPTIONS)

        image_cosines = np.diag(_row_cosines(image_embeddings, expected["image"]))
        text_cosines = np.diag(_row_cosines(text_embeddings, expected["text"]))
        assert np.all(image_cosines >= 0.9999)
        assert np.all(text_cosines >= 0.9999)
        np.testing.assert_allclose(
            embedder.embed_text(_CAPTIONS[0]), text_embeddings[0], atol=2e-7, rtol=1e-6
        )
    finally:
        embedder.close()
        for image in images:
            image.close()
