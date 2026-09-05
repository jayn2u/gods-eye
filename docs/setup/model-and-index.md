# Model preparation and index management

Demo Preparation defaults to `openai/clip-vit-base-patch16`. Prepare another supported model
explicitly, or repeat the option to prepare several sequentially:

```bash
./gods-eye prepare --model-id openai/clip-vit-base-patch32
./gods-eye prepare \
  --model-id openai/clip-vit-base-patch16 \
  --model-id openai/clip-vit-large-patch14 \
  --model-id openai/clip-vit-large-patch14-336
```

Repeated IDs are deduplicated in first-seen order. The Dataset Installations and Gallery Manifest
are shared and prepared once. Each model has its own immutable revision, resumable checkpoint,
index versions, active pointer, and smoke result. Successful earlier models remain reusable if a
later model fails; rerun the same command to resume. The Launcher reserves 4 GiB for the default
model and index, and checks another 4 GiB for each requested optional model.

The B/16 index stays under `indexes/{versions,active}`. Optional indexes live under
`indexes/models/<model-key>/{versions,active}`. State is schema 2 under
`.gods-eye/state.json` at `preparation.models[MODEL_ID]`; the legacy B/16 `model`, `index`, and
`smoke_test` fields remain as write-through aliases for rollback. New preparation binds the local
cache and index to the exact 40-character Hugging Face commit revision.

For development or repair, prepare the model and run the underlying index commands directly:

```bash
uv run gods-eye-prepare-model --model-id openai/clip-vit-base-patch16 \
  --cache-dir .cache/huggingface --device cpu
uv run gods-eye-index build --manifest indexes/gallery-manifest.json \
  --versions-dir indexes/versions --model-id openai/clip-vit-base-patch16 \
  --device auto --batch-size 32 --cache-dir .cache/huggingface
uv run gods-eye-index activate --version VERSION_DIRECTORY \
  --active-pointer indexes/active --model-id openai/clip-vit-base-patch16
```

Repeat the same build command to resume. Before activation, a lower-level artifact check is:

```bash
uv run python -c "from pathlib import Path; from gods_eye.index_store import validate_version; validate_version(Path('VERSION_DIRECTORY'))"
```

Activation validates artifacts again before changing the pointer. Build and runtime must use the
same model ID and revision. An older unpinned B/16 index is usable only when `refs/main` identifies
the single locally present snapshot; explicit B/16 preparation rebuilds it with pinned provenance.
Unreadable images are categorized in `coverage.json`; correct the source and build a new version
rather than editing an activated version.

For Compose, run build and activation through `docker compose run --rm service ...` so pointer
targets use container-visible `/indexes/...` paths.
