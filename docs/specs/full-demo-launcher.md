# Full Demo Launcher specification

## Outcome

A first-time operator can follow the README from prerequisites to a searchable Full Demo without invoking Python, Node.js, package managers, or raw Compose commands. The root `./gods-eye` Launcher is the only required project command.

## Supported environment

- Ubuntu/Linux on amd64.
- Docker Engine with Compose v2.
- NVIDIA GPU with at least 8 GB VRAM, a compatible driver, and NVIDIA Container Toolkit access from Docker.
- Loopback-only web and API bindings. The Launcher provides no public-host option.
- Project-local, gitignored storage for datasets, archives, installation state, model cache, indexes, Launcher state, and logs.

The Launcher must check facts rather than assume that installed host tools work. It reports all failed prerequisite checks together, with corrective guidance, and never installs system packages.

## First-run path

The README begins with the requirements and data-use warning, followed by:

```bash
./gods-eye doctor
./gods-eye prepare
./gods-eye start
```

`start` opens `http://127.0.0.1:5173` only after health and search readiness pass. When a port is occupied, the Launcher selects an available loopback port and prints the actual URL. Browser opening is skipped for SSH/headless sessions and can be disabled with `--no-open`.

If `start` finds that the Full Demo is not prepared, it describes the missing assets, expected work, and asks whether to run `prepare`. It does not begin downloads or accept data terms implicitly. Non-interactive use fails instead of prompting.

## Command contract

### `doctor`

Checks architecture, Docker daemon and Compose, GPU model and VRAM, driver, container GPU access, writable storage, calculated free-space requirement, and default port availability. It prints a single pass/fail table and exits nonzero when the supported environment is not available.

### `prepare`

Runs the following verified, resumable stages:

1. Preflight and storage calculation.
2. Dataset terms acknowledgement.
3. Dataset Acquisition for the registered CUHK-PEDES source.
4. CLIP ViT-B/16 model preparation.
5. Gallery Manifest generation.
6. GPU index build and atomic activation.
7. Model load, active-index validation, and a real-search smoke test.

The command shows stage number, progress, elapsed time, and an evidence-based estimate. Detailed output is written to `.gods-eye/logs/<timestamp>.log`. Cancellation preserves verified stages, resumable archive parts, and index checkpoints; a later run validates and resumes them. GPU-memory failure halves the conservatively selected batch size and retries the current index stage.

Before downloading, the operator sees the CUHK-PEDES official source and terms or license, its distinct mirror location, expected size, usage restrictions, and sensitive-data warning. Interactive acceptance is recorded with timestamp, Dataset Registry version, and selected source in `.gods-eye/state.json`. A Registry or source change requires renewed acceptance. `--yes` never implies `--accept-data-terms`.

### `start`

Runs the API and web containers in the foreground by default and stops them on `Ctrl+C`. It waits up to two minutes for health and readiness before presenting the URL; failure prints the cause, recovery guidance, and log path. `--detach` is supported, along with `stop`, `status`, and `logs`. `start --offline` refuses network access and reports missing local assets without fetching them.

### `reset`

Requires one or more explicit targets: `--index`, `--model-cache`, `--installed-datasets`, `--archives`, or `--all`. It displays targets and sizes and requires confirmation before deletion. With no target it only prints usage. Stopping containers does not remove prepared assets.

### Automation and updates

`--yes`, `--no-open`, and `--json` support non-interactive operation with documented exit codes. Data terms always require the separate explicit acceptance flag. State-changing commands use `.gods-eye/lock` to prevent concurrent preparation, reset, update, or runtime mutation; read-only status and logs remain available.

The Launcher does not update implicitly. `update` is explicit and shows the migration plan. State records application, Dataset Registry, model, Gallery Manifest schema, and index compatibility so compatible assets are reused and only invalidated stages are rebuilt.

Tagged releases publish public, immutable Linux amd64 service and web images to `ghcr.io/jayn2u/` without datasets, models, or indexes. A release checkout uses its pinned image digests. Until that publishing workflow exists, and for development checkouts, the same Launcher command clearly reports that it is building images from local source.

## Launcher architecture

The root `./gods-eye` file is a thin portable shell entry point. It verifies that Docker can be invoked and delegates stateful orchestration to a dedicated container, so the host does not require Python or Node.js. The orchestration component owns progress, state compatibility, locking, diagnostics, and subprocess exit handling; the shell wrapper does not duplicate that logic.

## README structure

The README retains only the project warning, supported requirements, three-command Quickstart, what preparation does, the main Launcher commands, and short recovery guidance. Detailed material moves under `docs/setup/` and covers Full Demo internals, local development, Dataset Acquisition, model/index management, offline use, and validation. Documentation must describe only currently executable behavior; GHCR pull behavior is added to the primary path only when its publishing workflow exists.

## Verification seams

- Launcher command and state transitions use a fake Docker process in fast tests.
- Tests cover failed preflight aggregation, explicit terms acceptance, resumable stages, cancellation, locking, port selection, readiness timeout, offline failure, reset confirmation, JSON output, and exit codes.
- A fixture-backed Compose smoke test verifies preparation-to-browser readiness without external datasets or model downloads.
- Full Dataset Acquisition, GPU indexing, and real-search validation remain explicit opt-in checks rather than routine CI work.
- Logs must not contain access tokens, raw natural-language queries, or host personal information.
