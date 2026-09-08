import assert from 'node:assert/strict';

// Invented observations only. These days deliberately separate operating evidence,
// missing telemetry, and incomplete prices without accessing a household database.
export function seedTimingBrowserFixture(store) {
  const quarter = 15 * 60_000;
  const add = (signal, value, unit, at, raw = {}) => store.observation({
    source: 'browser-fixture', device: 'synthetic-timing-evidence', signal, value, unit,
    sourceTime: at, receivedAt: at, quality: ['estimated'], raw: { fixture: true, ...raw },
  });
  store.transaction(() => {
    for (const date of ['2026-09-03', '2026-09-04', '2026-09-05']) {
      const from = Date.parse(`${date}T00:00:00+03:00`);
      for (let slot = 0; slot < 96; slot++) {
        if (date !== '2026-09-03' || slot !== 67) {
          add('spot_price', slot < 24 ? 0 : 20, 'c/kWh_ex_vat', from + slot * quarter);
        }
        if (date === '2026-09-03') {
          for (let phase = 1; phase <= 3; phase++) add(`ev1_current_l${phase}`, slot < 4 ? 10 : 0, 'A', from + slot * quarter);
        } else if (date === '2026-09-04' && slot <= 24) {
          add('heat_pump_power', slot < 24 ? 2 : null, 'kW', from + slot * quarter,
            { basis: 'estimated', powerBasis: 'modelled', compressorObserved: false, auxiliaryObserved: false, auxiliaryAssumed: true });
        } else if (date === '2026-09-05') {
          const metadata = [
            { basis: 'measured', powerBasis: 'measured' },
            { basis: 'estimated', compressorObserved: true, auxiliaryObserved: false },
            { basis: 'estimated', powerBasis: 'modelled', compressorObserved: false, auxiliaryObserved: false, auxiliaryAssumed: true },
            { basis: 'estimated' },
          ][Math.floor(slot / 24)];
          add('heat_pump_power', slot < 24 ? 3 : 1, 'kW', from + slot * quarter, metadata);
        }
      }
      // End the day explicitly so the next test day does not inherit power.
      if (date === '2026-09-05') add('heat_pump_power', null, 'kW', from + 96 * quarter);
      if (date === '2026-09-03') {
        for (let phase = 1; phase <= 3; phase++) add(`ev1_current_l${phase}`, null, 'A', from + 96 * quarter);
      }
    }
  });
}

export async function checkTimingBrowser({ command, evaluate, until, capture, context }) {
  const selector = (device, detail) => `.timing-device[data-device="${device}"] .timing-help[data-detail="${detail}"]`;
  const card = device => `.timing-device[data-device="${device}"]`;
  const text = css => evaluate(`document.querySelector(${JSON.stringify(css)})?.textContent ?? ''`);
  const visible = "!!document.querySelector('.timing-popover:not([hidden])')";
  const closed = "!document.querySelector('.timing-popover:not([hidden])')";
  const click = css => evaluate(`document.querySelector(${JSON.stringify(css)}).click(); true`);
  const chooseDate = async date => {
    await evaluate(`document.getElementById('date-start').value=${JSON.stringify(date)}; document.getElementById('date-start').dispatchEvent(new Event('change')); true`);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === ${JSON.stringify(date)} && document.getElementById('history').dataset.rangeEnd === ${JSON.stringify(date)}`);
  };
  const pointAt = async (css, pointerType = 'mouse', press = false) => {
    const point = JSON.parse(await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(css)});
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = element.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`));
    await command('input.performActions', { context, actions: [{ type: 'pointer', id: pointerType, parameters: { pointerType },
      actions: [{ type: 'pointerMove', x: point.x, y: point.y, duration: 0 },
        ...(press ? [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] : [])] }] });
  };
  const escape = async () => {
    await command('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard',
      actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }] });
    await until(closed);
  };
  const checkFits = async () => {
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Timing layout does not cause horizontal scrolling');
    assert.equal(await evaluate(`(() => {
      const popup = document.querySelector('.timing-popover:not([hidden])');
      if (!popup) return true;
      const r = popup.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    })()`), true, 'Timing explanation remains inside viewport');
  };

  await chooseDate('2026-09-06');
  await evaluate("document.getElementById('timing-benefit').scrollIntoView({ block: 'center' }); true");
  await capture('home-energy-timing-historical-desktop');
  assert.match(await text(card('heatPump')), /unavailable/i);
  assert.match(await text(card('charger')), /€[\d.]+/);
  assert.match(await text(selector('charger', 'coverage')), /100% of time included/,
    'Recorded zero current counts toward elapsed-time coverage');
  assert.equal(await evaluate("document.querySelector('.timing-price-caution') === null"), true,
    'Contract assumption explanation is in the contextual popup');
  await pointAt(selector('charger', 'rates'));
  await until(visible);
  assert.match(await text('.timing-popover'), /nearest known contract rates/i);
  assert.match(await text('.timing-popover'), /historical spot prices/i);
  assert.match(await text('.timing-popover'), /100%/);
  assert.match(await text('.timing-popover'), /2026/);
  await escape();
  await evaluate(`document.querySelector(${JSON.stringify(selector('charger', 'coverage'))}).focus(); true`);
  await until(visible);
  assert.match(await text('.timing-popover'), /zero/i);
  assert.match(await text('.timing-popover'), /how often the device ran/i);
  await escape();
  await click(selector('heatPump', 'unavailable'));
  await until(visible);
  assert.match(await text('.timing-popover'), /power|energy/i);

  await chooseDate('2026-09-05');
  await until(closed);
  assert.match(await text(selector('heatPump', 'evidence')), /mixed/i);
  await click(selector('heatPump', 'evidence'));
  await until(visible);
  for (const key of ['measured', 'observed', 'modelled', 'unknown']) {
    assert.match(await text(`.timing-source[data-source="${key}"]`), /25%/,
      `${key} is weighted by included time, not observation count`);
  }
  assert.match(await text('.timing-popover'), /included time/i);
  assert.match(await text('.timing-popover'), /2026/);
  await checkFits();
  await capture('home-energy-timing-evidence-desktop');
  await escape();

  for (const theme of ['dark', 'light']) {
    await evaluate(`if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) document.getElementById('theme-toggle').click(); true`);
    await evaluate("document.getElementById('timing-benefit').scrollIntoView({ block: 'center' }); true");
    await capture(`home-energy-timing-${theme}-desktop`);
    const positions = JSON.parse(await evaluate(`JSON.stringify(['heatPump', 'charger'].map(device => {
      const r = document.querySelector('.timing-device[data-device="' + device + '"]').getBoundingClientRect();
      return { top: r.top, left: r.left };
    }))`));
    assert.ok(Math.abs(positions[0].top - positions[1].top) < 1 && positions[0].left < positions[1].left,
      'Desktop presents heat pump left and charger right');
  }

  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 640 }]) {
    await command('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 });
    for (const theme of ['dark', 'light']) {
      await evaluate(`if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) document.getElementById('theme-toggle').click(); true`);
      await pointAt(selector('heatPump', 'evidence'), 'touch', true);
      await until(visible);
      await checkFits();
      await capture(`home-energy-timing-evidence-${theme}-${viewport.width}`);
      // A real touch outside the popup dismisses it.
      await command('input.performActions', { context, actions: [{ type: 'pointer', id: 'touch', parameters: { pointerType: 'touch' },
        actions: [{ type: 'pointerMove', x: 1, y: 1, duration: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
      await until(closed);
      await evaluate("document.getElementById('timing-benefit').scrollIntoView({ block: 'center' }); true");
      await checkFits();
      await capture(`home-energy-timing-${theme}-${viewport.width}`);
    }
  }

  await evaluate(`document.querySelector(${JSON.stringify(selector('heatPump', 'evidence'))}).focus(); true`);
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard',
    actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  await until("document.activeElement.classList.contains('timing-popover-content')");
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard',
    actions: [{ type: 'keyDown', value: '\uE010' }, { type: 'keyUp', value: '\uE010' }] }] });
  await until("document.querySelector('.timing-popover-content').scrollTop > 0");
  await escape();
  assert.equal(await evaluate(`document.activeElement.matches(${JSON.stringify(selector('heatPump', 'evidence'))})`), true,
    'Escape returns keyboard focus to the explanation trigger');
  await pointAt(selector('heatPump', 'evidence'), 'touch', true);
  await until(visible);
  await pointAt('.timing-popover-close', 'touch', true);
  await until(closed);
  await click(selector('heatPump', 'evidence'));
  await until(visible);
  await evaluate("document.getElementById('date-start').focus(); true");
  await until(closed);

  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await chooseDate('2026-09-04');
  assert.match(await text(selector('heatPump', 'evidence')), /model/i);
  assert.match(await text(selector('heatPump', 'coverage')), /25% of time included/);
  await click(selector('heatPump', 'evidence'));
  await until(visible);
  assert.match(await text('.timing-source[data-source="modelled"]'), /100%/);
  assert.match(await text('.timing-popover'), /thermal model|predicted/i);
  await capture('home-energy-timing-modelled-desktop');
  await chooseDate('2026-09-03');
  await until(closed);
  assert.equal(await evaluate("fetch('/api/chart?start=2026-09-03&end=2026-09-03').then(response => response.json()).then(data => data.meta.priceAssumptions.used)"), true);
  assert.match(await text(card('heatPump')), /unavailable/i);
  assert.match(await text(card('charger')), /unavailable/i);
  assert.equal(await evaluate("document.querySelectorAll('#timing-benefit .timing-assumed').length"), 1,
    'The chart-level assumed-rate indication appears once when both device comparisons are unavailable');
  assert.equal(await evaluate("document.querySelectorAll('.timing-chart-rates .timing-help').length"), 1);
  await click(selector('charger', 'unavailable'));
  await until(visible);
  assert.match(await text('.timing-popover'), /price/i);
  await escape();
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  await pointAt('.timing-chart-rates .timing-help', 'touch', true);
  await until(visible);
  assert.match(await text('.timing-popover'), /nearest known contract rates/i);
  assert.match(await text('.timing-popover'), /No device comparison.*includes affected time/i);
  assert.doesNotMatch(await text('.timing-popover'), /0% of included time/,
    'Chart-only assumptions do not present an irrelevant zero share of included device time');
  await checkFits();
  await capture('home-energy-timing-chart-rates-mobile');
  await pointAt('.timing-popover-close', 'touch', true);
  await until(closed);
  await pointAt('.timing-chart-rates .timing-help', 'touch', true);
  await until(visible);
  await evaluate("document.getElementById('range-today').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07'");
  await until(closed);
  assert.equal(await evaluate("document.querySelector('.timing-chart-rates') === null"), true,
    'Known-rate date selections remove the chart assumption indication');
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
}
