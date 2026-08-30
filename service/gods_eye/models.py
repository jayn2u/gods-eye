from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

Dataset = Literal["CUHK-PEDES", "ICFG-PEDES", "RSTPReid"]
SUPPORTED_DATASETS: tuple[Dataset, ...] = ("CUHK-PEDES", "ICFG-PEDES", "RSTPReid")


class SearchRequest(BaseModel):
    query: Annotated[str, Field(min_length=1, max_length=500)]
    top_k: Annotated[int, Field(ge=1, le=100)] = 24
    datasets: Annotated[list[Dataset], Field(min_length=1)] = list(SUPPORTED_DATASETS)

    @field_validator("query")
    @classmethod
    def query_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter a description to search")
        return value

    @field_validator("datasets")
    @classmethod
    def datasets_must_be_unique(cls, value: list[Dataset]) -> list[Dataset]:
        if len(value) != len(set(value)):
            raise ValueError("Dataset selection must not contain duplicates")
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
    results: list[SearchResult]


class ReadinessResponse(BaseModel):
    ready: bool
    model_id: str | None = None
    active_index_version: str | None = None
    gallery_count: int | None = None
    guidance: str | None = None
