import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Runs only against the disposable synthetic server created by browser-garage-smoke.
export async function checkChargingPriority({ send, evaluate, until, artifacts }) {
  const entryIds = ['charger1-shared-priority', 'charger2-shared-priority'];
  await until("typeof globalThis.refreshLearningSmokeStatus === 'function'");
  assert.deepEqual(await evaluate(`${JSON.stringify(entryIds)}.map(id => {
    const entry = document.getElementById(id), device = entry.closest('#charging-devices > details');
    return [entry.tagName, device?.id, !device.querySelector('summary').contains(entry), entry.getAttribute('aria-haspopup')];
  })`), [['BUTTON', 'charger1-device', true, 'dialog'], ['BUTTON', 'charger2-device', true, 'dialog']],
  'Persistent shared priority is edited from either charger’s details');
  await evaluate("document.getElementById('charger1-device').open = true; document.getElementById('charger1-shared-priority').click()");
  assert.equal(await evaluate("document.getElementById('charging-priority-dialog').open"), true);
  assert.match(await evaluate("document.getElementById('charging-priority-description').textContent"), /until you change it.*after unplugging/);
  await evaluate("document.getElementById('charging-priority-cancel').click()");
  try {
    for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width <= 390 ? 844 : 1100, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.homeEnergyTheme.setTheme('${theme}');
        document.querySelectorAll('#charging-devices > details').forEach(device => device.open = false);
        document.getElementById('charger1-device').scrollIntoView({ block: 'center' })`);
      const actions = await evaluate(`['charger1', 'charger2'].map(id => {
        const device = document.getElementById(id + '-device'), summary = device.querySelector('summary');
        const button = document.getElementById(id + '-charge-now'), bounds = button.getBoundingClientRect(), card = summary.getBoundingClientRect();
        const state = document.getElementById(id + '-charge-now-state'), range = document.createRange(); range.selectNodeContents(button);
        return { id, visible: button.checkVisibility(), caption: button.textContent, accessibleName: button.getAttribute('aria-label'),
          state: state.textContent, stateHidden: state.getAttribute('aria-hidden'), pressed: button.getAttribute('aria-pressed'), height: bounds.height,
          labelsFit: [...range.getClientRects()].every(rect => rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom),
          fits: bounds.left >= card.left && bounds.right <= card.right && bounds.top >= card.top && bounds.bottom <= card.bottom,
          rightAligned: bounds.left + bounds.width / 2 > card.left + card.width / 2,
          priorityHidden: !document.getElementById(id + '-shared-priority').checkVisibility() };
      })`);
      for (const action of actions) {
        assert(action.visible && action.fits && action.rightAligned && action.priorityHidden, `${width}px ${theme}: ${action.id} exposes Charge now at the top right: ${JSON.stringify(action)}`);
        assert.match(action.caption, /^Charge now\s*(ON|OFF)$/); assert.equal(action.accessibleName, 'Charge now');
        assert.equal(action.state, action.pressed === 'true' ? 'ON' : 'OFF'); assert.equal(action.stateHidden, 'true');
        assert(action.labelsFit, 'The label and explicit state fit inside the button');
        assert.equal(action.height, 44, 'The immediate-charge button keeps its original touch-target height');
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${width}px ${theme} has no horizontal overflow`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `charging-actions-${width}-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    // Stub only this disposable page’s charging actions, so touch/keyboard
    // behavior can be checked without authorizing any physical integration.
    await evaluate(`globalThis.chargingActionSmokeFetch = globalThis.fetch;
      globalThis.chargingActionSmokeSelected = false;
      globalThis.chargingActionSmokeAutomatic = false;
      globalThis.chargingActionSmokePriority = 'balanced';
      globalThis.chargingActionSmokeRevision = 0;
      globalThis.chargingActionSmokeWrites = [];
      const syntheticChargingStatus = async () => {
        const status = await globalThis.chargingActionSmokeFetch('/api/status').then(response => response.json());
        const charger = status.charging.chargers.find(item => item.id === 'charger1');
        charger.settings.enabled = globalThis.chargingActionSmokeAutomatic;
        charger.controls = { enabled: globalThis.chargingActionSmokeAutomatic, revision: globalThis.chargingActionSmokeRevision };
        status.charging.settings.priority = globalThis.chargingActionSmokePriority;
        status.charging.controls = { priority: globalThis.chargingActionSmokePriority, revision: globalThis.chargingActionSmokeRevision };
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
        if ((path.startsWith('/api/charging/chargers/charger1/') || path === '/api/charging/settings') && options?.method === 'POST') {
          if (globalThis.chargingActionSmokeDelay) await new Promise(resolve => { globalThis.chargingActionSmokeFinish = resolve; });
          const payload = JSON.parse(options.body);
          globalThis.chargingActionSmokeWrites.push([path, payload]);
          if (path === '/api/charging/settings') globalThis.chargingActionSmokePriority = payload.priority;
          else if (path.endsWith('/charge-now') || path.endsWith('/resume')) globalThis.chargingActionSmokeSelected = path.endsWith('/charge-now');
          if (path.endsWith('/control')) globalThis.chargingActionSmokeAutomatic = payload.enabled;
          if (path.endsWith('/control') || path === '/api/charging/settings') globalThis.chargingActionSmokeRevision += 1;
          return syntheticChargingStatus();
        }
        return globalThis.chargingActionSmokeFetch(input, options);
      };
      globalThis.refreshLearningSmokeStatus()`);
    await until("document.getElementById('charger1-charge-now').disabled === false");
    assert.equal(await evaluate("document.getElementById('charger1-enabled').getAttribute('aria-checked')"), 'false', 'Charge now is available with automatic charging OFF');
    assert.equal(await evaluate("document.getElementById('charger1-charge-now').title"), 'Turn on immediate charging until unplugging.');
    const actionLayout = async (width, theme) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.homeEnergyTheme.setTheme('${theme}'); document.getElementById('charger1-device').scrollIntoView({block: 'center'})`);
      return evaluate(`(() => {
        const summary = document.getElementById('charger1-device-summary'), box = summary.getBoundingClientRect();
        const button = document.getElementById('charger1-charge-now'), bounds = button.getBoundingClientRect();
        const state = document.getElementById('charger1-charge-now-state'), range = document.createRange(); range.selectNodeContents(button);
        return { height: box.height, buttonHeight: bounds.height, buttonWidth: bounds.width,
          background: getComputedStyle(button).backgroundColor, state: state.textContent,
          knobTransform: getComputedStyle(state, '::after').transform,
          labelsFit: [...range.getClientRects()].every(rect => rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom),
          fits: bounds.left >= box.left && bounds.right <= box.right && bounds.top >= box.top && bounds.bottom <= box.bottom,
          hasSecondAction: summary.contains(document.getElementById('charger1-resume')),
          hasMessage: document.getElementById('charger1-control-message').checkVisibility() };
      })()`);
    };
    const layouts = new Map();
    for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light'])
      layouts.set(`${width}:${theme}`, await actionLayout(width, theme));
    await evaluate("globalThis.chargingActionSmokeDelay = true; document.getElementById('charger1-charge-now').click()");
    await until("typeof globalThis.chargingActionSmokeFinish === 'function'");
    assert.equal(await evaluate("document.getElementById('charger1-charge-now').disabled"), true);
    for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light'])
      assert.deepEqual(await actionLayout(width, theme), layouts.get(`${width}:${theme}`), 'Saving keeps the card layout unchanged');
    await evaluate("globalThis.chargingActionSmokeDelay = false; globalThis.chargingActionSmokeFinish()");
    await until("document.getElementById('charger1-charge-now').getAttribute('aria-pressed') === 'true' && !document.getElementById('charger1-charge-now').disabled");
    assert.deepEqual(await evaluate('globalThis.chargingActionSmokeWrites'), [
      ['/api/charging/chargers/charger1/charge-now', { association: 'synthetic-browser-charger', sessionId: 'synthetic-browser-session', revision: 1 }],
    ], 'One click requests immediate charging for exactly the displayed connection');
    assert.equal(await evaluate("document.getElementById('charger1-device').open"), false, 'Charge now does not open the settings fold');
    assert.equal(await evaluate("document.getElementById('charger1-charge-now').title"), 'Charge now is on until unplugging. Turn off to use automatic charging.');
    for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
      const layout = await actionLayout(width, theme), before = layouts.get(`${width}:${theme}`);
      assert(layout.fits && !layout.hasSecondAction && !layout.hasMessage, `${width}px ${theme}: only the toggle occupies the action area`);
      assert.equal(layout.state, 'ON', 'The selected request remains explicit even when the vehicle is not charging');
      assert.equal(before.state, 'OFF'); assert(layout.labelsFit); assert.equal(layout.buttonHeight, 44);
      assert.notEqual(layout.background, before.background, 'Selected Charge now has a distinct fill');
      assert.notEqual(layout.knobTransform, before.knobTransform, 'The switch thumb moves when Charge now is on');
      assert.deepEqual({ ...layout, background: before.background, state: before.state, knobTransform: before.knobTransform }, before,
        'Selected Charge now keeps the card and button dimensions');
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `charging-selected-${width}-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await evaluate("document.getElementById('charger1-charge-now').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until("document.getElementById('charger1-charge-now').getAttribute('aria-pressed') === 'false' && globalThis.chargingActionSmokeWrites.length === 3 && !document.getElementById('charger1-charge-now').disabled");
    assert.equal(await evaluate("document.getElementById('charger1-device').open"), false, 'Keyboard toggling keeps details closed');
    for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light'])
      assert.deepEqual(await actionLayout(width, theme), layouts.get(`${width}:${theme}`), 'Returning to automatic restores the original button and card layout');
    assert.deepEqual(await evaluate('globalThis.chargingActionSmokeWrites[1]'), ['/api/charging/chargers/charger1/control', { association: 'synthetic-browser-charger', revision: 0, enabled: true }]);
    assert.deepEqual(await evaluate('globalThis.chargingActionSmokeWrites[2]'), ['/api/charging/chargers/charger1/resume', {}]);
    assert.equal(await evaluate("document.getElementById('charger1-enabled').getAttribute('aria-checked')"), 'true');
    await evaluate("document.getElementById('charger1-charge-now').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await until("document.getElementById('charger1-charge-now').getAttribute('aria-pressed') === 'true' && globalThis.chargingActionSmokeWrites.length === 4 && !document.getElementById('charger1-charge-now').disabled");
    assert.equal(await evaluate("document.getElementById('charger1-charge-now-state').textContent"), 'ON', 'Space turns Charge now on');
    assert.equal(await evaluate("document.getElementById('charger1-device').open"), false);
    await evaluate("document.getElementById('charger1-charge-now').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until("document.getElementById('charger1-charge-now').getAttribute('aria-pressed') === 'false' && globalThis.chargingActionSmokeWrites.length === 5 && !document.getElementById('charger1-charge-now').disabled");
    assert.equal(await evaluate("document.getElementById('charger1-charge-now-state').textContent"), 'OFF', 'Enter turns Charge now off');
    assert.equal(await evaluate("document.getElementById('charger1-device').open"), false);
    assert.deepEqual(await evaluate('globalThis.chargingActionSmokeWrites.slice(3)'), [
      ['/api/charging/chargers/charger1/charge-now', { association: 'synthetic-browser-charger', sessionId: 'synthetic-browser-session', revision: 1 }],
      ['/api/charging/chargers/charger1/resume', {}],
    ], 'Keyboard input toggles the same session request in both directions');
    await evaluate("document.getElementById('charger1-device').open = true; document.getElementById('charger1-shared-priority').click(); document.getElementById('charging-priority-charger2').click(); document.getElementById('charging-priority-save').click()");
    await until("!document.getElementById('charging-priority-dialog').open");
    assert.deepEqual(await evaluate("['charger1', 'charger2'].map(id => document.getElementById(id + '-shared-priority-value').textContent)"), ['Charger 2', 'Charger 2']);
    const priorityWrite = await evaluate('globalThis.chargingActionSmokeWrites[5]');
    assert.equal(priorityWrite[0], '/api/charging/settings'); assert.equal(priorityWrite[1].priority, 'charger2');
    assert.equal(priorityWrite[1].revision, 1); assert.equal(priorityWrite[1].associations.charger1, 'synthetic-browser-charger');
    await evaluate("document.getElementById('charger1-enabled').click()");
    await until("document.getElementById('charger1-enabled').getAttribute('aria-checked') === 'false'");
    assert.equal(await evaluate("document.getElementById('charger1-charge-now').disabled"), false);

  } finally {
    await evaluate("if (globalThis.chargingActionSmokeFetch) globalThis.fetch = globalThis.chargingActionSmokeFetch; window.homeEnergyTheme.setTheme('dark'); window.scrollTo(0, 0)");
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  }
}
