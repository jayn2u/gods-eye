import hashlib
import io
import json
import os
import re
import urllib.request
import zipfile
from pathlib import Path

import pytest
from gods_eye.datasets import (
    DatasetAcquirer,
    DatasetAcquisitionError,
    DatasetSource,
    load_registry,
)
from PIL import Image


def test_registry_pins_verified_public_archives() -> None:
    assert {source.name: source.sha256 for source in load_registry()} == {
        "CUHK-PEDES": "40498f0069f10b5332f329e5e39507664faa4b7b176eaaa1e0b4f6c411decbb9",
    }


def make_archive(path: Path, wrapper: str | None, metadata_name: str) -> str:
    prefix = f"{wrapper}/" if wrapper else ""
    rows = [{"split": "test", "file_path": "test/person.jpg", "id": 1}]
    image = io.BytesIO()
    Image.new("RGB", (2, 2), "navy").save(image, format="PNG")
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(f"{prefix}{metadata_name}", json.dumps(rows))
        archive.writestr(f"{prefix}imgs/test/person.jpg", image.getvalue())
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source(name: str, archive: Path, wrapper: str | None, metadata: str) -> DatasetSource:
    return DatasetSource(
        name=name,
        drive_id=f"drive-{name}",
        filename=archive.name,
        size=archive.stat().st_size,
        sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
        wrapper=wrapper,
        metadata=metadata,
    )


def test_install_publishes_receipts_and_gallery_manifest_atomically(tmp_path: Path) -> None:
    cuhk = tmp_path / "cuhk.zip"
    make_archive(cuhk, "CUHK-PEDES", "reid_raw.json")
    sources = [
        source("CUHK-PEDES", cuhk, "CUHK-PEDES", "reid_raw.json"),
    ]

    def download(dataset_source: DatasetSource, destination: Path) -> None:
        assert dataset_source.name == "CUHK-PEDES"
        destination.write_bytes(cuhk.read_bytes())

    acquirer = DatasetAcquirer(tmp_path / "data", tmp_path / "indexes", sources, download)
    result = acquirer.install([item.name for item in sources], accept_terms=True)

    assert result.installed == ["CUHK-PEDES"]
    assert (tmp_path / "data/install-state/CUHK-PEDES.receipt.json").is_file()
    assert not (tmp_path / "data/datasets/CUHK-PEDES/.installation-receipt.json").exists()
    assert (tmp_path / "data/datasets/CUHK-PEDES/imgs/test/person.jpg").is_file()
    manifest = json.loads((tmp_path / "indexes/gallery-manifest.json").read_text())
    assert len(manifest["records"]) == 1  # exact-byte duplicate is collapsed
    assert not list((tmp_path / "data/install-state").glob("*.staging"))


def test_install_requires_terms_and_rejects_checksum_mismatch(tmp_path: Path) -> None:
    archive = tmp_path / "source.zip"
    make_archive(archive, "CUHK-PEDES", "reid_raw.json")
    item = source("CUHK-PEDES", archive, "CUHK-PEDES", "reid_raw.json")
    item = DatasetSource(**{**item.__dict__, "sha256": "0" * 64})
    acquirer = DatasetAcquirer(
        tmp_path / "data",
        tmp_path / "indexes",
        [item],
        lambda _source, destination: destination.write_bytes(archive.read_bytes()),
    )

    with pytest.raises(DatasetAcquisitionError, match="accept-data-terms"):
        acquirer.install(["CUHK-PEDES"], accept_terms=False)
    with pytest.raises(DatasetAcquisitionError, match="SHA-256"):
        acquirer.install(["CUHK-PEDES"], accept_terms=True)
    assert not (tmp_path / "data/datasets/CUHK-PEDES").exists()


def test_install_rejects_zip_slip_and_verify_detects_missing_content(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as payload:
        payload.writestr("CUHK-PEDES/../escape", b"bad")
    item = source("CUHK-PEDES", archive, "CUHK-PEDES", "reid_raw.json")
    acquirer = DatasetAcquirer(
        tmp_path / "data",
        tmp_path / "indexes",
        [item],
        lambda _source, destination: destination.write_bytes(archive.read_bytes()),
    )
    with pytest.raises(DatasetAcquisitionError, match="unsafe ZIP"):
        acquirer.install(["CUHK-PEDES"], accept_terms=True)


def test_status_verify_and_clean_archives(tmp_path: Path) -> None:
    archive = tmp_path / "cuhk.zip"
    make_archive(archive, "CUHK-PEDES", "reid_raw.json")
    item = source("CUHK-PEDES", archive, "CUHK-PEDES", "reid_raw.json")
    acquirer = DatasetAcquirer(
        tmp_path / "data",
        tmp_path / "indexes",
        [item],
        lambda _source, destination: destination.write_bytes(archive.read_bytes()),
    )
    acquirer.install(["CUHK-PEDES"], accept_terms=True)
    assert acquirer.status()["CUHK-PEDES"] == "installed"
    assert acquirer.verify(["CUHK-PEDES"]) == {"CUHK-PEDES": True}
    (tmp_path / "data/datasets/CUHK-PEDES/reid_raw.json").unlink()
    assert acquirer.verify(["CUHK-PEDES"]) == {"CUHK-PEDES": False}
    acquirer.clean_archives()
    assert not (tmp_path / "data/archives/CUHK-PEDES.zip").exists()


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("RUN_DATASET_SOURCE_CHECK") != "1",
    reason="set RUN_DATASET_SOURCE_CHECK=1 to query the public Google Drive sources",
)
@pytest.mark.parametrize("dataset_source", load_registry(), ids=lambda item: item.name)
def test_public_drive_source_is_available_with_registered_filename(
    dataset_source: DatasetSource,
) -> None:
    request = urllib.request.Request(
        f"https://drive.google.com/file/d/{dataset_source.drive_id}/view",
        headers={"User-Agent": "gods-eye-dataset-source-check/1"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        page = response.read().decode("utf-8", errors="replace")

    title = re.search(r"<title>(.*?) - Google Drive</title>", page)
    assert title is not None
    assert title.group(1) == dataset_source.filename
