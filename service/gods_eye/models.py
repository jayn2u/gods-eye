from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .clip_models import DEFAULT_MODEL_ID, UnsupportedClipModelError, get_clip_model

Dataset = Literal["CUHK-PEDES"]
SUPPORTED_DATASETS: tuple[Dataset, ...] = ("CUHK-PEDES",)


class SearchValidationError(ValueError):
    pass


class SearchRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    query: Annotated[str, Field(min_length=1, max_length=500)]
    model_id: str = DEFAULT_MODEL_ID
    top_k: Annotated[int, Field(ge=1, le=100)] = 24
    datasets: Annotated[list[Dataset], Field(min_length=1)] = list(SUPPORTED_DATASETS)

    @field_validator("query")
    @classmethod
    def query_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise SearchValidationError("Enter a description to search")
        return value

    @field_validator("model_id")
    @classmethod
    def model_id_must_be_supported(cls, value: str) -> str:
        try:
            get_clip_model(value)
        except UnsupportedClipModelError as exc:
            raise SearchValidationError(str(exc)) from exc
        return value

    @field_validator("datasets")
    @classmethod
    def datasets_must_be_unique(cls, value: list[Dataset]) -> list[Dataset]:
        if len(value) != len(set(value)):
            raise SearchValidationError("Dataset selection must not contain duplicates")
        return value


class SearchResult(BaseModel):
    rank: int
    similarity: float
    dataset: Dataset
    id: str
    split: Literal["train", "validation", "test"]
    image_url: str


class SearchResponse(BaseModel):
    query: str
    model_id: str
    active_index_version: str
    results: list[SearchResult]


class ModelAvailability(BaseModel):
    model_config = ConfigDict(frozen=True)

    model_id: str
    label: str
    ready: bool
    active_index_version: str | None = None
    gallery_count: int | None = None
    guidance: str | None = None


class ModelCatalogResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    default_model_id: str = DEFAULT_MODEL_ID
    models: tuple[ModelAvailability, ...]


class ReadinessResponse(BaseModel):
    ready: bool
    model_id: str | None = None
    active_index_version: str | None = None
    gallery_count: int | None = None
    guidance: str | None = None
