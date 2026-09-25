import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Runs only against the disposable synthetic server created by browser-garage-smoke.
export async function checkChargingPriority({ send, evaluate, until, artifacts }) {
  const entryIds = ['charger1-shared-priority', 'charger2-shared-priority'];
  await until("typeof globalThis.refreshLearningSmokeStatus === 'function'");
  assert.deepEqual(await evaluate(`${JSON.stringify(entryIds)}.map(id => {
    const entry = document.getElementById(id), device = entry.closest('#charging-devices > details');
    return [entry.tagName, device?.id, !device.querySelector('summary').contains(entry), entry.querySelector('button, input') === null];
  })`), [['DIV', 'charger1-device', true, true], ['DIV', 'charger2-device', true, true]],
  'Configured priority is visible as read-only information in charger details');
  assert.equal(await evaluate("document.getElementById('charging-priority-dialog')"), null);
  assert.equal(await evaluate("document.getElementById('charging-priority-save')"), null);
  assert.equal(await evaluate(`${JSON.stringify(entryIds)}.every(id => document.getElementById(id).textContent.includes('set in configuration'))`), true);
  try {
    for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width <= 390 ? 844 : 1100, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.homeEnergyTheme.setTheme('${theme}');
        document.querySelectorAll('#charging-devices > details').forEach(device => device.open = false);
        document.getElementById('charger1-device').scrollIntoView({ block: 'center' })`);
      const actions = await evaluate(`['charger1', 'charger2'].map(id => {
        const device = document.getElementById(id + '-device'), summary = device.querySelector('summary');
        const button = document.getElementById(id + '-charge-now'), bounds = button.getBoundingClientRect(), card = summary.getBoundingClientRect();
        return { id, visible: button.checkVisibility(), caption: button.textContent, height: bounds.height,
          fits: bounds.left >= card.left && bounds.right <= card.right && bounds.top >= card.top && bounds.bottom <= card.bottom,
          rightAligned: bounds.left + bounds.width / 2 > card.left + card.width / 2,
          priorityHidden: !document.getElementById(id + '-shared-priority').checkVisibility() };
      })`);
      for (const action of actions) {
        assert(action.visible && action.fits && action.rightAligned && action.priorityHidden, `${width}px ${theme}: ${action.id} exposes Charge Now at the top right: ${JSON.stringify(action)}`);
        assert.equal(action.caption, 'Charge Now'); assert(action.height >= 44, 'The immediate-charge button has a generous touch target');
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${width}px ${theme} has no horizontal overflow`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `charging-actions-${width}-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    // Stub only this disposable page’s charging actions, so touch/keyboard
    // behavior can be checked without authorizing any physical integration.
    await evaluate(`globalThis.chargingActionSmokeFetch = globalThis.fetch;
      globalThis.chargingActionSmokeSelected = false;
      globalThis.chargingActionSmokeWrites = [];
      const syntheticChargingStatus = async () => {
        const status = await globalThis.chargingActionSmokeFetch('/api/status').then(response => response.json());
        const charger = status.charging.chargers.find(item => item.id === 'charger1');
        charger.settings.enabled = true;
        charger.association = 'synthetic-browser-charger';
        charger.request = { sessionId: 'synthetic-browser-session', revision: 1, overrides: {}, chargeNow: globalThis.chargingActionSmokeSelected };
        charger.values.connected = { value: true, available: true };
        charger.values.charging = { value: false, available: true };
        charger.control = { phase: globalThis.chargingActionSmokeSelected ? 'released' : 'waiting', manual: null };
        return new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } });
      };
      globalThis.fetch = async (input, options) => {
        const path = new URL(input.url ?? String(input), location.href).pathname;
        if (path === '/api/status') return syntheticChargingStatus();
        if (path.startsWith('/api/charging/chargers/charger1/') && options?.method === 'POST') {
          globalThis.chargingActionSmokeWrites.push([path, JSON.parse(options.body)]);
          globalThis.chargingActionSmokeSelected = path.endsWith('/charge-now');
          return syntheticChargingStatus();
        }
        return globalThis.chargingActionSmokeFetch(input, options);
      };
      globalThis.refreshLearningSmokeStatus()`);
    await until("document.getElementById('charger1-charge-now').disabled === false");
    await evaluate("document.getElementById('charger1-charge-now').click()");
    await until("document.getElementById('charger1-charge-now').getAttribute('aria-pressed') === 'true'");
    assert.deepEqual(await evaluate('globalThis.chargingActionSmokeWrites'), [
      ['/api/charging/chargers/charger1/charge-now', { association: 'synthetic-browser-charger', sessionId: 'synthetic-browser-session', revision: 1 }],
    ], 'One click requests immediate charging for exactly the displayed connection');
    assert.equal(await evaluate("document.getElementById('charger1-device').open"), false, 'Charge Now does not open the settings fold');
    assert.equal(await evaluate("document.getElementById('charger1-charge-now-hint').textContent"), 'Selected until unplugging');
    for (const width of [320, 390, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
      await evaluate("document.getElementById('charger1-device').scrollIntoView({block: 'center'})");
      assert.equal(await evaluate(`(() => {
        const summary = document.getElementById('charger1-device-summary').getBoundingClientRect();
        return ['charger1-charge-now', 'charger1-resume', 'charger1-control-message'].every(id => {
          const element = document.getElementById(id), box = element.getBoundingClientRect();
          return element.checkVisibility() && box.left >= summary.left && box.right <= summary.right
            && box.top >= summary.top && box.bottom <= summary.bottom;
        });
      })()`), true, `${width}px keeps the selected action, return to automatic and request status visible`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `charging-selected-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await evaluate("document.getElementById('charger1-resume').click()");
    await until("document.getElementById('charger1-charge-now').getAttribute('aria-pressed') === 'false'");
    assert.deepEqual(await evaluate('globalThis.chargingActionSmokeWrites[1]'), ['/api/charging/chargers/charger1/resume', {}]);
  } finally {
    await evaluate("if (globalThis.chargingActionSmokeFetch) globalThis.fetch = globalThis.chargingActionSmokeFetch; window.homeEnergyTheme.setTheme('dark'); window.scrollTo(0, 0)");
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  }
}
