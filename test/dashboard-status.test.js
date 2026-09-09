import test from 'node:test';
import assert from 'node:assert/strict';
import { learningOverview, settingsReloadScope } from '../chart/dashboard-status.js';

test('model overview preserves unknown evidence and distinguishes recorded zero counts', () => {
  for (const learning of [undefined, null, {}, { adaptive: { health: {} } }]) {
    const overview = learningOverview(learning);
    assert.equal(overview.status, 'unavailable');
    assert.equal(overview.usableSamples, null);
    assert.equal(overview.acceptedFits, null);
  }
  const initial = learningOverview({ adaptive: { health: { status: 'prior-estimates', usableSamples: 0, acceptedFits: 0 } } });
  assert.equal(initial.status, 'initial');
  assert.equal(initial.usableSamples, 0);
  assert.equal(initial.acceptedFits, 0);
  const partial = learningOverview({ adaptive: { health: { usableSamples: 18 } } });
  assert.equal(partial.usableSamples, 18);
  assert.equal(partial.acceptedFits, null);
  for (const invalid of [-1, 1.5, '12', Infinity, NaN]) {
    const overview = learningOverview({ adaptive: { health: { usableSamples: invalid, acceptedFits: invalid } } });
    assert.equal(overview.usableSamples, null);
    assert.equal(overview.acceptedFits, null);
  }
});

test('model overview separates temperature checks from action evidence and savings', () => {
  const learning = { adaptive: { health: { status: 'learning', usableSamples: 120, acceptedFits: 3 } },
    readiness: { thermalValidated: true, actionValidated: false, trialReady: true } };
  const overview = learningOverview(learning);
  assert.equal(overview.usableSamples, 120);
  assert.equal(overview.acceptedFits, 3);
  assert.match(overview.summary, /Heating-action forecasts are still being validated/);
  assert.doesNotMatch(overview.summary, /Savings|ready|complete|%/);
  delete learning.readiness.actionValidated;
  assert.match(learningOverview(learning).summary, /validation is not reported/);
  learning.readiness.actionValidated = true;
  assert.match(learningOverview(learning).summary, /Savings remain estimates/);
  learning.adaptive.health.status = 'retained-previous';
  assert.equal(learningOverview(learning).status, 'retained');
  assert.match(learningOverview(learning).summary, /previous model stays in use/);
});

test('settings reload requires an explicit usable API capability and honors busy and failed states', () => {
  for (const status of [undefined, null, { input: 'providers' }, { settingsReload: { available: 'yes' } }]) {
    assert.equal(settingsReloadScope(status).available, false);
  }
  assert.equal(settingsReloadScope({ settingsReload: { available: true, busy: false } }).available, true);
  const busy = settingsReloadScope({ settingsReload: { available: true, busy: true } });
  assert.equal(busy.available, false);
  assert.match(busy.message, /starting or updating/);
  const failed = settingsReloadScope({ settingsReload: { available: true, unavailable: true, reason: 'Restart after recovery failure.' } });
  assert.equal(failed.available, false);
  assert.equal(failed.message, 'Restart after recovery failure.');
  const noSource = settingsReloadScope({ settingsReload: { available: false, reason: 'No reloadable source.' } });
  assert.equal(noSource.available, false);
  assert.equal(noSource.message, 'No reloadable source.');
});

test('reload scope distinguishes live provider configuration from startup and environment settings', () => {
  const live = settingsReloadScope({ input: 'providers', settingsReload: { available: true } });
  assert(live.reloadable.some(item => /Provider connections/.test(item)));
  assert(live.reloadable.some(item => /H66 device selection/.test(item)));
  assert(live.reloadable.some(item => /Price-control mode/.test(item)));
  assert(live.reloadable.some(item => /Electricity rates/.test(item)));
  assert(live.restartRequired.some(item => /Input mode/.test(item)));
  assert(live.restartRequired.some(item => /access token/.test(item)));
  assert(live.restartRequired.some(item => /database/.test(item)));
  assert(live.restartRequired.some(item => /Environment variables/.test(item)));
  assert.match(live.message, /Startup environment overrides still apply/);
  assert.match(live.message, /pending heating restoration must complete/);
  assert.match(live.message, /block the whole reload/);
  for (const input of ['simulated', 'offline']) {
    const local = settingsReloadScope({ input, settingsReload: { available: true } });
    assert(!local.reloadable.some(item => /Provider|H66/.test(item)));
  }
});
