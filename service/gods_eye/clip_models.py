from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, Literal

Backend = Literal["hf", "openclip"]
ModelGroup = Literal["reference", "baseline", "fine-tuned"]


@dataclass(frozen=True, slots=True)
class OpenClipArch:
    model_name: str
    pretrained: str
    img_height: int
    img_width: int
    preprocess_mode: Literal["reid", "model_reid"]

    def __post_init__(self) -> None:
        if not isinstance(self.model_name, str) or not self.model_name:
            raise ValueError("model_name must be a non-empty string")
        if not isinstance(self.pretrained, str) or not self.pretrained:
            raise ValueError("pretrained must be a non-empty string")
        if (
            not isinstance(self.img_height, int)
            or isinstance(self.img_height, bool)
            or self.img_height < 1
            or not isinstance(self.img_width, int)
            or isinstance(self.img_width, bool)
            or self.img_width < 1
        ):
            raise ValueError("image size must use positive integer dimensions")
        if not isinstance(self.preprocess_mode, str) or self.preprocess_mode not in {
            "reid",
            "model_reid",
        }:
            raise ValueError("preprocess_mode must be 'reid' or 'model_reid'")

    @property
    def baseline_model_id(self) -> str:
        return (
            f"openclip/{self.model_name}@{self.pretrained}:"
            f"{self.img_height}x{self.img_width}-{self.preprocess_mode}"
        )

    @property
    def baseline_storage_key(self) -> str:
        model_name = self.model_name.lower().replace("_", "-")
        pretrained = self.pretrained.lower().replace("_", "-")
        return (
            f"openclip-{model_name}-{pretrained}-{self.img_height}x{self.img_width}-"
            f"{self.preprocess_mode}"
        )

    @property
    def baseline_label(self) -> str:
        name, separator, patch_size = self.model_name.rpartition("-")
        display_name = f"{name}/{patch_size}" if separator else self.model_name
        mode_label = "ReID" if self.preprocess_mode == "reid" else "model-ReID"
        return f"{display_name} zero-shot · {self.img_height}×{self.img_width} {mode_label}"


@dataclass(frozen=True, slots=True)
class PretrainedSource:
    repo_id: str
    filename: str
    revision: str
    quick_gelu: bool


@dataclass(frozen=True, slots=True)
class ClipModelSpec:
    model_id: str
    label: str
    storage_key: str
    backend: Backend = "hf"
    group: ModelGroup = "reference"
    arch: OpenClipArch | None = None
    paired_baseline_id: str | None = None
    checkpoint_dir: Path | None = None
    verified: bool = True
    registered_at: str | None = None


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

PRETRAINED_SOURCES: Final[dict[tuple[str, str], PretrainedSource]] = {
    ("ViT-B-16", "openai"): PretrainedSource(
        repo_id="timm/vit_base_patch16_clip_224.openai",
        filename="open_clip_model.safetensors",
        revision="977e3dd0ec55ab8da155f2fbeb6b5f54948b6e3d",
        quick_gelu=True,
    )
}
VERIFIED_ARCHS: Final[frozenset[tuple[str, str]]] = frozenset({("ViT-B-16", "openai")})
CHECKPOINT_ID_PATTERN: Final = re.compile(r"labclip:cuhk-pedes:[0-9a-f]{12}")
BASELINE_ID_PATTERN: Final = re.compile(
    r"openclip/([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):(\d+)x(\d+)-(reid|model_reid)"
)


def get_clip_model(model_id: str) -> ClipModelSpec:
    for spec in CLIP_MODELS:
        if spec.model_id == model_id:
            return spec
    raise UnsupportedClipModelError(model_id)


def parse_baseline_id(model_id: str) -> OpenClipArch:
    match = BASELINE_ID_PATTERN.fullmatch(model_id)
    if match is None:
        raise UnsupportedClipModelError(model_id)
    model_name, pretrained, height, width, preprocess_mode = match.groups()
    try:
        image_height = int(height)
        image_width = int(width)
    except ValueError as exc:
        raise UnsupportedClipModelError(model_id) from exc
    if image_height < 1 or image_width < 1:
        raise UnsupportedClipModelError(model_id)
    arch = OpenClipArch(
        model_name,
        pretrained,
        image_height,
        image_width,
        preprocess_mode,  # type: ignore[arg-type]
    )
    if arch.baseline_model_id != model_id:
        raise UnsupportedClipModelError(model_id)
    return arch


def is_known_model_id_shape(model_id: str) -> bool:
    if any(spec.model_id == model_id for spec in CLIP_MODELS):
        return True
    return bool(
        BASELINE_ID_PATTERN.fullmatch(model_id) or CHECKPOINT_ID_PATTERN.fullmatch(model_id)
    )


class ModelRegistry:
    def __init__(self, checkpoint_root: Path | None) -> None:
        self._checkpoint_root = checkpoint_root

    def get(self, model_id: str) -> ClipModelSpec:
        try:
            return get_clip_model(model_id)
        except UnsupportedClipModelError:
            pass

        if BASELINE_ID_PATTERN.fullmatch(model_id):
            arch = parse_baseline_id(model_id)
            if (arch.model_name, arch.pretrained) not in PRETRAINED_SOURCES:
                raise UnsupportedClipModelError(model_id)
            return self._baseline_spec(arch)

        if CHECKPOINT_ID_PATTERN.fullmatch(model_id) and self._checkpoint_root is not None:
            from .checkpoint_registry import find_registration

            found = find_registration(self._checkpoint_root, model_id)
            if found is not None:
                registration, checkpoint_dir = found
                return registration.to_spec(checkpoint_dir)
        raise UnsupportedClipModelError(model_id)

    def all(self) -> tuple[ClipModelSpec, ...]:
        if self._checkpoint_root is None:
            return CLIP_MODELS

        from .checkpoint_registry import read_registrations

        registrations = sorted(
            read_registrations(self._checkpoint_root),
            key=lambda item: _registered_at_datetime(item[0].registered_at),
            reverse=True,
        )
        baselines: dict[str, ClipModelSpec] = {}
        checkpoints: list[ClipModelSpec] = []
        for registration, checkpoint_dir in registrations:
            baseline_id = registration.paired_baseline_id
            if baseline_id not in baselines:
                baselines[baseline_id] = self._baseline_spec(registration.arch)
            checkpoints.append(registration.to_spec(checkpoint_dir))
        return (*CLIP_MODELS, *baselines.values(), *checkpoints)

    @staticmethod
    def _baseline_spec(arch: OpenClipArch) -> ClipModelSpec:
        return ClipModelSpec(
            model_id=arch.baseline_model_id,
            label=arch.baseline_label,
            storage_key=arch.baseline_storage_key,
            backend="openclip",
            group="baseline",
            arch=arch,
            verified=(arch.model_name, arch.pretrained) in VERIFIED_ARCHS,
        )


def _registered_at_datetime(registered_at: str) -> datetime:
    return datetime.fromisoformat(registered_at).astimezone(UTC)


def checkpoint_root_for(cache_dir: Path) -> Path:
    return cache_dir / "labclip-checkpoints"
