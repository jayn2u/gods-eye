import hashlib
import io
import json
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
        "ICFG-PEDES": "0e842b04371ddd85b3c5b17c605d502d2855d7ffa0e9770dc06336b9f8f11f8f",
        "RSTPReid": "711c31696d2fc2cf19e660a8d8a631c68b6240be0a1a694360c37f385dc57fa2",
    }


def make_archive(path: Path, wrapper: str | None, metadata_name: str) -> str:
    prefix = f"{wrapper}/" if wrapper else ""
    rows = [{"split": "train", "file_path": "train/person.jpg", "id": 1}]
    image = io.BytesIO()
    Image.new("RGB", (2, 2), "navy").save(image, format="PNG")
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(f"{prefix}{metadata_name}", json.dumps(rows))
        archive.writestr(f"{prefix}imgs/train/person.jpg", image.getvalue())
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
    rstp = tmp_path / "rstp.zip"
    make_archive(cuhk, "CUHK-PEDES", "reid_raw.json")
    make_archive(rstp, None, "data_captions.json")
    sources = [
        source("CUHK-PEDES", cuhk, "CUHK-PEDES", "reid_raw.json"),
        source("RSTPReid", rstp, None, "data_captions.json"),
    ]

    def download(dataset_source: DatasetSource, destination: Path) -> None:
        original = cuhk if dataset_source.name == "CUHK-PEDES" else rstp
        destination.write_bytes(original.read_bytes())

    acquirer = DatasetAcquirer(tmp_path / "data", tmp_path / "indexes", sources, download)
    result = acquirer.install([item.name for item in sources], accept_terms=True)

    assert result.installed == ["CUHK-PEDES", "RSTPReid"]
    assert (tmp_path / "data/datasets/CUHK-PEDES/.installation-receipt.json").is_file()
    assert (tmp_path / "data/datasets/RSTPReid/imgs/train/person.jpg").is_file()
    manifest = json.loads((tmp_path / "indexes/gallery-manifest.json").read_text())
    assert len(manifest["records"]) == 1  # exact-byte duplicate is collapsed
    assert not list((tmp_path / "data/install-state").glob("*.staging"))


def test_install_requires_terms_and_rejects_checksum_mismatch(tmp_path: Path) -> None:
    archive = tmp_path / "source.zip"
    make_archive(archive, None, "data_captions.json")
    item = source("RSTPReid", archive, None, "data_captions.json")
    item = DatasetSource(**{**item.__dict__, "sha256": "0" * 64})
    acquirer = DatasetAcquirer(
        tmp_path / "data",
        tmp_path / "indexes",
        [item],
        lambda _source, destination: destination.write_bytes(archive.read_bytes()),
    )

    with pytest.raises(DatasetAcquisitionError, match="accept-data-terms"):
        acquirer.install(["RSTPReid"], accept_terms=False)
    with pytest.raises(DatasetAcquisitionError, match="SHA-256"):
        acquirer.install(["RSTPReid"], accept_terms=True)
    assert not (tmp_path / "data/datasets/RSTPReid").exists()


def test_install_rejects_zip_slip_and_verify_detects_missing_content(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as payload:
        payload.writestr("../escape", b"bad")
    item = source("RSTPReid", archive, None, "data_captions.json")
    acquirer = DatasetAcquirer(
        tmp_path / "data",
        tmp_path / "indexes",
        [item],
        lambda _source, destination: destination.write_bytes(archive.read_bytes()),
    )
    with pytest.raises(DatasetAcquisitionError, match="unsafe ZIP"):
        acquirer.install(["RSTPReid"], accept_terms=True)


def test_status_verify_and_clean_archives(tmp_path: Path) -> None:
    archive = tmp_path / "rstp.zip"
    make_archive(archive, None, "data_captions.json")
    item = source("RSTPReid", archive, None, "data_captions.json")
    acquirer = DatasetAcquirer(
        tmp_path / "data",
        tmp_path / "indexes",
        [item],
        lambda _source, destination: destination.write_bytes(archive.read_bytes()),
    )
    acquirer.install(["RSTPReid"], accept_terms=True)
    assert acquirer.status()["RSTPReid"] == "installed"
    assert acquirer.verify(["RSTPReid"]) == {"RSTPReid": True}
    (tmp_path / "data/datasets/RSTPReid/data_captions.json").unlink()
    assert acquirer.verify(["RSTPReid"]) == {"RSTPReid": False}
    acquirer.clean_archives()
    assert not (tmp_path / "data/archives/RSTPReid.zip").exists()
