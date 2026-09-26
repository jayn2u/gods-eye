# Advisory Agent QA operator guide

Agent QA is an advisory browser check for this repository's fixture application. It publishes one
upserted pull-request summary and bounded evidence artifacts; it does not add a required status
check or grant a merge. `--make-pr` can create a pull request when the invoking tool supports it,
but it never grants merge permission or bypasses the repository review process.

Agent QA runs per **Agent Profile**: Copilot and Claude are available. Each run uses one AI browser
agent against the shared scenarios and is judged only by the **Browser Journal**. For the per-agent
design and migration rationale, see [ADR 0004](../adr/0004-label-opt-in-agent-qa-per-agent.md).

## Eligibility and activation

The controller considers only an open, non-draft pull request that carries either the
`copilot-agent-qa` or `claude-agent-qa` **QA Label**. A label is the sole opt-in for its Agent Profile:
there is no base-branch restriction, and release pull requests no longer trigger automatically. As
part of this migration, the former `agent-qa` label and nine unused default labels were removed from
the repository. Only a collaborator with triage or higher permission can apply a QA Label, and the
controller reads the label set from a fresh API response rather than from the event payload. The
pull-request author must independently have repository write-equivalent permission. A label, a
workflow actor, `author_association`, a title, or a body cannot substitute for that permission check.
Pull requests without either QA Label, closed pull requests, and drafts do not start browser work.

A pull request keeps its opt-in across pushes: each `synchronize` event supersedes the previous
generation while the QA Label remains. Removing an Agent Profile's QA Label, converting the pull
request to a draft, or retargeting it invalidates that profile's request, and the reporter updates its
existing advisory comment to `not_applicable`. Remove that QA Label when a pull request no longer
needs the profile's QA on every push. Both labels together run both agents independently; they share
the same global one-job-at-a-time queue.

Each workflow also receives label events for the other Agent Profile. Such an event gets a run name
like `<Agent> Agent QA ignored label event <run id>` and its `admission` job is skipped. Its unique
concurrency group means it neither cancels nor supersedes an in-progress Agent QA run. The
corresponding report workflow cannot correlate a trusted pull-request identity, so that workflow
run fails closed: it appears red in the Actions UI and writes nothing. This is expected for an ignored
label event; no browser QA result was produced.

The trusted `Copilot Agent QA`, `Copilot Agent QA Report`, `Claude Agent QA`, and
`Claude Agent QA Report` workflows become active only after their reviewed change reaches the default
`develop` branch through the normal team process. Do not directly push them to the default branch or
treat this guide as merge authorization. Until that happens, a runner, agent token secrets, and local
helper tests can be prepared, but the `pull_request_target` and `workflow_run` path cannot be accepted
as live.

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

There is no `login` step and no persistent agent credential on this runner. Copilot authenticates from
the `AGENT_QA_COPILOT_TOKEN` repository secret, passed as `QA_COPILOT_TOKEN` only to its agent step;
create it from a token carrying the Copilot Requests permission. Claude authenticates from the
`CLAUDE_CODE_OAUTH_TOKEN` repository secret, passed only to its agent step. Create it with
`claude setup-token`, then store it without printing the value:

```bash
claude_token="$(claude setup-token)"
printf %s "$claude_token" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo jayn2u/gods-eye
unset claude_token
```

Never echo the token or leave it in a terminal capture. The `printf %s` form avoids adding a newline
when piping it. The user unit unsets `OPENAI_API_KEY`,
`AZURE_OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_API_KEY`, and `COPILOT_GITHUB_TOKEN`, so no
ambient provider credential can be inherited; it also unsets `CLAUDE_CODE_OAUTH_TOKEN`. Each agent
step keeps `GITHUB_TOKEN` and `GH_TOKEN` empty, so an agent holds only its own provider credential
and no repository access.

`register` uses the already authenticated GitHub CLI to obtain a short-lived registration token; do
not copy, print, or save that token.

Use the read-only checks before start and while investigating a report:

```bash
node .github/agent-qa/doctor.cjs --json
bash .github/agent-qa/setup-runner.sh status
```

The doctor output contains only non-secret readiness metadata. Its `subscription_auth` check reports
`token_source: workflow-secret` outside Actions because tokens are only provided to agent steps. The
preparation check does not require a token; the agent step reports `auth_required` when its secret is
missing or malformed. A token that is present is not proof that the agent will answer.

After this Claude change, the runner operator must refresh the existing toolchain on the runner host,
using the reviewed checkout:

```bash
bash .github/agent-qa/setup-runner.sh install
bash .github/agent-qa/setup-runner.sh start
```

Until both commands have completed, Claude runs report `setup_failed` at the doctor's `tool_versions`
check. The doctor checks only the active Agent Profile's tools, so Copilot is unaffected.

Keep credentials, registration tokens, environment dumps, and raw agent output out of terminal
captures and issue comments.

The runner intentionally shares the current Linux user with development. Separate work roots and
clean child environments prevent routine collisions and accidental credential inheritance. They are
not a hostile-code sandbox: eligible team code and its build dependencies are trusted to run with
that user's access. Do not expand eligibility to untrusted contributors.

### Step layout

Each agent workflow passes the execution-state file path to later steps as `STATE_PATH`. `prepare`
runs the doctor with `phase: prepare`, starts the fixture runtime, runs the deterministic baseline,
and writes the prompt. It does not receive an agent token; only the matching agent step receives its
secret. The job has a 25-minute internal deadline from job start, with a 25-minute GitHub step limit
as a backstop for the agent action.

`finalize` runs under `always()`. It verifies the Browser Journal, writes the report, and stops the
handed-off runtime using its manifest. A run interrupted between steps is cleaned up by `finalize`;
the runner's orphan-process cleanup handles anything still left at job end. The report's `phases`
include `finalize`.

### Claude profile and action

Claude runs through
`anthropics/claude-code-base-action@7456abb892dcd39cd63025550e1726fe65b7c5d2`. The workflow sets
`NODE_VERSION` to `24.12.0` and limits the action step to `timeout-minutes: 25`. Claude Code `2.1.283`
and Bun `1.3.14` come from the runner's locked toolchain. `setup-runner.sh install` uses `npm ci
--ignore-scripts`, so it supplies the pinned platform executables directly to the action instead of
letting the action's installer download Claude Code. The runner unit exposes them as `QA_CLAUDE_BIN`
and `QA_BUN_BIN`.

Each run has a run-scoped `HOME` and a `CLAUDE_WORKING_DIR` outside the candidate checkout. The
prepared Claude directory contains a strict MCP configuration for the Playwright MCP server, and the
workflow passes it with `--strict-mcp-config --mcp-config`. Claude's `--allowedTools` list contains
only the 14 `mcp__playwright__<tool>` names declared by `scenarios.json` under
`browser.allowed_tools`. Its denied list is `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`,
`NotebookEdit`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `Task`, and `TodoWrite`. The same lists
are written to the run's settings file; the result schema is passed inline with `--json-schema`.

The workflow invokes `--model opus`. This is an intentional alias exception: it follows the newest
Opus model, and the report records the model resolved by that run.

## Evidence channel

A report's scenario status and findings come from the **Browser Journal**, written by harness code
inside the Playwright MCP server process, not from anything the agent narrates. The Browser Journal
records the profile selection, the ordered page-observed actions, and each receipt; a screenshot
counts only when it exists, is a real PNG, and postdates its scenario's receipt.

Receipt conditions live in `scenarios.json` and are evaluated by that harness code. The agent calls
`window.__GODS_EYE_QA__.receipt(<scenario id>)` and cannot supply, alter, or relay the condition. An
agent that describes a step it did not perform through a browser tool produces `incomplete` with
`invalid_output`, never a finding and never `no_findings`.

Because Copilot CLI resolves MCP configuration from `$HOME/.copilot`, lets a project `.mcp.json` or
`.github/mcp.json` override it, and offers no strict-config flag, each run gets its own HOME and an
empty working directory outside the candidate checkout, and refuses to start if a stray MCP config is
present there.

## Where a reviewer reads the result

Four surfaces carry the same validated `report.json`, in decreasing summary and increasing detail.

**The pull-request comment.** Each Agent Profile owns one bot comment per pull request, rewritten in
place on every push. Copilot uses title `Copilot Agent QA (advisory)` and marker
`<!-- gods-eye-copilot-agent-qa:v1 -->`; Claude uses title `Claude Agent QA (advisory)` and marker
`<!-- gods-eye-claude-agent-qa:v1 -->`. The comment carries the status, tested head, links to the run
and evidence artifact, a row per scenario, findings, and screenshots. The scenario table's
`Browser calls` column is counted from the trusted Browser Journal and its `Proof` column reflects a
screenshot the harness accepted, so neither number is the agent's own claim.

**The job summary.** The QA job renders the full report on its run page: tool and model versions,
per-phase timings, the deterministic baseline result, the scenario table, the findings, and a
collapsible block per scenario holding the agent's narrated steps beside the Browser Journal's call count and
the evidence that was actually accepted. This is the surface the comment's run link lands on.

**The evidence artifact.** Each artifact is retained 14 days and holds `report.json` and accepted
screenshots. Its name is `copilot-agent-qa-<pr>-<run>-<attempt>` or
`claude-agent-qa-<pr>-<run>-<attempt>`, according to the Agent Profile. Only files listed in the
report's evidence manifest, matched by size and sha256, are staged for upload, and screenshots for
unproven scenarios are deleted before staging.

**The job log.** For a run that did not complete, stderr names what each unproven scenario was
missing — origin, how many of its declared actions were observed, receipt attempts, screenshot — and
prints the harness's own state snapshot for a refused receipt.

### Screenshots in the pull request

Accepted screenshots are pushed to the orphan branch `copilot-agent-qa-evidence` or
`claude-agent-qa-evidence`, according to the Agent Profile, under
`pr-<number>/<run id>-<attempt>/<scenario>.png` and referenced from the comment. Older generations of
the same pull request are removed from that profile's branch in the same commit, so each branch holds
one directory per pull request rather than one per push; other pull requests' paths are never touched.
The branch shares no history with any source branch, and deleting it is safe — the next publication
recreates it.

The old `agent-qa-evidence` branch and `<!-- gods-eye-agent-qa:v1 -->` comments are no longer
updated. The old branch can be deleted.

This is the one part of Agent QA that writes to the repository, so it is a job of its own:
`publish-evidence` holds `contents: write` and no pull-request access, while `publish` holds
`pull-requests: write` and no repository write. Both run only control code checked out at
`github.workflow_sha`; candidate code runs in neither. A failure to publish screenshots degrades to a
comment without images and never withholds the report.

Because this repository is private, GitHub serves those images only to a viewer who can already read
the repository. A reader without that access sees the alt text, which is why each image is also
introduced by scenario name.

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

A run that reaches the agent step's 25-minute GitHub backstop still enters `finalize` before the job
ends. The internal deadline starts at job start, so it ends work before this later step limit and
leaves time for cleanup. The browser agent is invoked directly rather than through a lock wrapper,
so the supervisor terminates the agent's own process group and no lock survives to block later runs.
The runner's orphan-process cleanup handles anything still left at job end. If a report says
`setup_failed`, the job log names the failed prerequisite. The report's `phases` field records how
many seconds each stage took, including `finalize`, and the job summary prints it, so a run that
spent its deadline in dependency resolution rather than in the agent is visible without reading the
log.

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

Claude uses `auth_required` when its token is missing or invalid, including HTTP 401 or 403
responses. Recreate the `CLAUDE_CODE_OAUTH_TOKEN` secret from `claude setup-token`
and store it with `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo jayn2u/gods-eye`; if piping the token,
use `printf %s`, never `echo`, and keep it out of logs and captures. `rate_limited` means Claude
returned HTTP 429 or a usage limit response. `timeout` means the Claude step hit its 25-minute step
limit or was cancelled mid-run. `invalid_output` means Claude hit max turns, returned an agent error,
or produced no result. These are Agent QA outcomes, not product findings.

A `timeout` report names the phase that consumed the budget in the job log, as
`phases: doctor=1s runtime=612s ... finalize=1s`. A large `runtime` figure is dependency
installation, not the browser agent.

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
unchanged.

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

Claude Code `2.1.283` and Bun `1.3.14` are also pinned in the locked toolchain. Because
`setup-runner.sh install` uses `npm ci --ignore-scripts`, their platform packages provide the
executables directly at
`$QA_ROOT/toolchain/node_modules/@anthropic-ai/claude-code-linux-x64/claude` and
`$QA_ROOT/toolchain/node_modules/@oven/bun-linux-x64/bin/bun`; the runner unit exposes these as
`QA_CLAUDE_BIN` and `QA_BUN_BIN`. The Claude workflow passes these paths to the pinned action instead
of using its `curl | bash` installer.

Node, Playwright MCP, and each active Agent Profile's tools are pinned exactly; the doctor rejects a
drift in those tools. It checks only the active agent's binaries: Copilot, or Claude Code plus Bun.
`uv` and `pnpm` build the candidate, and their versions are governed by that candidate's own
`uv.lock` and `packageManager` field through corepack, so the doctor requires their presence and
records the observed version rather than asserting a global one. The runner unit pins `PATH` to the
directory of the Node that `install` verified, because the systemd user manager does not inherit a
login shell's PATH and a version-managed interpreter would otherwise be invisible.

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
