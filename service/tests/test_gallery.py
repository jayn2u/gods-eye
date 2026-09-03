import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from gods_eye.app import app, use_retrieval_engine
from gods_eye.gallery import GalleryBuildError, GalleryManifest, build_manifest, stable_id
from gods_eye.retrieval import ManifestRetrievalEngine
from PIL import Image


def image(path: Path, color: tuple[int, int, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (4, 6), color).save(path)


def metadata(path: Path, rows: list[dict]) -> None:
    path.write_text(json.dumps(rows))


def tiny_sources(tmp_path: Path):
    cuhk = tmp_path / "cuhk"
    image(cuhk / "train/p1/a.jpg", (0, 0, 255))
    image(cuhk / "val/p2/b.png", (255, 0, 0))
    metadata(
        tmp_path / "cuhk.json",
        [
            {"split": "train", "file_path": "train/p1/a.jpg", "id": 1, "captions": ["secret"]},
            {"split": "val", "file_path": "val/p2/b.png", "id": 2, "captions": ["secret"]},
        ],
    )
    return {"CUHK-PEDES": (cuhk, tmp_path / "cuhk.json")}


def test_cuhk_metadata_shapes_and_stable_ids(tmp_path: Path) -> None:
    sources = tiny_sources(tmp_path)
    manifest = build_manifest(sources)

    assert manifest.report == {
        "source_rows": 2,
        "unique_paths": 2,
        "exact_content_duplicates": 0,
        "records": 2,
        "errors": 0,
    }
    assert {record.dataset for record in manifest.records} == {"CUHK-PEDES"}
    validation = next(
        record for record in manifest.records if record.relative_path == "val/p2/b.png"
    )
    assert validation.split == "validation"
    assert validation.id == stable_id("CUHK-PEDES", "validation", "val/p2/b.png")
    assert not any(record.aliases for record in manifest.records)

    output = tmp_path / "manifest.json"
    manifest.write(output)
    assert GalleryManifest.read(output).to_dict() == manifest.to_dict()


def test_retired_dataset_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "images"
    root.mkdir()
    metadata_path = tmp_path / "metadata.json"
    metadata_path.write_text("[]")
    with pytest.raises(GalleryBuildError, match="Unsupported dataset"):
        build_manifest({"ICFG-PEDES": (root, metadata_path)})


def test_invalid_metadata_and_images_have_actionable_errors(tmp_path: Path) -> None:
    root = tmp_path / "images"
    root.mkdir()
    (root / "broken.jpg").write_text("not an image")
    meta = tmp_path / "bad.json"
    metadata(meta, [{"split": "train", "file_path": "broken.jpg", "id": 1}])
    with pytest.raises(GalleryBuildError, match=r"CUHK-PEDES row 1.*broken\.jpg"):
        build_manifest({"CUHK-PEDES": (root, meta)})

    meta.write_text("{")
    with pytest.raises(GalleryBuildError, match="Could not read CUHK-PEDES metadata"):
        build_manifest({"CUHK-PEDES": (root, meta)})


def test_filtered_search_and_safe_manifest_image_access(tmp_path: Path) -> None:
    manifest = build_manifest(tiny_sources(tmp_path))
    engine = ManifestRetrievalEngine(manifest)
    client = TestClient(app)
    with use_retrieval_engine(engine):
        response = client.post(
            "/api/search", json={"query": "blue coat", "top_k": 10, "datasets": ["CUHK-PEDES"]}
        )
        assert response.status_code == 200
        results = response.json()["results"]
        assert len(results) == 2
        assert {result["dataset"] for result in results} == {"CUHK-PEDES"}
        assert set(results[0]) == {"rank", "similarity", "dataset", "id", "split", "image_url"}
        assert "caption" not in response.text
        assert str(tmp_path) not in response.text
        assert client.get(results[0]["image_url"]).status_code == 200
        assert client.get("/api/images/unknown").status_code == 404
        assert client.get("/api/images/..%2F..%2Fetc%2Fpasswd").status_code in (404, 422)


def test_default_search_uses_cuhk_gallery(tmp_path: Path) -> None:
    engine = ManifestRetrievalEngine(build_manifest(tiny_sources(tmp_path)))
    client = TestClient(app)
    with use_retrieval_engine(engine):
        results = client.post("/api/search", json={"query": "person", "top_k": 10}).json()[
            "results"
        ]
    assert {result["dataset"] for result in results} == {"CUHK-PEDES"}
