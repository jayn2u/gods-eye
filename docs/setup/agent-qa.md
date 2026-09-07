# Advisory Agent QA operator guide

Agent QA is an advisory browser check for this repository's fixture application. It publishes one
upserted pull-request summary and bounded evidence artifacts; it does not add a required status
check or grant a merge. `--make-pr` can create a pull request when the invoking tool supports it,
but it never grants merge permission or bypasses the repository review process.

## Eligibility and activation

The controller considers only an open, non-draft pull request whose base branch matches
`^release/[^/]+$`. The pull-request author must currently have repository write-equivalent
permission. A workflow actor, `author_association`, a title, or a body cannot substitute for that
permission check. Pull requests to `develop`, nested release branch names, closed pull requests,
and drafts do not start browser work.

The trusted `Agent QA` and `Agent QA report` workflows become active only after their reviewed
change reaches the default `develop` branch through the normal team process. Do not directly push
them to the default branch or treat this guide as merge authorization. Until that happens, a
runner, CI subscription login, and local helper tests can be prepared, but the
`pull_request_target` and `workflow_run` path cannot be accepted as live.

## Runner and subscription lifecycle

Run the helpers from a trusted checkout at a reviewed default-branch revision. Choose a
repository-scoped `QA_ROOT` outside both the development checkout and the developer Codex home;
when unset, the helpers use `$HOME/.local/share/gods-eye-agent-qa`.

```bash
export QA_ROOT="$HOME/.local/share/gods-eye-agent-qa"
bash .github/agent-qa/setup-runner.sh install
bash .github/agent-qa/setup-runner.sh register
bash .github/agent-qa/setup-runner.sh login --device-auth
bash .github/agent-qa/setup-runner.sh start
```

`register` uses the already authenticated GitHub CLI to obtain a short-lived registration token;
do not copy, print, or save that token. On this headless runner, `login --device-auth` is the
primary Codex subscription login for the CI-only `CODEX_HOME` at `$QA_ROOT/codex-home`: Codex
prints a URL and one-time code, which the operator completes in a browser on another device. Device
authentication may need to be enabled in personal security settings or workspace permissions; see
[Log in on headless devices](https://learn.chatgpt.com/docs/auth#login-on-headless-devices). Bare
`login` remains available for a normal interactive refresh. Both forms take the auth lock, do not
copy the developer session, change `HOME`, or allow an API-key fallback. A present auth file alone
is not proof that the subscription can run QA.

Use the read-only checks before start, after a refresh, and while investigating a report:

```bash
node .github/agent-qa/doctor.cjs --json
bash .github/agent-qa/setup-runner.sh status
```

The doctor output contains only non-secret readiness metadata. Keep credentials, registration
tokens, environment dumps, and raw agent output out of terminal captures and issue comments.

The runner intentionally shares the current Linux user with development. Separate work roots,
clean child environments, and a separate `CODEX_HOME` prevent routine collisions and accidental
credential inheritance. They are not a hostile-code sandbox: eligible team code and its build
dependencies are trusted to run with that user's access. Do not expand eligibility to untrusted
contributors.

## Results, deadlines, and recovery

Each eligible head receives an advisory summary comment. A report can be `no_findings`,
`findings`, `incomplete`, or `cancelled`. `incomplete` reasons such as `auth_required`,
`runner_failed`, `browser_unavailable`, `timeout`, and `setup_failed` describe QA infrastructure;
they are not product findings or merge gates.

QA runs one job globally at a time. A newer event for the same pull request cancels its superseded
generation; another pull request stays queued. The GitHub job has a 15-minute running limit, with
an internal 12-minute work deadline reserved before scoped cleanup and upload. Queue time is not
running time: an offline runner can leave a job queued until GitHub reaches a terminal state.

The public artifact is named for its pull request, run, and attempt, and is retained for 14 days.
It may include the validated report, sanitized summary and steps, known screenshots, and
deterministic traces. It excludes CI auth, configuration, raw Codex events, environment dumps, and
real gallery assets.

For `auth_required`, run `login` again and then repeat the read-only checks; do not introduce an
API key or delete the CI auth directory. For a runner-offline result, use doctor and `status` to
identify the reported prerequisite, correct that prerequisite, then run `start`; do not kill all
Node processes. For a superseded or cancelled run, allow the newer generation or the reporter to
reach its terminal summary before deciding whether a new eligible pull-request event is needed.
Agent QA never uses Docker or Compose as a recovery step.

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

The CI toolchain pin is Codex `0.153.3` with npm integrity
`sha512-SwQns+YIXvaXV4a6RUd9twgTPJkkfZpuTNEkTtIkwBnfw6fpT61+d6gU1WHZxK6vWFNqJCBoJEP69FIAsoPduA==`
and Playwright MCP `0.0.80` with npm integrity
`sha512-FOPXHm2SvFhAQylm10jMZ35B/SR2TaMLVkavAlwoG4N2qCb5RqbvhQYcu3zmXNyxR2DW0Ooxe+9XPVt5UjKRCQ==`.
It uses the matching MCP Playwright `1.63.0-alpha-2026-08-31` Chromium separately from the
application E2E Playwright `1.62.1`. Host tooling is Node `24.12.0`, uv `0.12.6`, pnpm `10.15.0`,
and Python `>=3.11,<3.13`.

Pin changes require a normal reviewed change that updates the readable version comment and exact
hash or integrity value, revalidates its availability, runs the helper and workflow policy tests,
and records the actual runner version. Never substitute `latest`; failed preflight is the expected
safe result for an unavailable or mismatched pin.
