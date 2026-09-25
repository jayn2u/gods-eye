from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from gods_eye.reid_preprocess import batch_preprocess, reid_preprocess
from PIL import Image

GOLDEN = Path(__file__).parent / "fixtures" / "openclip_golden"
NAMES = sorted(path.stem for path in (GOLDEN / "images").glob("*.png"))


@pytest.mark.parametrize("name", NAMES)
def test_reid_preprocess_matches_labclip_eval_transform(name: str) -> None:
    with np.load(GOLDEN / "preprocess.npz") as fixtures:
        expected = fixtures[f"reid_{name}"]
    with Image.open(GOLDEN / "images" / f"{name}.png") as image:
        actual = reid_preprocess(image.convert("RGB"), height=384, width=128)
    assert actual.dtype == np.float32 and actual.shape == (3, 384, 128)
    np.testing.assert_allclose(actual, expected, atol=1e-5)


@pytest.mark.parametrize("name", NAMES)
def test_model_reid_preprocess_matches_labclip_eval_transform(name: str) -> None:
    with np.load(GOLDEN / "preprocess.npz") as fixtures:
        expected = fixtures[f"model_reid_{name}"]
        mean = fixtures["model_reid_mean"].copy()
        std = fixtures["model_reid_std"].copy()
        interpolation = str(fixtures["model_reid_interpolation"].item())
    assert interpolation == "bicubic"
    with Image.open(GOLDEN / "images" / f"{name}.png") as image:
        actual = reid_preprocess(
            image.convert("RGB"),
            height=384,
            width=128,
            mean=mean,
            std=std,
            interpolation=interpolation,
        )
    assert actual.dtype == np.float32 and actual.shape == (3, 384, 128)
    np.testing.assert_allclose(actual, expected, atol=1e-5)


def test_batch_preprocess_stacks_in_order() -> None:
    images = [
        Image.new("RGB", (10, 20), (255, 0, 0)),
        Image.new("RGB", (10, 20), (0, 0, 255)),
    ]
    batch = batch_preprocess(images, height=8, width=4)
    assert batch.shape == (2, 3, 8, 4)
    assert batch[0, 0].mean() > batch[1, 0].mean()
