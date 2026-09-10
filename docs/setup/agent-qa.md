# Advisory Agent QA operator guide

Agent QA is an advisory browser check for this repository's fixture application. It publishes one
upserted pull-request summary and bounded evidence artifacts; it does not add a required status
check or grant a merge. `--make-pr` can create a pull request when the invoking tool supports it,
but it never grants merge permission or bypasses the repository review process.

## Eligibility and activation

The controller considers only an open, non-draft pull request that is also *requested*: either its
base branch matches `^release/[^/]+$`, or the pull request currently carries the `agent-qa` label.
The label is the opt-in path for ordinary `develop` pull requests; only a collaborator with triage
or higher permission can apply it, and the controller reads the label set from a fresh API response
rather than from the event payload. The pull-request author must independently have repository
write-equivalent permission. A label, a workflow actor, `author_association`, a title, or a body
cannot substitute for that permission check. Unlabelled pull requests to `develop`, unlabelled
nested release branch names, closed pull requests, and drafts do not start browser work.

A labelled pull request keeps its opt-in across pushes: each `synchronize` event supersedes the
previous generation for that pull request while the label remains. Removing the label invalidates
the pull request the same way a draft conversion or a retarget does, and the reporter updates the
existing advisory comment to `not_applicable`. Remove the label when a pull request no longer needs
QA on every push; the global one-job-at-a-time queue is shared with every other eligible pull
request.

The trusted `Agent QA` and `Agent QA report` workflows become active only after their reviewed
change reaches the default `develop` branch through the normal team process. Do not directly push
them to the default branch or treat this guide as merge authorization. Until that happens, a
runner, the Copilot token secret, and local helper tests can be prepared, but the
`pull_request_target` and `workflow_run` path cannot be accepted as live.

## Runner and agent lifecycle

Run the helpers from a trusted checkout at a reviewed default-branch revision. Choose a
repository-scoped `QA_ROOT` outside the development checkout; when unset, the helpers use
`$HOME/.local/share/gods-eye-agent-qa`.

```bash
export QA_ROOT="$HOME/.local/share/gods-eye-agent-qa"
bash .github/agent-qa/setup-runner.sh install
bash .github/agent-qa/setup-runner.sh register
bash .github/agent-qa/setup-runner.sh start
```

There is no `login` step and no agent credential on this runner. The browser agent is the GitHub
Copilot CLI, which authenticates from the `AGENT_QA_COPILOT_TOKEN` repository secret that the
workflow passes in as `QA_COPILOT_TOKEN`. Create that secret from a token carrying the Copilot
Requests permission. The user unit unsets `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `CODEX_API_KEY`,
`ANTHROPIC_API_KEY`, and `COPILOT_GITHUB_TOKEN`, so no ambient provider credential can be inherited,
and the QA step keeps `GITHUB_TOKEN` and `GH_TOKEN` empty: the agent holds a Copilot credential and
no repository access.

`register` uses the already authenticated GitHub CLI to obtain a short-lived registration token; do
not copy, print, or save that token.

Use the read-only checks before start and while investigating a report:

```bash
node .github/agent-qa/doctor.cjs --json
bash .github/agent-qa/setup-runner.sh status
```

The doctor output contains only non-secret readiness metadata. Its `subscription_auth` check reports
`token_source: workflow-secret` outside Actions, because the token exists only inside a job; inside a
job a missing token fails the check and the run reports `auth_required`. A token that is present is
not proof that Copilot will answer.

Keep credentials, registration tokens, environment dumps, and raw agent output out of terminal
captures and issue comments.

The runner intentionally shares the current Linux user with development. Separate work roots and
clean child environments prevent routine collisions and accidental credential inheritance. They are
not a hostile-code sandbox: eligible team code and its build dependencies are trusted to run with
that user's access. Do not expand eligibility to untrusted contributors.

## Evidence channel

A report's scenario status and findings come from a journal written by harness code inside the
Playwright MCP server process, not from anything the agent narrates. The journal records the profile
selection, the ordered page-observed actions, and each receipt; a screenshot counts only when it
exists, is a real PNG, and postdates its scenario's receipt.

Receipt conditions live in `scenarios.json` and are evaluated by that harness code. The agent calls
`window.__GODS_EYE_QA__.receipt(<scenario id>)` and cannot supply, alter, or relay the condition. An
agent that describes a step it did not perform through a browser tool produces `incomplete` with
`invalid_output`, never a finding and never `no_findings`.

Because Copilot CLI resolves MCP configuration from `$HOME/.copilot`, lets a project `.mcp.json` or
`.github/mcp.json` override it, and offers no strict-config flag, each run gets its own HOME and an
empty working directory outside the candidate checkout, and refuses to start if a stray MCP config is
present there.

## Results, deadlines, and recovery

Each eligible head receives an advisory summary comment. A report can be `no_findings`,
`findings`, `incomplete`, or `cancelled`. `incomplete` reasons such as `auth_required`,
`runner_failed`, `browser_unavailable`, `timeout`, and `setup_failed` describe QA infrastructure;
they are not product findings or merge gates.

Dependency downloads are cached under `$QA_ROOT/cache` and shared across runs, and the resolved
Python environment is reused from `$QA_ROOT/cache/envs/py-<lock digest>`. The digest covers the
candidate's `uv.lock` and `pyproject.toml`, which with `--frozen` fully determine the environment, so
a changed lock rebuilds it and unrelated source changes do not. A per-run cache made every run refetch the whole dependency set, which
exhausted the internal deadline before the browser agent started. The cache and the environments survive runs and are
not cleaned with them; delete them by hand if a corrupt download has to be discarded.

A run that ends on its deadline can leave the agent's process group orphaned; the browser agent is
now invoked directly rather than through a lock wrapper, so the supervisor terminates the agent's own
group and no lock survives to block later runs. If a report says `setup_failed`, the job log names the
failed prerequisite.

Sharing state means inheriting what a killed run left behind. A deadline that lands mid-download
leaves partial package state in the pnpm store, and every later install then fails on it. The harness
discards the store once and retries the install, so this recovers without an operator; a cancellation
or a deadline is never treated that way. The retry appears in the job log as `pnpm-install-retry`.

Building an environment for a lock the runner has not seen can exceed the internal deadline on a slow
link. Warm it outside a job before the first run against a new lock:

```bash
UV_PROJECT_ENVIRONMENT="$QA_ROOT/cache/envs/py-$(cat uv.lock pyproject.toml | sha256sum | cut -c1-32)" \
  UV_CACHE_DIR="$QA_ROOT/cache/uv" uv sync --frozen --no-dev
```

QA runs one job globally at a time. A newer event for the same pull request cancels its superseded
generation; another pull request stays queued. The GitHub job has a 30-minute running limit, with
an internal 25-minute work deadline reserved before scoped cleanup and upload. The budget covers
agent variance rather than its best case: two consecutive runs of the same code and the same six
scenarios took 230 and 546 seconds. A `timeout` is therefore a statement about that run's agent, not
about the candidate, and the phase line separates it from dependency installation. Queue time is not
running time: an offline runner can leave a job queued until GitHub reaches a terminal state.

The public artifact is named for its pull request, run, and attempt, and is retained for 14 days.
It may include the validated report, sanitized summary and steps, known screenshots, and
deterministic traces. It excludes CI auth, MCP configuration, the raw browser journal, agent stdout,
environment dumps, and real gallery assets.

For `auth_required`, the Copilot CLI rejected the credential. The job log carries a sanitized excerpt
of the agent's own error; `Failed to fetch PAT user login (401) ... Bad credentials` means GitHub
refused the token itself rather than its permissions. Check, in order: the secret was stored without
a trailing newline (`printf %s` rather than `echo`, though the harness also trims it and the doctor
refuses a token carrying whitespace), the token has not expired, it carries the Copilot Requests
permission, and the account it belongs to has an active Copilot subscription. Renew the
`AGENT_QA_COPILOT_TOKEN` secret and repeat the read-only checks; do not introduce a provider API key
and do not place a token on the runner. For a runner-offline result, use doctor and `status` to
identify the reported prerequisite, correct that prerequisite, then run `start`; do not kill all
Node processes. For a superseded or cancelled run, allow the newer generation or the reporter to
reach its terminal summary before deciding whether a new eligible pull-request event is needed.
Agent QA never uses Docker or Compose as a recovery step.

A `timeout` report names the phase that consumed the budget in the job log, as
`phases: doctor=1s runtime=612s ...`. A large `runtime` figure is dependency installation, not the
browser agent.

A report whose reason is `invalid_output` most often means the browser journal did not prove a
scenario. Read the scenario list in the summary comment rather than the agent's prose.

Restarting the runner service can leave a job that GitHub already assigned to the dying session
queued indefinitely, with the runner reporting `online` and `busy: false`. The runner log shows
`A session for this runner already exists` while it reconnects. Cancel that run and let a new
eligible event start a fresh one; do not restart the service again to clear it.

To stop only the runner service during a scoped rollback or maintenance window, preserve the CI
login and use:

```bash
systemctl --user stop gods-eye-agent-qa-runner.service
```

Rollback disables only the Agent QA workflows or this service. It leaves the existing Python suite
and the non-pull-request Compose smoke unchanged. If repository protection later requires a Compose
context, treat that as an external prerequisite and resolve it through the normal review process;
do not silently change protection or re-enable PR Compose smoke.

## Pinned inputs and review

The runner bootstrap pin is GitHub Actions Runner `2.337.0` for Linux x64 with SHA-256
`70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613`. The workflows pin
`actions/checkout` v4 to `11d5960a326750d5838078e36cf38b85af677262`, `actions/github-script` v8
to `ed597411d8f924073f98dfc5c65a23a2325f34cd`, `actions/upload-artifact` v4 to
`ea165f8d65b6e75b540449e92b4886f43607fa02`, and `actions/download-artifact` v5 to
`634f93cb2916e3fdff6788551b99b062d0335ce0`.

The CI toolchain pin is the GitHub Copilot CLI `1.0.83` with npm integrity
`sha512-M8uZI0V0dahYV1KZij3nGDxaXEGG7I7YUZzQPI7NEZkL/83Nl/tNTbPdxKtdWZbOmWoXsPKXty/eEYoj6RHDhA==`
and Playwright MCP `0.0.80` with npm integrity
`sha512-FOPXHm2SvFhAQylm10jMZ35B/SR2TaMLVkavAlwoG4N2qCb5RqbvhQYcu3zmXNyxR2DW0Ooxe+9XPVt5UjKRCQ==`.
The Copilot CLI ships per-platform binary packages; `package-lock.json` pins each with its own
integrity value and `npm ci` selects only `copilot-linux-x64` on this runner. `QA_AGENT_MODEL` may
pin a model through the `AGENT_QA_MODEL` repository variable and is left unset by default.

Node, the Copilot CLI, and Playwright MCP are the harness's own tools and are pinned exactly; the
doctor rejects a drift. `uv` and `pnpm` build the candidate, and their versions are governed by that
candidate's own `uv.lock` and `packageManager` field through corepack, so the doctor requires their
presence and records the observed version rather than asserting a global one. The runner unit pins
`PATH` to the directory of the Node that `install` verified, because the systemd user manager does
not inherit a login shell's PATH and a version-managed interpreter would otherwise be invisible.

The published Actions guide installs the CLI with an unpinned `npm install -g @github/copilot` on an
ephemeral GitHub-hosted runner. This repository does not: a global install would mutate state shared
with development on this self-hosted runner, and an unpinned install is the `latest` substitution the
pin policy below forbids. `setup-runner.sh install` performs the pinned `npm ci` into `$QA_ROOT/toolchain`
instead, and a mismatched or unavailable pin is expected to fail preflight. It uses the matching MCP Playwright `1.63.0-alpha-2026-08-31` Chromium
separately from the application E2E Playwright `1.62.1`. Host tooling is Node `24.12.0`, uv `0.12.6`,
pnpm `10.15.0`, and Python `>=3.11,<3.13`.

Pin changes require a normal reviewed change that updates the readable version comment and exact
hash or integrity value, revalidates its availability, runs the helper and workflow policy tests,
and records the actual runner version. Never substitute `latest`; failed preflight is the expected
safe result for an unavailable or mismatched pin.
