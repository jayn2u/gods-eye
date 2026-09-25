import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from gods_eye.benchmark import (
    BENCHMARK_QUERY_COUNT,
    BENCHMARK_QUERY_SEED,
    EVALUATION_SCHEMA_VERSION,
    REFERENCE_WARNING_PP,
    BenchmarkQuery,
    Evaluation,
    evaluate,
    evaluation_path,
    first_match_ranks,
    gallery_person_ids,
    load_test_captions,
    read_benchmark_queries,
    read_evaluation,
    retrieval_metrics,
    sample_benchmark_queries,
    write_benchmark_queries,
    write_evaluation,
)
from gods_eye.benchmark import TestCaption as Caption
from gods_eye.gallery import GalleryManifest, GalleryRecord, Provenance
from gods_eye.index_store import validate_version
from test_index_store import build as build_numpy_index


def test_metrics_match_labclip_definitions() -> None:
    similarity = np.array([[0.9, 0.8, 0.1], [0.2, 0.9, 0.8]], dtype=np.float32)
    queries = ["1", "2"]
    gallery = [frozenset({"1"}), frozenset({"2"}), frozenset({"2"})]

    metrics = retrieval_metrics(similarity, queries, gallery)
    assert metrics["top1"] == 1.0
    assert metrics["mAP"] == 1.0
    assert metrics["mINP"] == 1.0
    ranks = first_match_ranks(similarity[::-1].copy(), ["1", "2"], gallery)
    assert ranks.tolist() == [3, 2]


def test_metrics_count_a_rank_one_miss_and_multiple_positives() -> None:
    similarity = np.array([[0.9, 0.8, 0.1], [0.7, 0.6, 0.5]], dtype=np.float32)
    queries = ["1", "2"]
    gallery = [frozenset({"1"}), frozenset({"2"}), frozenset({"1"})]

    metrics = retrieval_metrics(similarity, queries, gallery)

    assert metrics["top1"] == 0.5
    assert metrics["top5"] == 1.0
    assert metrics["top10"] == 1.0
    assert metrics["mAP"] == pytest.approx(2 / 3)
    assert metrics["mINP"] == pytest.approx(7 / 12)


def test_tied_scores_keep_the_lower_gallery_index_first() -> None:
    similarity = np.array([[0.9, 0.8, 0.8], [0.9, 0.8, 0.8]], dtype=np.float32)
    gallery = [frozenset({"1"}), frozenset({"2"}), frozenset({"3"})]

    assert first_match_ranks(similarity, ["2", "3"], gallery).tolist() == [2, 3]


def test_gallery_person_ids_include_alias_provenance() -> None:
    manifest = GalleryManifest(
        roots={"CUHK-PEDES": Path("/unused")},
        records=[
            GalleryRecord(
                id="image-1",
                dataset="CUHK-PEDES",
                split="test",
                relative_path="image.jpg",
                source_person_id="10",
                content_sha256="abc",
                aliases=[
                    Provenance(
                        dataset="CUHK-PEDES",
                        split="test",
                        relative_path="duplicate.jpg",
                        source_person_id="20",
                    )
                ],
            )
        ],
        report={},
    )

    assert gallery_person_ids(manifest) == [frozenset({"10", "20"})]
    assert (
        retrieval_metrics(
            np.array([[0.5], [0.4]], dtype=np.float32),
            ["10", "20"],
            gallery_person_ids(manifest),
        )["top1"]
        == 1.0
    )


def _python_reference_metrics(
    similarity: np.ndarray,
    query_person_ids: list[str],
    gallery_ids: list[frozenset[str]],
) -> dict[str, float]:
    row_matches = []
    for query_index, person_id in enumerate(query_person_ids):
        order = sorted(
            range(len(gallery_ids)),
            key=lambda index: (-float(similarity[query_index, index]), index),
        )
        row_matches.append([person_id in gallery_ids[index] for index in order])

    metrics: dict[str, float] = {}
    gallery_size = len(gallery_ids)
    for k in (1, 5, 10):
        effective_k = min(k, gallery_size)
        metrics[f"top{k}"] = sum(any(row[:effective_k]) for row in row_matches) / len(row_matches)

    average_precisions = []
    inverse_penalties = []
    for matches in row_matches:
        positives = sum(matches)
        precision_sum = 0.0
        seen = 0
        last_positive_rank = 0
        for rank, match in enumerate(matches, start=1):
            if match:
                seen += 1
                precision_sum += seen / rank
                last_positive_rank = rank
        average_precisions.append(precision_sum / positives)
        inverse_penalties.append(positives / last_positive_rank)
    metrics["mAP"] = sum(average_precisions) / len(average_precisions)
    metrics["mINP"] = sum(inverse_penalties) / len(inverse_penalties)
    return metrics


def test_metrics_match_an_independent_python_reference() -> None:
    rng = np.random.default_rng(20260925)
    query_ids = [f"person-{index}" for index in range(20)]
    gallery_ids = [frozenset({person_id}) for person_id in query_ids]
    gallery_ids.extend(frozenset({query_ids[int(index)]}) for index in rng.integers(0, 20, 10))
    similarity = rng.normal(size=(20, 30)).astype(np.float32)

    actual = retrieval_metrics(similarity, query_ids, gallery_ids)
    expected = _python_reference_metrics(similarity, query_ids, gallery_ids)

    assert actual == pytest.approx(expected)


def test_load_test_captions_keeps_test_rows_in_file_order_and_skips_blanks(
    tmp_path: Path,
) -> None:
    metadata = tmp_path / "reid_raw.json"
    metadata.write_text(
        json.dumps(
            [
                {"split": "train", "file_path": "train.jpg", "id": 1, "captions": ["train"]},
                {"split": "test", "file_path": "one.jpg", "id": 7, "captions": ["first", "  "]},
                {"split": "val", "file_path": "val.jpg", "id": 2, "captions": ["val"]},
                {
                    "split": "test",
                    "file_path": "two.jpg",
                    "id": 8,
                    "captions": [" second ", "third"],
                },
            ]
        ),
        encoding="utf-8",
    )

    assert load_test_captions(metadata) == (
        Caption("first", "7", "one.jpg"),
        Caption(" second ", "8", "two.jpg"),
        Caption("third", "8", "two.jpg"),
    )


def test_benchmark_queries_are_deterministic_unique_and_stable() -> None:
    captions = (
        Caption("caption 2a", "2", "2/a.jpg"),
        Caption("caption 1a", "1", "1/a.jpg"),
        Caption("caption 2b", "2", "2/b.jpg"),
        Caption("caption 3a", "3", "3/a.jpg"),
        Caption("caption 1b", "1", "1/b.jpg"),
    )

    sampled = sample_benchmark_queries(captions, count=10, seed=91)
    assert sampled == sample_benchmark_queries(captions, count=10, seed=91)
    assert len(sampled) == 3
    assert len({query.person_id for query in sampled}) == 3
    assert {query.person_id for query in sampled} == {"1", "2", "3"}

    capped = sample_benchmark_queries(captions, count=2, seed=91)
    assert len(capped) == 2
    assert len({query.person_id for query in capped}) == 2
    assert all(query.id.startswith("bq_") for query in (*sampled, *capped))
    assert (BENCHMARK_QUERY_COUNT, BENCHMARK_QUERY_SEED) == (48, 20260925)


def test_benchmark_query_files_are_digest_bound_and_newline_terminated(tmp_path: Path) -> None:
    path = tmp_path / "queries.json"
    queries = (BenchmarkQuery("bq_0123456789abcdef", "invented caption", "4"),)

    write_benchmark_queries(path, queries, manifest_sha256="manifest-digest")

    assert path.read_bytes().endswith(b"\n")
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert list(payload) == sorted(payload)
    assert read_benchmark_queries(path, manifest_sha256="manifest-digest") == queries
    with pytest.raises(ValueError, match="manifest"):
        read_benchmark_queries(path, manifest_sha256="another-digest")


def test_evaluate_uses_numpy_index_filters_queries_and_records_reference(tmp_path: Path) -> None:
    loaded = validate_version(build_numpy_index(tmp_path))
    captions = (
        Caption("query-0", "0", "0.png"),
        Caption("query-1", "1", "1.png"),
        Caption("unmatched", "outside-gallery", "outside.png"),
    )
    benchmark_queries = (
        BenchmarkQuery("bq_first", "query-0", "0"),
        BenchmarkQuery("bq_second", "query-1", "1"),
    )
    person_vectors = {
        record.source_person_id: loaded.vectors[index]
        for index, record in enumerate(loaded.manifest.records)
    }
    caption_vectors = {
        "query-0": person_vectors["0"],
        "query-1": person_vectors["1"],
        "unmatched": loaded.vectors[0],
    }

    def embed_texts(texts: list[str]) -> np.ndarray:
        return np.asarray([caption_vectors[text] for text in texts], dtype=np.float32)

    evaluation = evaluate(
        embed_texts,
        loaded,
        captions,
        benchmark_queries,
        model_id="fixture/deterministic-v1",
        model_revision="revision-a",
        reference_metrics={
            "dataset": "cuhk-pedes",
            "split": "test",
            "direction": "text-to-image",
            "queries": 6156,
            "gallery": 3074,
            "metrics": {"top1": 0.99, "top5": 1.0, "top10": 1.0, "mAP": 1.0, "mINP": 1.0},
        },
        now=datetime(2026, 9, 25, 7, 0, tzinfo=UTC),
    )

    assert evaluation.query_count == 2
    assert evaluation.gallery_count == 3
    assert evaluation.model_id == "fixture/deterministic-v1"
    assert evaluation.index_version == loaded.metadata.version_id
    assert evaluation.model_revision == "revision-a"
    assert evaluation.benchmark_query_ranks == {"bq_first": 1, "bq_second": 1}
    assert evaluation.metrics["top1"] == 1.0
    assert evaluation.reference is not None
    assert evaluation.reference["delta_top1_pp"] == 1.0
    assert evaluation.reference["warning"] is (1.0 > REFERENCE_WARNING_PP)


def test_evaluation_files_are_versioned_and_immutable(tmp_path: Path) -> None:
    evaluation = Evaluation(
        model_id="model-a",
        index_version="version-a",
        model_revision="revision-a",
        created_at="2026-09-25T07:00:00+00:00",
        query_count=1,
        gallery_count=2,
        metrics={"top1": 1.0},
        benchmark_query_ranks={"bq_one": 1},
        reference=None,
    )
    path = evaluation_path(tmp_path / "indexes", "version-a")

    assert path == tmp_path / "indexes" / "evaluations" / "version-a.json"
    write_evaluation(path, evaluation)
    assert path.read_bytes().endswith(b"\n")
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == EVALUATION_SCHEMA_VERSION == 1
    assert list(payload) == sorted(payload)
    assert read_evaluation(path) == evaluation

    changed = replace(evaluation, metrics={"top1": 0.0})
    with pytest.raises(ValueError, match="different"):
        write_evaluation(path, changed)
    assert read_evaluation(path) == evaluation


def test_sampled_query_id_uses_path_and_caption_hash() -> None:
    caption = Caption("invented", "person", "relative/image.jpg")

    query = sample_benchmark_queries((caption,), count=1, seed=4)[0]

    expected = hashlib.sha256(b"relative/image.jpg\ninvented").hexdigest()[:16]
    assert query.id == f"bq_{expected}"
