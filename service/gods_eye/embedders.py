from __future__ import annotations

from pathlib import Path
from typing import assert_never

from .clip import HuggingFaceClipEmbedder
from .clip_models import ModelRegistry, checkpoint_root_for
from .openclip_embedder import OpenClipEmbedder
from .retrieval import RuntimeEmbedder


def create_embedder(
    model_id: str,
    *,
    revision: str | None,
    device: str,
    offline: bool,
    cache_dir: Path | None,
    text_only: bool = False,
) -> RuntimeEmbedder:
    checkpoint_root = checkpoint_root_for(cache_dir) if cache_dir is not None else None
    spec = ModelRegistry(checkpoint_root).get(model_id)
    match spec.backend:
        case "hf":
            return HuggingFaceClipEmbedder(
                spec.model_id,
                revision=revision,
                device=device,
                offline=offline,
                cache_dir=cache_dir,
                text_only=text_only,
            )
        case "openclip":
            return OpenClipEmbedder(
                spec,
                revision=revision,
                device=device,
                offline=offline,
                cache_dir=cache_dir,
                text_only=text_only,
            )
        case unreachable:
            assert_never(unreachable)
