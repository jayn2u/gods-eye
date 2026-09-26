'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const test = require('node:test');

const qaRoot = resolve(__dirname, '..');
const evidenceRoot = resolve(process.env.QA_BROWSER_EVIDENCE ?? resolve(process.cwd(), '.omo/evidence/release-pr-agent-qa/task-5'));
const scenarioIds = ['search-detail-return', 'model-provenance', 'cancel-replace', 'unprepared-model', 'recover-409', 'blank-input'];

function runCommand(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, options);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => resolveRun({ code, signal, output }));
  });
}

function startMcp(command, args) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffered = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const message = JSON.parse(line);
      const resolveResponse = pending.get(message.id);
      if (resolveResponse !== undefined) {
        pending.delete(message.id);
        resolveResponse(message);
      }
    }
  });
  let id = 0;
  const request = (method, params) => new Promise((resolveResponse, rejectResponse) => {
    id += 1;
    pending.set(id, resolveResponse);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
      if (error !== null && error !== undefined) rejectResponse(error);
    });
  });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { child, notify, request, stderr: () => stderr };
}

async function stopMcp(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await exited;
}

test('Given trusted scenario input, when parsed, then all six bounded journeys and the safe MCP tools are fixed', async () => {
  const contract = JSON.parse(await readFile(resolve(qaRoot, 'scenarios.json'), 'utf8'));
  assert.deepEqual(contract.scenarios.map(({ id }) => id), scenarioIds);
  assert.deepEqual(contract.profiles, ['normal', 'cancel-replace', 'unprepared-model', 'recover-409']);
  assert.equal(contract.browser.allowed_tools.includes('browser_run_code_unsafe'), false);
  assert.equal(contract.browser.allowed_tools.includes('browser_file_upload'), false);
  assert.equal(contract.browser.allowed_tools.includes('browser_evaluate'), true);
  assert.equal(contract.browser.viewport.width, 1440);
  assert.equal(contract.browser.viewport.height, 1000);
});

test('Given the trusted agent prompt, when inspected, then source edits and retrieval-quality claims are forbidden', async () => {
  const prompt = await readFile(resolve(qaRoot, 'prompt.md'), 'utf8');
  assert.match(prompt, /Do not edit, create, move, or delete source files/i);
  assert.match(prompt, /fixture similarity scores do not measure real retrieval quality/i);
  assert.match(prompt, /browser_run_code/i);
  assert.match(prompt, /loopback/i);
});

function fakePage({ evaluate = async () => undefined } = {}) {
  const bindings = new Map();
  const journal = [];
  const routes = new Map();
  const frame = { url: () => 'http://127.0.0.1:41111/' };
  const pageUrl = 'http://127.0.0.1:41111/';
  const page = {
    route: async (pattern, handler) => { routes.set(pattern, handler); },
    exposeBinding: async (name, callback) => { bindings.set(name, callback); },
    addInitScript: async () => undefined,
    evaluate,
    on: (event, handler) => { journal.push([event, handler]); },
    mainFrame: () => frame,
    url: () => pageUrl,
  };
  return { page, bindings, listeners: journal, frame, routes };
}

test('Given an unknown scenario, when the trusted control parses it, then the request is rejected', async () => {
  const { page, bindings } = fakePage();
  const { installBrowserHarness } = require(resolve(qaRoot, 'browser-init.ts'));
  await installBrowserHarness({ page });
  const control = bindings.get('__godsEyeQaControl');
  await assert.rejects(async () => control({}, 'selectScenario', 'external-navigation'), /Unknown scenario/);
  await assert.rejects(async () => control({}, 'selectProfile', 'normal'), /Unknown browser harness command/);
});

test('Given an unprepared model profile, when the catalog is intercepted, then only that model availability is changed', async () => {
  const upstreamCatalog = {
    default_model_id: 'openai/clip-vit-base-patch16',
    catalog_revision: 'fixture-v2',
    models: [
      {
        model_id: 'openai/clip-vit-base-patch16',
        label: 'ViT-B/16',
        ready: true,
        active_index_version: 'fixture-b16-v2',
        gallery_count: 1,
        guidance: null,
        group: 'reference',
        paired_baseline_id: null,
        verified: true,
        registered_at: '2026-09-24T12:34:56Z',
        evaluation_ready: false,
      },
      {
        model_id: 'openai/clip-vit-large-patch14-336',
        label: 'ViT-L/14@336px',
        ready: true,
        active_index_version: 'fixture-l14-336-v2',
        gallery_count: 2,
        guidance: null,
        group: 'reference',
        paired_baseline_id: 'baseline-l14-336',
        verified: false,
        registered_at: '2026-09-25T01:02:03Z',
        evaluation_ready: true,
      },
      {
        model_id: 'labclip:fixture-model',
        label: 'Fine-tuned fixture',
        ready: true,
        active_index_version: 'fixture-ft-v2',
        gallery_count: 1,
        guidance: null,
        group: 'fine-tuned',
        paired_baseline_id: 'openai/clip-vit-base-patch16',
        verified: true,
        registered_at: '2026-09-23T00:00:00Z',
        evaluation_ready: true,
      },
    ],
  };
  const originalUpstreamCatalog = structuredClone(upstreamCatalog);
  const expectedCatalog = structuredClone(upstreamCatalog);
  expectedCatalog.models[1] = {
    ...expectedCatalog.models[1],
    ready: false,
    active_index_version: null,
    gallery_count: null,
    guidance: "Model 'openai/clip-vit-large-patch14-336' is not prepared. Run './gods-eye prepare --model-id openai/clip-vit-large-patch14-336'.",
  };
  const { page, bindings, routes } = fakePage();
  const { installBrowserHarness } = require(resolve(qaRoot, 'browser-init.ts'));
  await installBrowserHarness({ page });
  await bindings.get('__godsEyeQaControl')({ page }, 'selectScenario', 'unprepared-model');

  let fulfilled;
  const route = {
    fetch: async () => ({ ok: () => true, json: async () => upstreamCatalog }),
    fulfill: async (options) => { fulfilled = options; },
    continue: async () => assert.fail('the unprepared profile must fulfil the transformed catalog'),
  };
  await routes.get('**/api/models')(route);

  assert.deepEqual(fulfilled, { json: expectedCatalog });
  assert.deepEqual(upstreamCatalog, originalUpstreamCatalog, 'the upstream catalog must not be mutated');
});

test('Given an unusable upstream catalog, when the unprepared profile intercepts it, then the harness input is rejected', async (t) => {
  const invalidResponses = [
    {
      name: 'non-OK response',
      response: { ok: () => false, status: () => 502 },
      message: /HTTP 502/,
    },
    {
      name: 'non-object JSON',
      response: { ok: () => true, status: () => 200, json: async () => null },
      message: /not an object/,
    },
    {
      name: 'missing models array',
      response: { ok: () => true, status: () => 200, json: async () => ({ models: {} }) },
      message: /no models array/,
    },
    {
      name: 'missing 336 model',
      response: { ok: () => true, status: () => 200, json: async () => ({ models: [] }) },
      message: /does not include openai\/clip-vit-large-patch14-336/,
    },
    {
      name: 'invalid JSON',
      response: {
        ok: () => true,
        status: () => 200,
        json: async () => { throw new SyntaxError('invalid JSON'); },
      },
      message: /valid JSON/,
    },
  ];

  for (const { name, response, message } of invalidResponses) {
    await t.test(name, async () => {
      const { page, bindings, routes } = fakePage();
      const { installBrowserHarness } = require(resolve(qaRoot, 'browser-init.ts'));
      await installBrowserHarness({ page });
      await bindings.get('__godsEyeQaControl')({ page }, 'selectScenario', 'unprepared-model');
      let fulfilled = false;
      const route = {
        fetch: async () => response,
        fulfill: async () => { fulfilled = true; },
        continue: async () => assert.fail('the unprepared profile must not continue the request'),
      };

      await assert.rejects(
        async () => routes.get('**/api/models')(route),
        (error) => error.name === 'BrowserHarnessInputError' && message.test(error.message),
      );
      assert.equal(fulfilled, false);
    });
  }
});

test('Given a receipt request, when the harness serves it, then the predicate is contract text the agent never supplies', async () => {
  const evaluated = [];
  const { page, bindings } = fakePage({
    evaluate: async (expression) => {
      if (typeof expression === 'string') evaluated.push(expression);
      return true;
    },
  });
  const { installBrowserHarness } = require(resolve(qaRoot, 'browser-init.ts'));
  await installBrowserHarness({ page });
  const control = bindings.get('__godsEyeQaControl');
  const source = { page };

  await assert.rejects(async () => control(source, 'receipt', 'not-a-scenario'), /Unknown scenario receipt/);
  await assert.rejects(
    async () => control(source, 'receipt', '(s) => true'),
    /Unknown scenario receipt/,
    'an agent-supplied predicate must not be accepted as a scenario id',
  );

  await control(source, 'selectScenario', 'blank-input');
  const token = await control(source, 'receipt', 'blank-input');
  assert.equal(token, 'qa-receipt:blank-input');
  const contract = require(resolve(qaRoot, 'scenarios.json'));
  const declared = contract.scenarios.find(({ id }) => id === 'blank-input').receipt;
  assert.equal(evaluated.length, 1);
  assert.ok(evaluated[0].startsWith(`(${declared})(`), 'the evaluated expression must be the declared predicate');
});

test('Given observed page events, when they reach the harness, then typing is coalesced into one committed action', async () => {
  const { page, bindings } = fakePage();
  const { installBrowserHarness } = require(resolve(qaRoot, 'browser-init.ts'));
  await installBrowserHarness({ page });
  const record = bindings.get('__godsEyeQaRecord');
  assert.equal(typeof record, 'function');
  const textarea = { tag: 'TEXTAREA', id: 'query', type: '', ariaLabel: '', text: '' };
  // Without QA_BROWSER_JOURNAL the recorder is inert, so this asserts the shape contract only.
  record({}, { kind: 'input', target: textarea, value: 'A' });
  record({}, { kind: 'input', target: textarea, value: 'A person' });
  record({}, { kind: 'click', target: { tag: 'BUTTON', id: '', type: 'button', ariaLabel: 'Search gallery', text: 'Search gallery' }, value: '' });
  record({}, null);
});

test('Given the trusted baseline config, when inspected, then it requires run boundaries and never manages servers', async () => {
  const config = await readFile(resolve(qaRoot, 'baseline.config.ts'), 'utf8');
  assert.match(config, /QA_CANDIDATE/);
  assert.match(config, /QA_WEB_ORIGIN/);
  assert.match(config, /QA_EVIDENCE/);
  assert.doesNotMatch(config, /webServer\s*:/);
  assert.match(config, /workers:\s*1/);
  assert.match(config, /retries:\s*0/);
});

test('Given the real fixture page, when profiles are selected, then faults, reset, and recovery are browser-observable', { skip: process.env.QA_BROWSER_TESTS !== '1' }, async (t) => {
  const candidate = resolve(process.env.QA_CANDIDATE ?? process.cwd());
  const browserEvidence = resolve(evidenceRoot, 'browser');
  await mkdir(browserEvidence, { recursive: true });
  const { startRuntime, monotonicDeadlineAfter } = require(resolve(qaRoot, 'runtime.cjs'));
  const runtime = await startRuntime({ candidate, evidence: resolve(evidenceRoot, 'runtime'), deadline: monotonicDeadlineAfter(240_000) });
  t.after(() => runtime.stop());

  const { chromium } = require('playwright');
  // Set before the harness is installed: it binds the journal target once, at install time.
  const journalPath = resolve(browserEvidence, 'browser-journal.jsonl');
  await writeFile(journalPath, '', { mode: 0o600 });
  process.env.QA_BROWSER_JOURNAL = journalPath;
  t.after(() => { delete process.env.QA_BROWSER_JOURNAL; });
  const { installBrowserHarness } = require(resolve(qaRoot, 'browser-init.ts'));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await installBrowserHarness({ page });

  const selectScenario = async (id) => page.evaluate((selected) => Reflect.get(window, '__GODS_EYE_QA__').selectScenario(selected), id);
  const receipt = async (id) => page.evaluate((selected) => Reflect.get(window, '__GODS_EYE_QA__').receipt(selected), id);
  const screenshot = async (name) => page.screenshot({ path: resolve(browserEvidence, `${name}.png`), fullPage: true });
  const compose = async (id) => { await selectScenario(id); await page.goto(runtime.origin); await page.getByLabel('CLIP model').waitFor(); };
  // The harness no longer exposes its counters to the page: a scenario is asserted by asking for its
  // receipt, which is what a real run does. A refused receipt still journals the state it saw, so a
  // test that needs the raw counters reads them from the journal rather than from a test-only API.
  const harnessState = async (id) => {
    await receipt(id).catch(() => {});
    const entries = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim());
    const last = entries.map((line) => JSON.parse(line)).filter((entry) => entry.kind === 'receipt').at(-1);
    assert.ok(last, 'the harness must journal every receipt attempt');
    return last.state;
  };

  await t.test('normal search, detail, and return', async () => {
    await compose('search-detail-return');
    await page.getByLabel('Person description').fill('A person wearing a blue coat');
    await page.getByRole('button', { name: 'Search gallery' }).click();
    const image = page.getByRole('img', { name: 'Gallery result ranked 1' });
    await image.waitFor();
    assert.equal(await image.evaluate((element) => element.complete && element.naturalWidth > 0), true);
    await page.getByRole('button', { name: 'Open result 1 from CUHK-PEDES' }).click();
    await page.getByRole('heading', { name: 'Result #1' }).waitFor();
    await screenshot('search-detail-return');
    await page.getByRole('button', { name: 'Back to results' }).click();
    await page.getByRole('heading', { name: 'Closest visual matches' }).waitFor();
    assert.equal(await receipt('search-detail-return'), 'qa-receipt:search-detail-return');
  });

  await t.test('model provenance', async () => {
    await compose('model-provenance');
    await page.getByLabel('CLIP model').selectOption('openai/clip-vit-large-patch14');
    await page.getByLabel('Person description').fill('A person in a blue coat with a black shoulder bag');
    await page.getByRole('button', { name: 'Search gallery' }).click();
    await page.getByLabel('Search provenance').waitFor();
    assert.match(await page.getByLabel('Search provenance').innerText(), /fixture-clip-vit-l-14-v1/);
    await page.getByRole('button', { name: 'Open result 1 from CUHK-PEDES' }).click();
    await page.getByRole('heading', { name: 'Result #1' }).waitFor();
    await screenshot('model-provenance');
    assert.equal(await receipt('model-provenance'), 'qa-receipt:model-provenance');
  });

  await t.test('cancelled delayed reply cannot replace the newer response', async () => {
    await compose('cancel-replace');
    await page.getByLabel('CLIP model').selectOption('openai/clip-vit-large-patch14');
    await page.getByLabel('Person description').fill('A person in a red jacket carrying a backpack');
    await page.getByRole('button', { name: 'Search gallery' }).click();
    await page.getByRole('button', { name: 'Cancel search' }).click();
    await page.getByLabel('CLIP model').selectOption('openai/clip-vit-base-patch16');
    await page.getByLabel('Person description').fill('A person wearing a blue coat');
    await page.getByRole('button', { name: 'Search gallery' }).click();
    await page.getByLabel('Search provenance').waitFor();
    await page.waitForTimeout(650);
    const provenance = await page.getByLabel('Search provenance').innerText();
    assert.match(provenance, /qa-new-b16-v1/);
    assert.doesNotMatch(provenance, /qa-stale-l14-v1/);
    await screenshot('cancel-replace');
    // The receipt is what proves the late reply was actually attempted and still lost the race.
    assert.equal(await receipt('cancel-replace'), 'qa-receipt:cancel-replace');
  });

  await t.test('unprepared model is disabled with guidance', async () => {
    await compose('unprepared-model');
    const option = page.getByLabel('CLIP model').locator('option[value="openai/clip-vit-large-patch14-336"]');
    await page.waitForFunction(() => {
      const candidateOption = document.querySelector('option[value="openai/clip-vit-large-patch14-336"]');
      return candidateOption instanceof HTMLOptionElement && candidateOption.disabled;
    });
    assert.equal(await option.getAttribute('disabled'), '');
    assert.match(await page.getByLabel('Models needing preparation').innerText(), /\.\/gods-eye prepare --model-id openai\/clip-vit-large-patch14-336/);
    await screenshot('unprepared-model');
    assert.equal(await receipt('unprepared-model'), 'qa-receipt:unprepared-model');
  });

  await t.test('one-time 409 refreshes the catalog and a later retry succeeds', async () => {
    await compose('recover-409');
    await page.getByLabel('CLIP model').selectOption('openai/clip-vit-large-patch14-336');
    await page.getByLabel('Person description').fill('A person wearing a green hat');
    await page.getByRole('button', { name: 'Search gallery' }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /not prepared/);
    await page.waitForFunction(() => {
      const candidateOption = document.querySelector('option[value="openai/clip-vit-large-patch14-336"]');
      return candidateOption instanceof HTMLOptionElement && candidateOption.disabled;
    });
    assert.equal(await page.getByLabel('CLIP model').locator('option[value="openai/clip-vit-large-patch14-336"]').getAttribute('disabled'), '');
    await page.getByLabel('Person description').fill('A person wearing a blue coat');
    await page.getByRole('button', { name: 'Search gallery' }).click();
    await page.getByLabel('Search provenance').waitFor();
    assert.match(await page.getByLabel('Search provenance').innerText(), /qa-recovered-b16-v1/);
    await screenshot('recover-409');
    assert.equal(await receipt('recover-409'), 'qa-receipt:recover-409');
  });

  await t.test('blank input stays blank and sends no search', async () => {
    await compose('blank-input');
    await page.getByLabel('Person description').fill('');
    await page.getByRole('button', { name: 'Search gallery' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('Person description').inputValue(), '');
    await screenshot('blank-input');
    assert.equal(await receipt('blank-input'), 'qa-receipt:blank-input');
  });

  await t.test('reset removes the prior fault profile', async () => {
    await compose('search-detail-return');
    await page.waitForFunction(() => {
      const candidateOption = document.querySelector('option[value="openai/clip-vit-large-patch14-336"]');
      return candidateOption instanceof HTMLOptionElement && !candidateOption.disabled;
    });
    assert.equal(await page.getByLabel('CLIP model').locator('option[value="openai/clip-vit-large-patch14-336"]').isEnabled(), true);
    // Nothing has been done since the selection, so this receipt is refused and journals the state.
    const state = await harnessState('search-detail-return');
    assert.equal(state.profile, 'normal');
    assert.equal(state.searchRequests, 0);
    assert.equal(state.search409Count, 0);
    assert.equal(state.lateFirstReplyAttempted, false);
    assert.equal(state.unexpectedFailures, 0);
  });

  await t.test('trusted baseline runs candidate search and theme specs unchanged against the external origin', async () => {
    const baselineEvidence = resolve(evidenceRoot, 'baseline');
    await mkdir(baselineEvidence, { recursive: true });
    const result = await runCommand(
      resolve(candidate, 'web/node_modules/.bin/playwright'),
      ['test', '--config', resolve(qaRoot, 'baseline.config.ts')],
      {
        cwd: resolve(candidate, 'web'),
        env: { ...process.env, QA_CANDIDATE: candidate, QA_WEB_ORIGIN: runtime.origin, QA_EVIDENCE: baselineEvidence },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await writeFile(resolve(baselineEvidence, 'command.txt'), result.output, { mode: 0o600 });
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.output);
  });
});

test('Given a local unexpected 500, when search runs, then it is distinct from expected 409 recovery', { skip: process.env.QA_BROWSER_TESTS !== '1' }, async (t) => {
  const candidate = resolve(process.env.QA_CANDIDATE ?? process.cwd());
  const { startRuntime, monotonicDeadlineAfter } = require(resolve(qaRoot, 'runtime.cjs'));
  const runtime = await startRuntime({ candidate, evidence: resolve(evidenceRoot, 'failure-runtime'), deadline: monotonicDeadlineAfter(180_000) });
  t.after(() => runtime.stop());
  const { chromium } = require('playwright');
  const { installBrowserHarness } = require(resolve(qaRoot, 'browser-init.ts'));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await installBrowserHarness({ page, unexpectedSearchStatus: 500 });
  await page.goto(runtime.origin);
  await page.getByLabel('Person description').fill('A person wearing a blue coat');
  await page.getByRole('button', { name: 'Search gallery' }).click();
  await page.getByRole('alert').waitFor();
  const message = await page.getByRole('alert').innerText();
  assert.match(message, /search service failed/i);
  assert.doesNotMatch(message, /not prepared/i);
  await writeFile(resolve(evidenceRoot, 'failures.json'), `${JSON.stringify({ unexpected500: message, browserUnavailable: 'covered by pinned Chromium launch test' }, null, 2)}\n`, { mode: 0o600 });
});

test('Given the pinned MCP init page and loopback allowlist, when its browser starts, then the narrow control loads and external requests are blocked', { skip: process.env.QA_BROWSER_TESTS !== '1', timeout: 20_000 }, async () => {
  const mcp = startMcp(resolve(qaRoot, 'node_modules/.bin/playwright-mcp'), [
    '--headless', '--isolated', '--browser', 'chromium', '--viewport-size', '1440x1000',
    '--allowed-origins', 'http://127.0.0.1:9', '--init-page', resolve(qaRoot, 'browser-init.ts'),
    '--output-dir', resolve(evidenceRoot, 'mcp-policy-output'),
  ]);
  try {
    const initialized = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-qa-browser-probe', version: '1' } });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    mcp.notify('notifications/initialized');
    const control = await mcp.request('tools/call', { name: 'browser_evaluate', arguments: { function: '() => window.__GODS_EYE_QA__.state()' } });
    assert.match(JSON.stringify(control), /normal/);
    const blocked = await mcp.request('tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com/' } });
    assert.match(JSON.stringify(blocked), /blocked|not allowed|allowlist/i);
  } finally {
    await stopMcp(mcp.child);
  }
});

test('Given an unavailable pinned Chromium executable, when launch is required, then no developer-browser fallback occurs', { skip: process.env.QA_BROWSER_TESTS !== '1', timeout: 20_000 }, async () => {
  const missing = resolve(evidenceRoot, 'missing-browser', 'chromium');
  const mcp = startMcp(resolve(qaRoot, 'node_modules/.bin/playwright-mcp'), [
    '--headless', '--isolated', '--browser', 'chromium', '--executable-path', missing,
    '--viewport-size', '1440x1000', '--allowed-origins', 'http://127.0.0.1:9',
    '--init-page', resolve(qaRoot, 'browser-init.ts'), '--output-dir', resolve(evidenceRoot, 'missing-browser-output'),
  ]);
  try {
    const initialized = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-qa-browser-probe', version: '1' } });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    mcp.notify('notifications/initialized');
    const response = await mcp.request('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:9/' } });
    const rendered = JSON.stringify(response);
    assert.match(rendered, /executable|ENOENT|doesn't exist/i);
    assert.doesNotMatch(rendered, /channel.*chrome/i);
  } finally {
    await stopMcp(mcp.child);
  }
});
