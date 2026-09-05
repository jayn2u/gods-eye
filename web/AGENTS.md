# Web guidance

## Overview

React/Vite browser workflow with one stateful composition root and typed screen props.

## Where to look

| Task | File | Responsibility |
|------|------|----------------|
| Workflow or request lifecycle | `src/main.tsx` | Readiness, search state, cancellation, screen transitions, selected result |
| Screen markup and interaction | `src/screens.tsx` | Compose, progress, results, detail; behavior passed through props |
| Search rules | `src/search.ts` | Validation, pagination, status-to-recovery messages |
| HTTP contract | `src/api.ts` | Relative `/api/readiness` and `/api/search` calls |
| Dataset/result types | `src/types.ts` | Supported datasets and shared response shape |
| Theme behavior | `src/theme.ts`, `index.html` | Runtime persistence and pre-React initialization |
| Visual tokens/layout | `src/styles.css` | Light/dark variables and desktop layout |
| Pure logic coverage | `src/search.test.ts` | Vitest search-rule tests |
| Browser coverage | `e2e/search.spec.ts`, `e2e/theme.spec.ts` | Real API flow, navigation, viewport, theme |

## Behavioral contracts

- Keep workflow state and HTTP orchestration in `main.tsx`; screens receive typed data and callbacks.
- Search cancellation uses both `AbortController` and a request ID; preserve stale-response protection.
- Detail navigation uses result indexes. Closing detail restores focus to its result card.
- UI top-k options are 12, 24, and 48; pagination reveals 24 additional results.
- The request uses `top_k`; frontend state uses `topK`. Coordinate schema changes with
  `../service/gods_eye/models.py` and API contract tests.
- Dataset changes cross `types.ts`, backend validation, and fixture/browser assumptions.
- Keep `gods-eye-theme` and system-preference detection synchronized in `theme.ts` and `index.html`.
  The inline initialization prevents a theme flash before React mounts.
- Explicit theme selection overrides later system changes; blocked storage must not break toggling.
- Below 1200px, the desktop-required notice replaces the application shell. This is intentional E2E behavior.
- Preserve labels, live regions, result focus restoration, and Escape/arrow-key detail navigation.

## Test and serving boundaries

- Vitest excludes `e2e/**`; Playwright owns browser scenarios.
- Playwright starts or reuses the fixture API on port 8000 and Vite on port 5173.
  Check reused servers when results unexpectedly reflect a different mode.
- `GODS_EYE_REAL_INDEX=1` enables the real-index browser case; provision the intended service first.
- Vite proxies `/api` locally; container serving uses `../deploy/nginx.conf`. Preserve both routes.
- The web build runs TypeScript project checking before Vite production bundling.
- Keep the existing compact JSX conventions when making focused changes.
