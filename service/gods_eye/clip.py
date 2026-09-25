from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

import numpy as np
from PIL import Image

from .clip_models import DEFAULT_MODEL_ID
from .config import ClipRuntimeConfig


class ClipLoadError(RuntimeError):
    """CLIP assets are unavailable or the requested runtime cannot be initialized."""


def resolve_device(requested: str = "auto") -> str:
    try:
        import torch
    except ImportError as exc:  # pragma: no cover - dependency extra owns this path
        raise ClipLoadError(
            "PyTorch is required for CLIP inference; install the `clip` extra."
        ) from exc
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
        text_only: bool = False,
    ):
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
        self.text_only = text_only
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
        if text_only:
            self.model.vision_model = None
            self.model.visual_projection = None
            if self.device.startswith("cuda"):
                self.torch.cuda.empty_cache()
        self._closed = False

    @classmethod
    def from_config(cls, config: ClipRuntimeConfig) -> HuggingFaceClipEmbedder:
        return cls(
            config.model_id,
            revision=config.revision,
            device=config.device,
            offline=config.offline,
            cache_dir=config.cache_dir,
        )

    def _normalized(self, features) -> np.ndarray:
        features = self.torch.nn.functional.normalize(features, dim=-1)
        return np.ascontiguousarray(features.detach().cpu().float().numpy(), dtype=np.float32)

    def embed_text(self, text: str) -> np.ndarray:
        return self.embed_texts([text])[0]

    def embed_texts(self, texts: Sequence[str], batch_size: int = 256) -> np.ndarray:
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        if not texts:
            return np.empty((0, self.dimension), dtype=np.float32)
        vectors = []
        for start in range(0, len(texts), batch_size):
            inputs = self.processor(
                text=list(texts[start : start + batch_size]),
                return_tensors="pt",
                padding=True,
                truncation=True,
            )
            inputs = {key: value.to(self.device) for key, value in inputs.items()}
            with self.torch.inference_mode():
                features = self.model.get_text_features(**inputs)
            vectors.append(self._normalized(features))
        return np.ascontiguousarray(np.concatenate(vectors), dtype=np.float32)

    def embed_images(self, images: Sequence[Image.Image]) -> np.ndarray:
        if self.text_only:
            raise ClipLoadError("Image embeddings are unavailable for a text-only CLIP embedder.")
        if not images:
            return np.empty((0, self.dimension), dtype=np.float32)
        inputs = self.processor(images=list(images), return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self.torch.inference_mode():
            features = self.model.get_image_features(**inputs)
        return self._normalized(features)

    def close(self) -> None:
        """Release model references and return allocated CUDA memory to the runtime."""
        if self._closed:
            return
        self._closed = True
        self.model.to("cpu")
        del self.model
        del self.processor
        if self.device.startswith("cuda"):
            self.torch.cuda.empty_cache()


def prepare_cache() -> None:
    from .config import get_settings

    settings = get_settings()
    parser = argparse.ArgumentParser(description="Prepare CLIP assets for an offline demonstration")
    parser.add_argument("--model-id", default=settings.model_id)
    parser.add_argument("--revision", default=settings.model_revision)
    parser.add_argument("--cache-dir", type=Path, default=settings.hf_cache)
    parser.add_argument("--device", default=settings.device)
    args = parser.parse_args()
    HuggingFaceClipEmbedder.from_config(
        ClipRuntimeConfig(
            model_id=args.model_id,
            revision=args.revision,
            cache_dir=args.cache_dir,
            device=args.device,
        )
    )
    print(f"Prepared {args.model_id!r} in {args.cache_dir or 'the default Hugging Face cache'}")
