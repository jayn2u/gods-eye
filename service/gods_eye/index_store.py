from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

import numpy as np

from .gallery import GalleryBuildError, GalleryManifest


class IndexValidationError(ValueError):
    """An index version is incomplete, corrupt, or incompatible."""


def manifest_digest(manifest: GalleryManifest) -> str:
    payload = json.dumps(manifest.to_dict(), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def deterministic_embedding(value: str, dimension: int) -> np.ndarray:
    """Stable, normalized fixture feature used until the CLIP adapter is selected."""
    chunks = bytearray()
    counter = 0
    while len(chunks) < dimension * 4:
        chunks.extend(hashlib.sha256(f"{value}:{counter}".encode()).digest())
        counter += 1
    vector = np.frombuffer(bytes(chunks[: dimension * 4]), dtype=np.uint32).astype(np.float32)
    vector = vector / np.float32(2**32 - 1) - np.float32(0.5)
    return vector / np.linalg.norm(vector)


class FlatIndex(Protocol):
    dimension: int
    count: int

    def search(self, query: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]: ...


class NumpyFlatIndex:
    """Network-free exact IP adapter used by artifact and contract tests."""

    def __init__(self, vectors: np.ndarray):
        self.vectors = np.ascontiguousarray(vectors, dtype=np.float32)
        self.dimension = self.vectors.shape[1]
        self.count = self.vectors.shape[0]

    def search(self, query: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
        scores = self.vectors @ np.asarray(query, dtype=np.float32)
        rows = np.argsort(-scores, kind="stable")[:k]
        return scores[rows], rows


class FaissFlatIndex:
    def __init__(self, index):
        self.index = index
        self.dimension = int(index.d)
        self.count = int(index.ntotal)

    def search(self, query: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
        scores, rows = self.index.search(np.ascontiguousarray(query[None], dtype=np.float32), k)
        return scores[0], rows[0]


@dataclass(frozen=True)
class IndexMetadata:
    version: int
    version_id: str
    model_id: str
    dimension: int
    normalized: bool
    backend: str
    manifest_sha256: str
    manifest_file: str
    embeddings_file: str
    index_file: str
    created_at: str
    gallery_count: int
    dataset_configuration: list[str]


@dataclass(frozen=True)
class LoadedIndex:
    path: Path
    metadata: IndexMetadata
    manifest: GalleryManifest
    vectors: np.ndarray
    index: FlatIndex


def _write_index(vectors: np.ndarray, path: Path, backend: str) -> None:
    if backend == "faiss":
        try:
            import faiss
        except ImportError as exc:
            raise IndexValidationError("faiss-cpu is required for the faiss backend") from exc
        index = faiss.IndexFlatIP(vectors.shape[1])
        index.add(np.ascontiguousarray(vectors, dtype=np.float32))
        faiss.write_index(index, str(path))
    elif backend == "numpy":
        with path.open("wb") as handle:
            np.save(handle, vectors, allow_pickle=False)
    else:
        raise IndexValidationError(f"Unsupported index backend {backend!r}")


def _read_index(path: Path, backend: str) -> FlatIndex:
    if backend == "faiss":
        try:
            import faiss
        except ImportError as exc:
            raise IndexValidationError("faiss-cpu is required to load this index") from exc
        try:
            return FaissFlatIndex(faiss.read_index(str(path)))
        except RuntimeError as exc:
            raise IndexValidationError(f"Unreadable FAISS artifact: {exc}") from exc
    if backend == "numpy":
        try:
            with path.open("rb") as handle:
                return NumpyFlatIndex(np.load(handle, allow_pickle=False))
        except (OSError, ValueError) as exc:
            raise IndexValidationError(f"Unreadable exact-index artifact: {exc}") from exc
    raise IndexValidationError(f"Unsupported index backend {backend!r}")


def build_index(
    manifest_path: Path,
    versions_dir: Path,
    *,
    model_id: str = "fixture/deterministic-v1",
    dimension: int = 32,
    backend: str = "faiss",
    now: datetime | None = None,
) -> Path:
    manifest = GalleryManifest.read(manifest_path)
    digest = manifest_digest(manifest)
    created = now or datetime.now(timezone.utc)
    seed = f"{created.isoformat()}:{model_id}:{digest}"
    version_id = (
        created.strftime("%Y%m%dT%H%M%S%fZ")
        + "-"
        + hashlib.sha256(seed.encode()).hexdigest()[:8]
    )
    versions_dir.mkdir(parents=True, exist_ok=True)
    final = versions_dir / version_id
    if final.exists():
        raise IndexValidationError(f"Immutable version already exists: {version_id}")
    staging = Path(tempfile.mkdtemp(prefix=f".{version_id}-", dir=versions_dir))
    try:
        vectors = np.stack(
            [deterministic_embedding(record.id, dimension) for record in manifest.records]
        )
        vectors = np.ascontiguousarray(vectors, dtype=np.float32)
        shutil.copyfile(manifest_path, staging / "manifest.json")
        np.save(staging / "embeddings.npy", vectors, allow_pickle=False)
        _write_index(vectors, staging / "index.faiss", backend)
        coverage = {"indexed": len(manifest.records), "excluded": 0, **manifest.report}
        (staging / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
        metadata = IndexMetadata(
            version=1,
            version_id=version_id,
            model_id=model_id,
            dimension=dimension,
            normalized=True,
            backend=backend,
            manifest_sha256=digest,
            manifest_file="manifest.json",
            embeddings_file="embeddings.npy",
            index_file="index.faiss",
            created_at=created.isoformat(),
            gallery_count=len(manifest.records),
            dataset_configuration=sorted(manifest.roots),
        )
        (staging / "metadata.json").write_text(json.dumps(asdict(metadata), indent=2) + "\n")
        validate_version(staging, expected_model_id=model_id)
        os.replace(staging, final)
        return final
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def validate_version(version_dir: Path, expected_model_id: str | None = None) -> LoadedIndex:
    try:
        raw = json.loads((version_dir / "metadata.json").read_text())
        metadata = IndexMetadata(**raw)
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise IndexValidationError(f"Unreadable index metadata: {exc}") from exc
    if metadata.version != 1 or not metadata.normalized:
        raise IndexValidationError("Index must use metadata v1 and normalized vectors")
    if expected_model_id is not None and metadata.model_id != expected_model_id:
        raise IndexValidationError(
            f"Model mismatch: index uses {metadata.model_id!r}, service expects {expected_model_id!r}"
        )
    try:
        manifest = GalleryManifest.read(version_dir / metadata.manifest_file)
    except (GalleryBuildError, OSError) as exc:
        raise IndexValidationError(f"Unreadable linked manifest: {exc}") from exc
    if manifest_digest(manifest) != metadata.manifest_sha256:
        raise IndexValidationError("Manifest digest does not match index metadata")
    try:
        vectors = np.load(version_dir / metadata.embeddings_file, allow_pickle=False)
    except (OSError, ValueError) as exc:
        raise IndexValidationError(f"Unreadable embeddings: {exc}") from exc
    expected_shape = (len(manifest.records), metadata.dimension)
    if vectors.dtype != np.float32 or vectors.shape != expected_shape:
        raise IndexValidationError(f"Embeddings must be float32 with shape {expected_shape}")
    finite = np.all(np.isfinite(vectors))
    normalized = np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-4)
    if not finite or not normalized:
        raise IndexValidationError("Embeddings contain invalid or non-normalized vectors")
    index = _read_index(version_dir / metadata.index_file, metadata.backend)
    if index.dimension != metadata.dimension or index.count != len(manifest.records):
        raise IndexValidationError("Index dimension/count does not match metadata and manifest")
    if metadata.gallery_count != len(manifest.records):
        raise IndexValidationError("Gallery count does not match manifest")
    for record in manifest.records:
        if manifest.resolve(record.id) is None:
            raise IndexValidationError(f"Manifest image is not resolvable: {record.id}")
    return LoadedIndex(version_dir, metadata, manifest, vectors, index)


def activate_version(
    version_dir: Path, active_pointer: Path, expected_model_id: str
) -> LoadedIndex:
    loaded = validate_version(version_dir, expected_model_id)
    active_pointer.parent.mkdir(parents=True, exist_ok=True)
    temporary = active_pointer.with_name(f".{active_pointer.name}.{os.getpid()}.tmp")
    temporary.write_text(version_dir.resolve().as_posix() + "\n")
    os.replace(temporary, active_pointer)
    return loaded


def load_active(active_pointer: Path, expected_model_id: str) -> LoadedIndex:
    try:
        target = Path(active_pointer.read_text().strip())
    except OSError as exc:
        raise IndexValidationError("No active index. Build and activate an index first.") from exc
    return validate_version(target, expected_model_id)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build, validate, and activate exact search indexes"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--manifest", type=Path, required=True)
    build.add_argument("--versions-dir", type=Path, required=True)
    build.add_argument("--model-id", default="fixture/deterministic-v1")
    build.add_argument("--dimension", type=int, default=32)
    build.add_argument("--backend", choices=("faiss", "numpy"), default="faiss")
    activate = sub.add_parser("activate")
    activate.add_argument("--version", type=Path, required=True)
    activate.add_argument("--active-pointer", type=Path, required=True)
    activate.add_argument("--model-id", required=True)
    args = parser.parse_args()
    if args.command == "build":
        print(
            build_index(
                args.manifest,
                args.versions_dir,
                model_id=args.model_id,
                dimension=args.dimension,
                backend=args.backend,
            )
        )
    else:
        print(activate_version(args.version, args.active_pointer, args.model_id).metadata.version_id)


if __name__ == "__main__":
    main()
