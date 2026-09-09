'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SCENARIO_IDS, parseBrowserJournal, scenarioActionRequirements } = require('../journal.cjs');
const { extractAgentResult, copilotArguments, mcpConfig, DENIED_TOOLS } = require('../agents/copilot.cjs');
const scenarioContract = require('../scenarios.json');

const ORIGIN = 'http://127.0.0.1:41111';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function scenario(id) {
  return scenarioContract.scenarios.find((item) => item.id === id);
}

/** Build the journal a faithful run would produce, then let each test corrupt one thing. */
function faithfulJournal({ at = Date.UTC(2026, 8, 9, 12, 0, 0) } = {}) {
  const entries = [];
  let seq = 0;
  let clock = at;
  const push = (kind, payload) => {
    seq += 1;
    clock += 1000;
    entries.push({ seq, at: new Date(clock).toISOString(), kind, ...payload });
  };
  for (const item of scenarioContract.scenarios) {
    push('profile', { scenario: item.id, profile: item.profile, url: `${ORIGIN}/` });
    push('navigate', { url: `${ORIGIN}/` });
    for (const requirement of scenarioActionRequirements(item)) {
      push('action', observableFor(item, requirement.label));
    }
    push('receipt', { scenario: item.id, token: `qa-receipt:${item.id}`, satisfied: true, state: {} });
  }
  return entries;
}

function observableFor(item, label) {
  if (label.startsWith('enter ')) {
    const value = label.includes('replacement') || /replacement/u.test(label)
      ? item.replacement_description
      : JSON.parse(label.slice('enter '.length, label.lastIndexOf(' in the description')));
    return { action: 'type', target: { tag: 'TEXTAREA', id: 'query', type: '', ariaLabel: '', text: '' }, value };
  }
  if (label.startsWith('select ')) {
    return {
      action: 'select',
      target: { tag: 'SELECT', id: 'model-id', type: '', ariaLabel: '', text: '' },
      value: label.slice('select '.length),
    };
  }
  const name = /back to results/iu.test(label) ? 'Back to results'
    : /cancel search/iu.test(label) ? 'Cancel search'
      : /retry search/iu.test(label) ? 'Retry search'
        : /open a result/iu.test(label) ? 'Open result 1 from CUHK-PEDES'
          : 'Search gallery →';
  return { action: 'click', target: { tag: 'BUTTON', id: '', type: 'button', ariaLabel: name, text: name }, value: '' };
}

function withScreenshots(entries, { skip = [], staleBefore = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gods-eye-journal-'));
  const screenshots = path.join(root, 'screenshots');
  fs.mkdirSync(screenshots, { recursive: true });
  for (const id of SCENARIO_IDS) {
    if (skip.includes(id)) continue;
    const file = path.join(screenshots, `${id}.png`);
    fs.writeFileSync(file, PNG);
    const receipt = entries.find((entry) => entry.kind === 'receipt' && entry.scenario === id);
    const receiptAt = receipt ? Date.parse(receipt.at) : Date.now();
    // A faithful screenshot is written after its receipt; a stale one predates it.
    const mtime = staleBefore.includes(id) ? receiptAt - 60_000 : receiptAt + 1_000;
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
  }
  return { root, screenshots };
}

test('a faithful journal proves every scenario', () => {
  const entries = faithfulJournal();
  const { screenshots } = withScreenshots(entries);
  const parsed = parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots });
  assert.equal(parsed.complete, true);
  for (const id of SCENARIO_IDS) {
    const item = parsed.proof.get(id);
    assert.equal(item.receipt, true, id);
    assert.equal(item.screenshot, `screenshots/${id}.png`, id);
    assert.equal(item.nextAction, scenarioActionRequirements(scenario(id)).length, id);
  }
  const tools = new Set(parsed.toolCalls.map(({ tool }) => tool));
  assert.ok(tools.has('browser_navigate') && tools.has('browser_take_screenshot'));
});

test('narration cannot substitute for an observed action', async (t) => {
  const cases = [
    ['a missing ordered action', (entries) => {
      const index = entries.findIndex((entry) => entry.kind === 'action');
      entries.splice(index, 1);
    }],
    // The marker now carries the page it was issued from, so "before the navigate entry" no longer
    // means anything. The invariant that survives is that actions need established origin proof.
    ['an action with no origin proof at all', (entries) => {
      delete entries.find((entry) => entry.kind === 'profile').url;
      entries.splice(entries.findIndex((entry) => entry.kind === 'navigate'), 1);
      let seq = 0;
      for (const entry of entries) { seq += 1; entry.seq = seq; }
    }],
    ['a typed value that is not the supplied description', (entries) => {
      const typed = entries.find((entry) => entry.action === 'type');
      typed.value = 'A person wearing something else';
    }],
    ['a model selection the scenario did not ask for', (entries) => {
      const selected = entries.find((entry) => entry.action === 'select');
      selected.value = 'openai/clip-vit-base-patch16';
    }],
    ['a receipt the harness did not satisfy', (entries) => {
      entries.find((entry) => entry.kind === 'receipt').satisfied = false;
    }],
    ['a receipt token for another scenario', (entries) => {
      entries.find((entry) => entry.kind === 'receipt').token = 'qa-receipt:blank-input';
    }],
    ['a receipt claimed before the ordered actions', (entries) => {
      const receipt = entries.findIndex((entry) => entry.kind === 'receipt');
      const action = entries.findIndex((entry) => entry.kind === 'action');
      const moved = entries.splice(receipt, 1)[0];
      entries.splice(action, 0, moved);
      let seq = 0;
      for (const entry of entries) { seq += 1; entry.seq = seq; }
    }],
    ['a scenario executed out of declared order', (entries) => {
      const profiles = entries.filter((entry) => entry.kind === 'profile');
      profiles[0].profile = 'recover-409';
    }],
    ['navigation to a foreign origin', (entries) => {
      entries.find((entry) => entry.kind === 'navigate').url = 'http://127.0.0.1:9/';
    }],
    ['a replayed sequence number', (entries) => {
      entries[3].seq = entries[2].seq;
    }],
    ['an unknown journal entry kind', (entries) => {
      entries.splice(3, 0, { seq: 2.5, at: entries[3].at, kind: 'agent_says_it_clicked' });
      let seq = 0;
      for (const entry of entries) { seq += 1; entry.seq = seq; }
    }],
    ['a harness error', (entries) => {
      entries.splice(1, 0, { seq: 1.5, at: entries[1].at, kind: 'harness_error', message: 'receipt requested for an unknown scenario' });
      let seq = 0;
      for (const entry of entries) { seq += 1; entry.seq = seq; }
    }],
  ];
  for (const [name, corrupt] of cases) {
    await t.test(name, () => {
      const entries = faithfulJournal();
      corrupt(entries);
      const { screenshots } = withScreenshots(entries);
      const parsed = parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots });
      assert.equal(parsed.complete, false, name);
    });
  }
});

test('a retry restarts a scenario instead of being read as the next one', () => {
  const entries = faithfulJournal();
  // Three scenarios share the `normal` profile, so this is the case a profile-named marker could
  // not distinguish: repeating the first scenario used to shift every later scenario's evidence.
  const first = entries.findIndex((entry) => entry.kind === 'profile');
  const secondProfile = entries.findIndex((entry, index) => index > first && entry.kind === 'profile');
  const repeated = { ...entries[first] };
  entries.splice(secondProfile, 0, repeated);
  const replay = entries.slice(first, secondProfile).filter((entry) => entry.kind !== 'profile');
  entries.splice(secondProfile + 1, 0, ...replay.map((entry) => ({ ...entry })));
  let seq = 0;
  for (const entry of entries) { seq += 1; entry.seq = seq; }

  const { screenshots } = withScreenshots(entries);
  const parsed = parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots });
  assert.equal(parsed.complete, true, 'a completed retry still proves every scenario');
  assert.equal(parsed.proof.get('model-provenance').receipt, true, 'later scenarios keep their own evidence');
});

test('a retry that does not repeat the actions loses that scenario', () => {
  const entries = faithfulJournal();
  const secondProfile = entries.findIndex((entry, index) =>
    index > entries.findIndex((item) => item.kind === 'profile') && entry.kind === 'profile');
  entries.splice(secondProfile, 0, { ...entries[0] });
  let seq = 0;
  for (const entry of entries) { seq += 1; entry.seq = seq; }
  const { screenshots } = withScreenshots(entries);
  const parsed = parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots });
  assert.equal(parsed.complete, false);
  assert.equal(parsed.proof.get('search-detail-return').receipt, false);
});

test('a marker naming a scenario out of declared order is refused', () => {
  const entries = faithfulJournal();
  entries.find((entry) => entry.kind === 'profile').scenario = 'blank-input';
  const { screenshots } = withScreenshots(entries);
  assert.equal(parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots }).complete, false);
});

test('loading the application before the first scenario is selected is not fatal', () => {
  const entries = faithfulJournal();
  // The agent naturally opens the application before it selects the first scenario. That visit used
  // to invalidate the whole run and leave the first scenario without origin proof.
  entries.splice(0, 0, { seq: 0.5, at: entries[0].at, kind: 'navigate', url: `${ORIGIN}/` });
  const firstNavigate = entries.findIndex((entry, index) => index > 1 && entry.kind === 'navigate');
  entries.splice(firstNavigate, 1);
  let seq = 0;
  for (const entry of entries) { seq += 1; entry.seq = seq; }
  const { screenshots } = withScreenshots(entries);
  const parsed = parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots });
  assert.equal(parsed.complete, true, 'the marker page counts as that scenario origin proof');
  assert.equal(parsed.proof.get('search-detail-return').navigate, true);
});

test('a marker issued from a foreign origin proves nothing', () => {
  const entries = faithfulJournal();
  const first = entries.find((entry) => entry.kind === 'profile');
  first.url = 'http://example.test/';
  const firstNavigate = entries.findIndex((entry) => entry.kind === 'navigate');
  entries.splice(firstNavigate, 1);
  let seq = 0;
  for (const entry of entries) { seq += 1; entry.seq = seq; }
  const { screenshots } = withScreenshots(entries);
  const parsed = parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots });
  assert.equal(parsed.complete, false);
  assert.equal(parsed.proof.get('search-detail-return').navigate, false);
});

test('an action before any scenario is selected still invalidates the run', () => {
  const entries = faithfulJournal();
  entries.splice(0, 0, {
    seq: 0.5, at: entries[0].at, kind: 'action', action: 'click',
    target: { tag: 'BUTTON', id: '', type: 'button', ariaLabel: 'Search gallery', text: 'Search gallery' }, value: '',
  });
  let seq = 0;
  for (const entry of entries) { seq += 1; entry.seq = seq; }
  const { screenshots } = withScreenshots(entries);
  assert.equal(parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots }).complete, false);
});

test('a screenshot must exist and postdate its receipt', async (t) => {
  await t.test('missing screenshot', () => {
    const entries = faithfulJournal();
    const { screenshots } = withScreenshots(entries, { skip: ['blank-input'] });
    const parsed = parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots });
    assert.equal(parsed.complete, false);
    assert.equal(parsed.proof.get('blank-input').screenshot, null);
  });
  await t.test('screenshot taken before the receipt', () => {
    const entries = faithfulJournal();
    const { screenshots } = withScreenshots(entries, { staleBefore: ['recover-409'] });
    const parsed = parseBrowserJournal(entries, { origin: ORIGIN, screenshotsRoot: screenshots });
    assert.equal(parsed.complete, false);
    assert.equal(parsed.proof.get('recover-409').screenshot, null);
  });
});

test('receipt predicates are contract text, never agent input', () => {
  for (const item of scenarioContract.scenarios) {
    assert.equal(typeof item.receipt, 'string');
    assert.match(item.receipt, /^\(s\) => /u);
    assert.ok(item.receipt.includes(`s.profile === "${item.profile}"`), item.id);
  }
  assert.equal(scenarioContract.evidence.channel, 'trusted-browser-journal');
});

test('copilot invocation grants only the declared browser tools', () => {
  const { args } = copilotArguments({ copilotBin: '/toolchain/.bin/copilot', prompt: 'do the scenarios', model: 'gpt-5.4' });
  assert.deepEqual(args.slice(0, 4), ['-p', 'do the scenarios', '-s', '--no-ask-user']);
  for (const tool of scenarioContract.browser.allowed_tools) {
    assert.ok(args.includes(`--allow-tool=playwright(${tool})`), tool);
  }
  for (const denied of DENIED_TOOLS) {
    assert.ok(args.includes(`--deny-tool=${denied}`), denied);
  }
  assert.ok(args.includes('--model=gpt-5.4'));
  assert.equal(args.some((value) => /--allow-all/u.test(value)), false);
  assert.equal(args.some((value) => /--yolo/u.test(value)), false);
});

test('the MCP config pins the loopback origin, the journal, and the tool list', () => {
  const config = mcpConfig({
    mcpBin: '/toolchain/.bin/playwright-mcp',
    origin: ORIGIN,
    screenshotsRoot: '/evidence/screenshots',
    initPage: '/control/browser-init.ts',
    journal: '/private/browser-journal.jsonl',
  });
  const server = config.mcpServers.playwright;
  assert.equal(server.type, 'local');
  assert.deepEqual(server.env, { QA_BROWSER_JOURNAL: '/private/browser-journal.jsonl' });
  assert.ok(server.args.includes('--headless') && server.args.includes('--isolated'));
  assert.equal(server.args[server.args.indexOf('--allowed-origins') + 1], ORIGIN);
  assert.equal(server.args[server.args.indexOf('--init-page') + 1], '/control/browser-init.ts');
  // Copilot silently discards a server whose tools field is a string, and the agent then reports
  // that it had no browser tools at all. The CLI's own writer emits an array.
  assert.ok(Array.isArray(server.tools), 'tools must be an array, not a comma-separated string');
  assert.deepEqual(server.tools, scenarioContract.browser.allowed_tools);
  assert.equal(JSON.parse(JSON.stringify(config)).mcpServers.playwright.tools.length, 14);
});

test('a config Copilot will not load fails the run before it starts', () => {
  const { assertMcpServerLoaded, CopilotError } = require('../agents/copilot.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gods-eye-mcp-'));
  const listed = path.join(home, 'fake-copilot-listed');
  const empty = path.join(home, 'fake-copilot-empty');
  fs.writeFileSync(listed, '#!/usr/bin/env bash\necho "User servers:"\necho "  playwright (local)"\n', { mode: 0o700 });
  fs.writeFileSync(empty, '#!/usr/bin/env bash\necho "No MCP servers configured."\n', { mode: 0o700 });

  assert.doesNotThrow(() => assertMcpServerLoaded({ copilotBin: listed, home, env: {} }));
  assert.throws(
    () => assertMcpServerLoaded({ copilotBin: empty, home, env: {} }),
    (error) => error instanceof CopilotError
      && error.code === 'MCP_UNAVAILABLE'
      && /browser tools are unavailable/u.test(error.message),
  );
  assert.throws(() => assertMcpServerLoaded({ copilotBin: path.join(home, 'absent'), home, env: {} }), CopilotError);
});

test('the final document is extracted from stdout without granting a write tool', () => {
  const document = { summary: 'ok', scenarios: [], findings: [] };
  assert.deepEqual(extractAgentResult(JSON.stringify(document)), document);
  assert.deepEqual(extractAgentResult(`\`\`\`json\n${JSON.stringify(document)}\n\`\`\``), document);
  assert.deepEqual(extractAgentResult(`Here is the report:\n${JSON.stringify(document)}`), document);
  for (const rejected of ['', 'no json here', '[1,2,3]', '{ broken', 'x'.repeat(300 * 1024)]) {
    assert.equal(extractAgentResult(rejected), null, JSON.stringify(rejected.slice(0, 20)));
  }
});
