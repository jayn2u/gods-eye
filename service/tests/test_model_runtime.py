import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from gods_eye.benchmark import Evaluation, evaluation_path, write_evaluation
from gods_eye.checkpoint_registry import Registration, write_registration
from gods_eye.clip_models import (
    CLIP_MODELS,
    DEFAULT_MODEL_ID,
    PRETRAINED_SOURCES,
    ModelRegistry,
    OpenClipArch,
    checkpoint_root_for,
)
from gods_eye.gallery import GalleryManifest, build_manifest
from gods_eye.index_store import activate_version, build_index, deterministic_embedding
from gods_eye.model_runtime import (
    ModelRuntimeManager,
    ModelUnavailableError,
)
from PIL import Image

REVISION = "a" * 40


class LoadTracker:
    """Collect mutable concurrency and lifecycle observations for runtime tests."""

    def __init__(self) -> None:
        self.active = 0
        self.maximum = 0
        self.encode_active = 0
        self.maximum_encode = 0
        self.calls: list[tuple[str, str | None, bool, Path | None]] = []
        self.text_only_calls: list[bool] = []
        self.closed: list[str] = []
        self.fail_model_id: str | None = None
        self.fail_encode = False
        self.guard = threading.Lock()


class FakeEmbedder:
    dimension = 8

    def __init__(self, model_id: str, tracker: LoadTracker) -> None:
        self.model_id = model_id
        self.tracker = tracker
        with tracker.guard:
            tracker.active += 1
            tracker.maximum = max(tracker.maximum, tracker.active)

    def embed_text(self, text: str) -> np.ndarray:
        with self.tracker.guard:
            self.tracker.encode_active += 1
            self.tracker.maximum_encode = max(
                self.tracker.maximum_encode, self.tracker.encode_active
            )
        try:
            if self.tracker.fail_encode:
                raise OSError("synthetic inference failure")
            return deterministic_embedding(text, self.dimension)
        finally:
            with self.tracker.guard:
                self.tracker.encode_active -= 1

    def close(self) -> None:
        with self.tracker.guard:
            self.tracker.active -= 1
            self.tracker.closed.append(self.model_id)


class FakeFactory:
    def __init__(self, tracker: LoadTracker) -> None:
        self.tracker = tracker

    def __call__(
        self,
        model_id: str,
        *,
        revision: str | None,
        device: str,
        offline: bool,
        cache_dir: Path | None,
        text_only: bool = False,
    ) -> FakeEmbedder:
        del device
        self.tracker.calls.append((model_id, revision, offline, cache_dir))
        self.tracker.text_only_calls.append(text_only)
        if model_id == self.tracker.fail_model_id:
            raise OSError("synthetic local checkpoint failure")
        return FakeEmbedder(model_id, self.tracker)


@dataclass(frozen=True, slots=True)
class RuntimeFixture:
    index_root: Path
    dataset_root: Path
    hf_cache: Path
    stable_id: str
    version_ids: dict[str, str]


def _runtime_fixture(tmp_path: Path, model_ids: tuple[str, ...]) -> RuntimeFixture:
    dataset_root = tmp_path / "datasets"
    image_root = dataset_root / "CUHK-PEDES" / "images"
    image_root.mkdir(parents=True)
    Image.new("RGB", (4, 5), (220, 20, 20)).save(image_root / "person.png")
    metadata = tmp_path / "metadata.json"
    metadata.write_text(json.dumps([{"split": "test", "file_path": "person.png", "id": 1}]))
    source = build_manifest({"CUHK-PEDES": (image_root, metadata)})
    index_root = tmp_path / "indexes"
    source_path = tmp_path / "source-manifest.json"
    source.write(source_path)
    hf_cache = tmp_path / "huggingface"
    stable_id = source.records[0].id
    version_ids: dict[str, str] = {}
    for offset, model_id in enumerate(model_ids):
        spec = next(spec for spec in CLIP_MODELS if spec.model_id == model_id)
        versions = (
            index_root / "versions"
            if model_id == DEFAULT_MODEL_ID
            else index_root / "models" / spec.storage_key / "versions"
        )
        active = versions.parent / "active"
        version = build_index(
            source_path,
            versions,
            model_id=model_id,
            dimension=8,
            backend="numpy",
            now=datetime(2026, 9, 5, 1, offset, tzinfo=UTC),
            model_revision=REVISION,
            dataset_root=dataset_root,
        )
        activate_version(version, active, model_id, dataset_root)
        version_ids[model_id] = version.name
        repo = hf_cache / f"models--{model_id.replace('/', '--')}"
        (repo / "snapshots" / REVISION).mkdir(parents=True)
    source.serialized_roots = {"CUHK-PEDES": "CUHK-PEDES/images"}
    source.write(index_root / "gallery-manifest.json")
    return RuntimeFixture(index_root, dataset_root, hf_cache, stable_id, version_ids)


def _manager(
    fixture: RuntimeFixture, tracker: LoadTracker, *, resident_models: int = 4
) -> ModelRuntimeManager:
    return ModelRuntimeManager(
        fixture.index_root,
        fixture.dataset_root,
        fixture.hf_cache,
        embedder_factory=FakeFactory(tracker),
        resident_models=resident_models,
    )


@pytest.mark.parametrize("same_model", [True, False])
def test_concurrency_serializes_model_load_encode_and_index_search(
    tmp_path: Path, same_model: bool
) -> None:
    given_ids = tuple(spec.model_id for spec in CLIP_MODELS[:2])
    fixture = _runtime_fixture(tmp_path, given_ids)
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker)
    barrier = threading.Barrier(4)
    requested = [given_ids[0] if same_model else given_ids[index % 2] for index in range(4)]

    def search(model_id: str):
        barrier.wait()
        return runtime.search(model_id, "red coat", 1, ["CUHK-PEDES"])

    with ThreadPoolExecutor(max_workers=4) as pool:
        executions = list(pool.map(search, requested))

    for execution, model_id in zip(executions, requested, strict=True):
        assert (execution.model_id, execution.active_index_version) == (
            model_id,
            fixture.version_ids[model_id],
        )
        assert (execution.results[0].rank, execution.results[0].id) == (1, fixture.stable_id)
    assert tracker.maximum == (1 if same_model else 2)
    assert tracker.maximum_encode == 1


def test_runtime_loads_exact_pinned_snapshot_offline_and_resolves_common_image(
    tmp_path: Path,
) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker)

    execution = runtime.search(DEFAULT_MODEL_ID, "red coat", 1, ["CUHK-PEDES"])

    assert tracker.calls == [(DEFAULT_MODEL_ID, REVISION, True, fixture.hf_cache)]
    assert tracker.text_only_calls == [True]
    assert execution.results[0].id == fixture.stable_id
    assert runtime.resolve_image(fixture.stable_id).is_file()


def test_missing_pinned_snapshot_is_unavailable_without_loading(tmp_path: Path) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    snapshot = (
        fixture.hf_cache / f"models--{DEFAULT_MODEL_ID.replace('/', '--')}" / "snapshots" / REVISION
    )
    snapshot.rmdir()
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker)

    with pytest.raises(ModelUnavailableError, match="local cache"):
        runtime.search(DEFAULT_MODEL_ID, "coat", 1, ["CUHK-PEDES"])

    assert tracker.calls == []
    availability = next(item for item in runtime.catalog() if item.model_id == DEFAULT_MODEL_ID)
    assert availability.prepared is True
    assert availability.ready is False


def test_legacy_default_accepts_only_one_unambiguous_local_snapshot(tmp_path: Path) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    active = fixture.index_root / "active"
    version = (active.parent / active.read_text().strip()).resolve()
    metadata_path = version / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    metadata["model_revision"] = None
    metadata_path.write_text(json.dumps(metadata))
    repo = fixture.hf_cache / f"models--{DEFAULT_MODEL_ID.replace('/', '--')}"
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text(REVISION + "\n")
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker)

    availability = next(item for item in runtime.catalog() if item.model_id == DEFAULT_MODEL_ID)
    runtime.search(DEFAULT_MODEL_ID, "coat", 1, ["CUHK-PEDES"])

    assert availability.legacy_revision_unresolved is True
    assert "prepare" in (availability.guidance or "")
    assert tracker.calls[0][1] == REVISION


def test_legacy_default_rejects_ambiguous_snapshots_without_mutating_metadata(
    tmp_path: Path,
) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    active = fixture.index_root / "active"
    version = (active.parent / active.read_text().strip()).resolve()
    metadata_path = version / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    metadata["model_revision"] = None
    metadata_path.write_text(json.dumps(metadata))
    original = metadata_path.read_bytes()
    repo = fixture.hf_cache / f"models--{DEFAULT_MODEL_ID.replace('/', '--')}"
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text(REVISION)
    (repo / "snapshots" / ("b" * 40)).mkdir()

    runtime = _manager(fixture, LoadTracker())

    with pytest.raises(ModelUnavailableError, match="ambiguous"):
        runtime.search(DEFAULT_MODEL_ID, "coat", 1, ["CUHK-PEDES"])
    assert metadata_path.read_bytes() == original


def test_failed_load_preserves_other_residents_and_inference_failure_evicts_only_its_model(
    tmp_path: Path,
) -> None:
    model_ids = tuple(spec.model_id for spec in CLIP_MODELS[:3])
    fixture = _runtime_fixture(tmp_path, model_ids)
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker)
    runtime.search(model_ids[0], "coat", 1, ["CUHK-PEDES"])
    tracker.fail_model_id = model_ids[1]

    with pytest.raises(ModelUnavailableError, match=model_ids[1]):
        runtime.search(model_ids[1], "coat", 1, ["CUHK-PEDES"])

    assert tracker.active == 1
    assert tracker.closed == []
    assert all(revision == REVISION and offline for _, revision, offline, _ in tracker.calls)
    tracker.fail_model_id = None
    execution = runtime.search(model_ids[2], "coat", 1, ["CUHK-PEDES"])
    assert execution.model_id == model_ids[2]
    assert tracker.active == 2
    assert tracker.maximum == 2
    tracker.fail_encode = True
    with pytest.raises(ModelUnavailableError):
        runtime.search(model_ids[2], "coat", 1, ["CUHK-PEDES"])
    assert tracker.active == 1
    assert tracker.closed == [model_ids[2]]
    tracker.fail_encode = False
    assert runtime.search(model_ids[2], "coat", 1, ["CUHK-PEDES"]).results


def test_model_residency_is_lru_and_text_only(tmp_path: Path) -> None:
    model_ids = tuple(spec.model_id for spec in CLIP_MODELS[:3])
    fixture = _runtime_fixture(tmp_path, model_ids)
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker, resident_models=2)

    for model_id in (model_ids[0], model_ids[1], model_ids[0], model_ids[2]):
        runtime.search(model_id, "coat", 1, ["CUHK-PEDES"])

    assert [call[0] for call in tracker.calls] == [model_ids[0], model_ids[1], model_ids[2]]
    assert tracker.text_only_calls == [True, True, True]
    assert tracker.closed == [model_ids[1]]
    assert tracker.active == 2


def test_checkpoint_without_evaluation_is_not_ready(tmp_path: Path) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    weights = b"checkpoint fixture weights"
    weights_sha256 = hashlib.sha256(weights).hexdigest()
    model_id = f"labclip:cuhk-pedes:{weights_sha256[:12]}"
    checkpoint_root = checkpoint_root_for(fixture.hf_cache)
    registration = Registration(
        model_id=model_id,
        label="FT fixture",
        weights_sha256=weights_sha256,
        source_sha256="1" * 64,
        source_filename="fixture.pt",
        arch=OpenClipArch("ViT-B-16", "openai", 384, 128, "reid"),
        verified=True,
        registered_at="2026-09-25T00:00:00+00:00",
        provenance={},
        reference_metrics=None,
    )
    registration_path = write_registration(checkpoint_root, registration)
    (registration_path.parent / "model.safetensors").write_bytes(weights)
    spec_storage_key = f"labclip-{weights_sha256[:12]}"
    versions = fixture.index_root / "models" / spec_storage_key / "versions"
    source = GalleryManifest.read(
        fixture.index_root / "gallery-manifest.json", dataset_root=fixture.dataset_root
    )
    source.serialized_roots = None
    source_path = tmp_path / "checkpoint-source-manifest.json"
    source.write(source_path)
    version = build_index(
        source_path,
        versions,
        model_id=model_id,
        dimension=8,
        backend="numpy",
        now=datetime(2026, 9, 25, 1, tzinfo=UTC),
        model_revision=f"sha256:{weights_sha256}",
        dataset_root=fixture.dataset_root,
    )
    activate_version(
        version,
        versions.parent / "active",
        model_id,
        fixture.dataset_root,
    )

    runtime = _manager(fixture, LoadTracker())

    availability = next(item for item in runtime.catalog() if item.model_id == model_id)
    assert availability.group == "fine-tuned"
    assert availability.ready is False
    assert availability.guidance == (
        f"Benchmark evaluation is missing; rerun './gods-eye prepare --model-id {model_id}'."
    )


def test_registered_models_load_evaluations_and_compare_to_the_paired_baseline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    checkpoint_root = checkpoint_root_for(fixture.hf_cache)
    weights = b"registered checkpoint weights"
    weights_sha256 = hashlib.sha256(weights).hexdigest()
    model_id = f"labclip:cuhk-pedes:{weights_sha256[:12]}"
    reference_metrics = {"top1": 0.31, "top5": 0.55, "top10": 0.67, "mAP": 0.25, "mINP": 0.21}
    fine_metrics = {"top1": 0.70, "top5": 0.90, "top10": 0.96, "mAP": 0.60, "mINP": 0.50}
    registration = Registration(
        model_id=model_id,
        label="FT · run-42",
        weights_sha256=weights_sha256,
        source_sha256="2" * 64,
        source_filename="trained.pt",
        arch=OpenClipArch("ViT-B-16", "openai", 384, 128, "reid"),
        verified=True,
        registered_at="2026-09-25T00:00:00+00:00",
        provenance={
            "wandb": {"run_id": "run-42", "project": "lab", "entity": "research"},
            "epoch": 25,
            "global_step": 1200,
            "best_val_score": 0.78,
            "ema_enabled": True,
        },
        reference_metrics={"metrics": reference_metrics, "gallery": 1, "queries": 6156},
    )
    registration_path = write_registration(checkpoint_root, registration)
    (registration_path.parent / "model.safetensors").write_bytes(weights)
    registry = ModelRegistry(checkpoint_root)
    baseline_spec = registry.get(registration.paired_baseline_id)
    fine_spec = registry.get(model_id)
    baseline_revision = PRETRAINED_SOURCES[("ViT-B-16", "openai")].revision
    baseline_weights = tmp_path / "open_clip_model.safetensors"
    baseline_weights.write_bytes(b"pinned baseline weights")
    monkeypatch.setattr(
        "gods_eye.model_runtime.baseline_weights_path",
        lambda arch, *, revision, cache_dir, offline: baseline_weights,
    )

    source = GalleryManifest.read(
        fixture.index_root / "gallery-manifest.json", dataset_root=fixture.dataset_root
    )
    source.serialized_roots = None
    source_path = tmp_path / "registered-source-manifest.json"
    source.write(source_path)
    baseline_root = fixture.index_root / "models" / baseline_spec.storage_key
    fine_root = fixture.index_root / "models" / fine_spec.storage_key
    evaluations = {
        baseline_spec.model_id: (baseline_root, baseline_revision, reference_metrics),
        model_id: (fine_root, f"sha256:{weights_sha256}", fine_metrics),
    }
    for offset, (selected_id, (model_root, revision, metrics)) in enumerate(evaluations.items()):
        version = build_index(
            source_path,
            model_root / "versions",
            model_id=selected_id,
            dimension=8,
            backend="numpy",
            now=datetime(2026, 9, 25, 2, offset, tzinfo=UTC),
            model_revision=revision,
            dataset_root=fixture.dataset_root,
        )
        activate_version(version, model_root / "active", selected_id, fixture.dataset_root)
        reference = None
        if selected_id == model_id:
            reference = {
                "source": "lab_clip",
                "metrics": reference_metrics,
                "gallery": 1,
                "queries": 6156,
                "delta_top1_pp": -0.1,
                "warning": False,
            }
        write_evaluation(
            evaluation_path(model_root, version.name),
            Evaluation(
                model_id=selected_id,
                index_version=version.name,
                model_revision=revision,
                created_at="2026-09-25T00:00:00+00:00",
                query_count=6156,
                gallery_count=1,
                metrics=metrics,
                benchmark_query_ranks={"bq_sample": 1},
                reference=reference,
            ),
        )

    runtime = ModelRuntimeManager(
        fixture.index_root,
        fixture.dataset_root,
        fixture.hf_cache,
        embedder_factory=FakeFactory(LoadTracker()),
    )

    catalog = {item.model_id: item for item in runtime.catalog()}
    response = runtime.benchmark()
    models = {item.model_id: item for item in response.models}
    fine = models[model_id]
    assert catalog[baseline_spec.model_id].ready is True
    assert catalog[baseline_spec.model_id].group == "baseline"
    assert catalog[model_id].ready is True
    assert catalog[model_id].paired_baseline_id == baseline_spec.model_id
    assert catalog[model_id].registered_at == registration.registered_at
    assert catalog[model_id].evaluation_ready is True
    assert response.protocol.query_count == 6156
    assert response.protocol.gallery_count == 1
    assert fine.delta_vs_baseline_pp.model_dump() == {
        "top1": 39.0,
        "top5": 35.0,
        "top10": 29.0,
        "mAP": 35.0,
        "mINP": 29.0,
    }
    assert fine.reference.delta_top1_pp == -0.1
    assert fine.provenance == {
        "wandb_run_id": "run-42",
        "wandb_project": "lab",
        "wandb_entity": "research",
        "epoch": 25,
        "global_step": 1200,
        "best_val_score": 0.78,
        "ema_enabled": True,
        "source_filename": "trained.pt",
    }


def test_close_releases_the_resident_model(tmp_path: Path) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker)
    runtime.search(DEFAULT_MODEL_ID, "coat", 1, ["CUHK-PEDES"])

    runtime.close()

    assert tracker.active == 0


def test_unknown_model_is_rejected_before_runtime_loading(tmp_path: Path) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker)

    with pytest.raises(ValueError, match="community/untrusted-model"):
        runtime.search("community/untrusted-model", "coat", 1, ["CUHK-PEDES"])

    assert tracker.calls == []


def test_startup_index_snapshot_is_stable_if_active_pointer_changes(tmp_path: Path) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    runtime = _manager(fixture, LoadTracker())
    expected = next(item for item in runtime.catalog() if item.model_id == DEFAULT_MODEL_ID)
    (fixture.index_root / "active").write_text("versions/replaced-after-startup\n")

    execution = runtime.search(DEFAULT_MODEL_ID, "coat", 1, ["CUHK-PEDES"])

    assert execution.active_index_version == expected.active_index_version
