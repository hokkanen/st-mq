import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOverviewTemperatureFit, checkDashboardCompactLayout, checkHomeRoofHeaderClearance } from './dashboard-browser-checks.js';

/** Real renderers, synthetic status and intercepted commands only. */
export async function checkDashboardHeights({ evaluate, command, context, refresh, settle, until }) {
  const artifacts = process.env.STMQ_DASHBOARD_SCREENSHOT_DIR;
  if (artifacts) mkdirSync(artifacts, { recursive: true });
  await evaluate(`(() => {
    const fixture = window.equipmentUiFixture;
    const state = window.dashboardHeightFixture = { response: fixture.response, fetch: window.fetch,
      theme: document.documentElement.dataset.theme, scenario: 'normal', enabled: true, revision: 0,
      folds: [...document.querySelectorAll('.controller-panels details')].map(node => [node, node.open]) };
    fixture.response = base => {
      const status = structuredClone(state.response(base)), at = status.now;
      status.input = 'providers'; status.readOnly = false;
      status.automation.home = { ...status.automation.home, enabled: true, available: true };
      status.decision = { ...status.decision, phase: 'normal', action: 'normal', manualHold: null, plan: null };
      status.override = null;
      status.prices = [{ start: at, end: at + 86400000, allInCentsPerKWh: 14.2, spotCtPerKwh: 7.2 }];
      status.spot = [{ start: at, end: at + 86400000, spotCtPerKwh: 7.2 }];
      status.priceStatus = 'configured';
      for (const key of ['indoor', 'outdoor', 'garage']) status.observations[key] = {
        ...status.observations[key], value: key === 'indoor' ? 20.8 : key === 'outdoor' ? 12 : 18.2,
        observedAt: at, stale: false, configured: true };
      status.garage = { ...status.garage, settings: { ...status.garage?.settings, enabled: true }, mode: 'normal',
        normalTargetC: 18, awayTargetC: 5, requestedTargetC: 18, effectiveTargetC: 18,
        targetConfirmed: true, controlAvailable: true, controlReason: null,
        observations: { ...status.garage?.observations,
          rear: { ...status.observations.garage, sourceTime: at, receivedAt: at } } };
      for (const device of status.equipment.devices) if (device.kind === 'door') {
        device.cover.state = 'closed';
        for (const reading of Object.values(device.readings)) reading.value = 0;
      }
      status.charging.error = null;
      for (const charger of status.charging.chargers) {
        charger.association = 'height-fixture-' + charger.id;
        charger.settings.enabled = state.enabled;
        charger.controls = { enabled: state.enabled, revision: state.revision };
        charger.capabilities = { ...charger.capabilities, scheduling: true };
        charger.request = { sessionId: 'height-fixture-session-' + charger.id, revision: 1, overrides: {} };
        charger.values.connected = { value: true, available: true };
        charger.values.charging = { value: false, available: true };
        const vehicleSource = charger.id === 'charger1' ? 'bmw-cardata' : 'teslamate';
        charger.values.soc = { value: 40, available: true, source: vehicleSource, measuredAt: at };
        charger.values.minimumSoc = { value: 80, available: true, source: vehicleSource, measuredAt: at };
        charger.vehicle = { state: 'identified', id: charger.id === 'charger1' ? 'bmw' : 'tesla',
          label: charger.id === 'charger1' ? 'BMW' : 'Tesla', source: vehicleSource };
        const startAt = at + 3600000, finishAt = at + 3 * 3600000, deadlineAt = at + 5 * 3600000;
        charger.plan = { startAt, finishAt, deadlineAt, periods: [{ startAt, endAt: null }], feasible: true };
        charger.control = { phase: 'waiting', confirmed: true, owned: { startAt, periods: [{ startAt, endAt: null }] } };
        charger.forecast = { state: 'planned', controlled: true, startAt, finishAt, feasible: true, requiredGridKwh: 20 };
        charger.progress = { deliveredGridKwh: 4.2, remainingGridKwh: 20, estimatedSoc: 47, hasEnergyEstimate: true };
        charger.sessionCost = { totalCents: 343.64, recordedGridKwh: 4.2 };
      }
      if (state.scenario === 'unavailable' || state.scenario === 'stale' || state.scenario === 'not-configured') {
        for (const key of ['indoor', 'outdoor', 'garage']) Object.assign(status.observations[key],
          state.scenario === 'unavailable' ? { value: null, stale: true }
            : state.scenario === 'not-configured' ? { value: null, configured: false }
            : { observedAt: at - 3 * 3600000, needsAttention: true, attentionReasons: ['old-reading'] });
        if (status.garage) status.garage.observations.rear = { ...status.observations.garage };
        for (const device of status.equipment.devices) if (device.readings?.garage_temperature) {
          device.available = false;
          for (const reading of Object.values(device.readings)) reading.stale = true;
        }
        for (const provider of Object.values(status.providers)) if (provider && typeof provider === 'object') {
          provider.status = 'error'; provider.error = 'The synthetic source has not supplied current measurements. Check the connection and original measurement timestamps.';
        }
      }
      if (state.scenario === 'long-plan') {
        status.decision.phase = 'preheat'; status.decision.action = 'preheat';
        status.decision.plan = { schedule: { preheatStart: at - 60000,
          preheatEnd: at + 3 * 86400000, reductionStart: at + 4 * 86400000,
          reductionEnd: at + 5 * 86400000 } };
        status.observations.outdoor.source = 'openmeteo';
        status.observations.upstairs.source = 'husdata-h66';
        status.providers.weather.source = 'openmeteo'; status.providers.weather.status = 'fallback';
      }
      if (state.scenario === 'paused') status.automation.home.enabled = false;
      if (state.scenario === 'control-unavailable') status.automation.home = {
        ...status.automation.home, available: false, reason: 'The synthetic controller is waiting for a current equipment connection.' };
      if (state.scenario === 'missing-price') { status.prices = []; status.spot = []; status.priceStatus = 'missing-market-data'; }
      if (state.scenario === 'simulation') status.input = 'simulated';
      if (state.scenario === 'history') status.input = 'offline';
      if (state.scenario === 'replica') {
        status.readOnly = true;
        status.readView = { configurationMessage: 'Synthetic replica configuration is available for inspection. This long explanation remains accessible without resizing the folded dashboard.' };
      }
      if (state.scenario === 'charging-error') status.charging.error = 'charging-planning-unavailable';
      return status;
    };
    window.fetch = async (input, options = {}) => {
      const path = new URL(input.url ?? String(input), location.href).pathname;
      if (path.startsWith('/api/charging/') && options.method === 'POST') {
        state.requested = true;
        await new Promise(resolve => { state.release = resolve; });
        if (state.fail) return new Response(JSON.stringify({ error: 'Synthetic charging action failed. The charger could not confirm this request; inspect its current connection and try again.' }), { status: 503 });
        const body = JSON.parse(options.body);
        if (body.enabled !== undefined) state.enabled = body.enabled;
        state.revision++;
        return new Response(JSON.stringify(fixture.response(fixture.base)), { status: 200 });
      }
      return state.fetch(input, options);
    };
    for (const [node] of state.folds) node.open = false;
  })()`);
  const geometry = () => evaluate(`(() => {
    const cards = ['home-control', 'garage-control', 'providers-controls'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      return { id, height: box.height, bottom: box.bottom };
    });
    const footers = ['home-equipment-details', 'garage-equipment-details', 'connections-details'].map(id => {
      const box = document.querySelector('#' + id + ' > summary').getBoundingClientRect();
      return { id, height: box.height };
    });
    return { cards, footers, providers: [...document.querySelectorAll('#providers > li')].map(node => node.dataset.provider),
      chargers: [...document.querySelectorAll('#charging-devices > details')].map(node => node.id),
      headings: ['control-title', 'garage-title'].map(id => document.getElementById(id).getBoundingClientRect().top),
      fits: document.documentElement.scrollWidth <= innerWidth };
  })()`);
  const stable = async (baseline, label) => {
    await settle();
    const actual = await geometry();
    assert.equal(actual.fits, true, `${label}: the dashboard fits the viewport`);
    assert.deepEqual(actual.providers, baseline.providers, `${label}: provider inventory is unchanged`);
    assert.deepEqual(actual.chargers, baseline.chargers, `${label}: charger inventory is unchanged`);
    for (const group of ['cards', 'footers']) for (const [index, box] of actual[group].entries()) {
      assert.ok(Math.abs(box.height - baseline[group][index].height) <= 1,
        `${label}: ${box.id} retains its height (${baseline[group][index].height}px -> ${box.height}px)`);
    }
  };
  const receiptFits = async label => {
    const layout = await evaluate(`(() => {
      const receipt = document.getElementById('charger1-control-message');
      const trigger = receipt.querySelector('button') ?? receipt;
      const box = trigger.getBoundingClientRect();
      const summary = receipt.closest('summary').getBoundingClientRect();
      const report = document.getElementById('charger1-session-report').getBoundingClientRect();
      const overlaps = [...receipt.closest('summary').querySelectorAll('.charging-disclosure > span, .charging-session-report')]
        .filter(node => node.checkVisibility({ visibilityProperty: true })).filter(node => {
          const other = node.getBoundingClientRect();
          return box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top;
        }).map(node => node.className);
      return { overlaps, beforeReport: box.bottom <= report.top + 1,
        contained: box.left >= summary.left && box.right <= summary.right
        && box.top >= summary.top && box.bottom <= summary.bottom };
    })()`);
    assert.equal(layout.contained, true, `${label}: the receipt stays inside its summary`);
    assert.equal(layout.beforeReport, true, `${label}: feedback stays above Session report`);
    assert.deepEqual(layout.overlaps, [], `${label}: the receipt never covers charger details or Session report`);
  };
  const explain = async (selector, expected, label) => {
    await evaluate(`(() => {
      const trigger = document.querySelector(${JSON.stringify(selector)});
      trigger.scrollIntoView({ block: 'center' }); trigger.focus(); trigger.click();
    })()`);
    await until("document.getElementById('status-detail-popover')?.hidden === false");
    assert.match(await evaluate("document.getElementById('status-detail-popover').textContent"), expected,
      `${label}: full details are available`);
    assert.equal(await evaluate(`(() => {
      const popup = document.getElementById('status-detail-popover'), box = popup.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
        && popup.scrollWidth <= popup.clientWidth;
    })()`), true, `${label}: the explanation fits the viewport`);
    await command('input.performActions', { context, actions: [{ type: 'key', id: 'height-keyboard',
      actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }] });
    assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), true,
      `${label}: closing restores focus`);
  };
  try {
    for (const width of [1440, 1280, 1180, 1024, 600, 390, 320]) {
      await command('browsingContext.setViewport', { context, viewport: { width, height: 1100 }, devicePixelRatio: 1 });
      await evaluate("dashboardHeightFixture.scenario = 'normal'; dashboardHeightFixture.enabled = true"); await refresh();
      if (await evaluate("Boolean(document.getElementById('charger1-control-message').textContent)")) {
        await evaluate("dashboardHeightFixture.fail = false; dashboardHeightFixture.requested = false; document.getElementById('charger1-charge-now').click()");
        await until('dashboardHeightFixture.requested'); await evaluate('dashboardHeightFixture.release()');
        await until("!document.getElementById('charger1-charge-now').disabled");
      }
      const baseline = await geometry();
      await checkOverviewTemperatureFit({ evaluate, width });
      await checkDashboardCompactLayout({ evaluate, width });
      await checkHomeRoofHeaderClearance({ evaluate, width });
      if (artifacts) {
        await evaluate('window.scrollTo(0, 0)');
        const clip = await evaluate(`(() => {
          const box = document.querySelector('.controller-panels').getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
        })()`);
        const screenshot = await command('browsingContext.captureScreenshot', { context, clip });
        writeFileSync(join(artifacts, `dashboard-${width}.png`), Buffer.from(screenshot.data, 'base64'));
        writeFileSync(join(artifacts, `dashboard-${width}.json`), JSON.stringify(baseline, null, 2));
      }
      assert.ok(baseline.footers.every(footer => Math.abs(footer.height - baseline.footers[0].height) <= 1),
        `${width}px: Home equipment, Garage equipment and Connections share a footer heading height`);
      if (width > 800) {
        assert.ok(Math.abs(baseline.headings[0] - baseline.headings[1]) <= 1,
          'Desktop Home and Garage headings share a baseline');
        if (width >= 1280) assert.ok(Math.abs(baseline.cards[1].bottom - baseline.cards[2].bottom) <= 16,
          `Wide desktop Garage and Data card bottoms remain naturally close (${Math.abs(baseline.cards[1].bottom - baseline.cards[2].bottom)}px)`);
      }
      for (const scenario of ['unavailable', 'not-configured', 'stale', 'long-plan', 'paused', 'control-unavailable', 'missing-price', 'simulation', 'history', 'replica', 'charging-error', 'normal']) {
        await evaluate(`dashboardHeightFixture.scenario = '${scenario}'`); await refresh();
        await stable(baseline, `${width}px ${scenario}`);
        if (['unavailable', 'stale', 'control-unavailable'].includes(scenario))
          await checkHomeRoofHeaderClearance({ evaluate, width, scenario });
        if (scenario === 'unavailable') {
          assert.match(await evaluate("document.getElementById('indoor').textContent"), /Unavailable/);
          await explain('#indoor .status-detail-trigger', /unavailable.*reading/i, `${width}px missing indoor reading`);
        }
        if (scenario === 'stale') await explain('#indoor .status-detail-trigger', /attention|old/i, `${width}px stale indoor reading`);
        if (scenario === 'long-plan') await explain('[data-provider="main-temperatures"] .provider-category-state .status-detail-trigger', /Open-Meteo:/i,
          `${width}px expanded provider source list`);
        if (scenario === 'simulation') await explain('#provider-overview-state .status-detail-trigger', /example prices.*live providers/i, `${width}px simulation context`);
        if (scenario === 'replica') await explain('#provider-overview-state .status-detail-trigger', /synthetic replica configuration/i, `${width}px replica context`);
        if (scenario === 'charging-error') await explain('#charging-status .status-detail-trigger', /last charger instructions remain in effect/i, `${width}px charging error`);
      }

      // Toggle inside the charger's details, then return to the folded overview
      // while its response is pending. The save and failure use real UI handlers.
      for (const fail of [false, true]) {
        await evaluate(`dashboardHeightFixture.fail = ${fail}; dashboardHeightFixture.requested = false;
          document.getElementById('charger1-device').open = true;
          document.getElementById('charger1-enabled').click();
          document.getElementById('charger1-device').open = false`);
        await until('dashboardHeightFixture.requested');
        await stable(baseline, `${width}px pending charging preference`);
        await receiptFits(`${width}px pending charging preference`);
        await evaluate('dashboardHeightFixture.release()');
        await until("!document.getElementById('charger1-enabled').disabled");
        await stable(baseline, `${width}px ${fail ? 'failed' : 'saved'} charging preference`);
        await receiptFits(`${width}px ${fail ? 'failed' : 'saved'} charging preference`);
        await explain('#charger1-control-message .status-detail-trigger', fail ? /synthetic charging action failed/i
          : /automatic charging preference saved.*stays in effect until changed/i,
        `${width}px charging ${fail ? 'failure' : 'receipt'}`);
        await stable(baseline, `${width}px dismissed charging receipt`);
      }
      await evaluate("document.getElementById('garage-heating-details').open = true"); await settle();
      const garageOpen = await geometry();
      assert.ok(garageOpen.cards[1].height > baseline.cards[1].height,
        `${width}px: explicitly opening Garage heating can increase its height`);
      for (const index of [0, 2]) assert.ok(Math.abs(garageOpen.cards[index].height - baseline.cards[index].height) <= 1,
        `${width}px: opening Garage heating leaves ${baseline.cards[index].id} unchanged`);
      await evaluate("dashboardHeightFixture.scenario = 'charging-error'"); await refresh();
      await stable(garageOpen, `${width}px charging error with Garage heating open`);
      await evaluate("document.getElementById('garage-heating-details').open = false; dashboardHeightFixture.scenario = 'normal'");
      await refresh(); await stable(baseline, `${width}px closing Garage heating`);
      for (const [id, cardIndex] of [['home-heat-pump-details', 0], ['connections-details', 2]]) {
        await evaluate(`document.getElementById('${id}').open = true`); await settle();
        const open = await geometry();
        assert.ok(open.cards[cardIndex].height > baseline.cards[cardIndex].height,
          `${width}px: opening ${id} grows its own card`);
        for (const index of [0, 1, 2].filter(index => index !== cardIndex)) {
          assert.ok(Math.abs(open.cards[index].height - baseline.cards[index].height) <= 1,
            `${width}px: opening ${id} leaves ${baseline.cards[index].id} unchanged`);
        }
        await evaluate(`document.getElementById('${id}').open = false`);
        await stable(baseline, `${width}px closing ${id}`);
      }
    }
  } finally {
    await evaluate(`(() => {
      const state = dashboardHeightFixture;
      state.release?.(); window.fetch = state.fetch; window.equipmentUiFixture.response = state.response;
      document.documentElement.dataset.theme = state.theme;
      for (const [node, open] of state.folds) if (node.isConnected) node.open = open;
      delete window.dashboardHeightFixture;
    })()`);
    await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
    await refresh();
  }
}
