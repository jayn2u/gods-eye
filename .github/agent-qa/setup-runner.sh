#!/usr/bin/env bash
set -euo pipefail

RUNNER_VERSION="2.337.0"
RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
RUNNER_NAME="gods-eye-agent-qa"
SERVICE_NAME="gods-eye-agent-qa-runner.service"
REPOSITORY="${QA_REPOSITORY:-jayn2u/gods-eye}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
QA_ROOT="${QA_ROOT:-${HOME}/.local/share/gods-eye-agent-qa}"
DEVELOPER_CHECKOUT="${QA_DEVELOPER_CHECKOUT:-$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null || pwd -P)}"
SYSTEMD_DIR="${QA_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user}"
GH_BIN="${QA_GH_BIN:-gh}"
SYSTEMCTL_BIN="${QA_SYSTEMCTL_BIN:-systemctl}"
LOGINCTL_BIN="${QA_LOGINCTL_BIN:-loginctl}"
FLOCK_BIN="${QA_FLOCK_BIN:-flock}"
NPM_BIN="${QA_NPM_BIN:-npm}"

usage() {
  cat <<'EOF'
Usage: setup-runner.sh <install|register|login|start|status>

  install   Install the pinned runner, locked toolchain, Chromium, and user unit.
  register  Register this repository's single gods-eye-agent-qa runner.
  login     Complete interactive ChatGPT login in the CI-only CODEX_HOME.
  start     Verify prerequisites, then enable and start the user service.
  status    Print the non-secret JSON preflight report.
EOF
}

die() {
  printf 'setup-runner: %s\n' "$1" >&2
  exit 1
}

require_safe_root() {
  [[ "$(id -un)" == "${QA_EXPECTED_USER:-jayn2u}" ]] || die "this runner must be provisioned as the approved current user jayn2u"
  [[ "${QA_ROOT}" = /* ]] || die "QA_ROOT must be absolute"
  [[ "${QA_ROOT}" != *$'\n'* && "${QA_ROOT}" != *$'\r'* ]] || die "QA_ROOT contains unsupported characters"
  QA_ROOT="$(realpath -m -- "${QA_ROOT}")"
  DEVELOPER_CHECKOUT="$(realpath -m -- "${DEVELOPER_CHECKOUT}")"
  [[ "${QA_ROOT}" != "${DEVELOPER_CHECKOUT}"/* && "${DEVELOPER_CHECKOUT}" != "${QA_ROOT}"/* && "${QA_ROOT}" != "${DEVELOPER_CHECKOUT}" ]] \
    || die "QA_ROOT and the developer checkout must be separate"
  [[ "${QA_ROOT}" != "${HOME}/.codex" ]] || die "QA_ROOT cannot be the developer CODEX_HOME"
}

test_adapter_value() {
  local name="$1"
  [[ "${QA_TEST_ADAPTERS:-}" == "1" ]] || return 1
  printf '%s' "${!name:-}"
}

escape_systemd_path() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value// /\\x20}
  value=${value//$'\t'/\\x09}
  value=${value//\"/\\x22}
  value=${value//%/%%}
  printf '%s' "${value}"
}

escape_systemd_environment() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '%s' "${value}"
}

write_unit() {
  local unit_path="${SYSTEMD_DIR}/${SERVICE_NAME}"
  mkdir -p "${SYSTEMD_DIR}"
  chmod 700 "${SYSTEMD_DIR}"
  local escaped_root escaped_runner
  escaped_root="$(escape_systemd_environment "${QA_ROOT}")"
  escaped_runner="$(escape_systemd_path "${QA_ROOT}/runner")"
  local temp_unit
  temp_unit="$(mktemp "${QA_ROOT}/.unit.XXXXXX")"
  cat >"${temp_unit}" <<EOF
[Unit]
Description=God's Eye advisory agent QA runner
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${escaped_runner}
Environment="CODEX_HOME=${escaped_root}/codex-home"
Environment="PLAYWRIGHT_BROWSERS_PATH=${escaped_root}/toolchain/browsers"
Environment="QA_CODEX_BIN=${escaped_root}/toolchain/node_modules/.bin/codex"
Environment="QA_PLAYWRIGHT_MCP_BIN=${escaped_root}/toolchain/node_modules/.bin/playwright-mcp"
UnsetEnvironment=OPENAI_API_KEY AZURE_OPENAI_API_KEY CODEX_API_KEY
ExecStart=${escaped_runner}/run.sh
Restart=always
RestartSec=5
TimeoutStopSec=60
KillMode=mixed

[Install]
WantedBy=default.target
EOF
  chmod 600 "${temp_unit}"
  mv "${temp_unit}" "${unit_path}"
}

install_runner() {
  local runner_dir="${QA_ROOT}/runner"
  if [[ -e "${runner_dir}/.runner-version" ]]; then
    [[ "$(<"${runner_dir}/.runner-version")" == "${RUNNER_VERSION}" ]] \
      || die "a different runner version already exists; refusing implicit replacement"
    [[ -x "${runner_dir}/run.sh" && -x "${runner_dir}/config.sh" ]] \
      || die "existing runner installation is incomplete"
    return
  fi
  [[ ! -e "${runner_dir}" || -z "$(find "${runner_dir}" -mindepth 1 -print -quit 2>/dev/null)" ]] \
    || die "runner directory is non-empty and unmanaged"

  local archive expected archive_override
  archive="$(mktemp "${QA_ROOT}/.runner.XXXXXX.tar.gz")"
  trap 'rm -f "${archive:-}"' RETURN
  archive_override="$(test_adapter_value QA_TEST_RUNNER_ARCHIVE_PATH || true)"
  expected="$(test_adapter_value QA_TEST_RUNNER_SHA256 || true)"
  expected="${expected:-${RUNNER_SHA256}}"
  if [[ -n "${archive_override}" ]]; then
    cp -- "${archive_override}" "${archive}"
  else
    curl --fail --location --silent --show-error "${RUNNER_URL}" --output "${archive}"
  fi
  printf '%s  %s\n' "${expected}" "${archive}" | sha256sum --check --status \
    || die "runner archive checksum verification failed"

  local staging
  staging="$(mktemp -d "${QA_ROOT}/.runner-stage.XXXXXX")"
  tar -xzf "${archive}" -C "${staging}"
  [[ -x "${staging}/run.sh" && -x "${staging}/config.sh" ]] || die "runner archive is missing required executables"
  printf '%s\n' "${RUNNER_VERSION}" >"${staging}/.runner-version"
  chmod 700 "${staging}"
  if [[ -d "${runner_dir}" ]]; then rmdir "${runner_dir}"; fi
  mv "${staging}" "${runner_dir}"
  trap - RETURN
  rm -f "${archive}"
}

install_toolchain() {
  local source="${SCRIPT_DIR}"
  local injected
  injected="$(test_adapter_value QA_TEST_TOOLCHAIN_SOURCE || true)"
  source="${injected:-${source}}"
  [[ -f "${source}/package.json" && -f "${source}/package-lock.json" ]] \
    || die "locked agent QA package manifests are missing"
  install -m 600 "${source}/package.json" "${QA_ROOT}/toolchain/package.json"
  install -m 600 "${source}/package-lock.json" "${QA_ROOT}/toolchain/package-lock.json"
  "${NPM_BIN}" ci --prefix "${QA_ROOT}/toolchain" --ignore-scripts --no-audit --no-fund
  local browser_installer
  browser_installer="$(test_adapter_value QA_TEST_BROWSER_INSTALL_BIN || true)"
  browser_installer="${browser_installer:-${QA_ROOT}/toolchain/node_modules/.bin/playwright}"
  [[ -x "${browser_installer}" ]] || die "the locked Playwright browser installer is unavailable"
  PLAYWRIGHT_BROWSERS_PATH="${QA_ROOT}/toolchain/browsers" "${browser_installer}" install chromium
}

install_all() {
  require_safe_root
  mkdir -p "${QA_ROOT}" "${QA_ROOT}/runner" "${QA_ROOT}/toolchain" "${QA_ROOT}/codex-home" "${QA_ROOT}/runs"
  chmod 700 "${QA_ROOT}" "${QA_ROOT}/runner" "${QA_ROOT}/toolchain" "${QA_ROOT}/codex-home" "${QA_ROOT}/runs"
  : >"${QA_ROOT}/auth.lock"
  chmod 600 "${QA_ROOT}/auth.lock"
  install_runner
  install_toolchain
  write_unit
  printf 'Installed runner %s and locked QA toolchain under QA_ROOT.\n' "${RUNNER_VERSION}"
}

runner_listing() {
  "${GH_BIN}" api "repos/${REPOSITORY}/actions/runners" --paginate --slurp
}

harden_generated_runner_files() {
  local runner_dir="${QA_ROOT}/runner"
  local filename target
  target="${runner_dir}/.runner"
  [[ -f "${target}" && ! -L "${target}" ]] || die "runner configuration was not created safely"
  for filename in .runner .credentials .credentials_rsaparams; do
    target="${runner_dir}/${filename}"
    [[ ! -L "${target}" ]] || die "runner generated state is not a regular file"
    if [[ -e "${target}" ]]; then
      [[ -f "${target}" ]] || die "runner generated state is not a regular file"
      chmod 600 "${target}"
    fi
  done
}

register_runner() {
  require_safe_root
  [[ -x "${QA_ROOT}/runner/config.sh" ]] || die "run install first"
  local repository_json
  repository_json="$("${GH_BIN}" repo view "${REPOSITORY}" --json nameWithOwner,isPrivate)"
  REPOSITORY_JSON="${repository_json}" REPOSITORY_EXPECTED="${REPOSITORY}" node -e '
    const v=JSON.parse(process.env.REPOSITORY_JSON);
    if(v.nameWithOwner!==process.env.REPOSITORY_EXPECTED||v.isPrivate!==true) process.exit(1)' \
    || die "repository identity/private-state verification failed"

  local listing count
  listing="$(runner_listing)"
  count="$(RUNNERS_JSON="${listing}" node -e '
    const v=JSON.parse(process.env.RUNNERS_JSON); const pages=Array.isArray(v)?v:[v];
    const rs=pages.flatMap(p=>p.runners||[]).filter(r=>r.name==="gods-eye-agent-qa");
    process.stdout.write(String(rs.length));')"
  if [[ "${count}" != "0" ]]; then
    if [[ "${count}" == "1" && -f "${QA_ROOT}/runner/.runner" ]]; then
      harden_generated_runner_files
      LOCAL_RUNNER_JSON="$(<"${QA_ROOT}/runner/.runner")" REPOSITORY_EXPECTED="${REPOSITORY}" node -e '
        const parseRunnerConfig=(text)=>JSON.parse(text.replace(/^\uFEFF/, ""));
        const v=parseRunnerConfig(process.env.LOCAL_RUNNER_JSON);
        if(v.agentName!=="gods-eye-agent-qa"||v.gitHubUrl!==`https://github.com/${process.env.REPOSITORY_EXPECTED}`) process.exit(1)' \
        || die "the local runner configuration conflicts with the repository registration"
      printf 'Runner is already registered.\n'
      return
    fi
    die "a conflicting gods-eye-agent-qa runner registration already exists"
  fi

  local token
  token="$("${GH_BIN}" api --method POST "repos/${REPOSITORY}/actions/runners/registration-token" --jq .token)"
  [[ -n "${token}" ]] || die "GitHub did not return a runner registration token"
  (
    cd "${QA_ROOT}/runner"
    ./config.sh --unattended --url "https://github.com/${REPOSITORY}" --token "${token}" \
      --name "${RUNNER_NAME}" --labels "${RUNNER_NAME}" --work "${QA_ROOT}/runs"
  ) >/dev/null
  unset token
  harden_generated_runner_files
  printf 'Registered runner %s for %s.\n' "${RUNNER_NAME}" "${REPOSITORY}"
}

login_codex() {
  require_safe_root
  [[ -x "${QA_ROOT}/toolchain/node_modules/.bin/codex" ]] || die "run install first"
  mkdir -p "${QA_ROOT}/codex-home"
  chmod 700 "${QA_ROOT}/codex-home"
  (
    "${FLOCK_BIN}" -n 9 || die "the CI Codex auth lock is occupied"
    unset OPENAI_API_KEY AZURE_OPENAI_API_KEY CODEX_API_KEY
    CODEX_HOME="${QA_ROOT}/codex-home" "${QA_ROOT}/toolchain/node_modules/.bin/codex" login
    [[ -f "${QA_ROOT}/codex-home/auth.json" ]] && chmod 600 "${QA_ROOT}/codex-home/auth.json"
  ) 9>"${QA_ROOT}/auth.lock"
}

doctor() {
  QA_ROOT="${QA_ROOT}" QA_REPOSITORY="${REPOSITORY}" QA_DEVELOPER_CHECKOUT="${DEVELOPER_CHECKOUT}" \
    QA_GH_BIN="${GH_BIN}" QA_SYSTEMCTL_BIN="${SYSTEMCTL_BIN}" QA_LOGINCTL_BIN="${LOGINCTL_BIN}" QA_FLOCK_BIN="${FLOCK_BIN}" \
    node "${SCRIPT_DIR}/doctor.cjs" "$@"
}

start_runner() {
  doctor --json --phase start >/dev/null || die "runner prerequisites are not ready; run status"
  "${SYSTEMCTL_BIN}" --user daemon-reload
  "${SYSTEMCTL_BIN}" --user enable --now "${SERVICE_NAME}"
  printf 'Started %s.\n' "${SERVICE_NAME}"
}

main() {
  case "${1:-}" in
    install) [[ "$#" == 1 ]] || die "install takes no arguments"; install_all ;;
    register) [[ "$#" == 1 ]] || die "register takes no arguments"; register_runner ;;
    login) [[ "$#" == 1 ]] || die "login takes no arguments"; login_codex ;;
    start) [[ "$#" == 1 ]] || die "start takes no arguments"; start_runner ;;
    status) [[ "$#" == 1 ]] || die "status takes no arguments"; doctor --json ;;
    --help|-h|help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
