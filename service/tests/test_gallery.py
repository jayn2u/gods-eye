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
    icfg = tmp_path / "icfg"
    rstp = tmp_path / "rstp"
    image(cuhk / "train/p1/a.jpg", (0, 0, 255))
    image(cuhk / "val/p2/b.png", (255, 0, 0))
    image(icfg / "test/p3/c.jpg", (0, 255, 0))
    (icfg / "test/p3/copy.jpg").parent.mkdir(parents=True, exist_ok=True)
    (icfg / "test/p3/copy.jpg").write_bytes((icfg / "test/p3/c.jpg").read_bytes())
    image(rstp / "test/p4/d.jpg", (255, 255, 0))
    metadata(
        tmp_path / "cuhk.json",
        [
            {"split": "train", "file_path": "train/p1/a.jpg", "id": 1, "captions": ["secret"]},
            {"split": "val", "file_path": "val/p2/b.png", "id": 2, "captions": ["secret"]},
        ],
    )
    metadata(
        tmp_path / "icfg.json",
        [
            {"split": "test", "file_path": "test/p3/c.jpg", "id": 3},
            {"split": "test", "file_path": "test/p3/c.jpg", "id": 33},
            {"split": "test", "file_path": "test/p3/copy.jpg", "id": 4},
        ],
    )
    metadata(tmp_path / "rstp.json", [{"split": "test", "img_path": "test/p4/d.jpg", "id": 5}])
    return {
        "CUHK-PEDES": (cuhk, tmp_path / "cuhk.json"),
        "ICFG-PEDES": (icfg, tmp_path / "icfg.json"),
        "RSTPReid": (rstp, tmp_path / "rstp.json"),
    }


def test_all_metadata_shapes_stable_ids_and_exact_dedup(tmp_path: Path) -> None:
    sources = tiny_sources(tmp_path)
    manifest = build_manifest(sources)

    assert manifest.report == {
        "source_rows": 6,
        "unique_paths": 5,
        "exact_content_duplicates": 1,
        "records": 4,
        "errors": 0,
    }
    assert {record.dataset for record in manifest.records} == {
        "CUHK-PEDES",
        "ICFG-PEDES",
        "RSTPReid",
    }
    validation = next(record for record in manifest.records if record.relative_path == "val/p2/b.png")
    assert validation.split == "validation"
    assert validation.id == stable_id("CUHK-PEDES", "validation", "val/p2/b.png")
    assert any(record.aliases for record in manifest.records)
    icfg_record = next(record for record in manifest.records if record.dataset == "ICFG-PEDES")
    assert {item.source_person_id for item in icfg_record.aliases} == {"33", "4"}

    output = tmp_path / "manifest.json"
    manifest.write(output)
    assert GalleryManifest.read(output).to_dict() == manifest.to_dict()


def test_empty_icfg_validation_is_not_invented(tmp_path: Path) -> None:
    sources = tiny_sources(tmp_path)
    manifest = build_manifest(sources)
    icfg_splits = {
        provenance.split
        for record in manifest.records
        for provenance in [record.provenance_for(["ICFG-PEDES"])]
        if provenance is not None
    }
    assert icfg_splits == {"test"}


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
            "/api/search", json={"query": "yellow coat", "top_k": 10, "datasets": ["RSTPReid"]}
        )
        assert response.status_code == 200
        results = response.json()["results"]
        assert len(results) == 1
        assert results[0]["dataset"] == "RSTPReid"
        assert set(results[0]) == {"rank", "similarity", "dataset", "id", "split", "image_url"}
        assert "caption" not in response.text
        assert str(tmp_path) not in response.text
        assert client.get(results[0]["image_url"]).status_code == 200
        assert client.get("/api/images/unknown").status_code == 404
        assert client.get("/api/images/..%2F..%2Fetc%2Fpasswd").status_code in (404, 422)


def test_default_search_includes_every_dataset(tmp_path: Path) -> None:
    engine = ManifestRetrievalEngine(build_manifest(tiny_sources(tmp_path)))
    client = TestClient(app)
    with use_retrieval_engine(engine):
        results = client.post("/api/search", json={"query": "person", "top_k": 10}).json()["results"]
    assert {result["dataset"] for result in results} == {
        "CUHK-PEDES",
        "ICFG-PEDES",
        "RSTPReid",
    }
