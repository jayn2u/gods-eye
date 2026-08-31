# Local development and tests

The Docker-only Quickstart does not require these tools. Contributors need Python 3.11, `uv`,
Node.js 22 LTS, and pnpm 10.

```bash
uv sync --extra indexing --extra clip
pnpm install --frozen-lockfile
```

Run the fixture API and Vite server in separate terminals:

```bash
GODS_EYE_USE_FIXTURES=true uv run uvicorn gods_eye.app:app --app-dir service \
  --host 127.0.0.1 --port 8000 --reload
pnpm dev:web
```

Open `http://127.0.0.1:5173`. API docs are at `http://127.0.0.1:8000/docs`, OpenAPI is at
`/openapi.json`, liveness is `/api/health`, and search readiness is `/api/readiness`. A healthy
non-fixture process may correctly be unready until an index is activated.

Routine checks require no external dataset, model download, or GPU:

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
pnpm test:web
pnpm build:web
pnpm test:e2e
docker compose -f compose.yaml -f compose.smoke.yaml config
```

The Playwright suite runs the real API/web flow with the deterministic three-image fixture. The
opt-in Launcher/Compose smoke builds the same two containers, starts from a test-only Prepared Demo
state, and verifies web plus API readiness:

```bash
RUN_LAUNCHER_COMPOSE_SMOKE=1 uv run pytest \
  service/tests/test_quickstart_contract.py -m integration
```

This smoke path is test-only and does not claim that fixture assets constitute a real Full Demo.
