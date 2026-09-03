from pathlib import Path

from gods_eye.acceptance import coverage
from gods_eye.gallery import GalleryManifest, GalleryRecord, Provenance


def test_coverage_reports_source_active_and_duplicate_counts() -> None:
    manifest = GalleryManifest(
        roots={"CUHK-PEDES": Path("/gallery")},
        records=[
            GalleryRecord(
                id="one",
                dataset="CUHK-PEDES",
                split="train",
                relative_path="one.jpg",
                source_person_id="1",
                content_sha256="a",
                aliases=[Provenance("CUHK-PEDES", "test", "same.jpg", "2")],
            )
        ],
        report={"source_rows": 2, "records": 1},
    )

    result = coverage(manifest)

    assert result["source_by_dataset_split"]["CUHK-PEDES"]["train"] == 1
    assert result["source_by_dataset_split"]["CUHK-PEDES"]["test"] == 1
    assert result["active_by_canonical_dataset_split"]["CUHK-PEDES"]["test"] == 0
    assert result["duplicate_aliases_by_dataset_split"]["CUHK-PEDES"]["test"] == 1
    row = result["by_dataset_split"]["CUHK-PEDES"]["test"]
    assert row == {
        "source": 1,
        "accepted": 1,
        "duplicate": 1,
        "skipped": 0,
        "failed": 0,
        "active": 0,
    }
