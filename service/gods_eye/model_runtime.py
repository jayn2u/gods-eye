from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import assert_never

from .clip import ClipLoadError, HuggingFaceClipEmbedder
from .clip_models import CLIP_MODELS, DEFAULT_MODEL_ID, ClipModelSpec, get_clip_model
from .gallery import GalleryBuildError, GalleryManifest
from .index_store import IndexValidationError, LoadedIndex, load_active
from .models import Dataset
from .retrieval import (
    EmbedderFactory,
    FixtureRetrievalEngine,
    IndexedRetrievalEngine,
    RuntimeEmbedder,
    RuntimeModelAvailability,
    SearchExecution,
)

_COMMIT_SHA = re.compile(r"[0-9a-f]{40}")


class ModelUnavailableError(RuntimeError):
    def __init__(self, model_id: str, guidance: str, prepared: bool) -> None:
        self.model_id = model_id
        self.guidance = guidance
        self.prepared = prepared
        super().__init__(str(self))

    def __str__(self) -> str:
        return f"Model {self.model_id!r} is unavailable: {self.guidance}"


@dataclass(frozen=True, slots=True)
class _ReadyModel:
    availability: RuntimeModelAvailability
    loaded: LoadedIndex
    revision: str


class ModelRuntimeManager:
    """Mutable one-resident-model runtime serialized across load and search."""

    def __init__(
        self,
        index_root: Path,
        dataset_root: Path,
        hf_cache: Path | None,
        *,
        device: str = "auto",
        embedder_factory: EmbedderFactory = HuggingFaceClipEmbedder,
    ) -> None:
        self._index_root = index_root
        self._dataset_root = dataset_root
        default_home = Path(os.environ.get("HF_HOME", "~/.cache/huggingface")).expanduser()
        configured_cache = os.environ.get("HF_HUB_CACHE", str(default_home / "hub"))
        self._hf_cache = hf_cache or Path(configured_cache).expanduser()
        self._device = device
        self._embedder_factory = embedder_factory
        self._lock = threading.Lock()
        self._resident_model_id: str | None = None
        self._resident_embedder: RuntimeEmbedder | None = None
        self._models: dict[str, _ReadyModel | RuntimeModelAvailability] = {}
        try:
            self._manifest = GalleryManifest.read(
                index_root / "gallery-manifest.json", dataset_root=dataset_root
            )
            manifest_error = None
        except (GalleryBuildError, OSError) as exc:
            self._manifest = None
            manifest_error = str(exc)
        for spec in CLIP_MODELS:
            self._models[spec.model_id] = self._scan_model(spec, manifest_error)

    def _active_pointer(self, spec: ClipModelSpec) -> Path:
        if spec.model_id == DEFAULT_MODEL_ID:
            return self._index_root / "active"
        return self._index_root / "models" / spec.storage_key / "active"

    def _repo_cache(self, model_id: str) -> Path:
        return self._hf_cache / f"models--{model_id.replace('/', '--')}"

    def _scan_model(
        self, spec: ClipModelSpec, manifest_error: str | None
    ) -> _ReadyModel | RuntimeModelAvailability:
        active = self._active_pointer(spec)
        if not active.is_file():
            return self._unavailable(spec, False, "Run Demo Preparation for this model.")
        try:
            loaded = load_active(active, spec.model_id, dataset_root=self._dataset_root)
        except IndexValidationError as exc:
            return self._unavailable(spec, True, f"Active index validation failed: {exc}")
        if manifest_error is not None:
            return self._unavailable(
                spec, True, f"The shared Gallery Manifest is unavailable: {manifest_error}"
            )
        revision = loaded.metadata.model_revision
        if revision is None:
            return self._scan_legacy_default(spec, loaded)
        if _COMMIT_SHA.fullmatch(revision) is None:
            return self._unavailable(
                spec, True, "Index model revision is not an immutable commit SHA."
            )
        if not (self._repo_cache(spec.model_id) / "snapshots" / revision).is_dir():
            return self._unavailable(
                spec,
                True,
                f"The exact model revision {revision} is missing from the local cache.",
            )
        return self._ready(spec, loaded, revision)

    def _scan_legacy_default(
        self, spec: ClipModelSpec, loaded: LoadedIndex
    ) -> _ReadyModel | RuntimeModelAvailability:
        if spec.model_id != DEFAULT_MODEL_ID:
            return self._unavailable(spec, True, "Index metadata has no model revision.")
        repo = self._repo_cache(spec.model_id)
        try:
            revision = (repo / "refs" / "main").read_text().strip()
            snapshots = {
                path.name
                for path in (repo / "snapshots").iterdir()
                if path.is_dir() and _COMMIT_SHA.fullmatch(path.name)
            }
        except OSError:
            return self._unavailable(
                spec, True, "Legacy index revision cannot be resolved from the local cache."
            )
        if _COMMIT_SHA.fullmatch(revision) is None or revision not in snapshots:
            return self._unavailable(
                spec, True, "Legacy index revision cannot be resolved from the local cache."
            )
        if snapshots != {revision}:
            return self._unavailable(spec, True, "Legacy local model snapshots are ambiguous.")
        guidance = (
            "Run './gods-eye prepare --model-id openai/clip-vit-base-patch16' to pin provenance."
        )
        return self._ready(spec, loaded, revision, guidance=guidance, legacy=True)

    @staticmethod
    def _unavailable(
        spec: ClipModelSpec, prepared: bool, guidance: str
    ) -> RuntimeModelAvailability:
        return RuntimeModelAvailability(
            spec.model_id, spec.label, False, prepared, None, None, guidance
        )

    @staticmethod
    def _ready(
        spec: ClipModelSpec,
        loaded: LoadedIndex,
        revision: str,
        *,
        guidance: str | None = None,
        legacy: bool = False,
    ) -> _ReadyModel:
        availability = RuntimeModelAvailability(
            spec.model_id,
            spec.label,
            True,
            True,
            loaded.metadata.version_id,
            loaded.metadata.gallery_count,
            guidance,
            legacy,
        )
        return _ReadyModel(availability, loaded, revision)

    def catalog(self) -> tuple[RuntimeModelAvailability, ...]:
        entries = []
        for entry in self._models.values():
            match entry:
                case _ReadyModel(availability=availability):
                    entries.append(availability)
                case RuntimeModelAvailability():
                    entries.append(entry)
                case unreachable:
                    assert_never(unreachable)
        return tuple(entries)

    def resolve_image(self, stable_id: str) -> Path | None:
        if self._manifest is None:
            return None
        return self._manifest.resolve(stable_id)

    def _clear_resident(self) -> None:
        embedder = self._resident_embedder
        self._resident_model_id = None
        self._resident_embedder = None
        if embedder is not None:
            embedder.close()

    def close(self) -> None:
        with self._lock:
            self._clear_resident()

    def search(
        self, model_id: str, query: str, top_k: int, datasets: list[Dataset]
    ) -> SearchExecution:
        get_clip_model(model_id)
        entry = self._models[model_id]
        match entry:
            case RuntimeModelAvailability():
                raise ModelUnavailableError(
                    model_id, entry.guidance or "Model is unavailable.", entry.prepared
                )
            case _ReadyModel():
                pass
            case unreachable:
                assert_never(unreachable)
        with self._lock:
            try:
                if self._resident_model_id != model_id:
                    self._clear_resident()
                    embedder = self._embedder_factory(
                        model_id,
                        revision=entry.revision,
                        device=self._device,
                        offline=True,
                        cache_dir=self._hf_cache,
                    )
                    self._resident_embedder = embedder
                    self._resident_model_id = model_id
                embedder = self._resident_embedder
                if embedder is None:
                    raise ClipLoadError("The selected model did not become resident.")
                results = IndexedRetrievalEngine(entry.loaded, embedder).search(
                    query, top_k, datasets
                )
                return SearchExecution(model_id, entry.loaded.metadata.version_id, tuple(results))
            except (ClipLoadError, IndexValidationError, OSError, RuntimeError, ValueError) as exc:
                self._clear_resident()
                guidance = "Verify the prepared index and exact local model cache, then retry."
                raise ModelUnavailableError(model_id, guidance, True) from exc


class FixtureModelRuntime:
    """Synthetic four-model runtime for network-free application verification."""

    def __init__(self) -> None:
        self._engine = FixtureRetrievalEngine()

    def catalog(self) -> tuple[RuntimeModelAvailability, ...]:
        return tuple(
            RuntimeModelAvailability(
                spec.model_id,
                spec.label,
                True,
                True,
                f"fixture-{spec.storage_key}-v1",
                1,
                None,
            )
            for spec in CLIP_MODELS
        )

    def search(
        self, model_id: str, query: str, top_k: int, datasets: list[Dataset]
    ) -> SearchExecution:
        spec = get_clip_model(model_id)
        results = self._engine.search(query, top_k, datasets)
        return SearchExecution(model_id, f"fixture-{spec.storage_key}-v1", tuple(results))

    def resolve_image(self, stable_id: str) -> Path | None:
        del stable_id
        return None

    def close(self) -> None:
        pass
