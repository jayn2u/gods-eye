import json
import logging
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Protocol, assert_never

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from .benchmark import BenchmarkQuery, BenchmarkQueryNotFoundError
from .clip_models import DEFAULT_MODEL_ID
from .config import get_settings
from .index_store import load_active
from .model_runtime import FixtureModelRuntime, ModelRuntimeManager, ModelUnavailableError
from .models import (
    BenchmarkProtocol,
    BenchmarkQueriesResponse,
    BenchmarkQueryItem,
    BenchmarkResponse,
    BenchmarkSearchRequest,
    BenchmarkSearchResponse,
    Dataset,
    ModelAvailability,
    ModelCatalogResponse,
    ReadinessResponse,
    SearchRequest,
    SearchResponse,
)
from .retrieval import (
    FixtureRetrievalEngine,
    IndexedRetrievalEngine,
    ManifestRetrievalEngine,
    RetrievalEngine,
    RuntimeModelAvailability,
    SearchExecution,
    UnavailableRetrievalEngine,
)


class ModelRuntime(Protocol):
    def catalog(self) -> tuple[RuntimeModelAvailability, ...]: ...

    def search(
        self, model_id: str, query: str, top_k: int, datasets: list[Dataset]
    ) -> SearchExecution: ...

    def resolve_image(self, stable_id: str) -> Path | None: ...

    def benchmark(self) -> BenchmarkResponse: ...

    def benchmark_queries(self) -> tuple[BenchmarkQuery, ...]: ...

    def benchmark_search(
        self, model_id: str, query_id: str, top_k: int
    ) -> BenchmarkSearchResponse: ...

    def close(self) -> None: ...


@asynccontextmanager
async def _lifespan(application: FastAPI) -> AsyncIterator[None]:
    yield
    application.state.model_runtime.close()


app = FastAPI(title="God's Eye API", version="0.1.0", docs_url="/docs", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)


def _configured_runtime() -> ModelRuntime:
    settings = get_settings()
    if settings.use_fixtures:
        return FixtureModelRuntime()
    return ModelRuntimeManager(
        settings.index_root,
        settings.dataset_root,
        settings.hf_cache,
        device=settings.device,
        resident_models=settings.resident_models,
    )


class _RetrievalRuntimeAdapter:
    def __init__(self, engine: RetrievalEngine) -> None:
        self._engine = engine

    def catalog(self) -> tuple[RuntimeModelAvailability, ...]:
        engine = self._engine
        match engine:
            case IndexedRetrievalEngine():
                entry = RuntimeModelAvailability(
                    engine.model_id,
                    engine.model_id,
                    True,
                    True,
                    engine.version_id,
                    engine.gallery_count,
                    None,
                )
            case FixtureRetrievalEngine():
                entry = RuntimeModelAvailability(
                    "fixture", "Fixture", True, True, "fixture", 1, None
                )
            case UnavailableRetrievalEngine():
                guidance = (
                    engine.guidance
                    + ". Run `gods-eye-index build`, then `gods-eye-index activate`."
                )
                entry = RuntimeModelAvailability(
                    DEFAULT_MODEL_ID, "ViT-B/16", False, True, None, None, guidance
                )
            case ManifestRetrievalEngine():
                guidance = "No valid index is active. Run `gods-eye-index build`, then activate it."
                entry = RuntimeModelAvailability(
                    DEFAULT_MODEL_ID, "ViT-B/16", False, True, None, None, guidance
                )
            case unreachable:
                assert_never(unreachable)
        return (entry,)

    def search(
        self, model_id: str, query: str, top_k: int, datasets: list[Dataset]
    ) -> SearchExecution:
        engine = self._engine
        if isinstance(engine, UnavailableRetrievalEngine):
            raise ModelUnavailableError(model_id, engine.guidance, True)
        results = engine.search(query, top_k, datasets)
        version = engine.version_id if isinstance(engine, IndexedRetrievalEngine) else "fixture"
        return SearchExecution(model_id, version, tuple(results))

    def resolve_image(self, stable_id: str) -> Path | None:
        engine = self._engine
        if isinstance(engine, (ManifestRetrievalEngine, IndexedRetrievalEngine)):
            return engine.manifest.resolve(stable_id)
        return None

    def benchmark(self) -> BenchmarkResponse:
        return BenchmarkResponse(protocol=BenchmarkProtocol(), models=[])

    def benchmark_queries(self) -> tuple[BenchmarkQuery, ...]:
        return ()

    def benchmark_search(self, model_id: str, query_id: str, top_k: int) -> BenchmarkSearchResponse:
        del model_id, top_k
        raise BenchmarkQueryNotFoundError(query_id)

    def close(self) -> None:
        pass


app.state.model_runtime = _configured_runtime()
logger = logging.getLogger("gods_eye.operations")
logger.setLevel(getattr(logging, get_settings().log_level.upper(), logging.INFO))


def _log(event: str, **fields: str | float | list[Dataset]) -> None:
    # JSON keeps local/container collection predictable. Callers must never pass query text.
    logger.info(json.dumps({"event": event, **fields}, separators=(",", ":"), default=str))


def get_model_runtime() -> ModelRuntime:
    return app.state.model_runtime


@contextmanager
def use_model_runtime(runtime: ModelRuntime) -> Iterator[None]:
    previous = app.state.model_runtime
    app.state.model_runtime = runtime
    try:
        yield
    finally:
        app.state.model_runtime = previous


@contextmanager
def use_retrieval_engine(engine: RetrievalEngine) -> Iterator[None]:
    with use_model_runtime(_RetrievalRuntimeAdapter(engine)):
        yield


def activate_manifest(manifest) -> None:
    app.state.model_runtime = _RetrievalRuntimeAdapter(ManifestRetrievalEngine(manifest))


def activate_index(active_pointer, model_id: str) -> None:
    app.state.model_runtime = _RetrievalRuntimeAdapter(
        IndexedRetrievalEngine(load_active(active_pointer, model_id))
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/models", response_model=ModelCatalogResponse)
def model_catalog(runtime: ModelRuntime = Depends(get_model_runtime)) -> ModelCatalogResponse:  # noqa: B008
    return ModelCatalogResponse(
        models=tuple(
            ModelAvailability(
                model_id=entry.model_id,
                label=entry.label,
                ready=entry.ready,
                active_index_version=entry.active_index_version,
                gallery_count=entry.gallery_count,
                guidance=entry.guidance,
                group=entry.group,
                paired_baseline_id=entry.paired_baseline_id,
                verified=entry.verified,
                registered_at=entry.registered_at,
                evaluation_ready=entry.evaluation_ready,
            )
            for entry in runtime.catalog()
        )
    )


@app.get("/api/readiness", response_model=ReadinessResponse)
def readiness(runtime: ModelRuntime = Depends(get_model_runtime)) -> ReadinessResponse:  # noqa: B008
    catalog = runtime.catalog()
    default = (
        catalog[0]
        if isinstance(runtime, _RetrievalRuntimeAdapter)
        else next(entry for entry in catalog if entry.model_id == DEFAULT_MODEL_ID)
    )
    return ReadinessResponse(
        ready=default.ready,
        model_id=default.model_id if default.ready else None,
        active_index_version=default.active_index_version,
        gallery_count=default.gallery_count,
        guidance=default.guidance,
    )


@app.post("/api/search", response_model=SearchResponse)
def search(
    request: SearchRequest,
    runtime: ModelRuntime = Depends(get_model_runtime),  # noqa: B008
) -> SearchResponse:
    started = time.perf_counter()
    catalog = runtime.catalog()
    availability = (
        catalog[0]
        if isinstance(runtime, _RetrievalRuntimeAdapter)
        else next((entry for entry in catalog if entry.model_id == request.model_id), None)
    )
    index_version = availability.active_index_version if availability is not None else None
    gallery_count = availability.gallery_count if availability is not None else None
    telemetry = {
        "top_k": request.top_k,
        "datasets": request.datasets,
        "model_id": request.model_id,
        "index_version": index_version or "unavailable",
        "gallery_count": gallery_count or 0,
    }
    try:
        execution = runtime.search(request.model_id, request.query, request.top_k, request.datasets)
    except ModelUnavailableError as exc:
        if isinstance(runtime, _RetrievalRuntimeAdapter):
            category = "index_unavailable"
        elif exc.prepared:
            category = "model_unavailable"
        else:
            category = "model_unprepared"
        _log(
            "search_failed",
            category=category,
            duration_ms=round((time.perf_counter() - started) * 1000, 2),
            result_count=0,
            **telemetry,
        )
        if not exc.prepared:
            detail = (
                f"Model '{exc.model_id}' is not prepared. "
                f"Run './gods-eye prepare --model-id {exc.model_id}'."
            )
            raise HTTPException(status_code=409, detail=detail) from exc
        raise HTTPException(
            status_code=503,
            detail=(
                f"Model '{exc.model_id}' is unavailable from the prepared local cache. "
                "Verify Demo Preparation and try again."
            ),
        ) from exc
    _log(
        "search_completed",
        duration_ms=round((time.perf_counter() - started) * 1000, 2),
        result_count=len(execution.results),
        **{**telemetry, "index_version": execution.active_index_version},
    )
    return SearchResponse(
        query=request.query,
        model_id=execution.model_id,
        active_index_version=execution.active_index_version,
        results=list(execution.results),
    )


@app.get("/api/benchmark", response_model=BenchmarkResponse)
def benchmark(runtime: ModelRuntime = Depends(get_model_runtime)) -> BenchmarkResponse:  # noqa: B008
    return runtime.benchmark()


@app.get("/api/benchmark/queries", response_model=BenchmarkQueriesResponse)
def benchmark_queries(
    runtime: ModelRuntime = Depends(get_model_runtime),  # noqa: B008
) -> BenchmarkQueriesResponse:
    return BenchmarkQueriesResponse(
        queries=[
            BenchmarkQueryItem(id=query.id, caption=query.caption)
            for query in runtime.benchmark_queries()
        ]
    )


@app.post("/api/benchmark/search", response_model=BenchmarkSearchResponse)
def benchmark_search(
    request: BenchmarkSearchRequest,
    runtime: ModelRuntime = Depends(get_model_runtime),  # noqa: B008
) -> BenchmarkSearchResponse:
    started = time.perf_counter()
    try:
        response = runtime.benchmark_search(request.model_id, request.query_id, request.top_k)
    except BenchmarkQueryNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Benchmark Query not found.") from exc
    except ModelUnavailableError as exc:
        if not exc.prepared:
            detail = (
                f"Model '{exc.model_id}' is not prepared. "
                f"Run './gods-eye prepare --model-id {exc.model_id}'."
            )
            raise HTTPException(status_code=409, detail=detail) from exc
        raise HTTPException(
            status_code=503,
            detail=(
                f"Model '{exc.model_id}' is unavailable from the prepared local cache. "
                "Verify Demo Preparation and try again."
            ),
        ) from exc
    _log(
        "benchmark_search_completed",
        duration_ms=round((time.perf_counter() - started) * 1000, 2),
        result_count=len(response.results),
        model_id=response.model_id,
        index_version=response.active_index_version,
        top_k=request.top_k,
        first_match_rank=response.first_match_rank,
    )
    return response


_COLORS = {"sky": "#91d8ff", "violet": "#b7a8ff", "mint": "#8fe3c2"}


@app.get("/api/images/{name}", include_in_schema=False)
def fixture_image(name: str) -> Response:
    path = app.state.model_runtime.resolve_image(name)
    if path is not None:
        return FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})
    color = _COLORS.get(name.removesuffix(".svg"))
    if color is None:
        raise HTTPException(status_code=404, detail="Image not found")
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480"><rect width="360" height="480" fill="#101827"/><circle cx="180" cy="120" r="52" fill="{color}"/><path d="M80 410c0-120 40-210 100-210s100 90 100 210" fill="{color}"/><text x="180" y="455" text-anchor="middle" fill="#dcecff" font-family="sans-serif">Fixture portrait</text></svg>'''
    return Response(
        svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=3600"}
    )
