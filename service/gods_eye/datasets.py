from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import tempfile
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from .gallery import Dataset, build_manifest


class DatasetAcquisitionError(RuntimeError):
    """Raised when a Dataset Source cannot become a verified Dataset Installation."""


@dataclass(frozen=True)
class DatasetSource:
    name: Dataset
    drive_id: str
    filename: str
    size: int
    sha256: str
    wrapper: str | None
    metadata: str

    def __post_init__(self) -> None:
        if len(self.sha256) != 64 or any(
            character not in "0123456789abcdef" for character in self.sha256
        ):
            raise ValueError(f"Invalid pinned SHA-256 for {self.name}")

    @property
    def required_paths(self) -> tuple[str, str]:
        return ("imgs", self.metadata)


@dataclass(frozen=True)
class InstallResult:
    installed: list[str]
    skipped: list[str]
    manifest: Path


Downloader = Callable[[DatasetSource, Path], None]


def load_registry(path: Path | None = None) -> list[DatasetSource]:
    registry = path or Path(__file__).with_name("dataset_registry.json")
    raw = json.loads(registry.read_text())
    return [DatasetSource(**item) for item in raw["sources"]]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def gdown_download(source: DatasetSource, destination: Path) -> None:
    try:
        import gdown
    except ImportError as exc:  # pragma: no cover - dependency error is operator-facing
        raise DatasetAcquisitionError("Install the acquisition dependency: uv sync") from exc
    result = gdown.download(id=source.drive_id, output=str(destination), resume=True, quiet=False)
    if result is None:
        raise DatasetAcquisitionError(f"Google Drive download failed for {source.name}")


class DatasetAcquirer:
    def __init__(
        self,
        data_root: Path,
        index_root: Path,
        sources: Iterable[DatasetSource],
        downloader: Downloader = gdown_download,
    ) -> None:
        self.data_root = data_root
        self.index_root = index_root
        self.sources = {source.name: source for source in sources}
        self.downloader = downloader
        self.archives = data_root / "archives"
        self.installations = data_root / "datasets"
        self.state = data_root / "install-state"

    def install(
        self, names: Iterable[str] | None = None, *, accept_terms: bool = False, force: bool = False
    ) -> InstallResult:
        if not accept_terms:
            raise DatasetAcquisitionError("Pass --accept-data-terms to acknowledge dataset terms")
        selected = self._selected(names)
        required = sum(source.size for source in selected) * 3
        if len(selected) == len(self.sources):
            required = max(required, 6 * 1024**3)
        self.data_root.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(self.data_root).free < required:
            raise DatasetAcquisitionError(
                f"Insufficient disk space: need approximately {required} bytes free"
            )
        self.archives.mkdir(parents=True, exist_ok=True)
        self.installations.mkdir(parents=True, exist_ok=True)
        self.state.mkdir(parents=True, exist_ok=True)
        installed: list[str] = []
        skipped: list[str] = []
        for source in selected:
            if not force and self._verify_source(source):
                skipped.append(source.name)
                continue
            archive = self._archive(source)
            self._download_and_verify(source, archive)
            self._extract_and_publish(source, archive)
            installed.append(source.name)
        manifest_path = self.write_manifest()
        return InstallResult(installed, skipped, manifest_path)

    def status(self) -> dict[str, str]:
        return {
            name: "installed" if self._verify_source(source) else "not-installed"
            for name, source in self.sources.items()
        }

    def verify(self, names: Iterable[str] | None = None) -> dict[str, bool]:
        return {source.name: self._verify_source(source) for source in self._selected(names)}

    def clean_archives(self) -> list[str]:
        removed: list[str] = []
        for source in self.sources.values():
            for path in (self._archive(source), self._archive(source).with_suffix(".zip.part")):
                if path.exists():
                    path.unlink()
                    removed.append(path.name)
        return removed

    def _selected(self, names: Iterable[str] | None) -> list[DatasetSource]:
        requested = list(names or self.sources)
        unknown = sorted(set(requested) - self.sources.keys())
        if unknown:
            raise DatasetAcquisitionError(f"Unsupported dataset(s): {', '.join(unknown)}")
        return [self.sources[name] for name in requested]

    def _archive(self, source: DatasetSource) -> Path:
        return self.archives / source.filename

    def _receipt(self, source: DatasetSource) -> Path:
        return self.state / f"{source.name}.receipt.json"

    def _download_and_verify(self, source: DatasetSource, archive: Path) -> None:
        if (
            archive.exists()
            and archive.stat().st_size == source.size
            and _sha256(archive) == source.sha256
        ):
            return
        part = archive.with_suffix(archive.suffix + ".part")
        self.downloader(source, part)
        if part.stat().st_size != source.size:
            raise DatasetAcquisitionError(
                f"Size mismatch for {source.name}: expected {source.size}, got {part.stat().st_size}"
            )
        actual = _sha256(part)
        if actual != source.sha256:
            raise DatasetAcquisitionError(
                f"SHA-256 mismatch for {source.name}: expected {source.sha256}, got {actual}"
            )
        os.replace(part, archive)

    def _extract_and_publish(self, source: DatasetSource, archive: Path) -> None:
        final = self.installations / source.name
        staging_parent = Path(tempfile.mkdtemp(prefix=f"{source.name}.", dir=self.state))
        staging = staging_parent / source.name
        staging.mkdir()
        try:
            with zipfile.ZipFile(archive) as payload:
                for info in payload.infolist():
                    relative = PurePosixPath(info.filename)
                    parts = relative.parts
                    if source.wrapper:
                        if not parts or parts[0] != source.wrapper:
                            raise DatasetAcquisitionError(
                                f"Unexpected archive root for {source.name}: {info.filename}"
                            )
                        parts = parts[1:]
                    if not parts:
                        continue
                    if relative.is_absolute() or ".." in parts:
                        raise DatasetAcquisitionError(f"unsafe ZIP path: {info.filename}")
                    mode = info.external_attr >> 16
                    if stat.S_ISLNK(mode):
                        raise DatasetAcquisitionError(f"unsafe ZIP symlink: {info.filename}")
                    target = staging.joinpath(*parts)
                    if info.is_dir():
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with payload.open(info) as source_stream, target.open("wb") as output:
                            shutil.copyfileobj(source_stream, output)
            self._validate_structure(source, staging)
            receipt = {
                "schema_version": 1,
                "dataset": source.name,
                "archive": source.filename,
                "archive_sha256": source.sha256,
                "installed_at": datetime.now(UTC).isoformat(),
                "required_paths": list(source.required_paths),
            }
            backup = final.with_name(final.name + ".previous")
            if backup.exists():
                shutil.rmtree(backup)
            if final.exists():
                os.replace(final, backup)
            try:
                os.replace(staging, final)
            except OSError:
                if backup.exists():
                    os.replace(backup, final)
                raise
            else:
                if backup.exists():
                    shutil.rmtree(backup)
            receipt_path = self._receipt(source)
            pending_receipt = receipt_path.with_suffix(receipt_path.suffix + ".tmp")
            pending_receipt.write_text(json.dumps(receipt, indent=2) + "\n")
            os.replace(pending_receipt, receipt_path)
        finally:
            shutil.rmtree(staging_parent, ignore_errors=True)

    def _validate_structure(self, source: DatasetSource, root: Path) -> None:
        missing = [item for item in source.required_paths if not (root / item).exists()]
        if missing:
            raise DatasetAcquisitionError(
                f"Invalid {source.name} installation; missing: {', '.join(missing)}"
            )

    def _verify_source(self, source: DatasetSource) -> bool:
        root = self.installations / source.name
        receipt_path = self._receipt(source)
        try:
            receipt: dict[str, Any] = json.loads(receipt_path.read_text())
        except (OSError, ValueError):
            return False
        return (
            receipt.get("archive_sha256") == source.sha256
            and receipt.get("dataset") == source.name
            and all((root / item).exists() for item in source.required_paths)
        )

    def write_manifest(self) -> Path:
        """Publish a Gallery Manifest from every verified Dataset Installation."""
        sources: dict[Dataset, tuple[Path, Path]] = {}
        for source in self.sources.values():
            if self._verify_source(source):
                root = self.installations / source.name
                sources[source.name] = (root / "imgs", root / source.metadata)
        if not sources:
            raise DatasetAcquisitionError("No verified Dataset Installations are available")
        self.index_root.mkdir(parents=True, exist_ok=True)
        output = self.index_root / "gallery-manifest.json"
        build_manifest(sources).write(output)
        return output


def _manager(args: argparse.Namespace) -> DatasetAcquirer:
    return DatasetAcquirer(args.data_root, args.index_root, load_registry(args.registry))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Acquire verified God's Eye research datasets")
    parser.add_argument("--data-root", type=Path, default=Path("data"))
    parser.add_argument("--index-root", type=Path, default=Path("indexes"))
    parser.add_argument("--registry", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("install")
    install.add_argument("datasets", nargs="*")
    install.add_argument("--accept-data-terms", action="store_true")
    install.add_argument("--force", action="store_true")
    verify = commands.add_parser("verify")
    verify.add_argument("datasets", nargs="*")
    commands.add_parser("status")
    clean = commands.add_parser("clean")
    clean.add_argument("--archives", action="store_true", required=True)
    args = parser.parse_args(argv)
    manager = _manager(args)
    if args.command == "install":
        accepted = args.accept_data_terms or os.getenv("GODS_EYE_ACCEPT_DATA_TERMS") == "true"
        result = manager.install(args.datasets, accept_terms=accepted, force=args.force)
        print(json.dumps(asdict(result), default=str, indent=2))
        print(f"Next: gods-eye-index build --manifest {result.manifest} ...")
    elif args.command == "verify":
        result = manager.verify(args.datasets)
        print(json.dumps(result, indent=2))
        if not all(result.values()):
            raise SystemExit(1)
    elif args.command == "status":
        print(json.dumps(manager.status(), indent=2))
    else:
        print(json.dumps({"removed": manager.clean_archives()}, indent=2))


if __name__ == "__main__":
    main()
