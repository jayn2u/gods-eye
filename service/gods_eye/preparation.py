from __future__ import annotations

import json
import os
import shlex
import subprocess
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

from .benchmark import (
    evaluation_path,
    read_benchmark_queries,
    read_evaluation,
)
from .clip_models import DEFAULT_MODEL_ID, ModelRegistry, checkpoint_root_for
from .datasets import load_registry
from .preparation_state import (
    ensure_model_preparation,
    normalize_preparation_state,
    set_model_stage,
)

OOM_EXIT_CODE = 75


class PreparationProgress:
    """Operator progress and a query-free detailed audit log for stages 4-8."""

    def __init__(self, root: Path, preparation: dict):
        self.started = time.monotonic()
        self.preparation = preparation
        logs = root / ".gods-eye" / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        self.path = logs / f"prepare-model-index-{stamp}.log"

    def stage(self, number: int, label: str, state_key: str) -> float:
        elapsed = time.monotonic() - self.started
        previous = self.preparation.get(state_key, {}).get("duration_seconds")
        estimate = f"about {previous:.1f}s from the last verified run" if previous else "measuring"
        message = f"Stage {number}/8 — {label} (elapsed {elapsed:.1f}s; estimate {estimate})"
        print(message)
        with self.path.open("a") as stream:
            stream.write(message + "\n")
        return time.monotonic()

    def complete(self, state_key: str, stage_started: float, detail: str) -> float:
        duration = time.monotonic() - stage_started
        with self.path.open("a") as stream:
            stream.write(f"{state_key}: verified in {duration:.1f}s; {detail}\n")
        return duration

    def fail(self, state_key: str, stage_started: float, error: str) -> float:
        duration = time.monotonic() - stage_started
        with self.path.open("a") as stream:
            stream.write(f"{state_key}: failed in {duration:.1f}s; {error}\n")
        return duration


class PreparationError(RuntimeError):
    """A model/index Demo Preparation stage could not be completed."""

    def __init__(self, message: str, *, out_of_memory: bool = False):
        super().__init__(message)
        self.out_of_memory = out_of_memory


@dataclass(frozen=True, slots=True)
class PreparationPaths:
    root: Path

    @property
    def model_cache(self) -> Path:
        return self.root / ".cache" / "huggingface"

    @property
    def manifest(self) -> Path:
        return self.root / "indexes" / "gallery-manifest.json"

    @property
    def benchmark_queries(self) -> Path:
        return self.root / "indexes" / "benchmark-queries.json"

    def for_model(self, model_id: str) -> ModelPreparationPaths:
        spec = ModelRegistry(checkpoint_root_for(self.model_cache)).get(model_id)
        index_root = (
            self.root / "indexes"
            if model_id == DEFAULT_MODEL_ID
            else self.root / "indexes" / "models" / spec.storage_key
        )
        return ModelPreparationPaths(self.root, model_id, index_root)


@dataclass(frozen=True, slots=True)
class ModelPreparationPaths:
    root: Path
    model_id: str
    index_root: Path

    @property
    def versions(self) -> Path:
        return self.index_root / "versions"

    @property
    def active(self) -> Path:
        return self.index_root / "active"

    @property
    def evaluations(self) -> Path:
        return self.index_root / "evaluations"

    def checkpoint(self, resolved_revision: str, manifest_sha256: str) -> Path:
        signature = sha256(
            f"{self.model_id}:{resolved_revision}:{manifest_sha256}".encode()
        ).hexdigest()[:20]
        return self.root / "indexes" / ".checkpoints" / signature


class PreparationRunner:
    def __init__(self, command: str | None = None, *, timeout_seconds: int = 4 * 60 * 60):
        self.timeout_seconds = timeout_seconds
        if command:
            self.command = shlex.split(command)
        else:
            host_root = os.getenv("GODS_EYE_HOST_PROJECT_ROOT")
            if host_root:
                image = os.getenv("GODS_EYE_LAUNCHER_IMAGE", "gods-eye-launcher:local")
                self.command = [
                    "docker",
                    "run",
                    "--rm",
                    "--gpus",
                    "all",
                    "--pull",
                    "never",
                    "--entrypoint",
                    "python",
                    "--volume",
                    f"{host_root}:/workspace",
                    "--workdir",
                    "/workspace",
                    image,
                    "-m",
                    "gods_eye.preparation_worker",
                ]
            else:
                self.command = ["python", "-m", "gods_eye.preparation_worker"]

    def run(self, operation: str, *arguments: str) -> str:
        try:
            result = subprocess.run(
                [*self.command, operation, *arguments],
                text=True,
                capture_output=True,
                check=False,
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise PreparationError(
                f"{operation} timed out after {self.timeout_seconds} seconds"
            ) from exc
        if result.returncode != 0:
            message = result.stderr.strip() or result.stdout.strip() or f"{operation} failed"
            raise PreparationError(message, out_of_memory=result.returncode == OOM_EXIT_CODE)
        return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""


def select_batch_size(vram_mib: int, override: int | None = None) -> int:
    if override is not None:
        if override < 1:
            raise PreparationError("--batch-size must be greater than zero")
        return override
    if vram_mib >= 24 * 1024:
        return 128
    if vram_mib >= 16 * 1024:
        return 64
    if vram_mib >= 12 * 1024:
        return 48
    return 32


def _save_state(path: Path, state: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    os.replace(temporary, path)


def _arguments(
    paths: PreparationPaths,
    model_paths: ModelPreparationPaths,
    model_id: str,
    revision: str | None,
) -> dict[str, list[str]]:
    revision_args = ["--revision", revision] if revision else []
    metadata = _benchmark_metadata_path(paths.root / "data/datasets")
    return {
        "model": ["--model-id", model_id, "--cache-dir", str(paths.model_cache), *revision_args],
        "manifest": ["--data-root", str(paths.root / "data"), "--output", str(paths.manifest)],
        "index": [
            "--manifest",
            str(paths.manifest),
            "--versions-dir",
            str(model_paths.versions),
            "--model-id",
            model_id,
            "--cache-dir",
            str(paths.model_cache),
            "--dataset-root",
            str(paths.root / "data/datasets"),
            *revision_args,
        ],
        "smoke": [
            str(model_paths.active),
            "--model-id",
            model_id,
            "--cache-dir",
            str(paths.model_cache),
            "--dataset-root",
            str(paths.root / "data/datasets"),
            *revision_args,
        ],
        "benchmark": [
            "--manifest",
            str(paths.manifest),
            "--metadata",
            str(metadata),
            "--output",
            str(paths.benchmark_queries),
        ],
        "evaluation": [
            "--model-id",
            model_id,
            "--revision",
            revision or "",
            "--cache-dir",
            str(paths.model_cache),
            "--dataset-root",
            str(paths.root / "data/datasets"),
            "--metadata",
            str(metadata),
            "--benchmark-queries",
            str(paths.benchmark_queries),
        ],
    }


def _benchmark_metadata_path(dataset_root: Path) -> Path:
    source = next(
        (item for item in load_registry() if item.name == "CUHK-PEDES"),
        None,
    )
    if source is None:
        raise PreparationError("CUHK-PEDES metadata is missing from the Dataset Registry")
    return dataset_root / str(source.name) / source.metadata


def _parse_model_receipt(payload: str, expected_model_id: str) -> str:
    try:
        receipt = json.loads(payload)
        model_id = receipt["model_id"]
        resolved_revision = receipt["resolved_revision"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise PreparationError("prepare-model returned a malformed receipt") from exc
    valid_revision = isinstance(resolved_revision, str) and (
        (len(resolved_revision) == 40 and all(c in "0123456789abcdef" for c in resolved_revision))
        or (
            resolved_revision.startswith("sha256:")
            and len(resolved_revision) == 71
            and all(c in "0123456789abcdef" for c in resolved_revision[7:])
        )
    )
    if model_id != expected_model_id or not valid_revision:
        raise PreparationError("prepare-model returned an invalid receipt")
    return resolved_revision


def _parse_manifest_digest(payload: str) -> str:
    if len(payload) != 64 or not all(character in "0123456789abcdef" for character in payload):
        raise PreparationError("verify-manifest returned an invalid digest")
    return payload


def prepare_model_index(
    root: Path,
    state_path: Path,
    *,
    vram_mib: int,
    batch_override: int | None = None,
    runner: PreparationRunner | None = None,
    model_id: str = DEFAULT_MODEL_ID,
    model_revision: str | None = None,
) -> None:
    adapter = runner or PreparationRunner(os.getenv("GODS_EYE_PREPARATION_RUNNER"))
    paths = PreparationPaths(root)
    spec = ModelRegistry(checkpoint_root_for(paths.model_cache)).get(model_id)
    model_paths = paths.for_model(model_id)
    state = normalize_preparation_state(json.loads(state_path.read_text()))
    preparation = state.setdefault("preparation", {})
    model_record = ensure_model_preparation(preparation, model_id)
    progress = PreparationProgress(root, preparation)
    now = lambda: datetime.now(UTC).isoformat()

    stage_started = progress.stage(4, f"CLIP {spec.label} model preparation", "model")
    model_state = model_record.get("model", {})
    resolved_revision = model_state.get("resolved_revision")
    compatible_model = (
        model_state.get("status") == "verified"
        and model_state.get("model_id") == model_id
        and model_state.get("requested_revision") == model_revision
        and isinstance(resolved_revision, str)
    )
    if compatible_model:
        try:
            adapter.run(
                "verify-model",
                *_arguments(paths, model_paths, model_id, resolved_revision)["model"],
            )
            print("  reused (verified)")
        except PreparationError:
            compatible_model = False
    if not compatible_model:
        receipt = adapter.run(
            "prepare-model", *_arguments(paths, model_paths, model_id, model_revision)["model"]
        )
        resolved_revision = _parse_model_receipt(receipt, model_id)
        model_state = {
            "status": "verified",
            "model_id": model_id,
            "requested_revision": model_revision,
            "resolved_revision": resolved_revision,
            "completed_at": now(),
            "duration_seconds": progress.complete("model", stage_started, "model cache verified"),
        }
        set_model_stage(preparation, model_id, "model", model_state)
        _save_state(state_path, state)
    elif compatible_model:
        progress.complete("model", stage_started, "compatible model cache reused")
    if not isinstance(resolved_revision, str):
        raise PreparationError("model preparation did not resolve an immutable revision")
    args = _arguments(paths, model_paths, model_id, resolved_revision)

    stage_started = progress.stage(5, "Gallery Manifest generation", "gallery_manifest")
    manifest_state = preparation.get("gallery_manifest", {})
    manifest_compatible = manifest_state.get("path") == str(paths.manifest)
    if manifest_compatible:
        try:
            manifest_sha256 = _parse_manifest_digest(
                adapter.run("verify-manifest", str(paths.manifest))
            )
            print("  reused (verified)")
        except PreparationError:
            manifest_compatible = False
    if not manifest_compatible:
        adapter.run("build-manifest", *args["manifest"])
        manifest_sha256 = _parse_manifest_digest(
            adapter.run("verify-manifest", str(paths.manifest))
        )
        preparation["gallery_manifest"] = {
            "status": "verified",
            "schema_version": 1,
            "path": str(paths.manifest),
            "manifest_sha256": manifest_sha256,
            "completed_at": now(),
            "duration_seconds": progress.complete(
                "gallery_manifest", stage_started, "manifest records verified"
            ),
        }
        _save_state(state_path, state)
    elif manifest_compatible:
        progress.complete("gallery_manifest", stage_started, "compatible manifest reused")
        stored_manifest_sha256 = manifest_state.get("manifest_sha256")
        if stored_manifest_sha256 != manifest_sha256:
            manifest_state = {
                **manifest_state,
                "manifest_sha256": manifest_sha256,
                "completed_at": (
                    manifest_state.get("completed_at") if stored_manifest_sha256 is None else now()
                ),
            }
            preparation["gallery_manifest"] = manifest_state
            _save_state(state_path, state)

    stage_started = progress.stage(6, "GPU index build and atomic activation", "index")
    index_state = model_record.get("index", {})
    legacy_manifest_compatible = (
        index_state.get("legacy_revision_unresolved") is True
        and index_state.get("gallery_manifest_sha256") is None
        and index_state.get("gallery_manifest_completed_at")
        == preparation["gallery_manifest"]["completed_at"]
    )
    index_compatible = (
        index_state.get("model_id") == model_id
        and index_state.get("model_revision") == resolved_revision
        and (
            index_state.get("gallery_manifest_sha256") == manifest_sha256
            or legacy_manifest_compatible
        )
        and index_state.get("status") == "active"
    )
    active_version_id = ""
    if index_compatible:
        try:
            active_version = adapter.run(
                "verify-index",
                str(model_paths.active),
                "--model-id",
                model_id,
                "--dataset-root",
                str(paths.root / "data/datasets"),
                "--revision",
                resolved_revision,
            )
            active_version_id = Path(active_version).name
            print("  reused (verified)")
        except PreparationError:
            index_compatible = False
    if not index_compatible:
        batch_size = select_batch_size(vram_mib, batch_override)
        checkpoint = model_paths.checkpoint(resolved_revision, manifest_sha256)
        checkpoint.mkdir(parents=True, exist_ok=True)
        while True:
            try:
                version = adapter.run(
                    "build-index",
                    *args["index"],
                    "--batch-size",
                    str(batch_size),
                    "--checkpoint-dir",
                    str(checkpoint),
                )
                break
            except PreparationError as exc:
                if not exc.out_of_memory or batch_size == 1:
                    raise
                batch_size = max(1, batch_size // 2)
                print(f"  GPU memory exhausted; retrying index stage with batch size {batch_size}")
        active_version_id = Path(version).name
        adapter.run(
            "validate-index",
            version,
            "--model-id",
            model_id,
            "--revision",
            resolved_revision,
            "--dataset-root",
            str(paths.root / "data/datasets"),
        )
        adapter.run(
            "activate-index",
            version,
            "--active-pointer",
            str(model_paths.active),
            "--model-id",
            model_id,
            "--revision",
            resolved_revision,
            "--dataset-root",
            str(paths.root / "data/datasets"),
        )
        index_state = {
            "status": "active",
            "model_id": model_id,
            "model_revision": resolved_revision,
            "version_path": version,
            "batch_size": batch_size,
            "gallery_manifest_sha256": manifest_sha256,
            "gallery_manifest_completed_at": preparation["gallery_manifest"]["completed_at"],
            "completed_at": now(),
            "duration_seconds": progress.complete(
                "index", stage_started, f"active index verified with batch size {batch_size}"
            ),
        }
        set_model_stage(preparation, model_id, "index", index_state)
        _save_state(state_path, state)
    elif index_compatible:
        progress.complete("index", stage_started, "compatible active index reused")

    stage_started = progress.stage(7, "benchmark evaluation", "evaluation")
    index_version_id = active_version_id or Path(index_state.get("version_path", "")).name
    if not index_version_id:
        raise PreparationError("Active index verification did not return an immutable version ID")
    evaluation_file = evaluation_path(model_paths.index_root, index_version_id)
    evaluation_args = [
        str(model_paths.active),
        *args["evaluation"],
        "--output",
        str(evaluation_file),
    ]
    evaluation_state = model_record.get("evaluation", {})
    evaluation_compatible = False
    try:
        benchmark_state = preparation.get("benchmark_queries", {})
        benchmark_compatible = (
            benchmark_state.get("status") == "verified"
            and benchmark_state.get("path") == str(paths.benchmark_queries)
            and benchmark_state.get("manifest_sha256") == manifest_sha256
        )
        if benchmark_compatible:
            try:
                read_benchmark_queries(paths.benchmark_queries, manifest_sha256=manifest_sha256)
                print("  Benchmark Queries reused (verified)")
            except (OSError, TypeError, ValueError):
                benchmark_compatible = False
        if not benchmark_compatible:
            adapter.run("build-benchmark-queries", *args["benchmark"])
            try:
                read_benchmark_queries(paths.benchmark_queries, manifest_sha256=manifest_sha256)
            except (OSError, TypeError, ValueError) as exc:
                raise PreparationError(f"Benchmark Queries could not be verified: {exc}") from exc
            preparation["benchmark_queries"] = {
                "status": "verified",
                "path": str(paths.benchmark_queries),
                "manifest_sha256": manifest_sha256,
                "completed_at": now(),
            }
            _save_state(state_path, state)

        evaluation_compatible = (
            evaluation_state.get("status") == "verified"
            and evaluation_state.get("index_version") == index_version_id
            and evaluation_state.get("model_revision") == resolved_revision
            and evaluation_state.get("path") == str(evaluation_file)
        )
        if evaluation_compatible:
            try:
                stored_evaluation = read_evaluation(evaluation_file)
                evaluation_compatible = (
                    stored_evaluation.model_id == model_id
                    and stored_evaluation.index_version == index_version_id
                    and stored_evaluation.model_revision == resolved_revision
                )
            except (OSError, TypeError, ValueError):
                evaluation_compatible = False

        if evaluation_compatible:
            progress.complete("evaluation", stage_started, "compatible evaluation reused")
            print("  evaluation reused (verified)")
        else:
            adapter.run("evaluate", *evaluation_args)
            evaluation = read_evaluation(evaluation_file)
            if (
                evaluation.model_id != model_id
                or evaluation.index_version != index_version_id
                or evaluation.model_revision != resolved_revision
            ):
                raise PreparationError(
                    "evaluate returned a result for a different model, index, or revision"
                )
    except (OSError, TypeError, ValueError, PreparationError) as exc:
        if isinstance(exc, PreparationError):
            failure = exc
        else:
            failure = PreparationError(f"Benchmark evaluation returned an unreadable result: {exc}")
        failed_state = {
            "status": "failed",
            "model_id": model_id,
            "index_version": index_version_id,
            "model_revision": resolved_revision,
            "path": str(evaluation_file),
            "error": str(failure),
            "completed_at": now(),
            "duration_seconds": progress.fail("evaluation", stage_started, str(failure)),
        }
        set_model_stage(preparation, model_id, "evaluation", failed_state)
        _save_state(state_path, state)
        if spec.group == "reference":
            print(f"  reference-model benchmark evaluation failed: {failure}")
        else:
            raise failure
    else:
        if not evaluation_compatible:
            evaluation_state = {
                "status": "verified",
                "model_id": model_id,
                "index_version": index_version_id,
                "model_revision": resolved_revision,
                "path": str(evaluation_file),
                "completed_at": now(),
                "duration_seconds": progress.complete(
                    "evaluation", stage_started, "benchmark metrics verified"
                ),
            }
            set_model_stage(preparation, model_id, "evaluation", evaluation_state)
            _save_state(state_path, state)

    stage_started = progress.stage(8, "real-search smoke test", "smoke_test")
    adapter.run("smoke-search", *args["smoke"])
    smoke_state = {
        "status": "verified",
        "model_id": model_id,
        "model_revision": resolved_revision,
        "index_completed_at": index_state["completed_at"],
        "completed_at": now(),
        "duration_seconds": progress.complete(
            "smoke_test", stage_started, "model load, active index, and search verified"
        ),
    }
    set_model_stage(preparation, model_id, "smoke_test", smoke_state)
    _save_state(state_path, state)
    print(f"Detailed preparation log: {progress.path}")
