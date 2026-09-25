from __future__ import annotations

import math
import os
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar, assert_never

from .benchmark import (
    BenchmarkQuery,
    BenchmarkQueryNotFoundError,
    Evaluation,
    evaluation_path,
    gallery_person_ids,
    read_benchmark_queries,
    read_evaluation,
)
from .checkpoint_registry import Registration, find_registration
from .clip import ClipLoadError
from .clip_models import (
    CLIP_MODELS,
    DEFAULT_MODEL_ID,
    PRETRAINED_SOURCES,
    ClipModelSpec,
    ModelRegistry,
    UnsupportedClipModelError,
    checkpoint_root_for,
    is_known_model_id_shape,
)
from .embedders import create_embedder
from .gallery import GalleryBuildError, GalleryManifest
from .index_store import IndexValidationError, LoadedIndex, load_active, manifest_digest
from .models import (
    BenchmarkMetrics,
    BenchmarkProtocol,
    BenchmarkReference,
    BenchmarkResponse,
    BenchmarkSearchResponse,
    BenchmarkSearchResult,
    Dataset,
    ModelBenchmark,
)
from .openclip_embedder import baseline_weights_path
from .retrieval import (
    EmbedderFactory,
    FixtureRetrievalEngine,
    IndexedRetrievalEngine,
    RuntimeEmbedder,
    RuntimeModelAvailability,
    SearchExecution,
)

_COMMIT_SHA = re.compile(r"[0-9a-f]{40}")
_CHECKPOINT_SHA = re.compile(r"sha256:[0-9a-f]{64}")
_METRIC_NAMES = ("top1", "top5", "top10", "mAP", "mINP")
_FIXTURE_BASELINE_ID = "openclip/ViT-B-16@openai:384x128-reid"
_FIXTURE_FINETUNED_ID = "labclip:cuhk-pedes:0123456789ab"


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
    spec: ClipModelSpec
    evaluation: Evaluation | None


class ModelRuntimeManager:
    """Model catalog, immutable active indexes, and bounded text-embedder residency."""

    def __init__(
        self,
        index_root: Path,
        dataset_root: Path,
        hf_cache: Path | None,
        *,
        device: str = "auto",
        resident_models: int = 4,
        embedder_factory: EmbedderFactory = create_embedder,
    ) -> None:
        if resident_models < 1:
            raise ValueError("resident_models must be positive")
        self._index_root = index_root
        self._dataset_root = dataset_root
        default_home = Path(os.environ.get("HF_HOME", "~/.cache/huggingface")).expanduser()
        configured_cache = os.environ.get("HF_HUB_CACHE", str(default_home / "hub"))
        self._hf_cache = hf_cache or Path(configured_cache).expanduser()
        self._device = device
        self._resident_limit = resident_models
        self._embedder_factory = embedder_factory
        self._lock = threading.Lock()
        self._resident: OrderedDict[str, RuntimeEmbedder] = OrderedDict()
        self._registry = ModelRegistry(checkpoint_root_for(self._hf_cache))
        self._specs = self._registry.all()
        self._models: dict[str, _ReadyModel | RuntimeModelAvailability] = {}
        self._evaluations: dict[str, Evaluation] = {}
        self._index_versions: dict[str, str] = {}
        try:
            self._manifest = GalleryManifest.read(
                index_root / "gallery-manifest.json", dataset_root=dataset_root
            )
            self._manifest_sha256 = manifest_digest(self._manifest)
            manifest_error = None
        except (GalleryBuildError, OSError) as exc:
            self._manifest = None
            self._manifest_sha256 = None
            manifest_error = str(exc)
        self._benchmark_queries = self._load_benchmark_queries()
        for spec in self._specs:
            self._models[spec.model_id] = self._scan_model(spec, manifest_error)

    def _model_index_root(self, spec: ClipModelSpec) -> Path:
        if spec.model_id == DEFAULT_MODEL_ID:
            return self._index_root
        return self._index_root / "models" / spec.storage_key

    def _active_pointer(self, spec: ClipModelSpec) -> Path:
        return self._model_index_root(spec) / "active"

    def _repo_cache(self, model_id: str) -> Path:
        return self._hf_cache / f"models--{model_id.replace('/', '--')}"

    def _load_benchmark_queries(self) -> tuple[BenchmarkQuery, ...]:
        if self._manifest is None:
            return ()
        try:
            return read_benchmark_queries(
                self._index_root / "benchmark-queries.json",
                manifest_sha256=self._manifest_sha256,
            )
        except (OSError, TypeError, ValueError):
            return ()

    def _read_evaluation(self, spec: ClipModelSpec, loaded: LoadedIndex) -> Evaluation | None:
        try:
            evaluation = read_evaluation(
                evaluation_path(self._model_index_root(spec), loaded.metadata.version_id)
            )
        except (OSError, TypeError, ValueError):
            return None
        if (
            evaluation.model_id != spec.model_id
            or evaluation.index_version != loaded.metadata.version_id
            or evaluation.model_revision != loaded.metadata.model_revision
            or type(evaluation.gallery_count) is not int
            or evaluation.gallery_count != loaded.metadata.gallery_count
            or type(evaluation.query_count) is not int
            or evaluation.query_count < 1
            or not isinstance(evaluation.benchmark_query_ranks, dict)
            or any(
                not isinstance(query_id, str) or type(rank) is not int or rank < 1
                for query_id, rank in evaluation.benchmark_query_ranks.items()
            )
        ):
            return None
        for name in _METRIC_NAMES:
            value = evaluation.metrics.get(name) if isinstance(evaluation.metrics, dict) else None
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
            ):
                return None
        return evaluation

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
        self._index_versions[spec.model_id] = loaded.metadata.version_id
        evaluation = self._read_evaluation(spec, loaded)
        if evaluation is not None:
            self._evaluations[spec.model_id] = evaluation
        if manifest_error is not None:
            return self._unavailable(
                spec,
                True,
                f"The shared Gallery Manifest is unavailable: {manifest_error}",
                evaluation_ready=evaluation is not None,
            )
        revision = loaded.metadata.model_revision
        if spec.backend == "hf":
            if revision is None:
                return self._scan_legacy_default(spec, loaded, evaluation)
            if _COMMIT_SHA.fullmatch(revision) is None:
                return self._unavailable(
                    spec,
                    True,
                    "Index model revision is not an immutable commit SHA.",
                    evaluation_ready=evaluation is not None,
                )
            if not (self._repo_cache(spec.model_id) / "snapshots" / revision).is_dir():
                return self._unavailable(
                    spec,
                    True,
                    f"The exact model revision {revision} is missing from the local cache.",
                    evaluation_ready=evaluation is not None,
                )
        else:
            asset_error = self._openclip_asset_error(spec, revision)
            if asset_error is not None:
                return self._unavailable(
                    spec, True, asset_error, evaluation_ready=evaluation is not None
                )

        if spec.group != "reference" and evaluation is None:
            guidance = (
                "Benchmark evaluation is missing; rerun './gods-eye prepare --model-id "
                f"{spec.model_id}'."
            )
            return self._unavailable(spec, True, guidance)
        assert revision is not None
        return self._ready(spec, loaded, revision, evaluation)

    def _openclip_asset_error(self, spec: ClipModelSpec, revision: str | None) -> str | None:
        if spec.arch is None:
            return "OpenCLIP model architecture is unavailable."
        if spec.checkpoint_dir is not None:
            if not (spec.checkpoint_dir / "model.safetensors").is_file():
                return "Checkpoint weights are missing from the local checkpoint registry."
            if revision is None or _CHECKPOINT_SHA.fullmatch(revision) is None:
                return "Checkpoint index revision is not an immutable SHA-256 digest."
            return None

        source = PRETRAINED_SOURCES.get((spec.arch.model_name, spec.arch.pretrained))
        if source is None:
            return "No pinned OpenCLIP weights source exists for this model."
        if revision != source.revision:
            return "OpenCLIP index revision does not match its pinned model weights."
        try:
            path = baseline_weights_path(
                spec.arch,
                revision=source.revision,
                cache_dir=self._hf_cache,
                offline=True,
            )
        except (ClipLoadError, OSError, ValueError):
            return "The pinned OpenCLIP weights are missing from the local cache."
        if not path.is_file():
            return "The pinned OpenCLIP weights are missing from the local cache."
        return None

    def _scan_legacy_default(
        self,
        spec: ClipModelSpec,
        loaded: LoadedIndex,
        evaluation: Evaluation | None,
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
        return self._ready(spec, loaded, revision, evaluation, guidance=guidance, legacy=True)

    @staticmethod
    def _unavailable(
        spec: ClipModelSpec,
        prepared: bool,
        guidance: str,
        *,
        evaluation_ready: bool = False,
    ) -> RuntimeModelAvailability:
        return RuntimeModelAvailability(
            model_id=spec.model_id,
            label=spec.label,
            ready=False,
            prepared=prepared,
            active_index_version=None,
            gallery_count=None,
            guidance=guidance,
            group=spec.group,
            paired_baseline_id=spec.paired_baseline_id,
            verified=spec.verified,
            registered_at=spec.registered_at,
            evaluation_ready=evaluation_ready,
        )

    @staticmethod
    def _ready(
        spec: ClipModelSpec,
        loaded: LoadedIndex,
        revision: str,
        evaluation: Evaluation | None,
        *,
        guidance: str | None = None,
        legacy: bool = False,
    ) -> _ReadyModel:
        availability = RuntimeModelAvailability(
            model_id=spec.model_id,
            label=spec.label,
            ready=True,
            prepared=True,
            active_index_version=loaded.metadata.version_id,
            gallery_count=loaded.metadata.gallery_count,
            guidance=guidance,
            legacy_revision_unresolved=legacy,
            group=spec.group,
            paired_baseline_id=spec.paired_baseline_id,
            verified=spec.verified,
            registered_at=spec.registered_at,
            evaluation_ready=evaluation is not None,
        )
        return _ReadyModel(availability, loaded, revision, spec, evaluation)

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

    def _drop_resident(self, model_id: str) -> None:
        embedder = self._resident.pop(model_id, None)
        if embedder is not None:
            embedder.close()

    def _resident_embedder(self, model_id: str, entry: _ReadyModel) -> RuntimeEmbedder:
        resident = self._resident.get(model_id)
        if resident is not None:
            self._resident.move_to_end(model_id)
            return resident
        embedder = self._embedder_factory(
            model_id,
            revision=entry.revision,
            device=self._device,
            offline=True,
            cache_dir=self._hf_cache,
            text_only=True,
        )
        self._resident[model_id] = embedder
        while len(self._resident) > self._resident_limit:
            oldest_model_id, oldest_embedder = self._resident.popitem(last=False)
            del oldest_model_id
            oldest_embedder.close()
        return embedder

    def close(self) -> None:
        with self._lock:
            for model_id in tuple(self._resident):
                self._drop_resident(model_id)

    def _ready_entry(self, model_id: str) -> _ReadyModel:
        entry = self._models.get(model_id)
        if entry is None:
            if not is_known_model_id_shape(model_id):
                raise UnsupportedClipModelError(model_id)
            try:
                self._registry.get(model_id)
            except UnsupportedClipModelError as exc:
                raise ModelUnavailableError(
                    model_id, "No checkpoint registration exists for this model.", False
                ) from exc
            raise ModelUnavailableError(model_id, "Run Demo Preparation for this model.", False)
        if isinstance(entry, RuntimeModelAvailability):
            raise ModelUnavailableError(
                model_id, entry.guidance or "Model is unavailable.", entry.prepared
            )
        return entry

    def search(
        self, model_id: str, query: str, top_k: int, datasets: list[Dataset]
    ) -> SearchExecution:
        entry = self._ready_entry(model_id)
        with self._lock:
            try:
                embedder = self._resident_embedder(model_id, entry)
                results = IndexedRetrievalEngine(entry.loaded, embedder).search(
                    query, top_k, datasets
                )
                return SearchExecution(model_id, entry.loaded.metadata.version_id, tuple(results))
            except (ClipLoadError, IndexValidationError, OSError, RuntimeError, ValueError) as exc:
                self._drop_resident(model_id)
                guidance = "Verify the prepared index and exact local model cache, then retry."
                raise ModelUnavailableError(model_id, guidance, True) from exc

    def benchmark_queries(self) -> tuple[BenchmarkQuery, ...]:
        return self._benchmark_queries

    def benchmark(self) -> BenchmarkResponse:
        evaluations = self._evaluations
        sample = next(iter(evaluations.values()), None)
        model_rows = []
        for spec in self._specs:
            entry = self._models[spec.model_id]
            availability = entry.availability if isinstance(entry, _ReadyModel) else entry
            evaluation = evaluations.get(spec.model_id)
            metrics = self._metrics(evaluation.metrics) if evaluation is not None else None
            baseline = evaluations.get(spec.paired_baseline_id or "")
            delta = None
            if spec.group == "fine-tuned" and evaluation is not None and baseline is not None:
                delta = self._delta(evaluation.metrics, baseline.metrics)
            registration = None
            if spec.group == "fine-tuned":
                found = find_registration(checkpoint_root_for(self._hf_cache), spec.model_id)
                registration = found[0] if found is not None else None
            reference = (
                self._reference(evaluation.reference)
                if evaluation is not None and evaluation.reference is not None
                else None
            )
            model_rows.append(
                ModelBenchmark(
                    model_id=spec.model_id,
                    label=spec.label,
                    group=spec.group,
                    paired_baseline_id=spec.paired_baseline_id,
                    verified=spec.verified,
                    index_version=(
                        evaluation.index_version
                        if evaluation is not None
                        else self._index_versions.get(spec.model_id)
                        or availability.active_index_version
                    ),
                    metrics=metrics,
                    delta_vs_baseline_pp=delta,
                    reference=reference,
                    provenance=self._provenance(registration),
                    benchmark_query_ranks=(
                        evaluation.benchmark_query_ranks if evaluation is not None else {}
                    ),
                )
            )
        protocol = BenchmarkProtocol(
            query_count=sample.query_count if sample is not None else None,
            gallery_count=sample.gallery_count if sample is not None else None,
        )
        return BenchmarkResponse(protocol=protocol, models=model_rows)

    @staticmethod
    def _metrics(values: dict[str, float]) -> BenchmarkMetrics:
        return BenchmarkMetrics(**{name: values[name] for name in _METRIC_NAMES})

    @classmethod
    def _delta(cls, fine_tuned: dict[str, float], baseline: dict[str, float]) -> BenchmarkMetrics:
        return BenchmarkMetrics(
            **{name: round((fine_tuned[name] - baseline[name]) * 100, 1) for name in _METRIC_NAMES}
        )

    @classmethod
    def _reference(cls, value: dict) -> BenchmarkReference | None:
        try:
            return BenchmarkReference(
                source=value["source"],
                metrics=cls._metrics(value["metrics"]),
                gallery=value["gallery"],
                queries=value["queries"],
                delta_top1_pp=value["delta_top1_pp"],
                warning=value["warning"],
            )
        except (KeyError, TypeError, ValueError):
            return None

    @staticmethod
    def _scalar(value: object) -> str | int | float | bool | None:
        if value is None or isinstance(value, (str, int, float)) and not isinstance(value, bool):
            return value
        if isinstance(value, bool):
            return value
        return None

    @classmethod
    def _provenance(
        cls, registration: Registration | None
    ) -> dict[str, str | int | float | bool | None] | None:
        if registration is None:
            return None
        fields = registration.provenance
        wandb = fields.get("wandb")
        wandb = wandb if isinstance(wandb, dict) else {}
        return {
            "wandb_run_id": cls._scalar(wandb.get("run_id")),
            "wandb_project": cls._scalar(wandb.get("project")),
            "wandb_entity": cls._scalar(wandb.get("entity")),
            "epoch": cls._scalar(fields.get("epoch")),
            "global_step": cls._scalar(fields.get("global_step")),
            "best_val_score": cls._scalar(fields.get("best_val_score")),
            "ema_enabled": cls._scalar(fields.get("ema_enabled")),
            "source_filename": registration.source_filename,
        }

    def benchmark_search(self, model_id: str, query_id: str, top_k: int) -> BenchmarkSearchResponse:
        entry = self._ready_entry(model_id)
        query = next(
            (item for item in self._benchmark_queries if item.id == query_id),
            None,
        )
        if query is None:
            raise BenchmarkQueryNotFoundError(query_id)
        with self._lock:
            try:
                embedder = self._resident_embedder(model_id, entry)
                engine = IndexedRetrievalEngine(entry.loaded, embedder)
                scores, rows = engine.rank_all(query.caption)
                person_ids = gallery_person_ids(entry.loaded.manifest)
                first_match_rank = next(
                    (
                        rank
                        for rank, row in enumerate(rows, 1)
                        if int(row) >= 0 and query.person_id in person_ids[int(row)]
                    ),
                    0,
                )
                results = []
                for rank, (score, row) in enumerate(zip(scores, rows, strict=True), 1):
                    row = int(row)
                    if row < 0:
                        continue
                    record = entry.loaded.manifest.records[row]
                    provenance = record.provenance_for(["CUHK-PEDES"])
                    if provenance is None:
                        continue
                    is_match = query.person_id in person_ids[row]
                    results.append(
                        BenchmarkSearchResult(
                            rank=rank,
                            similarity=float(score),
                            dataset=provenance.dataset,
                            id=record.id,
                            split=provenance.split,
                            image_url=f"/api/images/{record.id}",
                            is_match=is_match,
                        )
                    )
                    if len(results) >= top_k:
                        break
                return BenchmarkSearchResponse(
                    query_id=query.id,
                    caption=query.caption,
                    model_id=model_id,
                    active_index_version=entry.loaded.metadata.version_id,
                    first_match_rank=first_match_rank,
                    results=results,
                )
            except (ClipLoadError, IndexValidationError, OSError, RuntimeError, ValueError) as exc:
                self._drop_resident(model_id)
                guidance = "Verify the prepared index and exact local model cache, then retry."
                raise ModelUnavailableError(model_id, guidance, True) from exc


class FixtureModelRuntime:
    """Synthetic model catalog and query comparisons for network-free application checks."""

    _fixture_specs = (
        ClipModelSpec(
            model_id=_FIXTURE_BASELINE_ID,
            label="ViT-B/16 zero-shot · 384×128 ReID",
            storage_key="fixture-openclip-vit-b-16-openai-384x128-reid",
            backend="openclip",
            group="baseline",
            paired_baseline_id=None,
            verified=True,
        ),
        ClipModelSpec(
            model_id=_FIXTURE_FINETUNED_ID,
            label="FT · fixture · val R@1 78.0",
            storage_key="fixture-labclip-0123456789ab",
            backend="openclip",
            group="fine-tuned",
            paired_baseline_id=_FIXTURE_BASELINE_ID,
            verified=True,
        ),
    )
    _queries = (
        BenchmarkQuery(
            "bq_improved",
            "A visitor in a yellow raincoat carries a folded paper map.",
            "fixture-person-improved",
        ),
        BenchmarkQuery(
            "bq_same",
            "A commuter with a striped scarf walks beside a railing.",
            "fixture-person-same",
        ),
        BenchmarkQuery(
            "bq_worse",
            "A cyclist in a blue jacket holds a bright red helmet.",
            "fixture-person-worse",
        ),
    )
    _baseline_metrics: ClassVar[dict[str, float]] = {
        "top1": 0.31,
        "top5": 0.55,
        "top10": 0.63,
        "mAP": 0.28,
        "mINP": 0.24,
    }
    _fine_tuned_metrics: ClassVar[dict[str, float]] = {
        "top1": 0.70,
        "top5": 0.90,
        "top10": 0.95,
        "mAP": 0.56,
        "mINP": 0.51,
    }
    _baseline_ranks: ClassVar[dict[str, int]] = {"bq_improved": 3, "bq_same": 2, "bq_worse": 1}
    _fine_tuned_ranks: ClassVar[dict[str, int]] = {"bq_improved": 1, "bq_same": 2, "bq_worse": 4}

    def __init__(self) -> None:
        self._engine = FixtureRetrievalEngine()
        self._specs = (*self._reference_specs(), *self._fixture_specs)
        self._by_id = {spec.model_id: spec for spec in self._specs}

    @staticmethod
    def _reference_specs() -> tuple[ClipModelSpec, ...]:
        return CLIP_MODELS

    def catalog(self) -> tuple[RuntimeModelAvailability, ...]:
        return tuple(
            RuntimeModelAvailability(
                model_id=spec.model_id,
                label=spec.label,
                ready=True,
                prepared=True,
                active_index_version=f"fixture-{spec.storage_key}-v1",
                gallery_count=1,
                guidance=None,
                group=spec.group,
                paired_baseline_id=spec.paired_baseline_id,
                verified=spec.verified,
                registered_at=spec.registered_at,
                evaluation_ready=spec.group != "reference",
            )
            for spec in self._specs
        )

    def search(
        self, model_id: str, query: str, top_k: int, datasets: list[Dataset]
    ) -> SearchExecution:
        spec = self._spec_for(model_id)
        results = self._engine.search(query, top_k, datasets)
        return SearchExecution(model_id, f"fixture-{spec.storage_key}-v1", tuple(results))

    def _spec_for(self, model_id: str) -> ClipModelSpec:
        spec = self._by_id.get(model_id)
        if spec is not None:
            return spec
        if not is_known_model_id_shape(model_id):
            raise UnsupportedClipModelError(model_id)
        guidance = (
            "No checkpoint registration exists for this model."
            if model_id.startswith("labclip:")
            else "Run Demo Preparation for this model."
        )
        raise ModelUnavailableError(model_id, guidance, False)

    def resolve_image(self, stable_id: str) -> Path | None:
        del stable_id
        return None

    def close(self) -> None:
        pass

    def benchmark_queries(self) -> tuple[BenchmarkQuery, ...]:
        return self._queries

    def benchmark(self) -> BenchmarkResponse:
        delta = ModelRuntimeManager._delta(self._fine_tuned_metrics, self._baseline_metrics)
        rows = []
        for spec in self._specs:
            if spec.model_id == _FIXTURE_BASELINE_ID:
                metrics = ModelRuntimeManager._metrics(self._baseline_metrics)
                ranks = self._baseline_ranks
            elif spec.model_id == _FIXTURE_FINETUNED_ID:
                metrics = ModelRuntimeManager._metrics(self._fine_tuned_metrics)
                ranks = self._fine_tuned_ranks
            else:
                metrics = None
                ranks = {}
            rows.append(
                ModelBenchmark(
                    model_id=spec.model_id,
                    label=spec.label,
                    group=spec.group,
                    paired_baseline_id=spec.paired_baseline_id,
                    verified=spec.verified,
                    index_version=f"fixture-{spec.storage_key}-v1",
                    metrics=metrics,
                    delta_vs_baseline_pp=(
                        delta if spec.model_id == _FIXTURE_FINETUNED_ID else None
                    ),
                    reference=None,
                    provenance=None,
                    benchmark_query_ranks=ranks,
                )
            )
        return BenchmarkResponse(
            protocol=BenchmarkProtocol(query_count=3, gallery_count=4),
            models=rows,
        )

    def benchmark_search(self, model_id: str, query_id: str, top_k: int) -> BenchmarkSearchResponse:
        spec = self._spec_for(model_id)
        query = next((item for item in self._queries if item.id == query_id), None)
        if query is None:
            raise BenchmarkQueryNotFoundError(query_id)
        if spec.model_id == _FIXTURE_BASELINE_ID:
            first_match_rank = self._baseline_ranks[query_id]
        elif spec.model_id == _FIXTURE_FINETUNED_ID:
            first_match_rank = self._fine_tuned_ranks[query_id]
        else:
            first_match_rank = 1
        results = [
            BenchmarkSearchResult(
                rank=result.rank,
                similarity=result.similarity,
                dataset=result.dataset,
                id=result.id,
                split=result.split,
                image_url=result.image_url,
                is_match=first_match_rank == result.rank,
            )
            for result in self._engine.search(query.caption, min(top_k, 1), ["CUHK-PEDES"])
        ]
        return BenchmarkSearchResponse(
            query_id=query.id,
            caption=query.caption,
            model_id=model_id,
            active_index_version=f"fixture-{spec.storage_key}-v1",
            first_match_rank=first_match_rank,
            results=results,
        )
