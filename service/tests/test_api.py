import json
import logging
from pathlib import Path

from fastapi.testclient import TestClient
from gods_eye.app import app, use_model_runtime, use_retrieval_engine
from gods_eye.model_runtime import FixtureModelRuntime, ModelUnavailableError
from gods_eye.models import Dataset
from gods_eye.retrieval import (
    FixtureRetrievalEngine,
    RuntimeModelAvailability,
    SearchExecution,
    UnavailableRetrievalEngine,
)

client = TestClient(app)

MODEL_IDS = [
    "openai/clip-vit-base-patch32",
    "openai/clip-vit-base-patch16",
    "openai/clip-vit-large-patch14",
    "openai/clip-vit-large-patch14-336",
]


def test_model_catalog_is_ordered_and_identifies_default() -> None:
    response = client.get("/api/models")

    assert response.status_code == 200
    body = response.json()
    assert body["default_model_id"] == "openai/clip-vit-base-patch16"
    assert [model["model_id"] for model in body["models"]] == MODEL_IDS


def test_search_defaults_to_b16_and_returns_index_provenance() -> None:
    with use_retrieval_engine(FixtureRetrievalEngine()):
        response = client.post(
            "/api/search",
            json={"query": "person in a blue coat", "top_k": 1},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["model_id"] == "openai/clip-vit-base-patch16"
    assert body["active_index_version"]


def test_selected_model_returns_matching_provenance() -> None:
    runtime = FixtureModelRuntime()
    with use_model_runtime(runtime):
        response = client.post(
            "/api/search",
            json={
                "query": "person in a blue coat",
                "model_id": "openai/clip-vit-large-patch14",
                "top_k": 1,
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["model_id"] == "openai/clip-vit-large-patch14"
    assert body["active_index_version"] == "fixture-clip-vit-l-14-v1"


class _UnavailableRuntime:
    def __init__(self, model_id: str, *, prepared: bool, guidance: str) -> None:
        self._model_id = model_id
        self._prepared = prepared
        self._guidance = guidance

    def catalog(self) -> tuple[RuntimeModelAvailability, ...]:
        return (
            RuntimeModelAvailability(
                self._model_id,
                "Selected model",
                False,
                self._prepared,
                None,
                None,
                self._guidance,
            ),
        )

    def search(
        self, model_id: str, query: str, top_k: int, datasets: list[Dataset]
    ) -> SearchExecution:
        del query, top_k, datasets
        raise ModelUnavailableError(model_id, self._guidance, self._prepared)

    def resolve_image(self, stable_id: str) -> Path | None:
        del stable_id
        return None

    def close(self) -> None:
        pass


def test_supported_unprepared_model_returns_actionable_conflict() -> None:
    model_id = "openai/clip-vit-large-patch14-336"
    runtime = _UnavailableRuntime(model_id, prepared=False, guidance="private path")
    with use_model_runtime(runtime):
        response = client.post("/api/search", json={"query": "coat", "model_id": model_id})

    assert response.status_code == 409
    assert response.json()["detail"] == (
        f"Model '{model_id}' is not prepared. Run './gods-eye prepare --model-id {model_id}'."
    )
    assert "private path" not in response.text


def test_prepared_model_local_failure_returns_redacted_unavailability() -> None:
    model_id = "openai/clip-vit-large-patch14"
    runtime = _UnavailableRuntime(
        model_id,
        prepared=True,
        guidance="missing /private/cache/snapshots/deadbeef for query secret",
    )
    with use_model_runtime(runtime):
        response = client.post("/api/search", json={"query": "secret", "model_id": model_id})

    assert response.status_code == 503
    assert "local cache" in response.json()["detail"]
    assert "/private/" not in response.text
    assert "secret" not in response.text


def test_unknown_model_is_rejected_before_runtime_search() -> None:
    runtime = _UnavailableRuntime("unknown/model", prepared=True, guidance="must not run")
    with use_model_runtime(runtime):
        response = client.post("/api/search", json={"query": "coat", "model_id": "unknown/model"})

    assert response.status_code == 422


def test_well_formed_unregistered_checkpoint_model_returns_conflict() -> None:
    with use_model_runtime(FixtureModelRuntime()):
        response = client.post(
            "/api/search",
            json={"query": "coat", "model_id": "labclip:cuhk-pedes:ffffffffffff"},
        )

    assert response.status_code == 409
    assert "labclip:cuhk-pedes:ffffffffffff" in response.json()["detail"]


class _ImageRuntime(FixtureModelRuntime):
    def __init__(self, image: Path) -> None:
        super().__init__()
        self._image = image

    def resolve_image(self, stable_id: str) -> Path | None:
        return self._image if stable_id == "cuhk:fixture:001" else None


def test_common_image_resolver_survives_model_swaps(tmp_path: Path) -> None:
    image = tmp_path / "person.jpg"
    image.write_bytes(b"person-image")
    runtime = _ImageRuntime(image)
    with use_model_runtime(runtime):
        for model_id in MODEL_IDS[:2]:
            searched = client.post(
                "/api/search", json={"query": "coat", "model_id": model_id, "top_k": 1}
            )
            assert searched.status_code == 200
        response = client.get("/api/images/cuhk:fixture:001")

    assert response.status_code == 200
    assert response.content == b"person-image"


def test_search_contract_is_ranked_and_path_safe() -> None:
    with use_retrieval_engine(FixtureRetrievalEngine()):
        response = client.post(
            "/api/search",
            json={
                "query": "person in a blue coat",
                "top_k": 1,
                "datasets": ["CUHK-PEDES"],
            },
        )
    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "person in a blue coat"
    assert [result["rank"] for result in body["results"]] == [1]
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
        response = client.post("/api/search", json={"query": secret_query, "top_k": 1})
    assert response.status_code == 200
    record = next(
        record for record in caplog.records if '"event":"search_completed"' in record.message
    )
    payload = json.loads(record.message)
    assert secret_query not in record.message
    assert payload["top_k"] == 1
    assert payload["result_count"] == 1
    assert payload["datasets"] == ["CUHK-PEDES"]
    assert payload["model_id"] == "openai/clip-vit-base-patch16"
    assert payload["index_version"] == "fixture"
    assert payload["gallery_count"] == 1
    assert payload["duration_ms"] >= 0


def test_failed_search_log_has_complete_categorized_telemetry(caplog) -> None:
    with (
        caplog.at_level(logging.INFO, logger="gods_eye.operations"),
        use_retrieval_engine(UnavailableRetrievalEngine()),
    ):
        response = client.post(
            "/api/search",
            json={"query": "private description", "top_k": 12, "datasets": ["CUHK-PEDES"]},
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
        "datasets": ["CUHK-PEDES"],
        "model_id": "openai/clip-vit-base-patch16",
        "index_version": "unavailable",
        "gallery_count": 0,
    }
    assert payload["duration_ms"] >= 0


def test_retired_dataset_is_rejected() -> None:
    response = client.post("/api/search", json={"query": "coat", "datasets": ["ICFG-PEDES"]})
    assert response.status_code == 422
