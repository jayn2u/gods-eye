import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from gods_eye.app import app, use_retrieval_engine
from gods_eye.gallery import (
    MANIFEST_SCHEMA_VERSION,
    GalleryBuildError,
    GalleryManifest,
    build_manifest,
    stable_id,
)
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
    image(cuhk / "test/p3/c.jpg", (0, 255, 0))
    image(cuhk / "test/p4/d.png", (255, 0, 255))
    metadata(
        tmp_path / "cuhk.json",
        [
            {"split": "train", "file_path": "train/p1/a.jpg", "id": 1, "captions": ["secret"]},
            {"split": "val", "file_path": "val/p2/b.png", "id": 2, "captions": ["secret"]},
            {"split": "test", "file_path": "test/p3/c.jpg", "id": 3, "captions": ["secret"]},
            {"split": "test", "file_path": "test/p4/d.png", "id": 4, "captions": ["secret"]},
        ],
    )
    return {"CUHK-PEDES": (cuhk, tmp_path / "cuhk.json")}


def test_gallery_holds_only_the_test_split_with_stable_ids(tmp_path: Path) -> None:
    sources = tiny_sources(tmp_path)
    manifest = build_manifest(sources)

    assert manifest.report == {
        "source_rows": 4,
        "gallery_split": "test",
        "out_of_scope_by_dataset_split": {"CUHK-PEDES": {"train": 1, "validation": 1}},
        "unique_paths": 2,
        "exact_content_duplicates": 0,
        "records": 2,
        "errors": 0,
    }
    assert {record.split for record in manifest.records} == {"test"}
    assert {record.relative_path for record in manifest.records} == {
        "test/p3/c.jpg",
        "test/p4/d.png",
    }
    record = next(item for item in manifest.records if item.relative_path == "test/p3/c.jpg")
    assert record.id == stable_id("CUHK-PEDES", "test", "test/p3/c.jpg")
    assert not any(record.aliases for record in manifest.records)

    output = tmp_path / "manifest.json"
    manifest.write(output)
    assert json.loads(output.read_text())["version"] == MANIFEST_SCHEMA_VERSION
    assert GalleryManifest.read(output).to_dict() == manifest.to_dict()


def test_manifest_built_before_the_test_split_restriction_is_rejected(tmp_path: Path) -> None:
    output = tmp_path / "manifest.json"
    build_manifest(tiny_sources(tmp_path)).write(output)
    stale = json.loads(output.read_text())
    stale["version"] = 1
    output.write_text(json.dumps(stale))

    with pytest.raises(GalleryBuildError, match="restricted to the CUHK-PEDES test split"):
        GalleryManifest.read(output)


def test_out_of_scope_rows_are_structurally_validated_but_never_read(tmp_path: Path) -> None:
    root = tmp_path / "images"
    image(root / "test/ok.jpg", (10, 20, 30))
    (root / "train").mkdir(parents=True, exist_ok=True)
    (root / "train/broken.jpg").write_text("not an image")
    meta = tmp_path / "meta.json"
    metadata(
        meta,
        [
            {"split": "train", "file_path": "train/broken.jpg", "id": 1},
            {"split": "test", "file_path": "test/ok.jpg", "id": 2},
        ],
    )

    manifest = build_manifest({"CUHK-PEDES": (root, meta)})
    assert manifest.report["out_of_scope_by_dataset_split"]["CUHK-PEDES"]["train"] == 1
    assert len(manifest.records) == 1

    metadata(meta, [{"split": "trian", "file_path": "train/broken.jpg", "id": 1}])
    with pytest.raises(GalleryBuildError, match="unsupported split"):
        build_manifest({"CUHK-PEDES": (root, meta)})

    metadata(meta, [{"split": "train", "file_path": "../escape.jpg", "id": 1}])
    with pytest.raises(GalleryBuildError, match="unsafe image path"):
        build_manifest({"CUHK-PEDES": (root, meta)})


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
    metadata(meta, [{"split": "test", "file_path": "broken.jpg", "id": 1}])
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
        assert {result["split"] for result in results} == {"test"}
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
