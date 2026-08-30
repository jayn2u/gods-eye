from pathlib import Path

from gods_eye.config import ClipRuntimeConfig, Settings


def test_safe_local_defaults() -> None:
    settings = Settings(_env_file=None)
    assert settings.bind_host == "127.0.0.1"
    assert settings.bind_port == 8000
    assert settings.model_id == "openai/clip-vit-base-patch16"
    assert settings.active_index == Path("indexes/active")
    assert settings.offline is False
    assert settings.clip_runtime == ClipRuntimeConfig(
        model_id="openai/clip-vit-base-patch16",
        device="auto",
    )
