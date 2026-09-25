import pytest
from gods_eye.clip_models import (
    BASELINE_ID_PATTERN,
    CHECKPOINT_ID_PATTERN,
    CLIP_MODELS,
    DEFAULT_MODEL_ID,
    VERIFIED_ARCHS,
    ModelRegistry,
    OpenClipArch,
    PretrainedSource,
    UnsupportedClipModelError,
    checkpoint_root_for,
    get_clip_model,
    is_known_model_id_shape,
    parse_baseline_id,
)


def test_registry_has_the_approved_models_in_public_order() -> None:
    assert [(spec.model_id, spec.label, spec.storage_key) for spec in CLIP_MODELS] == [
        ("openai/clip-vit-base-patch32", "ViT-B/32", "clip-vit-b-32"),
        ("openai/clip-vit-base-patch16", "ViT-B/16", "clip-vit-b-16"),
        ("openai/clip-vit-large-patch14", "ViT-L/14", "clip-vit-l-14"),
        ("openai/clip-vit-large-patch14-336", "ViT-L/14@336px", "clip-vit-l-14-336"),
    ]


def test_default_model_is_vit_b_16_registry_entry() -> None:
    assert DEFAULT_MODEL_ID == "openai/clip-vit-base-patch16"
    assert get_clip_model(DEFAULT_MODEL_ID) is CLIP_MODELS[1]


def test_known_model_lookup_preserves_registry_identity() -> None:
    spec = CLIP_MODELS[-1]

    assert get_clip_model(spec.model_id) is spec


@pytest.mark.parametrize("model_id", ["", "community/untrusted-model", "ViT-B/16"])
def test_unknown_model_ids_are_rejected(model_id: str) -> None:
    with pytest.raises(ValueError, match="Unsupported CLIP model ID"):
        get_clip_model(model_id)


def test_builtin_specs_keep_hf_reference_defaults() -> None:
    assert all(spec.backend == "hf" for spec in CLIP_MODELS)
    assert all(spec.group == "reference" for spec in CLIP_MODELS)
    assert all(spec.arch is None for spec in CLIP_MODELS)
    assert all(spec.paired_baseline_id is None for spec in CLIP_MODELS)
    assert all(spec.checkpoint_dir is None for spec in CLIP_MODELS)
    assert all(spec.verified for spec in CLIP_MODELS)
    assert all(spec.registered_at is None for spec in CLIP_MODELS)


def test_openclip_arch_derives_baseline_identity_and_label() -> None:
    arch = OpenClipArch("ViT-B-16", "openai", 384, 128, "reid")

    assert arch.baseline_model_id == "openclip/ViT-B-16@openai:384x128-reid"
    assert arch.baseline_storage_key == "openclip-vit-b-16-openai-384x128-reid"
    assert arch.baseline_label == "ViT-B/16 zero-shot · 384×128 ReID"


def test_model_reid_baseline_label_is_explicit() -> None:
    arch = OpenClipArch("ViT-B-16", "openai", 384, 128, "model_reid")

    assert arch.baseline_label == "ViT-B/16 zero-shot · 384×128 model-ReID"


def test_baseline_ids_parse_and_round_trip() -> None:
    arch = OpenClipArch("ViT-B-16", "openai", 384, 128, "reid")

    assert parse_baseline_id(arch.baseline_model_id) == arch
    assert BASELINE_ID_PATTERN.fullmatch(arch.baseline_model_id)


def test_invalid_baseline_id_is_unsupported() -> None:
    with pytest.raises(UnsupportedClipModelError):
        parse_baseline_id("openclip/ViT-B-16@openai:0x128-reid")


def test_model_id_shapes_include_builtin_baseline_and_checkpoint_ids() -> None:
    baseline_id = "openclip/ViT-B-16@openai:384x128-reid"
    checkpoint_id = "labclip:cuhk-pedes:012345abcdef"

    assert is_known_model_id_shape(DEFAULT_MODEL_ID)
    assert is_known_model_id_shape(baseline_id)
    assert is_known_model_id_shape(checkpoint_id)
    assert BASELINE_ID_PATTERN.fullmatch(baseline_id)
    assert CHECKPOINT_ID_PATTERN.fullmatch(checkpoint_id)
    assert not is_known_model_id_shape("labclip:cuhk-pedes:not-a-digest")


def test_baselines_resolve_by_id_but_are_listed_only_when_referenced(tmp_path) -> None:
    baseline_id = "openclip/ViT-B-16@openai:384x128-reid"
    registry = ModelRegistry(tmp_path)

    baseline = registry.get(baseline_id)

    assert baseline.model_id == baseline_id
    assert baseline.group == "baseline"
    assert baseline.backend == "openclip"
    assert baseline.arch == parse_baseline_id(baseline_id)
    assert baseline_id not in {spec.model_id for spec in registry.all()}


def test_registry_rejects_baseline_without_a_pinned_pretrained_source(tmp_path) -> None:
    model_id = "openclip/ViT-L-14@openai:384x128-reid"

    with pytest.raises(UnsupportedClipModelError):
        ModelRegistry(tmp_path).get(model_id)


def test_pinned_source_catalog_contains_only_verified_source() -> None:
    from gods_eye.clip_models import PRETRAINED_SOURCES

    assert PRETRAINED_SOURCES == {
        ("ViT-B-16", "openai"): PretrainedSource(
            repo_id="timm/vit_base_patch16_clip_224.openai",
            filename="open_clip_model.safetensors",
            revision="977e3dd0ec55ab8da155f2fbeb6b5f54948b6e3d",
            quick_gelu=True,
        )
    }
    assert VERIFIED_ARCHS == frozenset({("ViT-B-16", "openai")})


def test_checkpoint_root_is_scoped_to_the_model_cache(tmp_path) -> None:
    assert checkpoint_root_for(tmp_path) == tmp_path / "labclip-checkpoints"
