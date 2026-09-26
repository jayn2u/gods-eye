'use strict';

const scenarioContract = require('../scenarios.json');

const MAX_RESULT_BYTES = 256 * 1024;
const MCP_SERVER = 'playwright';
const TOOL_NAMES = Object.freeze([...scenarioContract.browser.allowed_tools]);

function browserToolNames() {
  return [...TOOL_NAMES];
}

function playwrightServer({ mcpBin, origin, screenshotsRoot, initPage, journal, browsers }) {
  return {
    command: mcpBin,
    args: [
      '--browser', 'chromium', '--headless', '--isolated', '--block-service-workers',
      '--codegen', 'none', '--viewport-size', '1440x1000',
      '--allowed-origins', origin,
      '--output-dir', screenshotsRoot,
      '--init-page', initPage,
    ],
    env: { QA_BROWSER_JOURNAL: journal, PLAYWRIGHT_BROWSERS_PATH: browsers },
  };
}

function stripFence(text) {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/u.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

function extractAgentResult(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0 || stdout.length > MAX_RESULT_BYTES) return null;
  const candidate = stripFence(stdout);
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(candidate.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

module.exports = Object.freeze({
  MCP_SERVER,
  browserToolNames,
  extractAgentResult,
  playwrightServer,
  stripFence,
});
