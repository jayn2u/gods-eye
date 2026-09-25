"""Torch-free port of lab_clip's evaluation-time ReID preprocessing."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np
from PIL import Image

CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)
_RESAMPLE = {
    "bilinear": Image.Resampling.BILINEAR,
    "bicubic": Image.Resampling.BICUBIC,
}


def reid_preprocess(
    image: Image.Image,
    *,
    height: int,
    width: int,
    mean: Sequence[float] = CLIP_MEAN,
    std: Sequence[float] = CLIP_STD,
    interpolation: str = "bilinear",
) -> np.ndarray:
    """Resize to (height, width) without cropping, scale to [0, 1], then normalize (CHW)."""
    resized = image.convert("RGB").resize((width, height), _RESAMPLE[interpolation])
    array = np.asarray(resized, dtype=np.float32) / np.float32(255.0)
    array = (array - np.asarray(mean, np.float32)) / np.asarray(std, np.float32)
    return np.ascontiguousarray(array.transpose(2, 0, 1), dtype=np.float32)


def batch_preprocess(images: Sequence[Image.Image], **options: Any) -> np.ndarray:
    """Preprocess each image with the same options and stack them in input order."""
    return np.stack([reid_preprocess(image, **options) for image in images])
