import hashlib
import sys
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import ClassVar

import numpy as np
import pytest
from gods_eye.checkpoint_registry import Registration, write_registration
from gods_eye.clip import ClipLoadError, HuggingFaceClipEmbedder
from gods_eye.clip_models import (
    ClipModelSpec,
    OpenClipArch,
    UnsupportedClipModelError,
    parse_baseline_id,
)
from gods_eye.embedders import create_embedder
from PIL import Image


class RecordingEmbedder:
    calls: ClassVar[list[tuple[tuple, dict]]] = []

    def __init__(self, *args, **kwargs) -> None:
        self.calls.append((args, kwargs))


class NumpyTensor:
    def __init__(self, values) -> None:
        self.values = np.asarray(values, dtype=np.float32)

    def to(self, device: str):
        del device
        return self

    def detach(self):
        return self

    def cpu(self):
        return self

    def float(self):
        return self

    def numpy(self) -> np.ndarray:
        return self.values


def _fake_torch(monkeypatch) -> ModuleType:
    torch = ModuleType("torch")
    torch.cuda = SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
    torch.nn = SimpleNamespace(
        functional=SimpleNamespace(
            normalize=lambda features, dim: NumpyTensor(
                features.values / np.linalg.norm(features.values, axis=dim, keepdims=True)
            )
        )
    )
    torch.inference_mode = nullcontext
    torch.from_numpy = lambda values: NumpyTensor(values)
    monkeypatch.setitem(sys.modules, "torch", torch)
    return torch


def _fake_openclip_runtime(monkeypatch, *, state: object):
    _fake_torch(monkeypatch)
    load_calls: list[tuple[str, object]] = []

    class Model:
        text_projection = np.zeros((3, 4), dtype=np.float32)
        visual = object()

        def float(self):
            return self

        def eval(self):
            return self

        def load_state_dict(self, loaded_state, *, strict: bool):
            load_calls.append(("load_state_dict", (loaded_state, strict)))

    model = Model()
    open_clip = ModuleType("open_clip")
    open_clip.create_model = lambda *args, **kwargs: model
    open_clip.load_checkpoint = lambda *args, **kwargs: pytest.fail(
        "registered checkpoints must load safetensors directly"
    )
    open_clip.get_model_preprocess_cfg = lambda loaded_model: {
        "mean": (0.5, 0.5, 0.5),
        "std": (0.5, 0.5, 0.5),
        "interpolation": "bicubic",
    }
    open_clip.get_tokenizer = lambda model_name: (lambda texts: NumpyTensor([[1, 2, 3] for _ in texts]))
    monkeypatch.setitem(sys.modules, "open_clip", open_clip)

    safe_package = ModuleType("safetensors")
    safe_package.__path__ = []
    safe_torch = ModuleType("safetensors.torch")
    safe_torch.load_file = lambda path: (load_calls.append(("load_file", path)) or state)
    monkeypatch.setitem(sys.modules, "safetensors", safe_package)
    monkeypatch.setitem(sys.modules, "safetensors.torch", safe_torch)
    return model, load_calls


@pytest.fixture(autouse=True)
def reset_recorded_calls() -> None:
    RecordingEmbedder.calls.clear()


def test_create_embedder_routes_baseline_to_openclip(monkeypatch, tmp_path: Path) -> None:
    from gods_eye import embedders

    monkeypatch.setattr(embedders, "OpenClipEmbedder", RecordingEmbedder)

    result = create_embedder(
        "openclip/ViT-B-16@openai:384x128-reid",
        revision="baseline-revision",
        device="cpu",
        offline=True,
        cache_dir=tmp_path,
        text_only=True,
    )

    assert isinstance(result, RecordingEmbedder)
    (args, kwargs), = RecordingEmbedder.calls
    assert args[0].arch == parse_baseline_id("openclip/ViT-B-16@openai:384x128-reid")
    assert args[0].checkpoint_dir is None
    assert kwargs == {
        "revision": "baseline-revision",
        "device": "cpu",
        "offline": True,
        "cache_dir": tmp_path,
        "text_only": True,
    }


def test_create_embedder_routes_registered_checkpoint_with_checkpoint_path(
    monkeypatch, tmp_path: Path
) -> None:
    from gods_eye import embedders

    monkeypatch.setattr(embedders, "OpenClipEmbedder", RecordingEmbedder)
    cache_dir = tmp_path / "cache"
    checkpoint_root = cache_dir / "labclip-checkpoints"
    weights_sha256 = "1" * 64
    registration = Registration(
        model_id=f"labclip:cuhk-pedes:{weights_sha256[:12]}",
        label="Fine tuned test model",
        weights_sha256=weights_sha256,
        source_sha256="2" * 64,
        source_filename="checkpoint.pt",
        arch=OpenClipArch("ViT-B-16", "openai", 384, 128, "reid"),
        verified=True,
        registered_at=datetime(2026, 9, 25, tzinfo=UTC).isoformat(),
        provenance={},
        reference_metrics=None,
    )
    write_registration(checkpoint_root, registration)

    result = create_embedder(
        registration.model_id,
        revision=None,
        device="cpu",
        offline=True,
        cache_dir=cache_dir,
    )

    assert isinstance(result, RecordingEmbedder)
    (args, kwargs), = RecordingEmbedder.calls
    assert args[0].model_id == registration.model_id
    assert args[0].arch == registration.arch
    assert args[0].checkpoint_dir == checkpoint_root / weights_sha256
    assert kwargs == {
        "revision": None,
        "device": "cpu",
        "offline": True,
        "cache_dir": cache_dir,
        "text_only": False,
    }


def test_create_embedder_routes_huggingface_reference(monkeypatch, tmp_path: Path) -> None:
    from gods_eye import embedders

    monkeypatch.setattr(embedders, "HuggingFaceClipEmbedder", RecordingEmbedder)

    result = create_embedder(
        "openai/clip-vit-base-patch16",
        revision="hf-revision",
        device="cpu",
        offline=True,
        cache_dir=tmp_path,
        text_only=True,
    )

    assert isinstance(result, RecordingEmbedder)
    (args, kwargs), = RecordingEmbedder.calls
    assert args == ("openai/clip-vit-base-patch16",)
    assert kwargs == {
        "revision": "hf-revision",
        "device": "cpu",
        "offline": True,
        "cache_dir": tmp_path,
        "text_only": True,
    }


def test_create_embedder_rejects_unknown_model_id(tmp_path: Path) -> None:
    with pytest.raises(UnsupportedClipModelError):
        create_embedder(
            "unknown/model",
            revision=None,
            device="cpu",
            offline=True,
            cache_dir=tmp_path,
        )


def test_build_openclip_model_uses_registered_architecture_and_source(monkeypatch) -> None:
    from gods_eye.clip_models import PRETRAINED_SOURCES
    from gods_eye.openclip_embedder import build_openclip_model

    calls: list[tuple[tuple, dict]] = []
    model = object()
    open_clip = ModuleType("open_clip")
    open_clip.create_model = lambda *args, **kwargs: (calls.append((args, kwargs)) or model)
    monkeypatch.setitem(sys.modules, "open_clip", open_clip)
    arch = OpenClipArch("ViT-B-16", "openai", 384, 128, "reid")

    result = build_openclip_model(arch, device="cpu")

    source = PRETRAINED_SOURCES[(arch.model_name, arch.pretrained)]
    assert result is model
    assert calls == [
        (
            ("ViT-B-16",),
            {
                "pretrained": None,
                "force_image_size": (384, 128),
                "force_quick_gelu": source.quick_gelu,
                "device": "cpu",
            },
        )
    ]


def test_baseline_weights_path_uses_pinned_hub_snapshot(monkeypatch, tmp_path: Path) -> None:
    from gods_eye.clip_models import PRETRAINED_SOURCES
    from gods_eye.openclip_embedder import baseline_weights_path

    arch = OpenClipArch("ViT-B-16", "openai", 384, 128, "reid")
    source = PRETRAINED_SOURCES[(arch.model_name, arch.pretrained)]
    path = (
        tmp_path
        / "models--timm--vit_base_patch16_clip_224.openai"
        / "snapshots"
        / source.revision
        / source.filename
    )
    calls: list[tuple[tuple, dict]] = []
    hub = ModuleType("huggingface_hub")
    hub.hf_hub_download = lambda *args, **kwargs: (calls.append((args, kwargs)) or str(path))
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)

    result = baseline_weights_path(arch, revision=source.revision, cache_dir=tmp_path, offline=True)

    assert result == path
    assert calls == [
        (
            (source.repo_id, source.filename),
            {
                "revision": source.revision,
                "cache_dir": tmp_path,
                "local_files_only": True,
            },
        )
    ]


def test_baseline_weights_path_rejects_different_resolved_revision(
    monkeypatch, tmp_path: Path
) -> None:
    from gods_eye.clip import ClipLoadError
    from gods_eye.clip_models import PRETRAINED_SOURCES
    from gods_eye.openclip_embedder import baseline_weights_path

    arch = OpenClipArch("ViT-B-16", "openai", 384, 128, "reid")
    source = PRETRAINED_SOURCES[(arch.model_name, arch.pretrained)]
    path = tmp_path / "snapshots" / source.revision / source.filename
    hub = ModuleType("huggingface_hub")
    hub.hf_hub_download = lambda *args, **kwargs: str(path)
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)

    with pytest.raises(ClipLoadError, match="resolved revision"):
        baseline_weights_path(arch, revision="a" * 40, cache_dir=tmp_path, offline=True)


def test_openclip_checkpoint_loads_strictly_and_can_drop_vision(
    monkeypatch, tmp_path: Path
) -> None:
    from gods_eye.openclip_embedder import OpenClipEmbedder

    weights_path = tmp_path / "model.safetensors"
    weights_path.write_bytes(b"safe checkpoint data")
    digest = hashlib.sha256(weights_path.read_bytes()).hexdigest()
    state = object()
    model, calls = _fake_openclip_runtime(monkeypatch, state=state)
    arch = OpenClipArch("ViT-B-16", "openai", 384, 128, "reid")
    spec = ClipModelSpec(
        model_id="labclip:cuhk-pedes:111111111111",
        label="fine tuned",
        storage_key="labclip-111111111111",
        backend="openclip",
        group="fine-tuned",
        arch=arch,
        checkpoint_dir=tmp_path,
    )

    embedder = OpenClipEmbedder(
        spec,
        revision=f"sha256:{digest}",
        device="cpu",
        offline=True,
        cache_dir=tmp_path,
        text_only=True,
    )

    assert calls == [
        ("load_file", weights_path),
        ("load_state_dict", (state, True)),
    ]
    assert model.visual is None
    assert embedder.dimension == 4
    with pytest.raises(ClipLoadError, match="text-only"):
        embedder.embed_images([Image.new("RGB", (2, 2))])


def test_openclip_checkpoint_revision_digest_is_checked_before_loading(
    monkeypatch, tmp_path: Path
) -> None:
    from gods_eye.openclip_embedder import OpenClipEmbedder

    (tmp_path / "model.safetensors").write_bytes(b"safe checkpoint data")
    model, calls = _fake_openclip_runtime(monkeypatch, state=object())
    arch = OpenClipArch("ViT-B-16", "openai", 384, 128, "reid")
    spec = ClipModelSpec(
        model_id="labclip:cuhk-pedes:111111111111",
        label="fine tuned",
        storage_key="labclip-111111111111",
        backend="openclip",
        group="fine-tuned",
        arch=arch,
        checkpoint_dir=tmp_path,
    )

    with pytest.raises(ClipLoadError, match="do not match"):
        OpenClipEmbedder(spec, revision=f"sha256:{'0' * 64}", device="cpu")

    assert calls == []
    assert model.visual is not None


def test_huggingface_text_only_embedder_batches_text_without_loading_images(monkeypatch) -> None:
    torch = _fake_torch(monkeypatch)
    batches: list[list[str]] = []

    class Processor:
        def __call__(self, *, text, **kwargs):
            del kwargs
            batches.append(text)
            return {"input_ids": NumpyTensor([[len(value), 1, 2] for value in text])}

    class Model:
        config = SimpleNamespace(projection_dim=3)
        vision_model = object()
        visual_projection = object()

        def to(self, device: str):
            del device
            return self

        def eval(self):
            return self

        def get_text_features(self, *, input_ids):
            return input_ids

    processor = Processor()
    model = Model()
    transformers = ModuleType("transformers")
    transformers.AutoProcessor = SimpleNamespace(from_pretrained=lambda *args, **kwargs: processor)
    transformers.CLIPModel = SimpleNamespace(from_pretrained=lambda *args, **kwargs: model)
    monkeypatch.setitem(sys.modules, "transformers", transformers)

    embedder = HuggingFaceClipEmbedder(
        "openai/clip-vit-base-patch16", device="cpu", text_only=True
    )
    embeddings = embedder.embed_texts(["first", "second", "third"], batch_size=2)

    assert batches == [["first", "second"], ["third"]]
    assert embeddings.shape == (3, 3)
    np.testing.assert_allclose(np.linalg.norm(embeddings, axis=1), 1.0)
    assert model.vision_model is None
    assert model.visual_projection is None
    assert torch.cuda.is_available() is False
    with pytest.raises(ClipLoadError, match="text-only"):
        embedder.embed_images([Image.new("RGB", (2, 2))])
