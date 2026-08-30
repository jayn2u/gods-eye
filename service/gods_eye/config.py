from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


@dataclass(frozen=True)
class ClipRuntimeConfig:
    model_id: str
    revision: str | None = None
    device: str = "auto"
    offline: bool = False
    cache_dir: Path | None = None

    def __post_init__(self) -> None:
        if not self.model_id.strip():
            raise ValueError("CLIP model_id must not be blank")
        if not self.device.strip():
            raise ValueError("CLIP device must not be blank")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GODS_EYE_", env_file=".env", extra="ignore")

    dataset_root: Path = Path("/data/datasets")
    index_root: Path = Path("indexes")
    active_index: Path = Path("indexes/active")
    model_id: str = "openai/clip-vit-base-patch16"
    model_revision: str | None = None
    hf_cache: Path | None = None
    offline: bool = False
    device: str = "auto"
    batch_size: int = 32
    bind_host: str = "127.0.0.1"
    bind_port: int = 8000
    use_fixtures: bool = False
    log_level: str = "INFO"

    @property
    def clip_runtime(self) -> ClipRuntimeConfig:
        return ClipRuntimeConfig(
            model_id=self.model_id,
            revision=self.model_revision,
            device=self.device,
            offline=self.offline,
            cache_dir=self.hf_cache,
        )

    @field_validator("model_revision", mode="before")
    @classmethod
    def blank_revision_is_unset(cls, value: object) -> object:
        return None if value == "" else value


@lru_cache
def get_settings() -> Settings:
    return Settings()
