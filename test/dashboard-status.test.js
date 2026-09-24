import test from 'node:test';
import assert from 'node:assert/strict';
import { learningOverview, garageLearningOverview, settingsReloadScope } from '../chart/dashboard-status.js';

test('garage overview uses whole episodes and observed duration instead of short-step prediction counts', () => {
  for (const input of [undefined, null, {}, { validation: { completedEpisodes: -1 }, validatedOffHours: '12' }]) {
    const overview = garageLearningOverview(input);
    assert.equal(overview.status, 'unavailable');
    assert.equal(overview.completedEpisodes, null);
    assert.equal(overview.validatedOffHours, null);
  }
  const learning = { status: 'learning', trainedIntervals: 0, thermalReady: false, electricalReady: false,
    validation: { completedEpisodes: 0 }, validatedOffHours: 0 };
  const initial = garageLearningOverview(learning);
  assert.equal(initial.status, 'initial');
  assert.equal(initial.completedEpisodes, 0); assert.equal(initial.validatedOffHours, 0);
  learning.trainedIntervals = 24;
  learning.heldOut = { advanceRear: { n: 10_000 } };
  assert.equal(garageLearningOverview(learning).status, 'learning');
  assert.equal(garageLearningOverview(learning).validatedOffHours, 0);
  learning.validation.completedEpisodes = 3;
  learning.thermalReady = true; learning.validatedOffHours = .75;
  learning.status = 'validated-provisional';
  const thermalOnly = garageLearningOverview(learning);
  assert.equal(thermalOnly.completedEpisodes, 3);
  assert.equal(thermalOnly.validatedOffHours, .75);
  assert.match(thermalOnly.summary, /Cooling checks cover 0.75 h OFF/);
  assert.match(thermalOnly.summary, /Longer pauses use extra uncertainty margins and must satisfy pipe protection/);
  assert.doesNotMatch(thermalOnly.summary, /pauses up to|maximum pause|ceiling/);
  assert.match(thermalOnly.summary, /Electricity and recovery-energy predictions still need validation/);
  learning.electricalReady = true;
  assert.match(garageLearningOverview(learning).summary, /checks have also passed\. Savings remain estimates/);
  learning.reconstruction = 'rebuilding';
  assert.equal(garageLearningOverview(learning).status, 'rebuilding');
  learning.reconstruction = 'failed';
  assert.equal(garageLearningOverview(learning).status, 'attention');
});

test('garage overview never infers current validation from an old status label or missing readiness', () => {
  const learning = { status: 'validated-provisional', trainedIntervals: 20_000,
    validatedOffHours: 8, heldOut: { advanceRear: { n: 8_000 } } };
  const unknown = garageLearningOverview(learning);
  assert.equal(unknown.status, 'learning');
  assert.equal(unknown.validatedOffHours, null);
  assert.doesNotMatch(unknown.summary, /passed|up to 8/);
  learning.thermalReady = false;
  assert.equal(garageLearningOverview(learning).validatedOffHours, 0);
  learning.thermalReady = true;
  assert.match(garageLearningOverview(learning).summary, /validation is not reported yet/);
});

test('replica overviews identify saved evidence without presenting live control readiness', () => {
  const home = learningOverview({ reconstruction: 'snapshot', adaptive: { health: {
    status: 'learning', usableSamples: 120, acceptedFits: 3 } } });
  assert.equal(home.title, 'Recorded primary model');
  assert.equal(home.usableSamples, 120);
  assert.match(home.summary, /Live action readiness and cycle assessments are unavailable/);
  const garage = garageLearningOverview({ reconstruction: 'snapshot', status: 'validated-provisional',
    thermalReady: true, electricalReady: true, validatedOffHours: 2, validation: { completedEpisodes: 3 } });
  assert.equal(garage.title, home.title);
  assert.equal(garage.validatedOffHours, 2);
  assert.match(garage.summary, /Live pause eligibility is unavailable/);
});

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
  assert(live.reloadable.some(item => /Access token/.test(item)));
  assert(!live.restartRequired.some(item => /access token/i.test(item)));
  assert(live.restartRequired.some(item => /Web address and port/.test(item)));
  assert(live.restartRequired.some(item => /database/.test(item)));
  assert(live.restartRequired.some(item => /Environment variables/.test(item)));
  assert.match(live.message, /Startup environment overrides still apply/);
  assert.match(live.message, /pending heating restoration must complete/);
  assert.match(live.message, /require restart and block the whole application/);
  for (const input of ['simulated', 'offline']) {
    const local = settingsReloadScope({ input, settingsReload: { available: true } });
    assert(!local.reloadable.some(item => /Provider|H66/.test(item)));
  }
});

test('configuration instructions use the actual standalone private path and preserve its permanent role', () => {
  const scope = settingsReloadScope({ settingsReload: { available: true,
    configuration: { environment: 'ubuntu', defaultsPath: '/opt/example/config.json', privatePath: '/etc/example/secrets.json' },
    access: { ingress: { enabled: false }, direct: { enabled: true, tokenRequired: false } } } });
  assert.match(scope.instructions.join(' '), /\/etc\/example\/secrets.json/);
  assert.match(scope.instructions.join(' '), /\/opt\/example\/config.json/);
  assert.match(scope.instructions.join(' '), /stays in place/);
  assert.match(scope.instructions.join(' '), /omitted settings use the defaults/);
  assert.match(scope.access.join(' '), /Loopback access works without a token/);
  assert.doesNotMatch(scope.instructions.join(' '), /upload|removes|Home Assistant/i);
  assert.deepEqual(scope.location.rows, [
    { label: 'Folder', value: '/etc/example' }, { label: 'File name', value: 'secrets.json' },
    { label: 'Full path', value: '/etc/example/secrets.json' },
  ]);
  assert.equal(scope.location.message, '');
});

test('Home Assistant configuration instructions distinguish sparse import, saved options and live access', () => {
  const reload = { available: true,
    configuration: { environment: 'home-assistant', defaultsPath: '/st-mq/config.json', privatePath: '/data/options.json',
      importPath: '/config/secrets.json', externalImportPath: '/addon_configs/example_st-mq/secrets.json' },
    access: { ingress: { enabled: true }, direct: { enabled: false, tokenRequired: true } } };
  const scope = settingsReloadScope({ settingsReload: reload });
  assert.match(scope.instructions.join(' '), /\/addon_configs\/example_st-mq\/secrets.json/);
  assert.match(scope.instructions.join(' '), /freshly saved options/);
  assert.match(scope.instructions.join(' '), /Omitted fields keep saved values, arrays replace saved arrays/);
  assert.match(scope.instructions.join(' '), /failed import keeps the file/);
  assert.match(scope.access.join(' '), /host login/);
  assert.match(scope.access.join(' '), /Direct access is disabled/);
  assert.deepEqual(scope.location.rows, [
    { label: 'Folder', value: '/addon_configs/example_st-mq' }, { label: 'File name', value: 'secrets.json' },
    { label: 'Full path', value: '/addon_configs/example_st-mq/secrets.json' },
    { label: 'Inside add-on', value: '/config/secrets.json' },
  ]);
  assert.equal(scope.location.message, '');
  reload.access.direct.enabled = true;
  assert.match(settingsReloadScope({ settingsReload: reload }).access.join(' '), /Clear controller.web_token and apply to disable/);
  reload.configuration.externalImportPath = null;
  const missingSlug = settingsReloadScope({ settingsReload: reload });
  assert.doesNotMatch(missingSlug.instructions.join(' '), /<.*slug|undefined|null/);
  assert.deepEqual(missingSlug.location.rows, [{ label: 'Inside add-on', value: '/config/secrets.json' }]);
  assert.equal(missingSlug.location.message, 'Restart the controller to load configuration paths, then refresh this page');
});

test('configuration location reports missing metadata explicitly without guessing private paths', () => {
  for (const configuration of [undefined, null, {}, { environment: 'ubuntu' }, { environment: 'home-assistant' },
    { environment: 'ubuntu', privatePath: '' }, { environment: 'ubuntu', privatePath: '/folder/' }]) {
    const scope = settingsReloadScope({ settingsReload: { available: true, configuration } });
    assert.equal(scope.location.message, 'Restart the controller to load configuration paths, then refresh this page');
    assert.deepEqual(scope.location.rows, []);
    assert.doesNotMatch(scope.instructions.join(' '), /undefined|null|\/home\/|\/addon_configs\/|\/config\/secrets/);
  }
});

test('configuration location preserves custom filenames, service paths and XDG paths with spaces', () => {
  for (const [privatePath, folder, filename] of [
    ['/srv/example/private/custom.json', '/srv/example/private', 'custom.json'],
    ['/home/example user/Settings/st-mq/secrets.json', '/home/example user/Settings/st-mq', 'secrets.json'],
    ['/settings.json', '/', 'settings.json'],
  ]) {
    const { location } = settingsReloadScope({ settingsReload: { configuration: { environment: 'ubuntu', privatePath } } });
    assert.deepEqual(location.rows, [{ label: 'Folder', value: folder }, { label: 'File name', value: filename },
      { label: 'Full path', value: privatePath }]);
    assert.equal(location.message, '');
  }
});
