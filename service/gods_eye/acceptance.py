from __future__ import annotations

import argparse
import json
import platform
import statistics
import time
from collections import Counter
from pathlib import Path
from typing import Any

from .gallery import GalleryManifest, Provenance
from .index_store import validate_version
from .models import SUPPORTED_DATASETS

DEFAULT_QUERIES = (
    "a person wearing a red shirt and dark trousers",
    "a person carrying a backpack and wearing a light jacket",
    "a person in a black coat with white shoes",
)
ALL_DATASETS = list(SUPPORTED_DATASETS)


def _provenance(record) -> list[Provenance]:
    return [
        Provenance(record.dataset, record.split, record.relative_path, record.source_person_id),
        *record.aliases,
    ]


def coverage(manifest: GalleryManifest) -> dict[str, Any]:
    source = Counter(
        (item.dataset, item.split) for record in manifest.records for item in _provenance(record)
    )
    active = Counter((record.dataset, record.split) for record in manifest.records)
    aliases = Counter(
        (item.dataset, item.split) for record in manifest.records for item in record.aliases
    )

    def rows(counter: Counter) -> dict[str, dict[str, int]]:
        return {
            dataset: {split: counter[(dataset, split)] for split in ("train", "validation", "test")}
            for dataset in ALL_DATASETS
        }

    source_rows = rows(source)
    active_rows = rows(active)
    duplicate_rows = rows(aliases)

    def zero_rows() -> dict[str, dict[str, int]]:
        return rows(Counter())

    accepted_rows = {
        dataset: {split: source_rows[dataset][split] for split in ("train", "validation", "test")}
        for dataset in ALL_DATASETS
    }
    return {
        "totals": manifest.report,
        "by_dataset_split": {
            dataset: {
                split: {
                    "source": source_rows[dataset][split],
                    "accepted": accepted_rows[dataset][split],
                    "duplicate": duplicate_rows[dataset][split],
                    "skipped": 0,
                    "failed": 0,
                    "active": active_rows[dataset][split],
                }
                for split in ("train", "validation", "test")
            }
            for dataset in ALL_DATASETS
        },
        "source_by_dataset_split": source_rows,
        "accepted_by_dataset_split": accepted_rows,
        "duplicate_by_dataset_split": duplicate_rows,
        "skipped_by_dataset_split": zero_rows(),
        "failed_by_dataset_split": zero_rows(),
        "active_by_dataset_split": active_rows,
        # Compatibility names retained for existing report consumers.
        "active_by_canonical_dataset_split": active_rows,
        "duplicate_aliases_by_dataset_split": duplicate_rows,
    }


def evaluate(
    manifest_path: Path,
    version_dir: Path | None,
    *,
    model_id: str,
    revision: str | None,
    cache_dir: Path | None,
    device: str,
    offline: bool,
    top_k: int,
    repetitions: int,
    dataset_root: Path | None = None,
) -> dict[str, Any]:
    manifest = GalleryManifest.read(manifest_path)
    report: dict[str, Any] = {
        "scope": "qualitative research acceptance; not biometric identification or benchmark accuracy",
        "hardware": {"platform": platform.platform(), "processor": platform.processor()},
        "coverage": coverage(manifest),
        "index": {"status": "not supplied"},
    }
    if version_dir is None:
        return report

    from .clip import HuggingFaceClipEmbedder
    from .retrieval import IndexedRetrievalEngine

    loaded = validate_version(version_dir, model_id, revision, dataset_root)
    from .config import ClipRuntimeConfig

    embedder = HuggingFaceClipEmbedder.from_config(
        ClipRuntimeConfig(
            model_id=model_id,
            revision=revision,
            cache_dir=cache_dir,
            device=device,
            offline=offline,
        )
    )
    engine = IndexedRetrievalEngine(loaded, embedder)
    query_reports = []
    for query_number, query in enumerate(DEFAULT_QUERIES, 1):
        durations = []
        results = None
        for _ in range(repetitions):
            started = time.perf_counter()
            results = engine.search(query, top_k, ALL_DATASETS)
            durations.append((time.perf_counter() - started) * 1000)
        assert results is not None
        query_reports.append(
            {
                "query_number": query_number,
                "latency_ms": durations,
                "ranked_results": [
                    {
                        "rank": item.rank,
                        "id": item.id,
                        "dataset": item.dataset,
                        "split": item.split,
                        "similarity": item.similarity,
                    }
                    for item in results
                ],
            }
        )
    all_durations = [value for item in query_reports for value in item["latency_ms"]]
    ordered = sorted(all_durations)
    p95_index = min(len(ordered) - 1, int(0.95 * len(ordered)))
    report["index"] = {
        "status": "validated",
        "version": loaded.metadata.version_id,
        "model_id": loaded.metadata.model_id,
        "model_revision": loaded.metadata.model_revision,
        "device": embedder.device,
        "gallery_count": loaded.metadata.gallery_count,
        "top_k": top_k,
        "cold_ms": all_durations[0],
        "warm_median_ms": statistics.median(all_durations[1:] or all_durations),
        "warm_p95_ms": ordered[p95_index],
        "max_ms": max(all_durations),
        "under_three_seconds": max(all_durations) < 3000,
        "queries": query_reports,
    }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate and report a full-gallery acceptance run"
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--version", type=Path)
    parser.add_argument("--model-id", default="openai/clip-vit-base-patch16")
    parser.add_argument("--revision")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--dataset-root", type=Path, default=Path("data/datasets"))
    parser.add_argument("--offline", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--top-k", type=int, default=24)
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = evaluate(
        args.manifest,
        args.version,
        model_id=args.model_id,
        revision=args.revision,
        cache_dir=args.cache_dir,
        device=args.device,
        offline=args.offline,
        top_k=args.top_k,
        repetitions=args.repetitions,
        dataset_root=args.dataset_root,
    )
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
