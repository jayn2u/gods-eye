from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from .models import SearchRequest, SearchResponse
from .retrieval import FixtureRetrievalEngine, ManifestRetrievalEngine, RetrievalEngine

app = FastAPI(title="God's Eye API", version="0.1.0", docs_url="/docs")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)
app.state.retrieval_engine = FixtureRetrievalEngine()


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


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/search", response_model=SearchResponse)
def search(
    request: SearchRequest,
    engine: RetrievalEngine = Depends(get_retrieval_engine),  # noqa: B008
) -> SearchResponse:
    return SearchResponse(
        query=request.query,
        results=engine.search(request.query, request.top_k, request.datasets),
    )


_COLORS = {"sky": "#91d8ff", "violet": "#b7a8ff", "mint": "#8fe3c2"}


@app.get("/api/images/{name}", include_in_schema=False)
def fixture_image(name: str) -> Response:
    engine = app.state.retrieval_engine
    if isinstance(engine, ManifestRetrievalEngine):
        path = engine.manifest.resolve(name)
        if path is None:
            raise HTTPException(status_code=404, detail="Image not found")
        return FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})
    color = _COLORS.get(name.removesuffix(".svg"))
    if color is None:
        raise HTTPException(status_code=404, detail="Image not found")
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480"><rect width="360" height="480" fill="#101827"/><circle cx="180" cy="120" r="52" fill="{color}"/><path d="M80 410c0-120 40-210 100-210s100 90 100 210" fill="{color}"/><text x="180" y="455" text-anchor="middle" fill="#dcecff" font-family="sans-serif">Fixture portrait</text></svg>'''
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=3600"})
