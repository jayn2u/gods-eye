'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { validateEvidenceFile } = require('./evidence-contracts.cjs');
const scenarioContract = require('./scenarios.json');

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_ACTIONS = 500;
const MODEL_IDS = Object.freeze({
  b32: 'openai/clip-vit-base-patch32',
  b16: 'openai/clip-vit-base-patch16',
  l14: 'openai/clip-vit-large-patch14',
  l14336: 'openai/clip-vit-large-patch14-336',
});
const SCENARIO_IDS = Object.freeze(scenarioContract.scenarios.map(({ id }) => id));
const scenariosById = new Map(scenarioContract.scenarios.map((scenario) => [scenario.id, scenario]));

class JournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
  }
}

// The journal is written by trusted Node code inside the Playwright MCP server process, so an
// action is proof that the page observed it. The public vocabulary stays the browser-tool vocabulary
// the report schema and `hasCompleteBrowserProof` already speak.
const ACTION_TOOL = Object.freeze({
  type: 'browser_type',
  select: 'browser_select_option',
  click: 'browser_click',
  key: 'browser_press_key',
});

function readJournal(file) {
  const stats = fs.statSync(file, { throwIfNoEntry: false });
  if (!stats || !stats.isFile() || stats.size < 1 || stats.size > MAX_JOURNAL_BYTES) {
    throw new JournalError('INVALID_JOURNAL', 'browser journal is missing or oversized');
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  if (lines.length > MAX_ENTRIES) throw new JournalError('INVALID_JOURNAL', 'browser journal has too many entries');
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new JournalError('INVALID_JOURNAL', 'browser journal contains invalid JSONL');
    }
  });
}

function targetName(target) {
  if (!target || typeof target !== 'object') return '';
  return `${target.ariaLabel ?? ''} ${target.text ?? ''} ${target.id ?? ''}`;
}

function requirement(label, matches) {
  return { label, matches };
}

function typeInto(value) {
  return requirement(`enter ${JSON.stringify(value)} in the description`, (entry) => entry.action === 'type'
    && entry.target?.id === 'query'
    && entry.value === value);
}

function selectModel(value) {
  return requirement(`select ${value}`, (entry) => entry.action === 'select'
    && entry.target?.id === 'model-id'
    && entry.value === value);
}

function clickNamed(label, pattern) {
  return requirement(label, (entry) => entry.action === 'click' && pattern.test(targetName(entry.target)));
}

function scenarioActionRequirements(scenario) {
  switch (scenario.id) {
    case 'search-detail-return': return [
      typeInto(scenario.description),
      clickNamed('activate Search gallery', /search gallery/iu),
      clickNamed('open a result', /open result/iu),
      clickNamed('activate Back to results', /back to results/iu),
    ];
    case 'model-provenance': return [
      selectModel(MODEL_IDS.l14),
      typeInto(scenario.description),
      clickNamed('activate Search gallery', /search gallery/iu),
      clickNamed('open a result', /open result/iu),
    ];
    case 'cancel-replace': return [
      selectModel(MODEL_IDS.l14),
      typeInto(scenario.description),
      clickNamed('activate Search gallery', /search gallery/iu),
      clickNamed('activate Cancel search', /cancel search/iu),
      selectModel(MODEL_IDS.b16),
      typeInto(scenario.replacement_description),
      clickNamed('activate Search gallery for the replacement', /search gallery/iu),
    ];
    case 'unprepared-model': return [selectModel(MODEL_IDS.b32)];
    case 'recover-409': return [
      selectModel(MODEL_IDS.l14336),
      typeInto(scenario.description),
      clickNamed('activate Search gallery for the deliberate 409', /search gallery/iu),
      typeInto(scenario.replacement_description),
      clickNamed('activate Retry search', /retry search/iu),
    ];
    case 'blank-input': return [
      clickNamed('activate Search gallery with the empty description', /search gallery/iu),
    ];
    default: throw new JournalError('INVALID_SCENARIO', `No action requirements for ${scenario.id}`);
  }
}

function isMainOrigin(url, origin) {
  try {
    const target = new URL(url);
    return target.origin === origin && target.pathname === '/' && !target.search && !target.hash;
  } catch {
    return false;
  }
}

function screenshotProof(screenshotsRoot, scenarioId, receiptAt) {
  const relative = `screenshots/${scenarioId}.png`;
  const absolute = path.join(screenshotsRoot, `${scenarioId}.png`);
  const stats = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stats || !stats.isFile()) return null;
  // The screenshot must have been taken after the trusted receipt observed the expected page state.
  if (!Number.isFinite(receiptAt) || stats.mtimeMs + 1000 < receiptAt) return null;
  try {
    validateEvidenceFile(path.dirname(screenshotsRoot), relative, { allowedExtensions: ['.png'] });
  } catch {
    return null;
  }
  return relative;
}

/**
 * Turn a trusted browser journal into the same proof shape the report pipeline consumes.
 * No field of the returned value comes from the agent's own narration.
 */
function parseBrowserJournal(entries, { origin, screenshotsRoot }) {
  const proof = new Map(SCENARIO_IDS.map((id) => [id, {
    navigate: false, nextAction: 0, receipt: false, receiptAt: NaN, screenshot: null,
  }]));
  const toolCalls = [];
  let scenarioIndex = -1;
  let current = null;
  let invalid = false;
  let errorText = '';
  let lastSeq = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.seq) || entry.seq <= lastSeq) {
      invalid = true;
      continue;
    }
    lastSeq = entry.seq;

    if (entry.kind === 'harness_error') {
      errorText += ` ${typeof entry.message === 'string' ? entry.message : ''}`;
      invalid = true;
      continue;
    }

    if (entry.kind === 'profile') {
      const next = scenarioContract.scenarios[scenarioIndex + 1];
      if (!next || entry.profile !== next.profile) {
        invalid = true;
        continue;
      }
      scenarioIndex += 1;
      current = next.id;
      continue;
    }

    if (current === null) {
      // Nothing observable may happen before the first trusted profile selection.
      invalid = true;
      continue;
    }

    const scenario = scenariosById.get(current);
    const scenarioProof = proof.get(current);

    if (entry.kind === 'navigate') {
      if (!isMainOrigin(entry.url, origin)) {
        invalid = true;
        continue;
      }
      scenarioProof.navigate = true;
      toolCalls.push({ scenario_id: current, tool: 'browser_navigate', status: 'completed' });
      continue;
    }

    if (entry.kind === 'action') {
      const tool = ACTION_TOOL[entry.action];
      if (!tool) {
        invalid = true;
        continue;
      }
      if (scenarioProof.navigate && !scenarioProof.receipt) {
        const next = scenarioActionRequirements(scenario)[scenarioProof.nextAction];
        if (next?.matches(entry)) scenarioProof.nextAction += 1;
      }
      toolCalls.push({ scenario_id: current, tool, status: 'completed' });
      continue;
    }

    if (entry.kind === 'receipt') {
      const requirements = scenarioActionRequirements(scenario);
      const at = Date.parse(entry.at);
      if (entry.scenario !== current
        || entry.token !== `qa-receipt:${current}`
        || entry.satisfied !== true
        || !Number.isFinite(at)
        || scenarioProof.nextAction !== requirements.length) {
        invalid = true;
        continue;
      }
      scenarioProof.receipt = true;
      scenarioProof.receiptAt = at;
      continue;
    }

    invalid = true;
  }

  if (scenarioIndex !== SCENARIO_IDS.length - 1) invalid = true;
  if (toolCalls.length > MAX_ACTIONS) invalid = true;

  for (const scenario of scenarioContract.scenarios) {
    const scenarioProof = proof.get(scenario.id);
    if (!scenarioProof.receipt) continue;
    const relative = screenshotProof(screenshotsRoot, scenario.id, scenarioProof.receiptAt);
    if (!relative) continue;
    scenarioProof.screenshot = relative;
    toolCalls.push({
      scenario_id: scenario.id, tool: 'browser_take_screenshot', status: 'completed', evidence: relative,
    });
  }

  const complete = !invalid && scenarioContract.scenarios.every((scenario) => {
    const item = proof.get(scenario.id);
    return item.navigate
      && item.nextAction === scenarioActionRequirements(scenario).length
      && item.receipt
      && item.screenshot;
  });
  return { complete, errorText: errorText.trim(), proof, toolCalls: toolCalls.slice(0, MAX_ACTIONS) };
}

module.exports = Object.freeze({
  ACTION_TOOL,
  JournalError,
  MODEL_IDS,
  SCENARIO_IDS,
  parseBrowserJournal,
  readJournal,
  scenarioActionRequirements,
});
