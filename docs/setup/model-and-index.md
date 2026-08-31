# Model preparation and index management

Demo Preparation uses `openai/clip-vit-base-patch16`. It prepares a dedicated Hugging Face cache,
builds gallery embeddings in GPU batches, validates the completed version, atomically updates the
active pointer, and performs a real retrieval before marking the demo prepared. Compatible batch
checkpoints are reused after interruption. On CUDA out-of-memory, the Launcher halves the batch
size and retries the stage.

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
same model ID and revision. Unreadable images are categorized in `coverage.json`; correct the source
and build a new version rather than editing an activated version.

For Compose, run build and activation through `docker compose run --rm service ...` so pointer
targets use container-visible `/indexes/...` paths.
