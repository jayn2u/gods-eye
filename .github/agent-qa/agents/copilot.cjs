'use strict';

const { spawnSync } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
  MCP_SERVER, browserToolNames, extractAgentResult, playwrightServer, stripFence,
} = require('./mcp.cjs');

const ALLOWED_TOOLS = Object.freeze(browserToolNames());
// Copilot CLI resolves tool permissions as `server(tool)` and has no strict-config flag, so every
// other capability is denied by name and the config file is written into a run-scoped HOME.
const DENIED_TOOLS = Object.freeze(['shell', 'write', 'str_replace_editor', 'view', 'fetch']);

class CopilotError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CopilotError';
    this.code = code;
    this.details = details;
  }
}

function mcpConfig({ mcpBin, origin, screenshotsRoot, initPage, journal, browsers }) {
  const server = playwrightServer({ mcpBin, origin, screenshotsRoot, initPage, journal, browsers });
  return {
    mcpServers: {
      [MCP_SERVER]: {
        type: 'local',
        command: server.command,
        args: server.args,
        env: { QA_BROWSER_JOURNAL: server.env.QA_BROWSER_JOURNAL },
        // An array, not a comma-separated string: Copilot discards the whole server entry for a
        // string value, silently, and the agent then reports that no browser tools exist.
        tools: [...ALLOWED_TOOLS],
      },
    },
  };
}

/**
 * Copilot CLI reads MCP configuration from `$HOME/.copilot/mcp-config.json` and lets a project
 * `.mcp.json` or `.github/mcp.json` override it, with no flag to forbid that. The run therefore gets
 * its own HOME and an empty working directory that is not inside the candidate checkout, so no
 * candidate-supplied configuration is discoverable.
 */
async function prepareCopilotHome({ home, workDir, mcpBin, origin, screenshotsRoot, initPage, journal, browsers }) {
  const configDir = path.join(home, '.copilot');
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(configDir, 'mcp-config.json');
  await fsp.writeFile(journal, '', { mode: 0o600 });
  const config = mcpConfig({ mcpBin, origin, screenshotsRoot, initPage, journal, browsers });
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  for (const forbidden of ['.mcp.json', path.join('.github', 'mcp.json')]) {
    const stray = path.join(workDir, forbidden);
    if (await fsp.stat(stray).then(() => true, () => false)) {
      throw new CopilotError('UNTRUSTED_MCP_CONFIG', `Working directory carries ${forbidden}`);
    }
  }
  return { configPath, configDir };
}

/**
 * Copilot drops a malformed server entry without a warning, so the only symptom is an agent that
 * says it had no tools. Ask the CLI what it actually loaded before spending a run on it.
 */
function assertMcpServerLoaded({ copilotBin, home, env }) {
  const listed = spawnSync(copilotBin, ['mcp', 'list'], {
    env: { ...env, HOME: home }, encoding: 'utf8', timeout: 30_000,
  });
  const output = `${listed.stdout ?? ''}${listed.stderr ?? ''}`;
  if (listed.error || listed.status !== 0 || !new RegExp(`\\b${MCP_SERVER}\\b`, 'u').test(output)) {
    throw new CopilotError(
      'MCP_UNAVAILABLE',
      `Copilot did not load the ${MCP_SERVER} MCP server; browser tools are unavailable`,
    );
  }
}

function copilotArguments({ copilotBin, prompt, model }) {
  const args = ['-p', prompt, '-s', '--no-ask-user'];
  for (const tool of ALLOWED_TOOLS) args.push(`--allow-tool=${MCP_SERVER}(${tool})`);
  for (const tool of DENIED_TOOLS) args.push(`--deny-tool=${tool}`);
  if (model) args.push(`--model=${model}`);
  return { command: copilotBin, args };
}

async function runCopilot({ runtime, paths, prompt, environment, sanitizedChildEnvironment }) {
  const prepared = await prepareCopilotHome({
    home: paths.agentHome,
    workDir: paths.workDir,
    mcpBin: paths.mcpBin,
    origin: paths.origin,
    screenshotsRoot: paths.screenshotsRoot,
    initPage: paths.initPage,
    journal: paths.journal,
    browsers: paths.browsers,
  });
  const childEnvironment = sanitizedChildEnvironment(runtime.supervisor.runRoot, {
    HOME: paths.agentHome,
    XDG_CONFIG_HOME: path.join(paths.agentHome, '.config'),
    COPILOT_GITHUB_TOKEN: environment.copilotToken,
    PLAYWRIGHT_BROWSERS_PATH: paths.browsers,
    QA_BROWSER_JOURNAL: paths.journal,
  });
  assertMcpServerLoaded({ copilotBin: paths.copilotBin, home: paths.agentHome, env: childEnvironment });
  const invocation = copilotArguments({
    copilotBin: paths.copilotBin,
    prompt,
    model: paths.model,
  });
  let processError;
  try {
    // Invoked directly, with no lock wrapper. Copilot authenticates from an environment token, so
    // there is no shared credential file to serialize, and QA already runs one job at a time. The
    // wrapper only added a process layer between the supervisor and the agent, which is how an
    // orphaned agent group survived a timed-out run and then held that lock against every later run.
    await runtime.supervisor.runToDeadline(
      'copilot', invocation.command, invocation.args,
      {
        cwd: paths.workDir,
        env: childEnvironment,
      },
    );
  } catch (error) {
    processError = error;
  }
  const stdoutPath = path.join(runtime.supervisor.runRoot, 'logs', 'copilot.stdout.log');
  const stderrPath = path.join(runtime.supervisor.runRoot, 'logs', 'copilot.stderr.log');
  let agentResult = null;
  try {
    agentResult = extractAgentResult(await fsp.readFile(stdoutPath, 'utf8'));
  } catch { /* an unreadable transcript is an invalid result, not a product finding */ }
  if (agentResult) {
    await fsp.writeFile(paths.privateResult, `${JSON.stringify(agentResult)}\n`, { mode: 0o600 });
  }
  return {
    processError,
    journalPath: paths.journal,
    stdoutPath,
    stderrPath,
    configPath: prepared.configPath,
    privateResult: paths.privateResult,
  };
}

module.exports = Object.freeze({
  ALLOWED_TOOLS,
  CopilotError,
  DENIED_TOOLS,
  MCP_SERVER,
  assertMcpServerLoaded,
  copilotArguments,
  extractAgentResult,
  mcpConfig,
  prepareCopilotHome,
  runCopilot,
  stripFence,
});
