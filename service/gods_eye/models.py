from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .clip_models import DEFAULT_MODEL_ID, is_known_model_id_shape

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
        if not is_known_model_id_shape(value):
            raise SearchValidationError(f"Unsupported CLIP model ID: {value!r}")
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
    group: Literal["reference", "baseline", "fine-tuned"] = "reference"
    paired_baseline_id: str | None = None
    verified: bool = True
    registered_at: str | None = None
    evaluation_ready: bool = False


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


class BenchmarkMetrics(BaseModel):
    model_config = ConfigDict(frozen=True)

    top1: float
    top5: float
    top10: float
    mAP: float
    mINP: float


class BenchmarkReference(BaseModel):
    model_config = ConfigDict(frozen=True)

    source: str
    metrics: BenchmarkMetrics
    gallery: int
    queries: int
    delta_top1_pp: float
    warning: bool


class ModelBenchmark(BaseModel):
    model_config = ConfigDict(frozen=True)

    model_id: str
    label: str
    group: Literal["reference", "baseline", "fine-tuned"]
    paired_baseline_id: str | None
    verified: bool
    index_version: str | None
    metrics: BenchmarkMetrics | None
    delta_vs_baseline_pp: BenchmarkMetrics | None
    reference: BenchmarkReference | None
    provenance: dict[str, str | int | float | bool | None] | None
    benchmark_query_ranks: dict[str, int]


class BenchmarkProtocol(BaseModel):
    model_config = ConfigDict(frozen=True)

    dataset: str = "CUHK-PEDES"
    split: str = "test"
    direction: str = "text-to-image"
    ground_truth: str = "person-id"
    query_count: int | None = None
    gallery_count: int | None = None


class BenchmarkResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    protocol: BenchmarkProtocol
    models: list[ModelBenchmark]


class BenchmarkQueryItem(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    caption: str


class BenchmarkQueriesResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    queries: list[BenchmarkQueryItem]


class BenchmarkSearchRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    query_id: str
    model_id: str
    top_k: Annotated[int, Field(ge=1, le=100)] = 24

    @field_validator("model_id")
    @classmethod
    def model_id_must_be_supported(cls, value: str) -> str:
        if not is_known_model_id_shape(value):
            raise SearchValidationError(f"Unsupported CLIP model ID: {value!r}")
        return value


class BenchmarkSearchResult(SearchResult):
    is_match: bool


class BenchmarkSearchResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    query_id: str
    caption: str
    model_id: str
    active_index_version: str
    first_match_rank: int
    results: list[BenchmarkSearchResult]
