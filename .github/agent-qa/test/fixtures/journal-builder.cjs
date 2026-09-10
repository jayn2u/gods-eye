'use strict';

const scenarioContract = require('../../scenarios.json');
const { scenarioActionRequirements } = require('../../journal.cjs');

/** Describe the page event a faithful run would produce for one declared requirement. */
function observableFor(scenario, label) {
  if (label.startsWith('enter ')) {
    const quoted = label.slice('enter '.length, label.lastIndexOf(' in the description'));
    return {
      action: 'type',
      target: { tag: 'TEXTAREA', id: 'query', type: '', ariaLabel: '', text: '' },
      value: JSON.parse(quoted),
    };
  }
  if (label.startsWith('select any prepared model')) {
    return {
      action: 'select',
      target: { tag: 'SELECT', id: 'model-id', type: '', ariaLabel: '', text: '' },
      value: 'openai/clip-vit-base-patch32',
    };
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

/** The journal a faithful six-scenario run writes, for tests to assert on or corrupt. */
function faithfulJournalEntries(origin, { startedAt = Date.now() - 60_000 } = {}) {
  const entries = [];
  let seq = 0;
  let clock = startedAt;
  const push = (kind, payload) => {
    seq += 1;
    clock += 1000;
    entries.push({ seq, at: new Date(clock).toISOString(), kind, ...payload });
  };
  for (const scenario of scenarioContract.scenarios) {
    push('profile', { scenario: scenario.id, profile: scenario.profile, url: `${origin}/` });
    push('navigate', { url: `${origin}/` });
    for (const requirement of scenarioActionRequirements(scenario)) {
      push('action', observableFor(scenario, requirement.label));
    }
    push('receipt', { scenario: scenario.id, token: `qa-receipt:${scenario.id}`, satisfied: true, state: {} });
  }
  return entries;
}

module.exports = Object.freeze({ faithfulJournalEntries, observableFor });
