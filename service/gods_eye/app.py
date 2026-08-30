import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from .index_store import IndexValidationError, load_active
from .models import ReadinessResponse, SearchRequest, SearchResponse
from .retrieval import (
    FixtureRetrievalEngine,
    IndexedRetrievalEngine,
    ManifestRetrievalEngine,
    RetrievalEngine,
    UnavailableRetrievalEngine,
)

app = FastAPI(title="God's Eye API", version="0.1.0", docs_url="/docs")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)


def _configured_engine() -> RetrievalEngine:
    if os.environ.get("GODS_EYE_USE_FIXTURES") == "1":
        return FixtureRetrievalEngine()
    pointer = os.environ.get("GODS_EYE_ACTIVE_INDEX")
    model_id = os.environ.get("GODS_EYE_MODEL_ID", "openai/clip-vit-base-patch16")
    if pointer:
        try:
            revision = os.environ.get("GODS_EYE_MODEL_REVISION")
            loaded = load_active(Path(pointer), model_id, revision)
            if model_id == "fixture/deterministic-v1":
                return IndexedRetrievalEngine(loaded)
            from .clip import HuggingFaceClipEmbedder

            embedder = HuggingFaceClipEmbedder(
                model_id,
                revision=revision or loaded.metadata.model_revision,
                device=os.environ.get("GODS_EYE_DEVICE", "auto"),
                offline=os.environ.get("GODS_EYE_OFFLINE") == "1",
                cache_dir=Path(value) if (value := os.environ.get("GODS_EYE_HF_CACHE")) else None,
            )
            return IndexedRetrievalEngine(loaded, embedder)
        except (IndexValidationError, RuntimeError) as exc:
            return UnavailableRetrievalEngine(str(exc))
    return UnavailableRetrievalEngine()


app.state.retrieval_engine = _configured_engine()


def get_retrieval_engine() -> RetrievalEngine:
    return app.state.retrieval_engine


@contextmanager
def use_retrieval_engine(engine: RetrievalEngine) -> Iterator[None]:
    previous = app.state.retrieval_engine
    app.state.retrieval_engine = engine
    try:
        yield
    finally:
        app.state.retrieval_engine = previous


def activate_manifest(manifest) -> None:
    app.state.retrieval_engine = ManifestRetrievalEngine(manifest)


def activate_index(active_pointer, model_id: str) -> None:
    app.state.retrieval_engine = IndexedRetrievalEngine(load_active(active_pointer, model_id))


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/readiness", response_model=ReadinessResponse)
def readiness(engine: RetrievalEngine = Depends(get_retrieval_engine)) -> ReadinessResponse:  # noqa: B008
    if isinstance(engine, IndexedRetrievalEngine):
        return ReadinessResponse(
            ready=True,
            model_id=engine.model_id,
            active_index_version=engine.version_id,
            gallery_count=engine.gallery_count,
        )
    if isinstance(engine, FixtureRetrievalEngine):
        return ReadinessResponse(
            ready=True,
            model_id="fixture",
            active_index_version="fixture",
            gallery_count=3,
        )
    return ReadinessResponse(
        ready=False,
        guidance=(engine.guidance + ". Run `gods-eye-index build`, then `gods-eye-index activate`.")
        if isinstance(engine, UnavailableRetrievalEngine)
        else "No valid index is active. Run `gods-eye-index build`, then activate it.",
    )


@app.post("/api/search", response_model=SearchResponse)
def search(
    request: SearchRequest,
    engine: RetrievalEngine = Depends(get_retrieval_engine),  # noqa: B008
) -> SearchResponse:
    if isinstance(engine, UnavailableRetrievalEngine):
        raise HTTPException(
            status_code=503,
            detail="Search is unavailable. Build and activate a compatible index first.",
        )
    return SearchResponse(
        query=request.query,
        results=engine.search(request.query, request.top_k, request.datasets),
    )


_COLORS = {"sky": "#91d8ff", "violet": "#b7a8ff", "mint": "#8fe3c2"}


@app.get("/api/images/{name}", include_in_schema=False)
def fixture_image(name: str) -> Response:
    engine = app.state.retrieval_engine
    if isinstance(engine, (ManifestRetrievalEngine, IndexedRetrievalEngine)):
        path = engine.manifest.resolve(name)
        if path is None:
            raise HTTPException(status_code=404, detail="Image not found")
        return FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})
    color = _COLORS.get(name.removesuffix(".svg"))
    if color is None:
        raise HTTPException(status_code=404, detail="Image not found")
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480"><rect width="360" height="480" fill="#101827"/><circle cx="180" cy="120" r="52" fill="{color}"/><path d="M80 410c0-120 40-210 100-210s100 90 100 210" fill="{color}"/><text x="180" y="455" text-anchor="middle" fill="#dcecff" font-family="sans-serif">Fixture portrait</text></svg>'''
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=3600"})
