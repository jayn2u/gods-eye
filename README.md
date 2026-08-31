# God’s Eye

**Text-to-Image Person Retrieval** is a desktop-first research proof of concept. It ranks gallery
images against an English description with CLIP ViT-B/16. A deterministic three-image fixture mode
exercises the complete API and browser flow without a model download or research datasets.

> Research use only. This is visual similarity retrieval, not identity verification. A similarity
> score is not a probability or evidence that two people have the same identity.

## Prerequisites and data terms

- Python 3.11, [uv](https://docs.astral.sh/uv/), Node.js 22 LTS, and pnpm 10
- Docker with Compose v2 for the container workflow
- Optional CUDA-capable GPU for practical full-gallery indexing
- Explicit acceptance of the CUHK-PEDES, ICFG-PEDES, and RSTPReid data terms

Datasets are not bundled, copied into images, or redistributed. The pinned public Google Drive
files are third-party mirrors, not proof of publisher authorization. Review the current publisher
terms before accepting the download. Treat person imagery as sensitive research data, do not
expose the service publicly, and comply with applicable research-only, non-commercial, and
redistribution restrictions.

## Configuration

Copy `.env.example` to `.env` and edit machine-specific paths. Command-line indexer options override
matching environment values.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GODS_EYE_DATA_HOME` | `./data` | Host acquisition root used by Compose tooling |
| `GODS_EYE_DATASET_ROOT` | `./data/datasets` | Verified Dataset Installation root |
| `GODS_EYE_INDEX_ROOT` | `indexes` | Writable index/checkpoint root |
| `GODS_EYE_ACTIVE_INDEX` | `indexes/active` | Active-version pointer file |
| `GODS_EYE_MODEL_ID` | `openai/clip-vit-base-patch16` | Hugging Face model identity |
| `GODS_EYE_MODEL_REVISION` | unset | Optional immutable Hub revision |
| `GODS_EYE_HF_CACHE` | HF default | Prepared model cache |
| `GODS_EYE_OFFLINE` | `false` | Refuse model network access |
| `GODS_EYE_DEVICE` | `auto` | `auto`, `cpu`, `cuda`, or CUDA device |
| `GODS_EYE_BATCH_SIZE` | `32` | Image embedding batch size |
| `GODS_EYE_BIND_HOST` | `127.0.0.1` | Service bind address |
| `GODS_EYE_BIND_PORT` | `8000` | Service port |
| `GODS_EYE_USE_FIXTURES` | `false` | Use packaged deterministic gallery |
| `GODS_EYE_LOG_LEVEL` | `INFO` | Operational log level |

Loopback is the safe default. A non-loopback `GODS_EYE_BIND_HOST` is an explicit operator decision
and does not add authentication or TLS. Compose publishes only on host loopback while explicitly
binding `0.0.0.0` inside the service container.

## Local development

```bash
uv sync --extra indexing --extra clip
pnpm install --frozen-lockfile
GODS_EYE_USE_FIXTURES=true uv run uvicorn gods_eye.app:app --app-dir service \
  --host "${GODS_EYE_BIND_HOST:-127.0.0.1}" --port "${GODS_EYE_BIND_PORT:-8000}" --reload
pnpm dev:web
```

Run the last two commands separately and open `http://127.0.0.1:5173`. API docs are at
`http://127.0.0.1:8000/docs`, OpenAPI at `/openapi.json`, liveness at `/api/health`, and search
readiness at `/api/readiness`. A live process may correctly be unready until an index is activated.

## Docker Compose

Set host paths in `.env`, then run `docker compose config`, `docker compose up --build`, and check:

```bash
curl http://127.0.0.1:8000/api/health
curl http://127.0.0.1:8000/api/readiness
```

Compose mounts the dataset root at `/datasets` **read-only**, the independent index root at
`/indexes` read-write, and model cache at `/models`. Images are excluded from build contexts and
layers. Set `GODS_EYE_USE_FIXTURES=true` for a packaged smoke demo. `docker compose down` preserves
host indexes and cache.

For a real Compose index, run the gallery/build/activation commands through `docker compose run
--rm service ...` so the active pointer records container-visible `/indexes/...` paths. The service
container ships the same `gods-eye-index` and `gods-eye-prepare-model` commands used locally.

## Dataset acquisition and manifest

The explicit installer downloads the three pinned public Drive archives into the gitignored
`data/archives/`, verifies exact size and SHA-256, safely extracts into staging, validates required
metadata and image directories, and atomically publishes `data/datasets/<dataset>`. A verified
Installation Receipt prevents partial extraction from being treated as installed. Archives remain
available for repair until explicitly cleaned.

```bash
# Installs all three sources and writes indexes/gallery-manifest.json.
uv run gods-eye-datasets install --accept-data-terms

# One dataset, inspection, offline verification, and optional archive cleanup.
uv run gods-eye-datasets install CUHK-PEDES --accept-data-terms
uv run gods-eye-datasets status
uv run gods-eye-datasets verify
uv run gods-eye-datasets clean --archives

# Compose-only equivalent. The normal service never gets write access to datasets.
docker compose --profile tools run --rm dataset-installer \
  --data-root /data --index-root /indexes install --accept-data-terms
```

Downloads use resumable `.part` files. Installation requires free space for the retained archive,
staging tree, and final tree. Re-run `install` to resume or skip verified installations; use
`--force` to rebuild one. CI may set `GODS_EYE_ACCEPT_DATA_TERMS=true` only after its operator has
reviewed and accepted the terms. The installer prints the separate `gods-eye-index build` command
when acquisition completes; it never starts model indexing or the web service.

The resulting layout is:

Metadata filenames vary by release; explicit `--source` values are authoritative.

```text
./data/datasets/
  CUHK-PEDES/{imgs,reid_raw.json}
  ICFG-PEDES/{imgs,ICFG-PEDES.json}
  RSTPReid/{imgs,data_captions.json}
```

```bash
uv run python -m gods_eye.gallery \
  --source CUHK-PEDES="$GODS_EYE_DATASET_ROOT/CUHK-PEDES/imgs=$GODS_EYE_DATASET_ROOT/CUHK-PEDES/reid_raw.json" \
  --source ICFG-PEDES="$GODS_EYE_DATASET_ROOT/ICFG-PEDES/imgs=$GODS_EYE_DATASET_ROOT/ICFG-PEDES/ICFG-PEDES.json" \
  --source RSTPReid="$GODS_EYE_DATASET_ROOT/RSTPReid/imgs=$GODS_EYE_DATASET_ROOT/RSTPReid/data_captions.json" \
  --output "$GODS_EYE_INDEX_ROOT/gallery-manifest.json"
```

The builder validates paths/images, normalizes `val` to `validation`, creates stable public IDs,
and collapses only byte-identical files. API data never exposes captions or absolute host paths.

## Model preparation, indexing, resume, validation, activation

Prepare a dedicated cache once while online:

```bash
uv run gods-eye-prepare-model --model-id "$GODS_EYE_MODEL_ID" \
  --cache-dir "$GODS_EYE_HF_CACHE" --device cpu
```

Build the index. Completed batches are checkpointed and reused when model, revision, manifest, and
batch size match. Unreadable images are categorized in `coverage.json`.

```bash
uv run gods-eye-index build --manifest "$GODS_EYE_INDEX_ROOT/gallery-manifest.json" \
  --versions-dir "$GODS_EYE_INDEX_ROOT/versions" --model-id "$GODS_EYE_MODEL_ID" \
  --device auto --batch-size 32 --cache-dir "$GODS_EYE_HF_CACHE"

# Repeat the same build command to resume after interruption.
uv run python -c "from pathlib import Path; from gods_eye.index_store import validate_version; validate_version(Path('VERSION_DIRECTORY'))"
uv run gods-eye-index activate --version VERSION_DIRECTORY \
  --active-pointer "$GODS_EYE_ACTIVE_INDEX" --model-id "$GODS_EYE_MODEL_ID"
```

Activation validates artifacts before atomically changing the pointer. For a disconnected demo,
prepare model and index online, then set `GODS_EYE_OFFLINE=true` (optionally `HF_HUB_OFFLINE=1`).
The indexer also supports explicit `--offline`. Missing assets fail with preparation guidance.

## API, logging, and tests

`POST /api/search` accepts an English `query`, `top_k` 1–100, and a non-empty dataset subset. See
Swagger for schemas. Images are served only through validated manifest IDs. Operational logs are
one-line JSON with duration, top-K, selected datasets, versions, counts, and error category. **Raw
query text is never logged.** Reverse proxies and third-party telemetry need their own review.

Fixture-backed checks need no dataset or model download:

```bash
uv run pytest
uv run ruff check service
pnpm test:web
pnpm build:web
pnpm test:e2e
GODS_EYE_USE_FIXTURES=true docker compose config
```

With cached model assets, run the opt-in adapter check:

```bash
RUN_CLIP_INTEGRATION=1 GODS_EYE_OFFLINE=true uv run pytest -m integration
```

## Performance measurement

After warm-up, record hardware, device, model/revision, gallery count, query count, median, p95, and
maximum local `POST /api/search` latency without recording queries. The target is under three seconds
on the measured system, not a universal SLA. If missed, separately measure text embedding, exact
search, image I/O, and rendering. The combined gallery is a demo, not a benchmark split.

For a reproducible coverage, artifact-validation, ranked-result, and latency JSON record, run
`gods-eye-acceptance` after building the manifest and validated index. The observed local acceptance
run and exact commands are documented in [docs/full-gallery-validation.md](docs/full-gallery-validation.md).

## Troubleshooting and limitations

- **Not ready:** build and activate an index; in Compose its pointer target must be valid in
  `/indexes`.
- **Model mismatch:** use identical model ID/revision for build, activation, and service.
- **Offline cache error:** prepare the identical model/revision/cache while online.
- **CUDA unavailable/OOM:** use CPU or reduce batch size, then resume.
- **Unreadable images:** inspect `coverage.json`, correct source data, and rebuild a new version.
- **API unreachable:** use the Vite proxy/Compose web service; non-loopback operation requires
  deliberate origin, authentication, TLS, and network controls outside this PoC.
- General CLIP is not person-ReID-specialized. Bias, dataset shift, and false matches are expected.
  Never use results for identification, surveillance, automated decisions, or safety-critical use.
- No authentication, accounts, saved queries, shortlist, or case management is provided. This MVP
  is for one local research workstation.
