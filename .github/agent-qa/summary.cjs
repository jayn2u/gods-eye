'use strict';

/**
 * Shared, trusted rendering of a validated report into Markdown.
 *
 * Two surfaces consume this: the pull-request comment the reporter maintains, and the job summary
 * the QA job writes. Both render the same validated `report.json` and never touch raw agent output,
 * so what a reviewer reads in the comment and what they read in the run page cannot disagree.
 *
 * Every value that reaches Markdown passes through `escapeMarkdown` first. Scenario text is written
 * by the agent, which reads untrusted candidate bytes, so it is data to be displayed and never
 * markup, a link, or a mention.
 */

const STATUS_LABEL = Object.freeze({
  observed: '✅ observed',
  finding: '⚠️ finding',
  incomplete: '⛔ not proven',
});

const SEVERITY_ORDER = Object.freeze(['high', 'medium', 'low']);

function redactSecrets(value) {
  const text = typeof value === 'string' ? value : '';
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b/gu, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, 'Bearer [redacted]');
}

function escapeMarkdown(value, maxLength = 1000) {
  return redactSecrets(value)
    .slice(0, maxLength)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;')
    .replace(/([\\`*_{}\[\]()#!|])/gu, '\\$1')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

/**
 * Text for a backtick code span. Markdown escapes are not processed inside a span, so escaping
 * there would print the backslashes; what matters instead is that nothing can close the span or
 * break the line.
 */
function code(value, maxLength = 200) {
  return redactSecrets(value)
    .slice(0, maxLength)
    .replace(/[`\\]/gu, '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim() || '—';
}

/** Text inside a literal HTML element, where `<` and `&` must be entities and markdown does not run. */
function escapeHtml(value, maxLength = 200) {
  return redactSecrets(value)
    .slice(0, maxLength)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim() || '&#8212;';
}

/** A newline inside a table cell breaks the row, so cell text is collapsed to one line. */
function cell(value, maxLength = 200) {
  return escapeMarkdown(value, maxLength).replace(/\s*[\r\n]+\s*/gu, ' ').trim() || '—';
}

function countCalls(report) {
  const counts = new Map();
  for (const call of Array.isArray(report?.tool_calls) ? report.tool_calls : []) {
    const key = call?.scenario_id;
    if (typeof key !== 'string') continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * One row per scenario, with the counts taken from the trusted browser journal rather than from the
 * agent's narration: `status` is the agent's claim, `calls` is what the harness observed, and
 * `proven` is whether the scenario earned a screenshot the harness accepted.
 */
function scenarioRows(report) {
  const scenarios = Array.isArray(report?.scenarios) ? report.scenarios : [];
  const counts = countCalls(report);
  return scenarios.map((scenario) => ({
    id: typeof scenario?.id === 'string' ? scenario.id : '',
    status: STATUS_LABEL[scenario?.status] ?? String(scenario?.status ?? ''),
    calls: counts.get(scenario?.id) ?? 0,
    proven: Array.isArray(scenario?.evidence) && scenario.evidence.length > 0,
    expected: scenario?.expected,
    actual: scenario?.actual,
    steps: Array.isArray(scenario?.steps) ? scenario.steps : [],
    evidence: Array.isArray(scenario?.evidence) ? scenario.evidence : [],
  }));
}

/** Compact scenario table for the pull-request comment. Returns null when there is nothing to show. */
function renderScenarioTable(report) {
  const rows = scenarioRows(report);
  if (rows.length === 0) return null;
  return [
    '| Scenario | Result | Browser calls | Proof |',
    '| --- | --- | ---: | --- |',
    ...rows.map((row) => `| \`${code(row.id, 80)}\` | ${row.status} | ${row.calls} | ${
      row.proven ? 'screenshot' : '—'} |`),
  ].join('\n');
}

function renderToolLine(report) {
  const tools = report?.tools;
  if (!tools || typeof tools !== 'object') return null;
  const agent = tools.agent && typeof tools.agent === 'object' ? tools.agent : {};
  const parts = [
    `${cell(agent.name, 40)} ${cell(agent.version, 40)}`,
    agent.model ? `model \`${code(agent.model, 80)}\`` : null,
    `chromium ${cell(tools.chromium, 40)}`,
    `node ${cell(tools.node, 40)}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function renderPhaseLine(report) {
  const phases = Array.isArray(report?.phases) ? report.phases : [];
  if (phases.length === 0) return null;
  return phases
    .map((phase) => `${cell(phase?.name, 30)} ${Number.isFinite(phase?.seconds) ? phase.seconds : 0}s`)
    .join(' · ');
}

function renderBaselineLine(report) {
  const results = Array.isArray(report?.deterministic_results) ? report.deterministic_results : [];
  if (results.length === 0) return null;
  return results
    .map((entry) => `${cell(entry?.name, 60)}: **${cell(entry?.status, 20)}** (${
      Number.isFinite(entry?.duration_ms) ? entry.duration_ms : 0}ms)`)
    .join(' · ');
}

function sortedFindings(report) {
  const findings = Array.isArray(report?.findings) ? [...report.findings] : [];
  return findings.sort((left, right) => SEVERITY_ORDER.indexOf(left?.severity) - SEVERITY_ORDER.indexOf(right?.severity));
}

/**
 * The full job summary. It is written on the run page, where there is room for the per-scenario
 * detail that would not fit in a comment, and it is the surface an operator lands on from the
 * comment's run link.
 */
function renderJobSummary({ report, runUrl = null, artifactUrl = null }) {
  const lines = ['# Agent QA (advisory)', ''];
  lines.push(`**Status:** \`${code(report?.status, 40)}\` · **Reason:** \`${code(report?.reason, 60)}\``);
  lines.push(`**Tested head:** \`${code(report?.tested_head_sha, 40)}\``);
  const tools = renderToolLine(report);
  if (tools) lines.push(`**Tools:** ${tools}`);
  const phases = renderPhaseLine(report);
  if (phases) lines.push(`**Phases:** ${phases}`);
  const baseline = renderBaselineLine(report);
  if (baseline) lines.push(`**Deterministic baseline:** ${baseline}`);
  if (runUrl) lines.push(`**Run:** ${runUrl}`);
  if (artifactUrl) lines.push(`**Evidence artifact:** ${artifactUrl}`);
  lines.push('');

  const table = renderScenarioTable(report);
  if (table) lines.push('## Scenarios', '', table, '');

  const findings = sortedFindings(report);
  lines.push('## Findings', '');
  if (findings.length === 0) {
    lines.push('None. Every proven scenario behaved as expected.', '');
  } else {
    for (const finding of findings.slice(0, 20)) {
      lines.push(`- **${cell(finding?.severity, 20)} — ${cell(finding?.title, 200)}** (\`${
        code(finding?.scenario_id, 80)}\`)`);
      lines.push(`  ${escapeMarkdown(finding?.description, 800).replace(/\s*[\r\n]+\s*/gu, ' ')}`);
    }
    lines.push('');
  }

  lines.push('## What the agent did', '');
  for (const row of scenarioRows(report)) {
    lines.push(`<details><summary>${row.status} — <code>${escapeHtml(row.id, 80)}</code></summary>`, '');
    lines.push(`**Expected:** ${escapeMarkdown(row.expected, 1000)}`, '');
    lines.push(`**Actual:** ${escapeMarkdown(row.actual, 1000)}`, '');
    if (row.steps.length > 0) {
      lines.push('**Observed steps (agent narration):**', '');
      for (const step of row.steps.slice(0, 20)) lines.push(`1. ${escapeMarkdown(step, 400)}`);
      lines.push('');
    }
    lines.push(`**Journal-observed browser calls:** ${row.calls}`, '');
    lines.push(`**Accepted evidence:** ${row.evidence.length > 0
      ? row.evidence.map((item) => `\`${code(item, 240)}\``).join(', ')
      : 'none — this scenario was not proven'}`, '');
    lines.push('</details>', '');
  }

  const cleanup = report?.cleanup;
  if (cleanup && typeof cleanup === 'object') {
    lines.push(`_Cleanup: ${cleanup.processes_stopped ?? 0} process(es) stopped; private output deleted: ${
      cleanup.private_output_deleted === true}._`);
  }
  lines.push('', '_Agent QA is advisory fixture-backed research-demo QA. It does not establish identity'
    + ' or real-gallery retrieval quality._');
  return lines.join('\n');
}

module.exports = Object.freeze({
  STATUS_LABEL,
  escapeHtml,
  escapeMarkdown,
  renderJobSummary,
  renderScenarioTable,
  scenarioRows,
});
