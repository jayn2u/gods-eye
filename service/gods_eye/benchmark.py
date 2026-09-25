from __future__ import annotations

import hashlib
import json
import os
import random
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from .gallery import GalleryManifest
    from .index_store import LoadedIndex

BENCHMARK_QUERY_COUNT = 48
BENCHMARK_QUERY_SEED = 20260925
EVALUATION_SCHEMA_VERSION = 1
REFERENCE_WARNING_PP = 0.5


@dataclass(frozen=True, slots=True)
class TestCaption:
    caption: str
    person_id: str
    relative_path: str


def load_test_captions(metadata: Path) -> tuple[TestCaption, ...]:
    rows = json.loads(metadata.read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise TypeError("Test metadata must contain a JSON array")

    captions: list[TestCaption] = []
    for row in rows:
        if not isinstance(row, dict):
            raise TypeError("Test metadata rows must be JSON objects")
        if row.get("split") != "test":
            continue
        relative_path = row["file_path"]
        person_id = str(row["id"])
        for caption in row["captions"]:
            if not isinstance(caption, str):
                raise TypeError("Test captions must be strings")
            if caption.strip():
                captions.append(TestCaption(caption, person_id, relative_path))
    return tuple(captions)


def gallery_person_ids(manifest: GalleryManifest) -> list[frozenset[str]]:
    result = []
    for record in manifest.records:
        person_ids = {record.source_person_id}
        person_ids.update(alias.source_person_id for alias in record.aliases)
        result.append(frozenset(person_ids))
    return result


def _ranked_matches(
    similarity: np.ndarray,
    query_person_ids: Sequence[str],
    gallery_ids: Sequence[frozenset[str]],
) -> np.ndarray:
    scores = np.asarray(similarity)
    if scores.ndim != 2:
        raise ValueError("similarity must be a 2D array")
    if scores.shape != (len(query_person_ids), len(gallery_ids)):
        raise ValueError("similarity shape does not match query and gallery IDs")

    match_cache: dict[str, np.ndarray] = {}
    for person_id in query_person_ids:
        if person_id not in match_cache:
            match_cache[person_id] = np.fromiter(
                (person_id in row_ids for row_ids in gallery_ids),
                dtype=np.bool_,
                count=len(gallery_ids),
            )
    if len(query_person_ids) > 0:
        matches = np.stack([match_cache[person_id] for person_id in query_person_ids])
    else:
        matches = np.empty((0, len(gallery_ids)), dtype=np.bool_)
    if matches.shape[0] and not matches.any(axis=1).all():
        raise ValueError("At least one query has no matching gallery target ID")

    # Stable descending sort keeps the lower gallery index first when scores tie.
    order = np.argsort(-scores, axis=1, kind="stable")
    return np.take_along_axis(matches, order, axis=1)


def retrieval_metrics(
    similarity: np.ndarray,
    query_person_ids: Sequence[str],
    gallery_person_ids: Sequence[frozenset[str]],
) -> dict[str, float]:
    ranked_matches = _ranked_matches(similarity, query_person_ids, gallery_person_ids)
    gallery_size = ranked_matches.shape[1]

    metrics: dict[str, float] = {}
    for k in (1, 5, 10):
        effective_k = min(k, gallery_size)
        metrics[f"top{k}"] = float(ranked_matches[:, :effective_k].any(axis=1).mean())

    positive_counts = ranked_matches.sum(axis=1).clip(min=1)
    ranks = np.arange(1, gallery_size + 1, dtype=np.float64)[None, :]
    precision_at_rank = np.cumsum(ranked_matches, axis=1) / ranks
    average_precision = (precision_at_rank * ranked_matches).sum(axis=1) / positive_counts
    last_positive_rank = gallery_size - np.argmax(ranked_matches[:, ::-1], axis=1)
    inverse_negative_penalty = positive_counts / last_positive_rank
    metrics["mAP"] = float(average_precision.mean())
    metrics["mINP"] = float(inverse_negative_penalty.mean())
    return metrics


def first_match_ranks(
    similarity: np.ndarray,
    query_person_ids: Sequence[str],
    gallery_person_ids: Sequence[frozenset[str]],
) -> np.ndarray:
    ranked_matches = _ranked_matches(similarity, query_person_ids, gallery_person_ids)
    return np.argmax(ranked_matches, axis=1).astype(np.int64) + 1


@dataclass(frozen=True, slots=True)
class BenchmarkQuery:
    id: str
    caption: str
    person_id: str


class BenchmarkQueryNotFoundError(LookupError):
    """Raised when a requested query is not part of the fixed sample."""


def sample_benchmark_queries(
    captions: Sequence[TestCaption],
    *,
    count: int = BENCHMARK_QUERY_COUNT,
    seed: int = BENCHMARK_QUERY_SEED,
) -> tuple[BenchmarkQuery, ...]:
    captions_by_person: dict[str, list[TestCaption]] = {}
    for caption in captions:
        captions_by_person.setdefault(caption.person_id, []).append(caption)

    person_ids = sorted(captions_by_person)
    sampled_ids = random.Random(seed).sample(person_ids, min(count, len(person_ids)))
    result = []
    for person_id in sampled_ids:
        caption = random.Random(f"{seed}:{person_id}").choice(captions_by_person[person_id])
        query_id = hashlib.sha256(
            f"{caption.relative_path}\n{caption.caption}".encode()
        ).hexdigest()
        result.append(BenchmarkQuery(f"bq_{query_id[:16]}", caption.caption, person_id))
    return tuple(result)


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_benchmark_queries(
    path: Path,
    queries: Sequence[BenchmarkQuery],
    *,
    manifest_sha256: str,
) -> None:
    payload = {
        "manifest_sha256": manifest_sha256,
        "queries": [asdict(query) for query in queries],
    }
    _atomic_write_json(path, payload)


def read_benchmark_queries(
    path: Path,
    *,
    manifest_sha256: str | None = None,
) -> tuple[BenchmarkQuery, ...]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("queries"), list):
        raise TypeError("Unreadable Benchmark Query file")
    if manifest_sha256 is not None and payload.get("manifest_sha256") != manifest_sha256:
        raise ValueError("Benchmark Query manifest digest does not match")
    try:
        return tuple(BenchmarkQuery(**query) for query in payload["queries"])
    except (TypeError, ValueError) as exc:
        raise ValueError("Unreadable Benchmark Query file") from exc


@dataclass(frozen=True, slots=True)
class Evaluation:
    model_id: str
    index_version: str
    model_revision: str
    created_at: str
    query_count: int
    gallery_count: int
    metrics: dict[str, float]
    benchmark_query_ranks: dict[str, int]
    reference: dict | None


def evaluate(
    embed_texts: Callable[[Sequence[str]], np.ndarray],
    loaded: LoadedIndex,
    captions: Sequence[TestCaption],
    benchmark_queries: Sequence[BenchmarkQuery],
    *,
    model_id: str,
    model_revision: str,
    reference_metrics: dict | None,
    now: datetime,
) -> Evaluation:
    gallery_ids = gallery_person_ids(loaded.manifest)
    available_person_ids = set().union(*gallery_ids) if gallery_ids else set()
    kept_captions = tuple(
        caption for caption in captions if caption.person_id in available_person_ids
    )
    if not kept_captions:
        raise ValueError("No test captions have a matching gallery person ID")

    gallery_vectors = np.asarray(loaded.vectors, dtype=np.float32)
    query_vectors = np.asarray(
        embed_texts([caption.caption for caption in kept_captions]), dtype=np.float32
    )
    expected_query_shape = (len(kept_captions), gallery_vectors.shape[1])
    if query_vectors.shape != expected_query_shape:
        raise ValueError(f"Text embeddings must have shape {expected_query_shape}")
    similarity = query_vectors @ gallery_vectors.T
    metrics = retrieval_metrics(
        similarity,
        [caption.person_id for caption in kept_captions],
        gallery_ids,
    )

    if benchmark_queries:
        benchmark_vectors = np.asarray(
            embed_texts([query.caption for query in benchmark_queries]), dtype=np.float32
        )
        expected_benchmark_shape = (len(benchmark_queries), gallery_vectors.shape[1])
        if benchmark_vectors.shape != expected_benchmark_shape:
            raise ValueError(f"Text embeddings must have shape {expected_benchmark_shape}")
        benchmark_similarity = benchmark_vectors @ gallery_vectors.T
        ranks = first_match_ranks(
            benchmark_similarity,
            [query.person_id for query in benchmark_queries],
            gallery_ids,
        )
        benchmark_ranks = {
            query.id: int(rank) for query, rank in zip(benchmark_queries, ranks, strict=True)
        }
    else:
        benchmark_ranks = {}

    reference = None
    if reference_metrics is not None:
        reference_values = reference_metrics["metrics"]
        delta_top1_pp = round((metrics["top1"] - float(reference_values["top1"])) * 100, 2)
        reference = {
            "source": "lab_clip",
            "metrics": reference_values,
            "gallery": reference_metrics["gallery"],
            "queries": reference_metrics["queries"],
            "delta_top1_pp": delta_top1_pp,
            "warning": abs(delta_top1_pp) > REFERENCE_WARNING_PP,
        }

    return Evaluation(
        model_id=model_id,
        index_version=loaded.metadata.version_id,
        model_revision=model_revision,
        created_at=now.isoformat(),
        query_count=len(kept_captions),
        gallery_count=len(loaded.manifest.records),
        metrics=metrics,
        benchmark_query_ranks=benchmark_ranks,
        reference=reference,
    )


def evaluation_path(index_root: Path, version_id: str) -> Path:
    return index_root / "evaluations" / f"{version_id}.json"


def _evaluation_payload(evaluation: Evaluation) -> dict:
    return {"schema_version": EVALUATION_SCHEMA_VERSION, **asdict(evaluation)}


def write_evaluation(path: Path, evaluation: Evaluation) -> None:
    payload = _evaluation_payload(evaluation)
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Cannot overwrite unreadable evaluation file: {path}") from exc
        if existing != payload:
            raise ValueError(f"Refusing to overwrite a different evaluation payload: {path}")
        return
    _atomic_write_json(path, payload)


def read_evaluation(path: Path) -> Evaluation:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(payload, dict)
        or type(payload.get("schema_version")) is not int
        or payload.get("schema_version") != EVALUATION_SCHEMA_VERSION
    ):
        raise ValueError("Unsupported evaluation schema")
    try:
        return Evaluation(
            model_id=payload["model_id"],
            index_version=payload["index_version"],
            model_revision=payload["model_revision"],
            created_at=payload["created_at"],
            query_count=payload["query_count"],
            gallery_count=payload["gallery_count"],
            metrics=payload["metrics"],
            benchmark_query_ranks=payload["benchmark_query_ranks"],
            reference=payload["reference"],
        )
    except (KeyError, TypeError) as exc:
        raise ValueError("Unreadable evaluation payload") from exc
