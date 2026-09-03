from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from PIL import Image, UnidentifiedImageError

from .models import SUPPORTED_DATASETS, Dataset

Split = Literal["train", "validation", "test"]


class GalleryBuildError(ValueError):
    """Raised when gallery metadata cannot safely be normalized."""


@dataclass(frozen=True)
class Provenance:
    dataset: Dataset
    split: Split
    relative_path: str
    source_person_id: str


@dataclass
class GalleryRecord:
    id: str
    dataset: Dataset
    split: Split
    relative_path: str
    source_person_id: str
    content_sha256: str
    aliases: list[Provenance] = field(default_factory=list)

    def provenance_for(self, datasets: list[Dataset]) -> Provenance | None:
        choices = [
            Provenance(self.dataset, self.split, self.relative_path, self.source_person_id),
            *self.aliases,
        ]
        return next((item for item in choices if item.dataset in datasets), None)


@dataclass
class GalleryManifest:
    roots: dict[Dataset, Path]
    records: list[GalleryRecord]
    report: dict[str, Any]
    serialized_roots: dict[Dataset, str] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        self._by_id = {record.id: record for record in self.records}
        if len(self._by_id) != len(self.records):
            raise GalleryBuildError("Manifest contains duplicate stable IDs")

    def resolve(self, stable_id: str) -> Path | None:
        record = self._by_id.get(stable_id)
        if record is None:
            return None
        root = self.roots[record.dataset].resolve()
        candidate = (root / record.relative_path).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            return None
        return candidate

    def to_dict(self) -> dict[str, Any]:
        roots = self.serialized_roots or {
            dataset: str(root) for dataset, root in self.roots.items()
        }
        return {
            "version": 1,
            "roots": roots,
            "records": [
                {
                    "id": record.id,
                    "dataset": record.dataset,
                    "split": record.split,
                    "relative_path": record.relative_path,
                    "source_person_id": record.source_person_id,
                    "content_sha256": record.content_sha256,
                    "aliases": [alias.__dict__ for alias in record.aliases],
                }
                for record in self.records
            ],
            "report": self.report,
        }

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False) + "\n")

    @classmethod
    def read(cls, path: Path, *, dataset_root: Path | None = None) -> GalleryManifest:
        try:
            raw = json.loads(path.read_text())
            if raw.get("version") != 1:
                raise GalleryBuildError(f"Unsupported manifest version in {path}")
            serialized_roots = {dataset: str(value) for dataset, value in raw["roots"].items()}
            unsupported = sorted(set(serialized_roots) - set(SUPPORTED_DATASETS))
            if unsupported:
                raise GalleryBuildError(
                    f"Manifest contains unsupported dataset(s): {', '.join(unsupported)}"
                )
            roots = {
                dataset: _resolve_dataset_root(dataset, value, dataset_root)
                for dataset, value in serialized_roots.items()
            }
            for item in raw["records"]:
                if item["dataset"] not in SUPPORTED_DATASETS:
                    raise GalleryBuildError(
                        f"Manifest contains unsupported dataset: {item['dataset']}"
                    )
                for alias in item.get("aliases", []):
                    if alias["dataset"] not in SUPPORTED_DATASETS:
                        raise GalleryBuildError(
                            f"Manifest contains unsupported dataset: {alias['dataset']}"
                        )
            records = [
                GalleryRecord(
                    id=item["id"],
                    dataset=item["dataset"],
                    split=item["split"],
                    relative_path=item["relative_path"],
                    source_person_id=str(item["source_person_id"]),
                    content_sha256=item["content_sha256"],
                    aliases=[Provenance(**alias) for alias in item.get("aliases", [])],
                )
                for item in raw["records"]
            ]
            return cls(
                roots=roots,
                records=records,
                report=raw.get("report", {}),
                serialized_roots=serialized_roots,
            )
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise GalleryBuildError(f"Unreadable gallery manifest {path}: {exc}") from exc


def _resolve_dataset_root(dataset: Dataset, value: str, dataset_root: Path | None) -> Path:
    stored = Path(value)
    if dataset_root is None:
        return stored
    if not stored.is_absolute():
        candidate = (dataset_root / stored).resolve()
    else:
        legacy_root = Path("/workspace/data/datasets")
        try:
            suffix = stored.relative_to(legacy_root)
        except ValueError as exc:
            raise GalleryBuildError(
                f"Dataset Installation root is outside the configured root: {dataset}"
            ) from exc
        candidate = (dataset_root / suffix).resolve()
    configured = dataset_root.resolve()
    if not candidate.is_relative_to(configured) or dataset not in candidate.parts:
        raise GalleryBuildError(f"Unsafe Dataset Installation root for {dataset}")
    return candidate


def _relative_path(value: Any, dataset: Dataset, row_number: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GalleryBuildError(f"{dataset} row {row_number}: missing image path")
    path = PurePosixPath(value.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise GalleryBuildError(f"{dataset} row {row_number}: unsafe image path {value!r}")
    normalized = path.as_posix().lstrip("./")
    if not normalized:
        raise GalleryBuildError(f"{dataset} row {row_number}: empty image path")
    return normalized


def _split(value: Any, dataset: Dataset, row_number: int) -> Split:
    normalized = "validation" if value == "val" else value
    if normalized not in ("train", "validation", "test"):
        raise GalleryBuildError(f"{dataset} row {row_number}: unsupported split {value!r}")
    return normalized


def stable_id(dataset: Dataset, split: Split, relative_path: str) -> str:
    identity = f"{dataset}:{split}:{relative_path}".encode()
    return "img_" + hashlib.sha256(identity).hexdigest()[:24]


def _load_rows(metadata: Path, dataset: Dataset) -> list[dict[str, Any]]:
    try:
        value = json.loads(metadata.read_text())
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GalleryBuildError(f"Could not read {dataset} metadata {metadata}: {exc}") from exc
    if not isinstance(value, list):
        raise GalleryBuildError(f"{dataset} metadata {metadata} must contain a JSON array")
    if not all(isinstance(row, dict) for row in value):
        raise GalleryBuildError(f"{dataset} metadata {metadata} contains a non-object row")
    return value


def build_manifest(sources: dict[Dataset, tuple[Path, Path]]) -> GalleryManifest:
    unsupported = sorted(set(sources) - set(SUPPORTED_DATASETS))
    if unsupported:
        raise GalleryBuildError(f"Unsupported dataset(s): {', '.join(unsupported)}")
    errors: list[str] = []
    candidates: dict[tuple[Dataset, Split, str], tuple[str, list[Provenance]]] = {}
    source_rows = 0

    for dataset in sorted(sources):
        root, metadata = sources[dataset]
        root = root.resolve()
        for row_number, row in enumerate(_load_rows(metadata, dataset), 1):
            source_rows += 1
            try:
                relative = _relative_path(
                    row.get("img_path", row.get("file_path")), dataset, row_number
                )
                split = _split(row.get("split"), dataset, row_number)
                provenance = Provenance(dataset, split, relative, str(row.get("id", "")))
                key = (dataset, split, relative)
                if key in candidates:
                    candidates[key][1].append(provenance)
                    continue
                image_path = (root / relative).resolve()
                if not image_path.is_relative_to(root):
                    raise GalleryBuildError("resolved path escapes the configured image root")
                content = image_path.read_bytes()
                with Image.open(image_path) as image:
                    image.verify()
                candidates[key] = (hashlib.sha256(content).hexdigest(), [provenance])
            except (OSError, UnidentifiedImageError, GalleryBuildError) as exc:
                errors.append(
                    f"{dataset} row {row_number} ({row.get('file_path', row.get('img_path'))!r}): {exc}"
                )

    if errors:
        preview = "\n- ".join(errors[:20])
        suffix = f"\n... and {len(errors) - 20} more" if len(errors) > 20 else ""
        raise GalleryBuildError(
            f"Gallery validation failed with {len(errors)} error(s):\n- {preview}{suffix}"
        )

    by_hash: dict[str, list[Provenance]] = {}
    for digest, provenances in candidates.values():
        by_hash.setdefault(digest, []).extend(provenances)

    records: list[GalleryRecord] = []
    for digest, provenances in sorted(by_hash.items()):
        ordered = sorted(provenances, key=lambda p: (p.dataset, p.split, p.relative_path))
        canonical, *aliases = ordered
        records.append(
            GalleryRecord(
                id=stable_id(canonical.dataset, canonical.split, canonical.relative_path),
                dataset=canonical.dataset,
                split=canonical.split,
                relative_path=canonical.relative_path,
                source_person_id=canonical.source_person_id,
                content_sha256=digest,
                aliases=aliases,
            )
        )
    records.sort(key=lambda record: record.id)
    return GalleryManifest(
        roots={dataset: root.resolve() for dataset, (root, _) in sources.items()},
        records=records,
        report={
            "source_rows": source_rows,
            "unique_paths": len(candidates),
            "exact_content_duplicates": len(candidates) - len(records),
            "records": len(records),
            "errors": 0,
        },
    )


def _parse_source(values: Iterable[str]) -> dict[Dataset, tuple[Path, Path]]:
    sources: dict[Dataset, tuple[Path, Path]] = {}
    for value in values:
        try:
            dataset_value, root, metadata = value.split("=", 2)
        except ValueError as exc:
            raise GalleryBuildError("Sources must use DATASET=IMAGE_ROOT=METADATA_JSON") from exc
        if dataset_value not in SUPPORTED_DATASETS:
            raise GalleryBuildError(f"Unsupported dataset {dataset_value!r}")
        sources[dataset_value] = (Path(root), Path(metadata))  # type: ignore[index]
    return sources


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a normalized God's Eye gallery manifest")
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = build_manifest(_parse_source(args.source))
    manifest.write(args.output)
    print(json.dumps(manifest.report, indent=2))


if __name__ == "__main__":
    main()
