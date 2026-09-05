import pytest
from gods_eye.clip_models import CLIP_MODELS, DEFAULT_MODEL_ID, get_clip_model


def test_registry_has_the_approved_models_in_public_order() -> None:
    assert [
        (spec.model_id, spec.label, spec.storage_key)
        for spec in CLIP_MODELS
    ] == [
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
