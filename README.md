# God’s Eye

God’s Eye is a desktop-first research demo for finding person images from an English description.
The Full Demo ranks the CUHK-PEDES gallery with CLIP ViT-B/16.

> **Research use only.** This is visual-similarity retrieval, not identity verification. Scores are
> neither probabilities nor evidence of identity. Do not use the app for identification,
> surveillance, automated decisions, or safety-critical work.

## Requirements

The supported Full Demo environment is:

- Ubuntu/Linux on `amd64`
- Docker Engine with Compose v2
- an NVIDIA GPU with at least 8 GiB VRAM, a compatible driver, and NVIDIA Container Toolkit
- enough project-disk space for the retained CUHK-PEDES archive, extracted images, the model cache,
  index, and a safety reserve; `doctor` calculates the current requirement

You do **not** need host Python, Node.js, `uv`, or `pnpm`. The Launcher checks every prerequisite
without changing the host. The API and web app bind only to `127.0.0.1`.

The datasets are sensitive third-party research data and are not bundled or redistributed. The
configured Google Drive files are mirrors, not proof of publisher authorization. Before download,
`prepare` shows the official sources and terms, mirror locations, sizes, restrictions, and an
explicit acceptance prompt. Confirm that your use complies with the current publisher terms.

## Quickstart

From the repository root, run:

```bash
./gods-eye doctor
./gods-eye prepare
./gods-eye start
```

`prepare` is the long, one-time step. It asks you to accept the data terms and safely resumes after
an interruption. `start` waits for both API health and search readiness, then opens the actual
loopback URL (normally `http://127.0.0.1:5173`). Press `Ctrl+C` to stop the containers; prepared
datasets, model files, and indexes remain on disk.

For unattended preparation, confirmation and data acceptance remain separate:

```bash
./gods-eye prepare --yes --accept-data-terms
```

## Open the web app

After `./gods-eye start` reports that the Full Demo is ready, open the URL printed in the terminal
on the same computer. The Launcher normally opens it automatically. If it does not—for example,
with `--no-open` or in a headless session—copy the printed URL into a desktop browser:

```text
God's Eye Full Demo is ready: http://127.0.0.1:5173
```

Treat that output as authoritative. `5173` is the default web port, but the Launcher chooses a
different loopback port when the default is occupied and prints the actual URL to use. The interface
requires a desktop viewport at least 1200 pixels wide.

The default foreground session keeps running in the terminal; press `Ctrl+C` to stop it. If you
started with `./gods-eye start --detach`, stop the Demo Runtime with `./gods-eye stop`.

The Demo Runtime uses plain HTTP and has no account, password, or TLS. It listens only on
`127.0.0.1` and is intended for access from the same computer. Public or network exposure is not
supported.

## What preparation does

`./gods-eye prepare` verifies and resumes seven stages: preflight, terms acknowledgement, Dataset
Acquisition, CLIP model preparation, Gallery Manifest generation, GPU index build and atomic
activation, and a real-search smoke test. It records compatible completed stages and detailed logs
under the gitignored `.gods-eye/` directory. It does not report the Full Demo as prepared unless the
final search succeeds.

Development checkouts build the service and web images from local source. Tagged releases can use
the repository's immutable `release-images.env`; the Launcher always reports which mode it chose.
Datasets, model files, and indexes are never stored in images.

## Launcher commands

```text
./gods-eye doctor                         Check every supported-environment prerequisite
./gods-eye prepare [--batch-size N]       Prepare or resume the real Full Demo
./gods-eye start [--detach] [--no-open]   Start after readiness succeeds
./gods-eye start --offline                Refuse model/network fallback while starting
./gods-eye status                         Show runtime containers
./gods-eye logs                           Show recent runtime logs
./gods-eye stop                           Stop containers and preserve prepared assets
./gods-eye update                         Preview asset compatibility changes
./gods-eye reset TARGET                   Preview and confirm explicit asset removal
```

Reset targets are `--index`, `--model-cache`, `--installed-datasets`, `--archives`, or `--all`.
With no target, `reset` removes nothing. State-changing commands reject concurrent mutations.

## Recovery

- If `doctor` fails, apply every item in its combined **Fix** report, then rerun it.
- If preparation stops, rerun `./gods-eye prepare`; the verified download and checkpoints are reused.
- If `start` says the demo is incomplete, run `./gods-eye prepare`. It never downloads data or
  accepts terms silently.
- If readiness fails, run `./gods-eye logs`. Model/revision mismatch and missing offline assets need
  a new compatible preparation.
- If CUDA runs out of memory, preparation halves its conservative batch size and retries. You can
  also choose a smaller positive value with `--batch-size`.
- If ports 5173 or 8000 are occupied, the Launcher selects free loopback ports and prints the URL.

## Detailed setup and development

- [Full Demo lifecycle and storage](docs/setup/full-demo.md)
- [Local development and tests](docs/setup/local-development.md)
- [Dataset Acquisition and Gallery Manifest](docs/setup/datasets.md)
- [Model preparation and index management](docs/setup/model-and-index.md)
- [Offline operation, validation, and limitations](docs/setup/offline-and-validation.md)
