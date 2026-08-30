from __future__ import annotations

import argparse
import os
from collections.abc import Sequence
from pathlib import Path

import numpy as np
from PIL import Image

DEFAULT_MODEL_ID = "openai/clip-vit-base-patch16"


class ClipLoadError(RuntimeError):
    """CLIP assets are unavailable or the requested runtime cannot be initialized."""


def resolve_device(requested: str = "auto") -> str:
    try:
        import torch
    except ImportError as exc:  # pragma: no cover - dependency extra owns this path
        raise ClipLoadError("PyTorch is required for CLIP inference; install the `clip` extra.") from exc
    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested.startswith("cuda") and not torch.cuda.is_available():
        raise ClipLoadError(f"Device {requested!r} was requested, but CUDA is unavailable.")
    return requested


class HuggingFaceClipEmbedder:
    """Normalized image/text features from Hugging Face's CLIP interfaces."""

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL_ID,
        *,
        revision: str | None = None,
        device: str = "auto",
        offline: bool = False,
        cache_dir: Path | None = None,
    ):
        # Some processor sub-loaders consult the Hub's process-level offline flag rather than
        # forwarding local_files_only consistently. Set it before importing Transformers so an
        # explicitly offline process never performs network probes.
        if offline:
            os.environ["HF_HUB_OFFLINE"] = "1"
        try:
            import torch
            from transformers import AutoProcessor, CLIPModel
        except ImportError as exc:
            raise ClipLoadError(
                "CLIP dependencies are missing; install with `uv sync --extra clip`."
            ) from exc
        self.torch = torch
        self.model_id = model_id
        self.revision = revision
        self.device = resolve_device(device)
        options = {
            "revision": revision,
            "local_files_only": offline,
            "cache_dir": str(cache_dir) if cache_dir else None,
        }
        options = {key: value for key, value in options.items() if value is not None}
        try:
            self.processor = AutoProcessor.from_pretrained(model_id, **options)
            self.model = CLIPModel.from_pretrained(model_id, **options).to(self.device).eval()
        except (OSError, ValueError) as exc:
            mode = "offline cache" if offline else "Hugging Face Hub/cache"
            raise ClipLoadError(
                f"Could not load {model_id!r} from the {mode}. "
                "Run once online to prepare the cache, or correct GODS_EYE_HF_CACHE."
            ) from exc
        self.dimension = int(self.model.config.projection_dim)

    def _normalized(self, features) -> np.ndarray:
        features = self.torch.nn.functional.normalize(features, dim=-1)
        return np.ascontiguousarray(features.detach().cpu().float().numpy(), dtype=np.float32)

    def embed_text(self, text: str) -> np.ndarray:
        inputs = self.processor(
            text=[text], return_tensors="pt", padding=True, truncation=True
        )
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self.torch.inference_mode():
            features = self.model.get_text_features(**inputs)
        return self._normalized(features)[0]

    def embed_images(self, images: Sequence[Image.Image]) -> np.ndarray:
        inputs = self.processor(images=list(images), return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self.torch.inference_mode():
            features = self.model.get_image_features(**inputs)
        return self._normalized(features)


def prepare_cache() -> None:
    from .config import get_settings

    settings = get_settings()
    parser = argparse.ArgumentParser(description="Prepare CLIP assets for an offline demonstration")
    parser.add_argument("--model-id", default=settings.model_id)
    parser.add_argument("--revision", default=settings.model_revision)
    parser.add_argument("--cache-dir", type=Path, default=settings.hf_cache)
    parser.add_argument("--device", default=settings.device)
    args = parser.parse_args()
    HuggingFaceClipEmbedder(args.model_id, revision=args.revision, cache_dir=args.cache_dir,
                            device=args.device, offline=False)
    print(f"Prepared {args.model_id!r} in {args.cache_dir or 'the default Hugging Face cache'}")
