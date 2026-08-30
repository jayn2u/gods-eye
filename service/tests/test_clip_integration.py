"""Opt-in real-model smoke test: RUN_CLIP_INTEGRATION=1 uv run pytest -m integration."""

import os

import numpy as np
import pytest
from gods_eye.clip import DEFAULT_MODEL_ID, HuggingFaceClipEmbedder
from PIL import Image

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.environ.get("RUN_CLIP_INTEGRATION") != "1", reason="opt-in test"),
]


def test_real_clip_embeds_fixture_images_and_text(tmp_path) -> None:
    images = [Image.new("RGB", (64, 96), color) for color in ((220, 20, 20), (20, 20, 220))]
    embedder = HuggingFaceClipEmbedder(
        DEFAULT_MODEL_ID,
        device=os.environ.get("GODS_EYE_DEVICE", "auto"),
        offline=os.environ.get("GODS_EYE_OFFLINE") == "1",
    )
    image_features = embedder.embed_images(images)
    text_feature = embedder.embed_text("a person wearing a red top")
    assert image_features.shape == (2, embedder.dimension)
    assert text_feature.shape == (embedder.dimension,)
    assert np.allclose(np.linalg.norm(image_features, axis=1), 1, atol=1e-5)
    assert np.isclose(np.linalg.norm(text_feature), 1, atol=1e-5)
    assert np.all(np.isfinite(image_features @ text_feature))
