from dataclasses import dataclass
from typing import Final


@dataclass(frozen=True, slots=True)
class ClipModelSpec:
    model_id: str
    label: str
    storage_key: str


@dataclass(frozen=True, slots=True)
class UnsupportedClipModelError(ValueError):
    model_id: str

    def __str__(self) -> str:
        return f"Unsupported CLIP model ID: {self.model_id!r}"


CLIP_MODELS: Final[tuple[ClipModelSpec, ...]] = (
    ClipModelSpec("openai/clip-vit-base-patch32", "ViT-B/32", "clip-vit-b-32"),
    ClipModelSpec("openai/clip-vit-base-patch16", "ViT-B/16", "clip-vit-b-16"),
    ClipModelSpec("openai/clip-vit-large-patch14", "ViT-L/14", "clip-vit-l-14"),
    ClipModelSpec("openai/clip-vit-large-patch14-336", "ViT-L/14@336px", "clip-vit-l-14-336"),
)
DEFAULT_MODEL_ID: Final = "openai/clip-vit-base-patch16"


def get_clip_model(model_id: str) -> ClipModelSpec:
    for spec in CLIP_MODELS:
        if spec.model_id == model_id:
            return spec
    raise UnsupportedClipModelError(model_id)
