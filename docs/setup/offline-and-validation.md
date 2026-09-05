# Offline operation, validation, and limitations

After successful online preparation, `./gods-eye start --offline` adds network isolation and sets
the model libraries to offline mode. Preflight requires the exact revision-bound B/16 snapshot and
contained active index pointer; a merely nonempty cache is insufficient. Missing or incompatible
cached assets fail with guidance, and optional-model problems do not block a valid default start.
The Launcher does not fetch anything. Use identical model identity, revision, cache, manifest
schema, and index version across preparation and runtime.

The API accepts `POST /api/search` with an English `query`, `top_k` from 1 through 100, and a
non-empty dataset subset. Images are served only through validated manifest IDs. Operational logs
record timings, counts, versions, and error categories, but never raw query text. Reverse proxies
and third-party telemetry require a separate privacy review.

Routine fixture validation is synthetic and does not prove that real Hugging Face checkpoints load.
With all four checkpoints already cached and a compatible NVIDIA GPU, the opt-in real matrix is:

```bash
RUN_CLIP_INTEGRATION=1 GODS_EYE_REAL_MODEL_MATRIX=1 GODS_EYE_OFFLINE=1 \
  uv run pytest service/tests/test_clip_integration.py -m integration -q
```

After building a real index, `gods-eye-acceptance` produces reproducible coverage,
artifact-validation, ranked-result, and latency evidence. See
[the recorded full-gallery validation](../full-gallery-validation.md). Report hardware, device,
model/revision, gallery size, query count, median, p95, and maximum latency; the three-second target
is a measured-system goal, not a universal SLA.

General CLIP is not person-ReID-specialized. Bias, dataset shift, and false matches are expected.
The CUHK-PEDES gallery is a demo, not a benchmark split. The MVP has no authentication, accounts,
saved queries, shortlist, or case management and is intended for one local research workstation.
