from pathlib import Path

from gods_eye.acceptance import coverage
from gods_eye.gallery import GalleryManifest, GalleryRecord, Provenance


def test_coverage_scopes_counts_to_the_gallery_split() -> None:
    manifest = GalleryManifest(
        roots={"CUHK-PEDES": Path("/gallery")},
        records=[
            GalleryRecord(
                id="one",
                dataset="CUHK-PEDES",
                split="test",
                relative_path="test/one.jpg",
                source_person_id="1",
                content_sha256="a",
                aliases=[Provenance("CUHK-PEDES", "test", "test/same.jpg", "2")],
            )
        ],
        report={
            "source_rows": 5,
            "gallery_split": "test",
            "out_of_scope_by_dataset_split": {"CUHK-PEDES": {"train": 2, "validation": 1}},
            "records": 1,
        },
    )

    result = coverage(manifest)

    assert result["gallery_split"] == "test"
    assert result["source_by_dataset_split"]["CUHK-PEDES"] == {"test": 2}
    assert result["skipped_by_dataset_split"]["CUHK-PEDES"] == {"train": 2, "validation": 1}
    assert result["active_by_canonical_dataset_split"]["CUHK-PEDES"]["test"] == 1
    assert result["duplicate_aliases_by_dataset_split"]["CUHK-PEDES"]["test"] == 1

    rows = result["by_dataset_split"]["CUHK-PEDES"]
    assert rows["test"] == {
        "source": 2,
        "accepted": 2,
        "duplicate": 1,
        "skipped": 0,
        "failed": 0,
        "active": 1,
    }
    # Skipped splits carry no duplicate count: their images are never hashed, so a zero there
    # would claim a measurement the build never made.
    assert rows["train"] == {
        "source": 2,
        "accepted": 0,
        "skipped": 2,
        "failed": 0,
        "active": 0,
    }
    assert "duplicate" not in rows["train"]
