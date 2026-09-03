# CUHK-PEDES validation

This document records the reproducible acceptance run for the CUHK-only Full Demo. The results are
qualitative visual-similarity observations. They are not benchmark accuracy, biometric
identification, or evidence of a sighting.

## Run recorded on 2026-09-02

Manifest construction read the retained CUHK-PEDES Dataset Installation without modifying it. It
contained 40,206 metadata rows and 40,206 unique referenced paths. Thirteen byte-identical paths
were collapsed into 40,193 canonical active records, with zero validation errors.

| Dataset | Split | Source | Accepted | Duplicate | Skipped | Failed | Active |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CUHK-PEDES | train | 34,054 | 34,054 | 10 | 0 | 0 | 34,044 |
| CUHK-PEDES | validation | 3,078 | 3,078 | 2 | 0 | 0 | 3,076 |
| CUHK-PEDES | test | 3,074 | 3,074 | 1 | 0 | 0 | 3,073 |

The workstation has 16 CPUs and no active NVIDIA driver, so the index was built with CLIP
ViT-B/16 on CPU using the retained offline model cache. The resulting FAISS version
`20260902T074223353343Z-5ec73987` contains 512-dimensional normalized embeddings for all 40,193
records. Its coverage artifact reports 40,193 successful, zero skipped, and zero failed images.
The active pointer now resolves to this version, whose dataset configuration and Manifest roots
contain CUHK-PEDES only.

## Search observations and latency

Three fixed English descriptions were each searched three times at top 24 with the active index.
Measured direct engine latency included CPU CLIP text embedding and exact FAISS search: cold
177.77 ms, warm median 56.82 ms, p95 177.77 ms, and maximum 177.77 ms. The observed run met the
three-second target; it is a measurement on this workstation, not a universal SLA.

| Description | Rank-one trace | Similarity |
| --- | --- | ---: |
| a person wearing a red shirt and dark trousers | `img_f8ca91cbd471254eaedc836c` (CUHK-PEDES, train) | 0.337245 |
| a person carrying a backpack and wearing a light jacket | `img_6ff4dc1683c1d145ab6658a9` (CUHK-PEDES, validation) | 0.357294 |
| a person in a black coat with white shoes | `img_e53028930fc4e97bf66e21d5` (CUHK-PEDES, train) | 0.336104 |

The generated JSON report is retained at `.gods-eye/cuhk-acceptance-report.json`. A separate
offline CPU smoke search through the active index returned one CUHK-PEDES result for
`a person wearing dark clothing`, confirming model load, index resolution, and dataset filtering.

## Reproduce the CUHK-PEDES manifest

Confirm that the installer sees only the retained Dataset Source and that its Dataset Installation
passes structural verification:

```bash
uv run gods-eye-datasets status
uv run gods-eye-datasets verify CUHK-PEDES
```

Generate a fresh Gallery Manifest from the explicit CUHK-PEDES source:

```bash
uv run python -m gods_eye.gallery \
  --source CUHK-PEDES="data/datasets/CUHK-PEDES/imgs=data/datasets/CUHK-PEDES/reid_raw.json" \
  --output indexes/gallery-manifest.json
```

Before indexing, inspect the generated manifest and require that it contains no retired dataset:

```bash
uv run python -c "import json; from pathlib import Path; raw=json.loads(Path('indexes/gallery-manifest.json').read_text()); assert set(raw['roots']) == {'CUHK-PEDES'}; assert all(item['dataset'] == 'CUHK-PEDES' and all(alias['dataset'] == 'CUHK-PEDES' for alias in item.get('aliases', [])) for item in raw['records']); print({'records': len(raw['records']), 'roots': sorted(raw['roots'])})"
```

Record the manifest's `report` values after the command succeeds.

## Build, validate, and activate the index

Use the prepared CLIP cache and a checkpoint directory that belongs to this CUHK-only manifest:

```bash
uv run gods-eye-index build \
  --manifest indexes/gallery-manifest.json \
  --versions-dir indexes/versions \
  --checkpoint-dir indexes/.checkpoints/clip-vit-b-16 \
  --model-id openai/clip-vit-base-patch16 \
  --cache-dir .cache/huggingface \
  --device auto --batch-size 32 --offline
```

Replace `VERSION_DIRECTORY` with the version directory printed by the build, then validate and
activate it:

```bash
uv run python -c "from pathlib import Path; from gods_eye.index_store import validate_version; loaded=validate_version(Path('VERSION_DIRECTORY'), 'openai/clip-vit-base-patch16'); assert loaded.metadata.dataset_configuration == ['CUHK-PEDES']; assert set(loaded.manifest.roots) == {'CUHK-PEDES'}; assert all(record.dataset == 'CUHK-PEDES' and all(alias.dataset == 'CUHK-PEDES' for alias in record.aliases) for record in loaded.manifest.records); print({'version': loaded.metadata.version_id, 'gallery_count': loaded.metadata.gallery_count})"
uv run gods-eye-index activate \
  --version VERSION_DIRECTORY \
  --active-pointer indexes/active \
  --model-id openai/clip-vit-base-patch16
```

The active version must pass the same validation after activation. Keep the generated manifest,
index, checkpoints, cache, report, and images out of version control.

## Acceptance evidence

Generate a machine-readable report only after the index validation succeeds:

```bash
HF_HUB_OFFLINE=1 uv run gods-eye-acceptance \
  --manifest indexes/gallery-manifest.json \
  --version VERSION_DIRECTORY \
  --dataset-root data/datasets \
  --cache-dir .cache/huggingface \
  --device auto --offline \
  --output .gods-eye/cuhk-acceptance-report.json
```

The report should record the date, hardware, model and revision, Gallery Manifest coverage,
gallery count, query count, cold latency, warm median, p95, maximum latency, and whether the
three-second measurement target was met. These are measurements of this workstation and are not a
universal service-level agreement.

Start the prepared runtime in offline mode and verify the HTTP boundary:

```bash
./gods-eye start --offline --no-open
```

Submit the fixed descriptions from the acceptance report through the browser. Every result must
identify `CUHK-PEDES`; a request naming a retired dataset must be rejected by the API. If the real
index browser check is enabled, run the opt-in Playwright test with `GODS_EYE_REAL_INDEX=1` and
compare displayed IDs, splits, ranks, and scores with the newly generated report.

If the three-second target is missed, preserve correctness and profile CLIP text embedding, exact
FAISS search, image transfer, and browser rendering separately. Do not reintroduce a retired
dataset or reuse the obsolete combined index to improve the measurement.
