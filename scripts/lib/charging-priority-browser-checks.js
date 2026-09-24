import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Runs only against the disposable synthetic server created by browser-garage-smoke.
export async function checkChargingPriority({ send, evaluate, until, keyPress, artifacts }) {
  const entryIds = ['charger1-shared-priority', 'charger2-shared-priority'];
  const radioId = priority => `charging-priority-${priority}`;
  const selected = priority => `document.getElementById('${radioId(priority)}').checked`;
  const labels = { balanced: /Balanced/, charger1: /Charger 1/, charger2: /Charger 2/ };
  const geometry = () => evaluate(`['#garage-control', '#charger1-device', '#charger2-device',
    '#charger1-device > summary', '#charger2-device > summary'].map(selector => {
      const { width, height } = document.querySelector(selector).getBoundingClientRect();
      return { selector, width, height };
    })`);
  const assertSameGeometry = (actual, expected, description) => {
    for (let index = 0; index < expected.length; index++) {
      assert.ok(Math.abs(actual[index].width - expected[index].width) <= 1
        && Math.abs(actual[index].height - expected[index].height) <= 1,
      `${description}: ${expected[index].selector} keeps its dimensions`);
    }
  };
  const open = async charger => {
    await evaluate(`document.getElementById('charger${charger}-device').open = true;
      document.getElementById('charger${charger}-shared-priority').focus()`);
    await keyPress('Enter');
    await until("document.getElementById('charging-priority-dialog')?.open");
    assert.equal(await evaluate("document.getElementById('charging-priority-dialog').parentElement === document.body"), true,
      'The shared priority dialog lives outside the Garage card layout');
    assert.equal(await evaluate("document.getElementById('charging-priority-dialog').matches(':modal')"), true,
      'Priority opens as a native modal above the dashboard');
    assert.equal(await evaluate("document.getElementById('charging-priority-dialog').contains(document.activeElement)"), true,
      'Opening priority puts keyboard focus inside the dialog');
  };
  const close = async (charger, escape = false) => {
    if (escape) await keyPress('Escape');
    else await evaluate("document.getElementById('charging-priority-cancel').click()");
    await until("!document.getElementById('charging-priority-dialog').open");
    assert.equal(await evaluate(`document.activeElement === document.getElementById('charger${charger}-shared-priority')`), true,
      'Closing priority returns keyboard focus to the charger that opened it');
  };
  const readPriority = () => evaluate("fetch('/api/status').then(response => response.json()).then(status => status.charging.settings.priority)");
  await until("typeof globalThis.refreshLearningSmokeStatus === 'function'");
  assert.equal(await evaluate("document.getElementById('charging-priority')"), null,
    'There is no standalone priority selector in the Garage overview');
  assert.deepEqual(await evaluate(`${JSON.stringify(entryIds)}.map(id => {
    const entry = document.getElementById(id), device = entry.closest('#charging-devices > details');
    return [entry.tagName, entry.type, device?.id, !device.querySelector('summary').contains(entry)];
  })`), [['BUTTON', 'button', 'charger1-device', true], ['BUTTON', 'button', 'charger2-device', true]],
  'Each charger exposes the same shared setting inside its details');
  assert.equal(await readPriority(), 'balanced');
  await evaluate(`globalThis.prioritySmokeFetch = globalThis.fetch;
    globalThis.prioritySmokeWrites = []; globalThis.prioritySmokeReads = 0;
    globalThis.fetch = async (input, options) => {
      const path = new URL(input.url ?? String(input), location.href).pathname;
      if (path === '/api/charging/settings' && options?.method === 'POST')
        globalThis.prioritySmokeWrites.push(JSON.parse(options.body));
      const response = await globalThis.prioritySmokeFetch(input, options);
      if (path === '/api/status') globalThis.prioritySmokeReads++;
      return response;
    }`);
  try {
    for (const charger of [1, 2]) {
      await open(charger);
      assert.equal(await evaluate(selected('balanced')), true);
      const current = await evaluate("document.getElementById('charging-priority-current').textContent");
      assert.match(current, labels.balanced);
      if (charger === 1) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        assert.equal(await evaluate(selected('charger1')), true, 'Native arrow keys select a draft priority');
      } else await evaluate(`document.getElementById('${radioId('charger1')}').click()`);
      const reads = await evaluate('globalThis.prioritySmokeReads');
      await evaluate('globalThis.refreshLearningSmokeStatus()');
      await until(`globalThis.prioritySmokeReads > ${reads}`);
      assert.equal(await evaluate(selected('charger1')), true, 'Status refresh preserves the draft priority');
      assert.equal(await evaluate("document.getElementById('charging-priority-current').textContent"), current,
        'The saved priority remains distinct from the draft choice');
      assert.equal(await readPriority(), 'balanced', 'Choosing a radio does not save immediately');
      assert.deepEqual(await evaluate('globalThis.prioritySmokeWrites'), []);
      await close(charger);
      await open(charger);
      assert.equal(await evaluate(selected('balanced')), true, 'Cancel discards the draft');
      await evaluate(`document.getElementById('${radioId('charger2')}').click()`);
      await close(charger, true);
      await open(charger);
      assert.equal(await evaluate(selected('balanced')), true, 'Escape discards the draft');
      await close(charger);
    }
    for (const [charger, priority] of [[1, 'charger1'], [2, 'charger2'], [1, 'balanced']]) {
      await open(charger);
      await evaluate(`document.getElementById('${radioId(priority)}').click();
        document.getElementById('charging-priority-save').click()`);
      await until("!document.getElementById('charging-priority-dialog').open");
      assert.equal(await evaluate(`document.activeElement === document.getElementById('charger${charger}-shared-priority')`), true,
        'Saving returns focus to the opening charger');
      assert.equal(await readPriority(), priority, 'Explicit Save persists the shared setting');
      const captions = await evaluate(`${JSON.stringify(entryIds)}.map(id => document.getElementById(id + '-value').textContent)`);
      assert.equal(captions[0], captions[1], 'Both chargers display the same saved priority');
      assert.match(captions[0], labels[priority]);
      const other = charger === 1 ? 2 : 1;
      await open(other);
      assert.equal(await evaluate(selected(priority)), true, 'The other charger opens the same saved setting');
      assert.match(await evaluate("document.getElementById('charging-priority-current').textContent"), labels[priority]);
      await close(other);
    }
    assert.deepEqual(await evaluate('globalThis.prioritySmokeWrites'),
      [{ priority: 'charger1' }, { priority: 'charger2' }, { priority: 'balanced' }],
      'Only the three explicit saves send a shared priority mutation');

    for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width <= 390 ? 844 : 1100, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.homeEnergyTheme.setTheme('${theme}');
        document.querySelectorAll('#charging-devices > details').forEach(device => device.open = false)`);
      const closed = await geometry();
      await evaluate(`${JSON.stringify(entryIds)}.forEach(id => document.getElementById(id).hidden = true)`);
      assertSameGeometry(await geometry(), closed, `${width}px ${theme} closed cards with priority entries removed`);
      await evaluate(`${JSON.stringify(entryIds)}.forEach(id => document.getElementById(id).hidden = false)`);
      assertSameGeometry(await geometry(), closed, `${width}px ${theme} closed cards with priority entries restored`);
      assert.equal(await evaluate(`${JSON.stringify(entryIds)}.every(id => !document.getElementById(id).checkVisibility())`), true,
        'Shared priority entries remain invisible while charger details are closed');
      await evaluate("document.getElementById('charger1-device').open = true");
      const expanded = await geometry();
      await open(1);
      assertSameGeometry(await geometry(), expanded, `${width}px ${theme} open priority dialog`);
      const layout = await evaluate(`(() => {
        const dialog = document.getElementById('charging-priority-dialog'), bounds = dialog.getBoundingClientRect();
        const controls = [...dialog.querySelectorAll('input, button')].map(control => {
          const box = control.getBoundingClientRect();
          return { id: control.id, fits: box.left >= bounds.left && box.right <= bounds.right
            && box.top >= bounds.top && box.bottom <= bounds.bottom };
        });
        return { inViewport: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
          noHorizontalOverflow: dialog.scrollWidth <= dialog.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth,
          compactOptions: [...dialog.querySelectorAll('input[type=radio]')].every(input => {
            const radio = input.getBoundingClientRect(), text = input.parentElement.lastElementChild.getBoundingClientRect();
            return radio.height <= 20 && radio.right < text.left && Math.abs(radio.top - text.top) <= 5;
          }),
          singleLineActions: [...dialog.querySelectorAll('button')].every(button => {
            const range = document.createRange(); range.selectNodeContents(button);
            return range.getClientRects().length === 1;
          }), controls };
      })()`);
      assert.equal(layout.inViewport && layout.noHorizontalOverflow, true,
        `${width}px ${theme} priority dialog fits the viewport without horizontal scrolling`);
      assert.equal(layout.compactOptions && layout.singleLineActions, true,
        `${width}px ${theme} radio options stay beside their text and action labels stay on one line`);
      assert.deepEqual(layout.controls.filter(control => !control.fits), [],
        `${width}px ${theme} priority choices and actions fit inside the dialog`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `charging-priority-${width}-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
      await close(1, true);
      assertSameGeometry(await geometry(), expanded, `${width}px ${theme} dismissed priority dialog`);
      await evaluate("document.querySelectorAll('#charging-devices > details').forEach(device => device.open = false)");
      assertSameGeometry(await geometry(), closed, `${width}px ${theme} returned closed cards`);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.homeEnergyTheme.setTheme('dark')");
    await open(1);
    await evaluate("document.getElementById('charging-priority-charger2').click()");
    for (const action of ['save', 'cancel']) {
      assert.equal(await evaluate(`(() => {
        const button = document.getElementById('charging-priority-${action}'); button.focus();
        const bounds = button.getBoundingClientRect(), dialog = document.getElementById('charging-priority-dialog').getBoundingClientRect();
        return bounds.top >= Math.max(0, dialog.top) && bounds.bottom <= Math.min(innerHeight, dialog.bottom)
          && document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === button;
      })()`), true, `The ${action} action is reachable with keyboard focus in a short 320×640 viewport`);
    }
    const shortScreenshot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, 'charging-priority-320-short-dark.png'), Buffer.from(shortScreenshot.data, 'base64'));
    await close(1, true);
    assert.equal(await readPriority(), 'balanced', 'Inspecting a short viewport preserves the saved priority');
  } finally {
    await evaluate(`globalThis.fetch = globalThis.prioritySmokeFetch;
      delete globalThis.prioritySmokeFetch; delete globalThis.prioritySmokeWrites; delete globalThis.prioritySmokeReads;
      document.getElementById('charging-priority-dialog').close();
      document.querySelectorAll('#charging-devices > details').forEach(device => device.open = false);
      ${JSON.stringify(entryIds)}.forEach(id => document.getElementById(id).hidden = false);
      window.homeEnergyTheme.setTheme('dark'); window.scrollTo(0, 0)`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  }
}
