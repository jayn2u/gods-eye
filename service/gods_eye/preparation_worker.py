from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .clip import HuggingFaceClipEmbedder
from .config import ClipRuntimeConfig
from .datasets import DatasetAcquirer, load_registry
from .gallery import GalleryManifest
from .index_store import activate_version, build_index, load_active, validate_version
from .models import SUPPORTED_DATASETS
from .preparation import OOM_EXIT_CODE
from .retrieval import IndexedRetrievalEngine


def _model(args: argparse.Namespace, *, offline: bool) -> None:
    HuggingFaceClipEmbedder.from_config(
        ClipRuntimeConfig(args.model_id, args.revision, "cuda", offline, args.cache_dir)
    )
    print(args.cache_dir)


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
            print(args.path)
        elif args.operation == "build-index":
            embedder = HuggingFaceClipEmbedder(
                args.model_id, revision=args.revision, device="cuda", cache_dir=args.cache_dir
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
        else:
            loaded = load_active(args.active, args.model_id, args.revision, args.dataset_root)
            embedder = HuggingFaceClipEmbedder.from_config(
                ClipRuntimeConfig(args.model_id, args.revision, "cuda", True, args.cache_dir)
            )
            results = IndexedRetrievalEngine(loaded, embedder).search(
                "a person wearing dark clothing", 1, list(SUPPORTED_DATASETS)
            )
            if not results:
                raise RuntimeError("real-search smoke test returned no results")
            print(f"ok:{loaded.metadata.version_id}:{len(results)}")
    except RuntimeError as exc:
        if "out of memory" in str(exc).lower():
            print(str(exc), file=sys.stderr)
            return OOM_EXIT_CODE
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
