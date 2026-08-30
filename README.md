# God’s Eye

Text-to-Image Person Retrieval research PoC. The initial vertical slice uses deterministic fixtures; it does not download a model or require datasets.

## Requirements

- Python 3.11 and [uv](https://docs.astral.sh/uv/)
- Node.js 22 LTS and pnpm 10

## Run locally

```bash
uv sync
pnpm install
uv run uvicorn gods_eye.app:app --app-dir service --reload
pnpm dev:web
```

Open `http://127.0.0.1:5173`. API documentation is at `http://127.0.0.1:8000/docs`.

Search defaults to `top_k=24` across `CUHK-PEDES`, `ICFG-PEDES`, and `RSTPReid`. The accepted range is 1–100 and at least one supported dataset must be selected.

## Offline checks

Once dependencies have been installed, all checks run without network access, model downloads, or external datasets:

```bash
uv run pytest
uv run ruff check service
pnpm test:web
pnpm build:web
pnpm test:e2e
```

The browser test starts the real FastAPI and Vite processes. Only the expensive retrieval seam is replaced by the deterministic fixture adapter.
