# God’s Eye

Text-to-Image Person Retrieval research PoC. The initial vertical slice uses deterministic fixtures; it does not download a model or require datasets.

## Requirements

- Python 3.11 and [uv](https://docs.astral.sh/uv/)
- Node.js 22 LTS and pnpm 10

## Run locally

```bash
uv sync
pnpm install
GODS_EYE_USE_FIXTURES=1 uv run uvicorn gods_eye.app:app --app-dir service --reload
pnpm dev:web
```

Open `http://127.0.0.1:5173`. API documentation is at `http://127.0.0.1:8000/docs`.

Search defaults to `top_k=24` across `CUHK-PEDES`, `ICFG-PEDES`, and `RSTPReid`. The accepted range is 1–100 and at least one supported dataset must be selected.

## Build a normalized gallery manifest

The gallery builder validates every referenced image, normalizes `val` to `validation`, creates
path-stable public IDs, and collapses only byte-identical images. It exits with an actionable
report if a record is unsafe, missing, or unreadable.

```bash
uv run python -m gods_eye.gallery \
  --source CUHK-PEDES=/data/jayn2u/lab_datasets/CUHK-PEDES/imgs=/data/jayn2u/lab_datasets/CUHK-PEDES/reid_raw.json \
  --source ICFG-PEDES=/data/jayn2u/lab_datasets/ICFG-PEDES/imgs=/data/jayn2u/lab_datasets/ICFG-PEDES/ICFG-PEDES.json \
  --source RSTPReid=/data/jayn2u/lab_datasets/RSTPReid/imgs=/data/jayn2u/lab_datasets/RSTPReid/data_captions.json \
  --output indexes/gallery-manifest.json
```

The manifest is an internal service artifact. API responses expose stable IDs, dataset, and split
provenance only; captions and absolute host paths are never returned.

## Build and activate an exact index

The default backend creates a CPU `IndexFlatIP` FAISS artifact. `--backend numpy` exists only for
small, network-free fixture tests of the same exact inner-product contract.

```bash
uv run gods-eye-index build --manifest indexes/gallery-manifest.json \
  --versions-dir indexes/versions --model-id fixture/deterministic-v1 --backend numpy
uv run gods-eye-index activate --version indexes/versions/<version> \
  --active-pointer indexes/active --model-id fixture/deterministic-v1
GODS_EYE_ACTIVE_INDEX=indexes/active uv run uvicorn gods_eye.app:app --app-dir service
```

Every rebuild creates an immutable directory. Activation validates model identity, manifest linkage,
row counts, dimensions, vector normalization, stable-ID uniqueness, image resolution, and index
metadata before atomically replacing the active pointer. Failed validation leaves the previous
pointer untouched. `/api/health` reports process liveness; `/api/readiness` separately reports the
active model, version, and gallery count. Without a valid index the UI remains available and gives
recovery guidance, but search stays disabled.

## Index with Hugging Face CLIP ViT-B/16

Install the optional inference dependencies, then build with the configured CLIP model. Image and
text features are both L2-normalized; exact inner product therefore represents cosine similarity.

```bash
uv sync --extra indexing --extra clip
uv run gods-eye-index build --manifest indexes/gallery-manifest.json \
  --versions-dir indexes/versions --model-id openai/clip-vit-base-patch16 \
  --device auto --batch-size 32
uv run gods-eye-index activate --version indexes/versions/<version> \
  --active-pointer indexes/active --model-id openai/clip-vit-base-patch16
GODS_EYE_ACTIVE_INDEX=indexes/active uv run uvicorn gods_eye.app:app --app-dir service
```

`--device auto` selects CUDA when PyTorch reports it available and otherwise uses CPU. Pass
`--device cpu` (or a specific CUDA device) and adjust `--batch-size` for the machine. Completed
batches remain in a model/manifest-specific checkpoint directory, so repeating an interrupted build
with the same model, revision, manifest, and batch size skips them. Unreadable images are excluded
and categorized in `coverage.json`; absolute host paths are not recorded.

Prepare the model cache once online, then set `GODS_EYE_OFFLINE=1` for the server and pass
`--offline` to the indexer for a reproducible offline demo. `--cache-dir` and `GODS_EYE_HF_CACHE`
select a dedicated cache. Missing offline assets fail with cache-preparation guidance.
`HF_HUB_OFFLINE=1` can additionally enforce Hub-wide offline behavior.

The real-model test is deliberately excluded from normal CI. With cached model assets, run:

```bash
RUN_CLIP_INTEGRATION=1 GODS_EYE_OFFLINE=1 uv run pytest -m integration
```

For a qualitative browser smoke check, search for `a person wearing a red top`. Confirm that ranked
cards come from the active index and `/api/readiness` reports `openai/clip-vit-base-patch16`. This is
a qualitative check, not an identity probability or benchmark claim.

## Offline checks

Once dependencies have been installed, all checks run without network access, model downloads, or external datasets:

```bash
uv run pytest
uv run ruff check service
pnpm test:web
pnpm build:web
pnpm test:e2e
```

The browser test starts the real FastAPI and Vite processes. Only the expensive retrieval seam is replaced by the deterministic fixture adapter.
