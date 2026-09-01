from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

import numpy as np
from PIL import Image, UnidentifiedImageError

from .gallery import GalleryBuildError, GalleryManifest


class IndexValidationError(ValueError):
    """An index version is incomplete, corrupt, or incompatible."""


def manifest_digest(manifest: GalleryManifest) -> str:
    payload = json.dumps(manifest.to_dict(), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def _portable_manifest(manifest: GalleryManifest, dataset_root: Path) -> GalleryManifest:
    serialized_roots: dict = {}
    configured_root = dataset_root.resolve()
    for dataset, root in manifest.roots.items():
        resolved = root.resolve()
        try:
            relative = resolved.relative_to(configured_root)
        except ValueError as exc:
            raise IndexValidationError(
                f"Dataset Installation root is outside the configured root: {dataset}"
            ) from exc
        serialized_roots[dataset] = relative.as_posix()
    return GalleryManifest(
        roots=manifest.roots,
        records=manifest.records,
        report=manifest.report,
        serialized_roots=serialized_roots,
    )


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
    model_revision: str | None = None
    processor_id: str | None = None


@dataclass(frozen=True)
class LoadedIndex:
    path: Path
    metadata: IndexMetadata
    manifest: GalleryManifest
    vectors: np.ndarray
    index: FlatIndex


@dataclass(frozen=True)
class EmbeddingResult:
    manifest: GalleryManifest
    vectors: np.ndarray
    failures: list[dict[str, str]]


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


def embed_manifest(
    manifest: GalleryManifest,
    *,
    model_id: str,
    dimension: int = 32,
    embedder=None,
    batch_size: int = 32,
    checkpoint_dir: Path,
    model_revision: str | None = None,
) -> EmbeddingResult:
    digest = manifest_digest(manifest)
    if embedder is None:
        vectors = np.stack(
            [deterministic_embedding(record.id, dimension) for record in manifest.records]
        )
        return EmbeddingResult(manifest, vectors, [])

    dimension = embedder.dimension
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    signature_path = checkpoint_dir / "signature.json"
    signature = {
        "model_id": model_id,
        "model_revision": model_revision,
        "manifest_sha256": digest,
        "dimension": dimension,
        "batch_size": batch_size,
    }
    if signature_path.exists() and json.loads(signature_path.read_text()) != signature:
        raise IndexValidationError("Checkpoint does not match model/config/manifest")
    signature_path.write_text(json.dumps(signature, sort_keys=True) + "\n")
    failures: list[dict[str, str]] = []
    successful = []
    all_vectors = []
    records_by_id = {record.id: record for record in manifest.records}
    for start in range(0, len(manifest.records), batch_size):
        records = manifest.records[start : start + batch_size]
        shard = checkpoint_dir / f"{start:09d}.npz"
        if shard.exists():
            saved = np.load(shard, allow_pickle=False)
            ids = saved["ids"].tolist()
            batch_vectors = saved["vectors"]
            failures.extend(json.loads(str(saved["failures_json"].item())))
            try:
                batch_records = [records_by_id[value] for value in ids]
            except KeyError as exc:
                raise IndexValidationError("Checkpoint contains an unknown image ID") from exc
        else:
            images, batch_records, batch_failures = [], [], []
            for record in records:
                path = manifest.resolve(record.id)
                try:
                    if path is None:
                        raise FileNotFoundError("manifest image is no longer available")
                    with Image.open(path) as source:
                        images.append(source.convert("RGB"))
                    batch_records.append(record)
                except (OSError, UnidentifiedImageError) as exc:
                    failure = {
                        "id": record.id,
                        "category": "unreadable_image",
                        "error": type(exc).__name__,
                    }
                    failures.append(failure)
                    batch_failures.append(failure)
            batch_vectors = (
                embedder.embed_images(images)
                if images
                else np.empty((0, dimension), dtype=np.float32)
            )
            temporary = shard.with_suffix(".tmp.npz")
            np.savez(
                temporary,
                ids=np.array([record.id for record in batch_records]),
                vectors=np.asarray(batch_vectors, dtype=np.float32),
                failures_json=json.dumps(batch_failures),
            )
            os.replace(temporary, shard)
        successful.extend(batch_records)
        all_vectors.append(batch_vectors)
    if not successful:
        raise IndexValidationError("No readable images were available to index")
    indexed_manifest = GalleryManifest(
        records=successful,
        roots=manifest.roots,
        report={**manifest.report, "unreadable_images": len(failures)},
    )
    return EmbeddingResult(indexed_manifest, np.concatenate(all_vectors), failures)


def publish_index(
    result: EmbeddingResult,
    source_manifest: GalleryManifest,
    versions_dir: Path,
    *,
    model_id: str,
    dimension: int,
    backend: str,
    created: datetime,
    model_revision: str | None,
    dataset_root: Path | None = None,
) -> Path:
    digest = manifest_digest(source_manifest)
    seed = f"{created.isoformat()}:{model_id}:{digest}"
    version_id = (
        created.strftime("%Y%m%dT%H%M%S%fZ") + "-" + hashlib.sha256(seed.encode()).hexdigest()[:8]
    )
    versions_dir.mkdir(parents=True, exist_ok=True)
    final = versions_dir / version_id
    if final.exists():
        raise IndexValidationError(f"Immutable version already exists: {version_id}")
    staging = Path(tempfile.mkdtemp(prefix=f".{version_id}-", dir=versions_dir))
    try:
        vectors = np.ascontiguousarray(result.vectors, dtype=np.float32)
        indexed_manifest = (
            _portable_manifest(result.manifest, dataset_root)
            if dataset_root is not None
            else result.manifest
        )
        indexed_manifest.write(staging / "manifest.json")
        np.save(staging / "embeddings.npy", vectors, allow_pickle=False)
        _write_index(vectors, staging / "index.faiss", backend)
        indexed_digest = manifest_digest(indexed_manifest)
        coverage = {
            "successful": len(result.manifest.records),
            "skipped": len(result.failures),
            "failed": 0,
            "failures": result.failures,
            **source_manifest.report,
        }
        (staging / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
        metadata = IndexMetadata(
            version=1,
            version_id=version_id,
            model_id=model_id,
            dimension=dimension,
            normalized=True,
            backend=backend,
            manifest_sha256=indexed_digest,
            manifest_file="manifest.json",
            embeddings_file="embeddings.npy",
            index_file="index.faiss",
            created_at=created.isoformat(),
            gallery_count=len(result.manifest.records),
            dataset_configuration=sorted(source_manifest.roots),
            model_revision=model_revision,
            processor_id=model_id if model_id != "fixture/deterministic-v1" else None,
        )
        (staging / "metadata.json").write_text(json.dumps(asdict(metadata), indent=2) + "\n")
        validate_version(staging, expected_model_id=model_id, dataset_root=dataset_root)
        os.replace(staging, final)
        return final
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def build_index(
    manifest_path: Path,
    versions_dir: Path,
    *,
    model_id: str = "fixture/deterministic-v1",
    dimension: int = 32,
    backend: str = "faiss",
    now: datetime | None = None,
    embedder=None,
    batch_size: int = 32,
    checkpoint_dir: Path | None = None,
    model_revision: str | None = None,
    dataset_root: Path | None = None,
) -> Path:
    manifest = GalleryManifest.read(manifest_path)
    checkpoint = checkpoint_dir or (
        versions_dir
        / ".checkpoints"
        / hashlib.sha256(
            f"{model_id}:{model_revision}:{manifest_digest(manifest)}".encode()
        ).hexdigest()[:20]
    )
    result = embed_manifest(
        manifest,
        model_id=model_id,
        dimension=dimension,
        embedder=embedder,
        batch_size=batch_size,
        checkpoint_dir=checkpoint,
        model_revision=model_revision,
    )
    return publish_index(
        result,
        manifest,
        versions_dir,
        model_id=model_id,
        dimension=result.vectors.shape[1],
        backend=backend,
        created=now or datetime.now(UTC),
        model_revision=model_revision,
        dataset_root=dataset_root,
    )


def validate_version(
    version_dir: Path,
    expected_model_id: str | None = None,
    expected_model_revision: str | None = None,
    dataset_root: Path | None = None,
) -> LoadedIndex:
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
    if expected_model_revision is not None and metadata.model_revision != expected_model_revision:
        raise IndexValidationError(
            "Model revision mismatch: index uses "
            f"{metadata.model_revision!r}, service expects {expected_model_revision!r}"
        )
    if (
        metadata.model_id != "fixture/deterministic-v1"
        and metadata.processor_id != metadata.model_id
    ):
        raise IndexValidationError("Index processor identity does not match its model")
    try:
        manifest = GalleryManifest.read(
            version_dir / metadata.manifest_file, dataset_root=dataset_root
        )
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
    version_dir: Path,
    active_pointer: Path,
    expected_model_id: str,
    dataset_root: Path | None = None,
) -> LoadedIndex:
    loaded = validate_version(version_dir, expected_model_id, dataset_root=dataset_root)
    active_pointer.parent.mkdir(parents=True, exist_ok=True)
    temporary = active_pointer.with_name(f".{active_pointer.name}.{os.getpid()}.tmp")
    index_root = active_pointer.parent.resolve()
    version = version_dir.resolve()
    try:
        portable_reference = version.relative_to(index_root)
    except ValueError as exc:
        raise IndexValidationError(
            "Active index version must be inside the configured index root"
        ) from exc
    temporary.write_text(portable_reference.as_posix() + "\n")
    os.replace(temporary, active_pointer)
    return loaded


def load_active(
    active_pointer: Path,
    expected_model_id: str,
    expected_model_revision: str | None = None,
    dataset_root: Path | None = None,
) -> LoadedIndex:
    try:
        stored = Path(active_pointer.read_text().strip())
    except OSError as exc:
        raise IndexValidationError("No active index. Build and activate an index first.") from exc
    index_root = active_pointer.parent.resolve()
    if stored.is_absolute() and not stored.exists():
        try:
            stored = index_root / stored.relative_to("/workspace/indexes")
        except ValueError:
            pass
    target = stored.resolve() if stored.is_absolute() else (index_root / stored).resolve()
    if not target.is_relative_to(index_root):
        raise IndexValidationError("Active index reference escapes the configured index root")
    return validate_version(target, expected_model_id, expected_model_revision, dataset_root)


def main() -> None:
    from .config import get_settings

    settings = get_settings()
    parser = argparse.ArgumentParser(
        description="Build, validate, and activate exact search indexes"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--manifest", type=Path, required=True)
    build.add_argument("--versions-dir", type=Path, default=settings.index_root / "versions")
    build.add_argument("--model-id", default=settings.model_id)
    build.add_argument("--dimension", type=int, default=32)
    build.add_argument("--backend", choices=("faiss", "numpy"), default="faiss")
    build.add_argument("--device", default=settings.device)
    build.add_argument("--batch-size", type=int, default=settings.batch_size)
    build.add_argument("--revision", default=settings.model_revision)
    build.add_argument("--offline", action=argparse.BooleanOptionalAction, default=settings.offline)
    build.add_argument("--cache-dir", type=Path, default=settings.hf_cache)
    build.add_argument("--checkpoint-dir", type=Path)
    activate = sub.add_parser("activate")
    activate.add_argument("--version", type=Path, required=True)
    activate.add_argument("--active-pointer", type=Path, default=settings.active_index)
    activate.add_argument("--model-id", default=settings.model_id)
    args = parser.parse_args()
    if args.command == "build":
        embedder = None
        if args.model_id != "fixture/deterministic-v1":
            from .clip import HuggingFaceClipEmbedder
            from .config import ClipRuntimeConfig

            embedder = HuggingFaceClipEmbedder.from_config(
                ClipRuntimeConfig(
                    model_id=args.model_id,
                    revision=args.revision,
                    device=args.device,
                    offline=args.offline,
                    cache_dir=args.cache_dir,
                )
            )
        print(
            build_index(
                args.manifest,
                args.versions_dir,
                model_id=args.model_id,
                dimension=args.dimension,
                backend=args.backend,
                embedder=embedder,
                batch_size=args.batch_size,
                checkpoint_dir=args.checkpoint_dir,
                model_revision=args.revision,
                dataset_root=settings.dataset_root,
            )
        )
    else:
        print(
            activate_version(
                args.version,
                args.active_pointer,
                args.model_id,
                dataset_root=settings.dataset_root,
            ).metadata.version_id
        )


if __name__ == "__main__":
    main()
