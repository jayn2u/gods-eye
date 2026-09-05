# SERVICE MODULE MAP

This package contains the Python service, the operator Launcher, and the
asset-preparation primitives. Route changes by responsibility before editing.

## ENTRY POINTS

- `app.py`: FastAPI `app`; owns `/api/health`, `/api/readiness`, `/api/search`,
  and image serving. Keep HTTP validation in `models.py` and retrieval behavior
  in `retrieval.py`.
- `launcher.py` and `launcher_cli.py`: the `gods-eye` command surface. Command
  orchestration belongs here; shared paths and exit codes belong in
  `launcher_common.py`.
- `preparation_worker.py`: isolated preparation worker for model, dataset,
  gallery, and index stages. `preparation.py` coordinates its invocation.
- `datasets.py`, `gallery.py`, and `index_store.py`: the durable asset pipeline.
  `clip.py` supplies model loading and embedding support.

## STATE AND ASSET INVARIANTS

- `RuntimeLayout` in `launcher_common.py` is the source of truth for
  `.gods-eye/state.json`, logs, and the mutation lock. Update state through its
  atomic `write_state` path and serialize state-changing commands with
  `launcher_lifecycle.mutation_lock`.
- Dataset Acquisition verifies archive size and SHA-256 before extraction,
  validates required paths, publishes the installation atomically, then writes
  a receipt under `data/install-state`. Treat the receipt as evidence of the
  verified archive and installation; do not infer readiness from directory
  existence alone.
- Gallery Manifests are normalized provenance records. Index versions are
  immutable directories containing metadata, manifest, embeddings, and the
  backend index. `index_store.validate_version` must pass before publication or
  activation.
- The active index is a relative pointer beneath the configured index root.
  Activation writes it atomically; loading rejects pointers that escape the
  root, incompatible model/revision, manifest digest mismatches, malformed
  vectors, or count/dimension mismatches.

## API MODES

`app.py` selects the retrieval engine once from settings. Fixture mode uses
`FixtureRetrievalEngine`; a valid active index uses `IndexedRetrievalEngine`
with deterministic or CLIP embeddings; missing or invalid assets use
`UnavailableRetrievalEngine` and readiness/search report the preparation gap.
Use `use_retrieval_engine`, `activate_manifest`, or `activate_index` in tests
instead of mutating global engine state directly.

## CHANGE ROUTING

For dataset lifecycle changes, inspect `datasets.py`, `launcher_assets.py`, and
their tests. For index format or activation changes, inspect `index_store.py`,
`retrieval.py`, and index-store tests together. For Launcher behavior, follow
`launcher_cli.py` into the narrow sibling module (`launcher_doctor.py`,
`launcher_lifecycle.py`, or `launcher_runtime.py`) and its corresponding tests.
For API contract changes, inspect `models.py` and `app.py` together and cover
the affected readiness, fixture, unavailable, and indexed paths.
