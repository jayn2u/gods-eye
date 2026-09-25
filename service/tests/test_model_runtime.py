import json
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from gods_eye.clip_models import CLIP_MODELS, DEFAULT_MODEL_ID
from gods_eye.gallery import build_manifest
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
        del text_only
        self.tracker.calls.append((model_id, revision, offline, cache_dir))
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


def _manager(fixture: RuntimeFixture, tracker: LoadTracker) -> ModelRuntimeManager:
    return ModelRuntimeManager(
        fixture.index_root,
        fixture.dataset_root,
        fixture.hf_cache,
        embedder_factory=FakeFactory(tracker),
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
    assert tracker.maximum == 1
    assert tracker.maximum_encode == 1


def test_runtime_loads_exact_pinned_snapshot_offline_and_resolves_common_image(
    tmp_path: Path,
) -> None:
    fixture = _runtime_fixture(tmp_path, (DEFAULT_MODEL_ID,))
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker)

    execution = runtime.search(DEFAULT_MODEL_ID, "red coat", 1, ["CUHK-PEDES"])

    assert tracker.calls == [(DEFAULT_MODEL_ID, REVISION, True, fixture.hf_cache)]
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


def test_failed_swap_clears_resident_and_subsequent_model_can_load(tmp_path: Path) -> None:
    model_ids = tuple(spec.model_id for spec in CLIP_MODELS[:3])
    fixture = _runtime_fixture(tmp_path, model_ids)
    tracker = LoadTracker()
    runtime = _manager(fixture, tracker)
    runtime.search(model_ids[0], "coat", 1, ["CUHK-PEDES"])
    tracker.fail_model_id = model_ids[1]

    with pytest.raises(ModelUnavailableError, match=model_ids[1]):
        runtime.search(model_ids[1], "coat", 1, ["CUHK-PEDES"])

    assert tracker.active == 0
    assert all(revision == REVISION and offline for _, revision, offline, _ in tracker.calls)
    tracker.fail_model_id = None
    execution = runtime.search(model_ids[2], "coat", 1, ["CUHK-PEDES"])
    assert execution.model_id == model_ids[2]
    assert tracker.active == 1
    assert tracker.maximum == 1
    tracker.fail_encode = True
    with pytest.raises(ModelUnavailableError):
        runtime.search(model_ids[2], "coat", 1, ["CUHK-PEDES"])
    assert tracker.active == 0
    tracker.fail_encode = False
    assert runtime.search(model_ids[2], "coat", 1, ["CUHK-PEDES"]).results


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
