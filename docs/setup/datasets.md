# Dataset Acquisition and Gallery Manifest

The explicit installer downloads the pinned CUHK-PEDES Drive archive to `data/archives/`, checks its
exact size and SHA-256, rejects unsafe archive entries, validates the required metadata/image
directories in staging, and atomically publishes `data/datasets/CUHK-PEDES`. The Installation
Receipt distinguishes a complete Dataset Installation from partial files. The archive remains
available for repair until cleaned.

The Launcher is the normal path. These lower-level commands are for development and repair:

```bash
uv run gods-eye-datasets install --accept-data-terms
uv run gods-eye-datasets install CUHK-PEDES --accept-data-terms
uv run gods-eye-datasets status
uv run gods-eye-datasets verify
uv run gods-eye-datasets clean --archives
```

Re-running `install` resumes `.part` downloads and skips verified installations. Use `--force` to
rebuild a selected installation. Free space must cover the retained archive, staging tree, and
final tree. Automated environments may set `GODS_EYE_ACCEPT_DATA_TERMS=true` only after their
operator has actually reviewed and accepted the terms.

The Compose-only equivalent gives the installer write access while the runtime service retains a
read-only dataset mount:

```bash
docker compose --profile tools run --rm dataset-installer \
  --data-root /data --index-root /indexes install --accept-data-terms
```

The installed layout is `CUHK-PEDES/{imgs,reid_raw.json}`. The receipt lives under
`data/install-state/`. The Gallery Manifest normalizes split names, creates stable public IDs,
validates paths and images, and collapses only byte-identical files. API output never exposes
captions or absolute host paths.

Metadata filenames vary by release. When generating a manifest manually, explicit `--source`
values are authoritative:

```bash
uv run python -m gods_eye.gallery \
  --source CUHK-PEDES="data/datasets/CUHK-PEDES/imgs=data/datasets/CUHK-PEDES/reid_raw.json" \
  --output indexes/gallery-manifest.json
```

For an opt-in check that each pinned Drive object remains public with its registered filename:

```bash
RUN_DATASET_SOURCE_CHECK=1 uv run pytest service/tests/test_datasets.py -m integration
```
