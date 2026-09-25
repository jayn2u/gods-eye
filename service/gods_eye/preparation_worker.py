from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .benchmark import (
    evaluate as evaluate_benchmark,
)
from .benchmark import (
    gallery_person_ids,
    load_test_captions,
    read_benchmark_queries,
    sample_benchmark_queries,
    write_benchmark_queries,
    write_evaluation,
)
from .checkpoint_registry import find_registration
from .clip import HuggingFaceClipEmbedder
from .clip_models import ModelRegistry, checkpoint_root_for
from .config import ClipRuntimeConfig
from .datasets import DatasetAcquirer, load_registry
from .embedders import create_embedder
from .gallery import GalleryManifest
from .index_store import (
    activate_version,
    build_index,
    load_active,
    manifest_digest,
    validate_version,
)
from .models import SUPPORTED_DATASETS
from .openclip_embedder import baseline_weights_path
from .preparation import OOM_EXIT_CODE
from .retrieval import IndexedRetrievalEngine


@dataclass(frozen=True, slots=True)
class ModelRevisionError(RuntimeError):
    reason: str

    def __str__(self) -> str:
        return self.reason


_COMMIT_REVISION = re.compile(r"[0-9a-f]{40}")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _model(args: argparse.Namespace, *, offline: bool) -> None:
    registry = ModelRegistry(checkpoint_root_for(args.cache_dir))
    spec = registry.get(args.model_id)
    if spec.backend == "hf":
        embedder = HuggingFaceClipEmbedder.from_config(
            ClipRuntimeConfig(args.model_id, args.revision, "cuda", offline, args.cache_dir)
        )
        resolved_revision = getattr(embedder.model.config, "_commit_hash", None)
        if (
            not isinstance(resolved_revision, str)
            or _COMMIT_REVISION.fullmatch(resolved_revision) is None
        ):
            raise ModelRevisionError("loaded model does not expose an immutable commit revision")
        if args.revision is not None and resolved_revision != args.revision:
            raise ModelRevisionError("loaded model revision does not match the requested commit")
    elif spec.backend == "openclip" and spec.checkpoint_dir is None:
        if spec.arch is None:
            raise ModelRevisionError("OpenCLIP baseline is missing its architecture")
        weights_path = baseline_weights_path(
            spec.arch,
            revision=args.revision,
            cache_dir=args.cache_dir,
            offline=offline,
        )
        if not weights_path.is_file():
            raise ModelRevisionError("pinned OpenCLIP baseline weights are missing")
        resolved_revision = weights_path.parent.name
        if _COMMIT_REVISION.fullmatch(resolved_revision) is None:
            raise ModelRevisionError("OpenCLIP baseline did not resolve to an immutable commit")
    elif spec.backend == "openclip":
        found = find_registration(checkpoint_root_for(args.cache_dir), args.model_id)
        if found is None:
            raise ModelRevisionError("checkpoint registration is missing")
        registration, checkpoint_dir = found
        weights_path = checkpoint_dir / "model.safetensors"
        if not weights_path.is_file():
            raise ModelRevisionError("checkpoint model.safetensors is missing")
        digest = _sha256_file(weights_path)
        if digest != registration.weights_sha256:
            raise ModelRevisionError("checkpoint weights do not match the registered SHA-256")
        resolved_revision = f"sha256:{digest}"
        if args.revision is not None and args.revision != resolved_revision:
            raise ModelRevisionError(
                "checkpoint weights do not match the requested SHA-256 revision"
            )
    else:  # pragma: no cover - ModelRegistry defines the supported backend variants
        raise ModelRevisionError(f"unsupported model backend {spec.backend!r}")

    print(
        json.dumps(
            {"model_id": args.model_id, "resolved_revision": resolved_revision},
            separators=(",", ":"),
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="operation", required=True)
    for name in ("prepare-model", "verify-model"):
        command = commands.add_parser(name)
        command.add_argument("--model-id", required=True)
        command.add_argument("--revision")
        command.add_argument("--cache-dir", type=Path, required=True)
    manifest = commands.add_parser("build-manifest")
    manifest.add_argument("--data-root", type=Path, required=True)
    manifest.add_argument("--output", type=Path, required=True)
    verify_manifest = commands.add_parser("verify-manifest")
    verify_manifest.add_argument("path", type=Path)
    build = commands.add_parser("build-index")
    build.add_argument("--manifest", type=Path, required=True)
    build.add_argument("--versions-dir", type=Path, required=True)
    build.add_argument("--model-id", required=True)
    build.add_argument("--revision")
    build.add_argument("--cache-dir", type=Path, required=True)
    build.add_argument("--batch-size", type=int, required=True)
    build.add_argument("--checkpoint-dir", type=Path, required=True)
    build.add_argument("--dataset-root", type=Path, required=True)
    validate = commands.add_parser("validate-index")
    validate.add_argument("version", type=Path)
    validate.add_argument("--model-id", required=True)
    validate.add_argument("--revision")
    validate.add_argument("--dataset-root", type=Path, required=True)
    activate = commands.add_parser("activate-index")
    activate.add_argument("version", type=Path)
    activate.add_argument("--active-pointer", type=Path, required=True)
    activate.add_argument("--model-id", required=True)
    activate.add_argument("--revision", required=True)
    activate.add_argument("--dataset-root", type=Path, required=True)
    verify_index = commands.add_parser("verify-index")
    verify_index.add_argument("active", type=Path)
    verify_index.add_argument("--model-id", required=True)
    verify_index.add_argument("--revision")
    verify_index.add_argument("--dataset-root", type=Path, required=True)
    smoke = commands.add_parser("smoke-search")
    smoke.add_argument("active", type=Path)
    smoke.add_argument("--model-id", required=True)
    smoke.add_argument("--revision")
    smoke.add_argument("--cache-dir", type=Path, required=True)
    smoke.add_argument("--dataset-root", type=Path, required=True)
    benchmark = commands.add_parser("build-benchmark-queries")
    benchmark.add_argument("--manifest", type=Path, required=True)
    benchmark.add_argument("--metadata", type=Path, required=True)
    benchmark.add_argument("--output", type=Path, required=True)
    evaluation = commands.add_parser("evaluate")
    evaluation.add_argument("active", type=Path)
    evaluation.add_argument("--model-id", required=True)
    evaluation.add_argument("--revision", required=True)
    evaluation.add_argument("--cache-dir", type=Path, required=True)
    evaluation.add_argument("--dataset-root", type=Path, required=True)
    evaluation.add_argument("--metadata", type=Path, required=True)
    evaluation.add_argument("--benchmark-queries", type=Path, required=True)
    evaluation.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.operation == "prepare-model":
            _model(args, offline=False)
        elif args.operation == "verify-model":
            _model(args, offline=True)
        elif args.operation == "build-manifest":
            manager = DatasetAcquirer(args.data_root, args.output.parent, load_registry())
            print(manager.write_manifest())
        elif args.operation == "verify-manifest":
            loaded = GalleryManifest.read(args.path)
            if not loaded.records:
                raise ValueError("Gallery Manifest contains no records")
            print(manifest_digest(loaded))
        elif args.operation == "build-index":
            embedder = create_embedder(
                args.model_id,
                revision=args.revision,
                device="cuda",
                offline=True,
                cache_dir=args.cache_dir,
            )
            print(
                build_index(
                    args.manifest,
                    args.versions_dir,
                    model_id=args.model_id,
                    backend="faiss",
                    embedder=embedder,
                    batch_size=args.batch_size,
                    checkpoint_dir=args.checkpoint_dir / f"batch-{args.batch_size}",
                    model_revision=args.revision,
                    dataset_root=args.dataset_root,
                )
            )
        elif args.operation == "validate-index":
            print(
                validate_version(
                    args.version, args.model_id, args.revision, args.dataset_root
                ).metadata.version_id
            )
        elif args.operation == "activate-index":
            validate_version(args.version, args.model_id, args.revision, args.dataset_root)
            print(
                activate_version(
                    args.version, args.active_pointer, args.model_id, args.dataset_root
                ).metadata.version_id
            )
        elif args.operation == "verify-index":
            print(
                load_active(
                    args.active, args.model_id, args.revision, args.dataset_root
                ).metadata.version_id
            )
        elif args.operation == "smoke-search":
            loaded = load_active(args.active, args.model_id, args.revision, args.dataset_root)
            embedder = create_embedder(
                args.model_id,
                revision=args.revision,
                device="cuda",
                offline=True,
                cache_dir=args.cache_dir,
            )
            results = IndexedRetrievalEngine(loaded, embedder).search(
                "a person wearing dark clothing", 1, list(SUPPORTED_DATASETS)
            )
            if not results:
                raise RuntimeError("real-search smoke test returned no results")
            print(f"ok:{loaded.metadata.version_id}:{len(results)}")
        elif args.operation == "build-benchmark-queries":
            manifest = GalleryManifest.read(args.manifest)
            captions = load_test_captions(args.metadata)
            gallery_ids = {
                person_id
                for person_ids in gallery_person_ids(manifest)
                for person_id in person_ids
            }
            eligible_captions = tuple(
                caption for caption in captions if caption.person_id in gallery_ids
            )
            queries = sample_benchmark_queries(eligible_captions)
            write_benchmark_queries(
                args.output,
                queries,
                manifest_sha256=manifest_digest(manifest),
            )
            print(args.output)
        else:
            loaded = load_active(
                args.active,
                args.model_id,
                args.revision,
                args.dataset_root,
            )
            queries = read_benchmark_queries(args.benchmark_queries)
            captions = load_test_captions(args.metadata)
            checkpoint_root = checkpoint_root_for(args.cache_dir)
            spec = ModelRegistry(checkpoint_root).get(args.model_id)
            reference_metrics = None
            if spec.group == "fine-tuned":
                found = find_registration(checkpoint_root, args.model_id)
                if found is None:
                    raise ModelRevisionError("checkpoint registration is missing")
                registration, _checkpoint_dir = found
                reference_metrics = registration.reference_metrics
            embedder = create_embedder(
                args.model_id,
                revision=args.revision,
                device="cuda",
                offline=True,
                cache_dir=args.cache_dir,
                text_only=True,
            )
            try:
                result = evaluate_benchmark(
                    lambda texts: embedder.embed_texts(texts, batch_size=256),
                    loaded,
                    captions,
                    queries,
                    model_id=args.model_id,
                    model_revision=args.revision,
                    reference_metrics=reference_metrics,
                    now=datetime.now(UTC),
                )
            finally:
                embedder.close()
            write_evaluation(args.output, result)
            print(args.output)
    except RuntimeError as exc:
        if "out of memory" in str(exc).lower():
            print(str(exc), file=sys.stderr)
            return OOM_EXIT_CODE
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
