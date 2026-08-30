import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from gods_eye.app import app, use_retrieval_engine
from gods_eye.gallery import build_manifest
from gods_eye.index_store import (
    IndexValidationError,
    activate_version,
    build_index,
    load_active,
    validate_version,
)
from gods_eye.retrieval import IndexedRetrievalEngine, UnavailableRetrievalEngine
from PIL import Image


def fixture_manifest(tmp_path: Path) -> Path:
    root = tmp_path / "images"
    root.mkdir(parents=True)
    rows = []
    for number, (dataset, color) in enumerate(
        (("CUHK-PEDES", (255, 0, 0)), ("ICFG-PEDES", (0, 255, 0)), ("RSTPReid", (0, 0, 255)))
    ):
        name = f"{number}.png"
        Image.new("RGB", (3, 4), color).save(root / name)
        rows.append({"split": "test", "file_path": name, "id": number})
    sources = {}
    for dataset, row in zip(("CUHK-PEDES", "ICFG-PEDES", "RSTPReid"), rows, strict=True):
        metadata = tmp_path / f"{dataset}.json"
        metadata.write_text(json.dumps([row]))
        sources[dataset] = (root, metadata)
    manifest = build_manifest(sources)
    path = tmp_path / "source-manifest.json"
    manifest.write(path)
    return path


def build(tmp_path: Path) -> Path:
    return build_index(
        fixture_manifest(tmp_path),
        tmp_path / "versions",
        dimension=16,
        backend="numpy",
        now=datetime(2026, 8, 31, tzinfo=timezone.utc),
    )


def test_builds_complete_immutable_version_and_exact_ranking(tmp_path: Path) -> None:
    version = build(tmp_path)
    assert {path.name for path in version.iterdir()} == {
        "manifest.json", "embeddings.npy", "index.faiss", "metadata.json", "coverage.json"
    }
    loaded = validate_version(version, "fixture/deterministic-v1")
    assert loaded.metadata.gallery_count == 3
    assert loaded.metadata.normalized is True
    assert loaded.metadata.dataset_configuration == ["CUHK-PEDES", "ICFG-PEDES", "RSTPReid"]
    engine = IndexedRetrievalEngine(loaded)
    first = engine.search("blue coat", 3, ["CUHK-PEDES", "ICFG-PEDES", "RSTPReid"])
    second = engine.search("blue coat", 3, ["CUHK-PEDES", "ICFG-PEDES", "RSTPReid"])
    assert [(row.id, row.similarity) for row in first] == [
        (row.id, row.similarity) for row in second
    ]
    similarities = [row.similarity for row in first]
    assert similarities == sorted(similarities, reverse=True)


@pytest.mark.skipif(importlib.util.find_spec("faiss") is None, reason="faiss-cpu not installed")
def test_faiss_artifact_round_trip_when_runtime_is_installed(tmp_path: Path) -> None:
    version = build_index(
        fixture_manifest(tmp_path),
        tmp_path / "versions",
        dimension=16,
        backend="faiss",
    )
    loaded = validate_version(version)
    assert loaded.metadata.backend == "faiss"
    assert loaded.index.count == 3


def test_validation_rejects_corruption_mismatch_and_non_normalized_vectors(tmp_path: Path) -> None:
    version = build(tmp_path)
    with pytest.raises(IndexValidationError, match="Model mismatch"):
        validate_version(version, "different/model")

    vectors_path = version / "embeddings.npy"
    vectors = np.load(vectors_path)
    vectors[0] *= 2
    np.save(vectors_path, vectors)
    with pytest.raises(IndexValidationError, match="non-normalized"):
        validate_version(version)

    vectors[0] /= 2
    np.save(vectors_path, vectors)
    (version / "index.faiss").write_bytes(b"corrupt")
    with pytest.raises(IndexValidationError, match="Unreadable exact-index"):
        validate_version(version)


def test_activation_is_atomic_and_failed_activation_preserves_pointer(tmp_path: Path) -> None:
    version = build(tmp_path)
    active = tmp_path / "active"
    loaded = activate_version(version, active, "fixture/deterministic-v1")
    activated = load_active(active, "fixture/deterministic-v1")
    assert activated.metadata.version_id == loaded.metadata.version_id
    original = active.read_text()
    with pytest.raises(IndexValidationError, match="Model mismatch"):
        activate_version(version, active, "wrong/model")
    assert active.read_text() == original
    assert not list(tmp_path.glob(".active.*.tmp"))


def test_readiness_and_unavailable_search_are_distinct_from_health(tmp_path: Path) -> None:
    client = TestClient(app)
    with use_retrieval_engine(UnavailableRetrievalEngine()):
        assert client.get("/api/health").json() == {"status": "ok"}
        readiness = client.get("/api/readiness").json()
        assert readiness["ready"] is False
        assert "gods-eye-index build" in readiness["guidance"]
        assert client.post("/api/search", json={"query": "coat"}).status_code == 503

    loaded = validate_version(build(tmp_path / "indexed"))
    with use_retrieval_engine(IndexedRetrievalEngine(loaded)):
        readiness = client.get("/api/readiness").json()
        assert readiness == {
            "ready": True,
            "model_id": "fixture/deterministic-v1",
            "active_index_version": loaded.metadata.version_id,
            "gallery_count": 3,
            "guidance": None,
        }
