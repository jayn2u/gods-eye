# Service Test Guidance

## Test routing

Keep the default suite deterministic and local. Most tests construct small galleries,
indexes, manifests, or launcher state under `tmp_path`; preserve those isolated roots
when adding coverage. The service package is imported through the repository's `service`
Python path configured in `pyproject.toml`.

Use the focused module that owns the contract:

- `test_api.py`: HTTP validation, readiness/search behavior, OpenAPI, and operational
  logging without raw query text.
- `test_gallery.py`, `test_datasets.py`, and `test_index_store.py`: fixture files,
  archive safety, manifest/index schemas, atomic publication, and path containment.
- `test_launcher_command.py`: preparation stages, acceptance, resumability, fake service
  operations, redaction, and failure state.
- `test_launcher_runtime.py` and `test_launcher_lifecycle.py`: start/readiness/ports,
  runtime preservation, locking, reset, update, and invalidation behavior.
- `test_quickstart_contract.py` and `test_root_launcher_image.py`: README/Compose
  contracts, wrapper behavior, image fingerprints, and launcher-container boundaries.
- `test_release_images.py`: release workflow and immutable image contracts.

## Subprocess and filesystem patterns

Launcher tests intentionally use configurable fake Docker/Compose and service adapters,
usually created inside `tmp_path`, then inspect captured calls, JSONL logs, exit codes,
stdout/stderr, and generated state. Extend those adapters when a new command path needs
coverage; keep assertions about observable operator contracts rather than implementation
details. Tests that invoke the root `gods-eye` wrapper should run it with temporary project
roots and explicit environment variables so host assets and repository state stay isolated.

Use `tmp_path` for all generated data, archives, indexes, logs, and fake executables.
When testing a failed start or preparation, assert both the diagnostic and whether runtime
state, pointers, or downstream preparation stages were preserved.

## Integration gates

`@pytest.mark.integration` identifies opt-in or Docker-backed work; it is not a signal that
every test requires the same external dependency. Preserve the local skip gates:

- `RUN_CLIP_INTEGRATION=1` enables `test_clip_integration.py`; cached model assets and
  compatible device/offline settings are still required.
- `RUN_DATASET_SOURCE_CHECK=1` enables registered public-source checks in `test_datasets.py`.
- `RUN_PREPARATION_BUILD_SMOKE=1` enables the real Launcher service-image build test.
- `RUN_LAUNCHER_COMPOSE_SMOKE=1` enables fixture-backed Launcher/Compose tests.
- `RUN_STALE_LAUNCHER_SMOKE=1` enables stale-image replacement coverage.
- `RUN_PORTABLE_INDEX_SMOKE=1` enables portable prepared-index coverage.

Docker tests also skip when the Docker CLI is absent; FAISS round-trip coverage skips when
`faiss` is not installed. The fixture Compose path uses `compose.smoke.yaml`, CPU, offline
mode, and no dataset/model downloads. Do not silently turn a deterministic test into a
networked or GPU-dependent test.

## Completion check

After changing service behavior, run the narrowest affected module first. Report skipped
integration coverage with its required environment gate and assets.
