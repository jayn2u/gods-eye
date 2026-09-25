from __future__ import annotations

import hashlib
import re
from collections.abc import Sequence
from pathlib import Path

import numpy as np
from PIL import Image

from .clip import ClipLoadError, resolve_device
from .clip_models import PRETRAINED_SOURCES, ClipModelSpec, OpenClipArch
from .reid_preprocess import batch_preprocess

_CHECKPOINT_REVISION = re.compile(r"sha256:([0-9a-f]{64})")


def build_openclip_model(arch: OpenClipArch, *, device: str = "cpu"):
    source = PRETRAINED_SOURCES.get((arch.model_name, arch.pretrained))
    if source is None:
        raise ClipLoadError(
            f"No pinned OpenCLIP weights source exists for {arch.model_name!r}/{arch.pretrained!r}."
        )
    try:
        import open_clip
    except ImportError as exc:
        raise ClipLoadError("OpenCLIP dependencies are missing; install with `uv sync --extra clip`.") from exc
    try:
        return open_clip.create_model(
            arch.model_name,
            pretrained=None,
            force_image_size=(arch.img_height, arch.img_width),
            force_quick_gelu=source.quick_gelu,
            device=device,
        )
    except Exception as exc:
        raise ClipLoadError(f"Could not build OpenCLIP model {arch.model_name!r}.") from exc


def baseline_weights_path(
    arch: OpenClipArch,
    *,
    revision: str | None,
    cache_dir: Path | None,
    offline: bool,
) -> Path:
    source = PRETRAINED_SOURCES.get((arch.model_name, arch.pretrained))
    if source is None:
        raise ClipLoadError(
            f"No pinned OpenCLIP weights source exists for {arch.model_name!r}/{arch.pretrained!r}."
        )
    requested_revision = revision or source.revision
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as exc:
        raise ClipLoadError(
            "Hugging Face Hub dependencies are missing; install with `uv sync --extra clip`."
        ) from exc
    try:
        path = Path(
            hf_hub_download(
                source.repo_id,
                source.filename,
                revision=requested_revision,
                cache_dir=cache_dir,
                local_files_only=offline,
            )
        )
    except Exception as exc:
        mode = "offline cache" if offline else "Hugging Face Hub/cache"
        raise ClipLoadError(f"Could not load OpenCLIP baseline weights from the {mode}.") from exc
    resolved_revision = path.parent.name
    if resolved_revision != requested_revision:
        raise ClipLoadError(
            f"OpenCLIP baseline resolved revision {resolved_revision!r}, "
            f"which differs from requested revision {requested_revision!r}."
        )
    return path


class OpenClipEmbedder:
    """OpenCLIP text and image embeddings for baselines and registered checkpoints."""

    def __init__(
        self,
        spec: ClipModelSpec,
        *,
        revision: str | None,
        device: str = "auto",
        offline: bool = False,
        cache_dir: Path | None = None,
        text_only: bool = False,
    ) -> None:
        if spec.backend != "openclip" or spec.arch is None:
            raise ClipLoadError("An OpenCLIP model specification with an architecture is required.")
        try:
            import open_clip
            import torch
        except ImportError as exc:
            raise ClipLoadError(
                "OpenCLIP dependencies are missing; install with `uv sync --extra clip`."
            ) from exc
        self.torch = torch
        self.open_clip = open_clip
        self.spec = spec
        self.arch = spec.arch
        self.device = resolve_device(device)
        self.text_only = text_only
        self._closed = False
        try:
            self.model = build_openclip_model(self.arch, device=self.device)
            if spec.checkpoint_dir is not None:
                self._load_checkpoint(spec.checkpoint_dir, revision)
            else:
                path = baseline_weights_path(
                    self.arch,
                    revision=revision,
                    cache_dir=cache_dir,
                    offline=offline,
                )
                self.open_clip.load_checkpoint(self.model, path)
            self.model.float().eval()
            self.dimension = _embedding_dimension(self.model)
            self._preprocess_options = _preprocess_options(
                self.arch, self.open_clip.get_model_preprocess_cfg(self.model)
            )
            self.tokenizer = self.open_clip.get_tokenizer(self.arch.model_name)
            if text_only:
                self.model.visual = None
                if self.device.startswith("cuda"):
                    self.torch.cuda.empty_cache()
        except ClipLoadError:
            raise
        except Exception as exc:
            raise ClipLoadError(f"Could not load OpenCLIP model {spec.model_id!r}.") from exc

    def _load_checkpoint(self, checkpoint_dir: Path, revision: str | None) -> None:
        weights_path = checkpoint_dir / "model.safetensors"
        if not weights_path.is_file():
            raise ClipLoadError(f"Checkpoint weights are missing at {weights_path}.")
        if revision is not None and revision.startswith("sha256:"):
            match = _CHECKPOINT_REVISION.fullmatch(revision)
            if match is None:
                raise ClipLoadError("Checkpoint revision must use sha256:<64 lowercase hex digits>.")
            digest = _sha256_file(weights_path)
            if digest != match.group(1):
                raise ClipLoadError("Checkpoint weights do not match the requested SHA-256 revision.")
        try:
            from safetensors.torch import load_file
        except ImportError as exc:
            raise ClipLoadError(
                "Safetensors dependencies are missing; install with `uv sync --extra clip`."
            ) from exc
        state = load_file(weights_path)
        self.model.load_state_dict(state, strict=True)

    def embed_text(self, text: str) -> np.ndarray:
        return self.embed_texts([text])[0]

    def embed_texts(self, texts: Sequence[str], batch_size: int = 256) -> np.ndarray:
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        if not texts:
            return np.empty((0, self.dimension), dtype=np.float32)
        embeddings = []
        for start in range(0, len(texts), batch_size):
            tokens = self.tokenizer(list(texts[start : start + batch_size])).to(self.device)
            with self.torch.inference_mode():
                features = self.model.encode_text(tokens).float()
                features = self.torch.nn.functional.normalize(features, dim=-1)
            embeddings.append(_to_numpy(features))
        return np.ascontiguousarray(np.concatenate(embeddings), dtype=np.float32)

    def embed_images(self, images: Sequence[Image.Image]) -> np.ndarray:
        if self.text_only:
            raise ClipLoadError("Image embeddings are unavailable for a text-only OpenCLIP embedder.")
        if not images:
            return np.empty((0, self.dimension), dtype=np.float32)
        processed = batch_preprocess(
            images,
            height=self.arch.img_height,
            width=self.arch.img_width,
            **self._preprocess_options,
        )
        pixels = self.torch.from_numpy(processed).to(self.device)
        with self.torch.inference_mode():
            features = self.model.encode_image(pixels).float()
            features = self.torch.nn.functional.normalize(features, dim=-1)
        return _to_numpy(features)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.device.startswith("cuda"):
            self.model.to("cpu")
            self.torch.cuda.empty_cache()
        self.model = None
        self.tokenizer = None


def _embedding_dimension(model) -> int:
    projection = getattr(model, "text_projection", None)
    if projection is not None:
        if hasattr(projection, "shape") and projection.shape:
            return int(projection.shape[-1])
        if hasattr(projection, "out_features"):
            return int(projection.out_features)
    raise ClipLoadError("OpenCLIP model does not expose a text projection dimension.")


def _preprocess_options(arch: OpenClipArch, config: dict) -> dict:
    if arch.preprocess_mode == "reid":
        return {"interpolation": "bilinear"}
    return {
        "mean": config["mean"],
        "std": config["std"],
        "interpolation": config.get("interpolation", "bicubic"),
    }


def _to_numpy(features) -> np.ndarray:
    return np.ascontiguousarray(features.detach().cpu().float().numpy(), dtype=np.float32)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ClipLoadError(f"Could not verify checkpoint weights at {path}.") from exc
    return digest.hexdigest()
