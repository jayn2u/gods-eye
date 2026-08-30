from fastapi.testclient import TestClient
from gods_eye.app import app, use_retrieval_engine
from gods_eye.retrieval import FixtureRetrievalEngine

client = TestClient(app)


def test_search_contract_is_ranked_and_path_safe() -> None:
    with use_retrieval_engine(FixtureRetrievalEngine()):
        response = client.post(
            "/api/search",
            json={"query": "person in a blue coat", "top_k": 2, "datasets": ["CUHK-PEDES", "ICFG-PEDES"]},
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
