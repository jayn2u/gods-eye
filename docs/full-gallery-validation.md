# Full-gallery validation

This document is the reproducible acceptance record for issue #8. It reports only observed facts.
The results are qualitative visual-similarity observations, not benchmark accuracy, biometric
identification, or evidence of a sighting.

## Run recorded on 2026-08-31

The local metadata and image files under `/data/jayn2u/lab_datasets` were read without modification.
Manifest construction completed in 3 minutes 53.58 seconds with 115,233 metadata rows, 115,232
unique referenced paths, 262 byte-identical duplicates, 114,970 canonical active gallery records,
and zero missing, unsafe, or unreadable images. Exact-content deduplication therefore found 261
additional duplicate files beyond the one repeated ICFG metadata path.

| Dataset | Split | Source images | Duplicate aliases | Active canonical images |
| --- | --- | ---: | ---: | ---: |
| CUHK-PEDES | train | 34,054 | 10 | 34,044 |
| CUHK-PEDES | validation | 3,078 | 2 | 3,076 |
| CUHK-PEDES | test | 3,074 | 1 | 3,073 |
| ICFG-PEDES | train | 34,674 | 177 | 34,497 |
| ICFG-PEDES | validation | 0 | 0 | 0 |
| ICFG-PEDES | test | 19,848 | 47 | 19,801 |
| RSTPReid | train | 18,505 | 24 | 18,481 |
| RSTPReid | validation | 1,000 | 2 | 998 |
| RSTPReid | test | 1,000 | 0 | 1,000 |

The environment had 251 GiB RAM and 173 GiB free system disk space. `nvidia-smi` could not
communicate with the NVIDIA driver, so CUDA was unavailable. CLIP ViT-B/16 assets were prepared in
an uncommitted temporary Hugging Face cache. A 320-image CPU sample completed in 9.24 seconds. The
full 114,970-image CPU build then completed successfully in 1 hour 32 minutes 9 seconds, used at
most 31.8 GiB RSS, and produced 512-dimensional normalized embeddings and an exact FAISS index.
Its coverage artifact recorded 114,970 successful, zero skipped, and zero failed images.

The immutable version `20260830T164315743101Z-2b1b9780` passed an independent validation of its
metadata, manifest digest, embedding shape/dtype/norms, model and processor identity, FAISS
dimension/count, stable IDs, and resolvable images. Activation succeeded without modifying the
source datasets.

## Search observations and latency

Three fixed English descriptions were each searched three times at top 24. The measured direct
engine latency included CLIP text embedding and exact search over all 114,970 vectors: cold 197.61
ms, warm median 150.26 ms, p95 197.61 ms, and maximum 197.61 ms on CPU. The observed run therefore
met the three-second target; it is a measurement on this workstation, not a universal SLA.

| Description | Rank-one trace | Similarity |
| --- | --- | ---: |
| a person wearing a red shirt and dark trousers | `img_f033e0c72ab17aa25cdcef31` (ICFG-PEDES, test) | 0.361142 |
| a person carrying a backpack and wearing a light jacket | `img_7d014556b906fe337a997efc` (ICFG-PEDES, train) | 0.390003 |
| a person in a black coat with white shoes | `img_2019c0c6ac6c18305c330d9b` (ICFG-PEDES, test) | 0.378938 |

The generated JSON outside the repository contains all 24 ranked IDs for each query. These are
qualitative results only. The browser could not be exercised in the managed execution sandbox:
loopback requests were refused even after uvicorn reported startup, and a FastAPI TestClient startup
spent more than six minutes rechecking all 114,970 dataset paths before the bounded attempt was
stopped. The documented browser verification step remains required on the host workstation; no
browser result is claimed here.

## Reproduce and resume

Create the manifest using the three explicit `gods_eye.gallery` sources shown in the README, then
run the resumable build below. Checkpoint shards are outside the repository and survive interruption.

```bash
HF_HUB_OFFLINE=1 uv run gods-eye-index build \
  --manifest /path/to/gallery-manifest.json \
  --versions-dir /path/to/indexes/versions \
  --checkpoint-dir /path/to/indexes/checkpoints/clip-vit-b16-full \
  --model-id openai/clip-vit-base-patch16 \
  --cache-dir /path/to/huggingface-cache \
  --device auto --batch-size 32 --offline
```

After the build returns a version directory, validate, activate, and generate the machine-readable
acceptance evidence:

```bash
uv run python -c "from pathlib import Path; from gods_eye.index_store import validate_version; validate_version(Path('/path/to/version'), 'openai/clip-vit-base-patch16')"
uv run gods-eye-index activate --version /path/to/version \
  --active-pointer /path/to/indexes/active --model-id openai/clip-vit-base-patch16
HF_HUB_OFFLINE=1 uv run gods-eye-acceptance \
  --manifest /path/to/gallery-manifest.json --version /path/to/version \
  --cache-dir /path/to/huggingface-cache --device auto --offline \
  --output /path/to/acceptance-report.json
```

Start the API and web app with that active pointer, submit the three numbered fixed descriptions
from the generated report through the browser, and confirm that the displayed IDs, datasets,
splits, ranks, and scores match the traceable report results. Do not commit the generated manifest,
checkpoints, index, cache, report, or images.

If the three-second search target is missed, preserve correctness and separately profile text
embedding, FAISS search, image transfer, and browser rendering. The first recommended optimization
is GPU access for CLIP text/image inference; approximate search is not justified for only 114,970
512-dimensional vectors until profiling shows exact FAISS search is the bottleneck.
