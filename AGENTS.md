# Project knowledge base

Generated: 2026-09-05 | Source revision: `850f61e` | Branch: `codex/init-deep`

## Overview

God's Eye prepares research person-image galleries and retrieves visually similar images from
natural-language descriptions. FastAPI/Python provides retrieval and the Launcher; React/TypeScript
provides the browser experience. The primary Full Demo path runs through Docker.

## Before exploring

- Read `CONTEXT.md` for domain vocabulary and `docs/agents/domain.md` for the single-context documentation workflow.
- For Dataset Acquisition changes, read `docs/adr/0001-explicit-dataset-acquisition.md`.
- For Launcher, runtime, packaging, or Quickstart changes, read `docs/adr/0002-docker-only-full-demo-lifecycle.md` and `docs/specs/full-demo-launcher.md`.
- For issue/spec operations, read `docs/agents/issue-tracker.md`; GitHub Issues are the tracker.
- For triage, read `docs/agents/triage-labels.md` and retain the five canonical label names.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `jayn2u/gods-eye`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each mapped to an identically-named label. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Structure

```text
gods-eye                 Host shell entry point; bootstraps the Launcher container
service/gods_eye/        API, Dataset Acquisition, model/index preparation, Launcher
service/tests/           Python unit, contract, and opt-in integration tests
web/                     React UI, Vitest logic tests, Playwright browser tests
deploy/nginx.conf        Container SPA serving and /api proxy
docs/                    ADRs, operator/contributor guides, specs, validation evidence
compose*.yaml            Development, release, offline, and fixture-smoke modes
Dockerfile.*             Launcher, service, and browser image builds
```

## Where to look

| Task | Location | Guidance |
|------|----------|----------|
| Backend or Launcher behavior | `service/gods_eye/AGENTS.md` | Module map and persistence boundaries |
| Python regression coverage | `service/tests/AGENTS.md` | Test adapters and opt-in gates |
| Browser behavior | `web/AGENTS.md` | State, API, and test boundaries |
| Contributor tools and checks | `docs/setup/local-development.md` | Fixture API and local servers |
| Operator preparation/runtime | `docs/setup/full-demo.md` | Primary Docker lifecycle |
| Dataset or model/index operations | `docs/setup/datasets.md`, `docs/setup/model-and-index.md` | Explicit asset workflows |
| Offline or real-gallery validation | `docs/setup/offline-and-validation.md`, `docs/full-gallery-validation.md` | Asset-dependent acceptance |
| CI and releases | `.github/workflows/` | Python suite, Compose smoke, tag-triggered image publishing |

## Code map

CodeGraph snapshot; caller counts are graph observations, not complete runtime coverage.
LSP document symbols were unavailable from the installed Python server.

| Symbol | Location | Callers | Role |
|--------|----------|---------|------|
| `IndexedRetrievalEngine` | `service/gods_eye/retrieval.py` | 9 | Active-index search, preparation smoke, acceptance |
| `UnavailableRetrievalEngine` | `service/gods_eye/retrieval.py` | 6 | Explicit unready search state |
| `FixtureRetrievalEngine` | `service/gods_eye/retrieval.py` | 5 | Deterministic development/test retrieval |
| `ManifestRetrievalEngine` | `service/gods_eye/retrieval.py` | 5 | Manifest-backed retrieval path |
| `Dataset` | `service/gods_eye/models.py` | 5 | Shared dataset identity contract |

## Project boundaries

- Keep Dataset Acquisition explicit and terms-gated, separate from service startup and indexing.
- Keep Demo Preparation separate from Demo Runtime; `--yes` does not accept dataset terms.
- Preserve the Docker-only primary Quickstart; host Python/Node and fixtures belong in advanced contributor guidance.
- Keep datasets, model caches, indexes, and `.gods-eye` runtime state outside container images.
- Development Compose builds checkout source; release Compose uses immutable images with builds disabled.
- Keep research visual-similarity language; results do not establish a person's identity.
- Keep machine-specific paths in local configuration and tokens/raw queries out of operational logs.

## Commands

Run from the repository root; dependency setup and optional checks are documented in the contributor guide.

```bash
uv sync --frozen --extra indexing
uv run --extra indexing pytest -q -rs
uv run ruff check .
uv run ruff format --check .
pnpm install --frozen-lockfile
pnpm test:web
pnpm build:web
pnpm test:e2e
docker compose -f compose.yaml -f compose.smoke.yaml config
```

## Verification notes

- `/api/health` is liveness; `/api/readiness` is search capability. A live process can correctly be unready.
- Routine fixture checks need no external Dataset Installation, model download, or GPU.
- CI runs Python tests and a separate fixture-backed Compose smoke; web checks remain separate commands.
- Fixture smoke success is not evidence of a Prepared Demo using the real galleries.
