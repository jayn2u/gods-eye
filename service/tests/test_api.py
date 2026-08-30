import json
import logging

from fastapi.testclient import TestClient
from gods_eye.app import app, use_retrieval_engine
from gods_eye.retrieval import FixtureRetrievalEngine, UnavailableRetrievalEngine

client = TestClient(app)


def test_search_contract_is_ranked_and_path_safe() -> None:
    with use_retrieval_engine(FixtureRetrievalEngine()):
        response = client.post(
            "/api/search",
            json={
                "query": "person in a blue coat",
                "top_k": 2,
                "datasets": ["CUHK-PEDES", "ICFG-PEDES"],
            },
        )
    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "person in a blue coat"
    assert [result["rank"] for result in body["results"]] == [1, 2]
    assert set(body["results"][0]) == {"rank", "similarity", "dataset", "id", "split", "image_url"}
    assert body["results"][0]["image_url"].startswith("/api/images/")
    assert "/data/" not in str(body)
    assert "caption" not in str(body)


def test_blank_query_and_empty_datasets_are_rejected() -> None:
    blank = client.post("/api/search", json={"query": "   ", "datasets": ["CUHK-PEDES"]})
    empty = client.post("/api/search", json={"query": "coat", "datasets": []})
    assert blank.status_code == 422
    assert empty.status_code == 422


def test_top_k_is_bounded() -> None:
    response = client.post("/api/search", json={"query": "coat", "top_k": 101})
    assert response.status_code == 422


def test_openapi_is_available() -> None:
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200


def test_operational_search_log_excludes_raw_query(caplog) -> None:
    secret_query = "person wearing a uniquely private description"
    with (
        caplog.at_level(logging.INFO, logger="gods_eye.operations"),
        use_retrieval_engine(FixtureRetrievalEngine()),
    ):
        response = client.post("/api/search", json={"query": secret_query, "top_k": 2})
    assert response.status_code == 200
    record = next(
        record for record in caplog.records if '"event":"search_completed"' in record.message
    )
    payload = json.loads(record.message)
    assert secret_query not in record.message
    assert payload["top_k"] == 2
    assert payload["result_count"] == 2
    assert payload["datasets"] == ["CUHK-PEDES", "ICFG-PEDES", "RSTPReid"]
    assert payload["model_id"] == "fixture"
    assert payload["index_version"] == "fixture"
    assert payload["gallery_count"] == 3
    assert payload["duration_ms"] >= 0


def test_failed_search_log_has_complete_categorized_telemetry(caplog) -> None:
    with (
        caplog.at_level(logging.INFO, logger="gods_eye.operations"),
        use_retrieval_engine(UnavailableRetrievalEngine()),
    ):
        response = client.post(
            "/api/search",
            json={"query": "private description", "top_k": 12, "datasets": ["RSTPReid"]},
        )
    assert response.status_code == 503
    record = next(
        record for record in caplog.records if '"event":"search_failed"' in record.message
    )
    payload = json.loads(record.message)
    assert payload == {
        "event": "search_failed",
        "category": "index_unavailable",
        "duration_ms": payload["duration_ms"],
        "result_count": 0,
        "top_k": 12,
        "datasets": ["RSTPReid"],
        "model_id": "unavailable",
        "index_version": "unavailable",
        "gallery_count": 0,
    }
    assert payload["duration_ms"] >= 0
