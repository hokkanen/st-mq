import assert from 'node:assert/strict';
import { recordHeatPumpConfiguration } from '../../src/app/chart-heat-pump.js';

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
        } else if (date === '2026-09-05' && slot < 24) {
          const powerBasis = slot < 12 ? 'measured' : slot < 18 ? 'currents' : 'unknown';
          add('charger_power', slot < 12 ? 3 : 1, 'kW', from + slot * quarter, { powerBasis });
        }
      }
      if (date !== '2026-09-03') {
        recordHeatPumpConfiguration(store, 'providers', {
          heatPumpCompressorKw: date === '2026-09-04' ? 2 : 3, circulationKw: 0.08, auxRatedKw: 9,
        }, from);
        // Fresh original equipment states supply six hours on the partial day
        // and a complete day including valid zero consumption on the other.
        const minutes = date === '2026-09-04' ? 360 : 1440;
        for (let minute = 0; minute < minutes; minute += 5) {
          for (const [signal, value, unit] of [
            ['compressor_active', minute < 360 ? 1 : 0, 'state'], ['auxiliary_output', 0, '%'],
          ]) store.observation({ source: 'husdata-h66', device: 'synthetic-timing-equipment', signal, value, unit,
            sourceTime: from + minute * 60_000, receivedAt: from + minute * 60_000, quality: [],
            raw: { fixture: true, verified: true, usableForControl: true } });
        }
      }
      // Finish scalar power before the next day's independent current fixture.
      if (date === '2026-09-05') add('charger_power', null, 'kW', from + 24 * quarter);
      if (date === '2026-09-03') {
        for (let phase = 1; phase <= 3; phase++) add(`ev1_current_l${phase}`, null, 'A', from + 96 * quarter);
      }
    }
  });
}

export async function checkTimingBrowser({ command, evaluate, until, capture, context }) {
  const card = device => `.timing-device[data-device="${device}"]`;
  const detail = device => `.timing-device-detail[data-device="${device}"]`;
  const text = css => evaluate(`document.querySelector(${JSON.stringify(css)})?.textContent ?? ''`);
  const expanded = "document.getElementById('timing-details').open";
  const summary = '#timing-details > summary';
  const chooseDate = async date => {
    await evaluate(`document.getElementById('date-start').value=${JSON.stringify(date)}; document.getElementById('date-start').dispatchEvent(new Event('change')); true`);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === ${JSON.stringify(date)} && document.getElementById('history').dataset.rangeEnd === ${JSON.stringify(date)}`);
  };
  const key = value => command('input.performActions', { context, actions: [{ type: 'key', id: 'timing-keyboard',
    actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
  const tap = async css => {
    const point = JSON.parse(await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(css)});
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = element.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`));
    await command('input.performActions', { context, actions: [{ type: 'pointer', id: 'timing-touch', parameters: { pointerType: 'touch' },
      actions: [{ type: 'pointerMove', x: point.x, y: point.y, duration: 0 },
        { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
  };
  const checkFits = async () => {
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true,
      'Timing layout does not cause horizontal scrolling');
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('#timing-details .timing-device, #timing-details .timing-device-detail, #timing-details .timing-explanations, #timing-details .timing-source')).every(element => {
      const r = element.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1;
    })`), true, 'Inline explanations wrap inside their cards and the viewport');
  };
  const scrollTo = css => evaluate(`document.querySelector(${JSON.stringify(css)}).scrollIntoView({ block: 'start' }); true`);
  const checkOpen = expected => evaluate(expanded).then(actual => assert.equal(actual, expected,
    'Timing expansion follows the reader’s choice'));

  assert.equal(await evaluate("document.getElementById('timing-details').tagName"), 'DETAILS');
  assert.match(await text(summary), /Timing cost/i);
  await checkOpen(false);
  await evaluate(`window.timingFoldFixture = {
    details: document.getElementById('timing-details'), summary: document.querySelector(${JSON.stringify(summary)})
  }; true`);
  await chooseDate('2026-09-06');
  await checkOpen(false);
  await scrollTo(summary);
  await capture('home-energy-timing-folded-desktop');
  await evaluate(`document.querySelector(${JSON.stringify(summary)}).focus(); true`);
  await key('\uE007');
  await until(expanded);
  await key(' ');
  await until(`!${expanded}`);
  await key('\uE007');
  await until(expanded);
  assert.equal(await evaluate('document.activeElement === window.timingFoldFixture.summary'), true,
    'Native summary keeps keyboard focus while toggling');
  assert.equal(await evaluate("document.querySelectorAll('.timing-popover, #timing-benefit .timing-help, #timing-benefit button, #timing-benefit [role=dialog]').length"), 0,
    'Timing results and explanations are ordinary text without popup controls');

  assert.match(await text(card('heatPump')), /unavailable/i);
  assert.match(await text(`${card('charger')} .timing-amount`), /€[\d.]+/);
  assert.match(await text(`${card('charger')} .timing-coverage`), /100% of time included/,
    'Recorded zero current counts toward elapsed-time coverage');
  assert.match(await text(`${card('charger')} .timing-assumed`), /assumed rates/i);
  assert.match(await text('.timing-rate-explanation'), /nearest known contract rates/i);
  assert.match(await text('.timing-rate-explanation'), /historical spot prices/i);
  assert.match(await text(detail('charger')), /100%.*included time/i);
  assert.match(await text(card('charger')), /2026/);
  assert.match(await text('.timing-explanations'), /zero/i);
  assert.match(await text('.timing-explanations'), /how often the device ran/i);
  assert.match(await text('.timing-explanations'), /whole day|full.day|daily average/i);
  assert.match(await text('.timing-explanations'), /does not prove|not proven/i);
  assert.match(await text(card('heatPump')), /power|energy/i);
  await checkFits();
  await scrollTo(summary);
  await capture('home-energy-timing-historical-desktop');

  await chooseDate('2026-09-05');
  await checkOpen(true);
  assert.equal(await evaluate("document.getElementById('timing-details') === window.timingFoldFixture.details && document.querySelector('#timing-details > summary') === window.timingFoldFixture.summary"), true,
    'Changing dates updates the contents without replacing the fold or its summary');
  assert.equal(await evaluate('document.activeElement === window.timingFoldFixture.summary'), true,
    'Changing data preserves focus on the native summary');
  assert.match(await text(`${card('heatPump')} .timing-basis`), /operation estimate/i);
  assert.match(await text(`${detail('heatPump')} .timing-source[data-source="observed"]`), /100%/);
  assert.match(await text(detail('heatPump')), /reconstruct|recorded equipment/i);
  assert.match(await text(`${card('charger')} .timing-basis`), /mixed/i);
  for (const [source, share] of [['measured', '50%'], ['currents', '25%'], ['unknown', '25%']]) {
    const sourceText = await text(`${detail('charger')} .timing-source[data-source="${source}"]`);
    assert.ok(sourceText.includes(share), `${source} is weighted by included time, not observation count`);
    assert.match(sourceText, /included time/i);
    assert.match(sourceText, /2026/, 'Contributing dates remain next to each source explanation');
  }
  assert.match(await text(`${detail('charger')} .timing-source[data-source="measured"]`), /dedicated power/i);
  assert.match(await text(`${detail('charger')} .timing-source[data-source="currents"]`), /230 V/i);
  assert.match(await text(`${detail('charger')} .timing-source[data-source="unknown"]`), /not recorded/i);
  assert.equal(await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.timing-device')].map(element => element.getBoundingClientRect());
    const note = document.querySelector('.timing-explanations').getBoundingClientRect();
    const details = [...document.querySelectorAll('.timing-device-detail')].map(element => element.getBoundingClientRect());
    return cards.every(box => note.top >= box.bottom - 1) && details.every(box => box.top >= note.bottom - 1);
  })()`), true, 'Both results precede the shared explanations and the longer device details');

  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 640 }]) {
    await command('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 });
    for (const theme of ['dark', 'light']) {
      await evaluate(`if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) document.getElementById('theme-toggle').click(); true`);
      await checkOpen(true);
      await checkFits();
      const positions = JSON.parse(await evaluate(`JSON.stringify(['heatPump', 'charger'].map(device => {
        const r = document.querySelector('.timing-device[data-device="' + device + '"]').getBoundingClientRect();
        return { top: r.top, left: r.left, bottom: r.bottom };
      }))`));
      if (viewport.width === 1440) {
        assert.ok(Math.abs(positions[0].top - positions[1].top) < 1 && positions[0].left < positions[1].left,
          'Desktop presents heat pump left and charger right');
      } else if (viewport.width <= 390) {
        assert.ok(positions[1].top >= positions[0].bottom && Math.abs(positions[0].left - positions[1].left) < 1,
          'Narrow screens stack the device cards in reading order');
      }
      await scrollTo(summary);
      await capture(`home-energy-timing-${theme}-${viewport.width}`);
      await scrollTo(`${detail('charger')} .timing-source`);
      await capture(`home-energy-timing-evidence-${theme}-${viewport.width}`);
      await scrollTo('.timing-explanations');
      await capture(`home-energy-timing-explanations-${theme}-${viewport.width}`);
      await tap(summary);
      await until(`!${expanded}`);
      await capture(`home-energy-timing-folded-${theme}-${viewport.width}`);
      await tap(summary);
      await until(expanded);
    }
  }

  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await chooseDate('2026-09-04');
  await checkOpen(true);
  assert.match(await text(`${card('heatPump')} .timing-basis`), /operation estimate/i);
  assert.match(await text(`${card('heatPump')} .timing-coverage`), /25% of time included/);
  assert.match(await text(`${detail('heatPump')} .timing-source[data-source="observed"]`), /100%/);
  assert.match(await text(detail('heatPump')), /reconstruct|recorded equipment/i);
  await scrollTo(summary);
  await capture('home-energy-timing-reconstructed-desktop');
  await chooseDate('2026-09-03');
  await checkOpen(true);
  assert.equal(await evaluate("fetch('/api/chart?start=2026-09-03&end=2026-09-03').then(response => response.json()).then(data => data.meta.priceAssumptions.used)"), true);
  assert.match(await text(card('heatPump')), /unavailable/i);
  assert.match(await text(card('charger')), /unavailable/i);
  assert.match(await text(card('charger')), /price/i);
  assert.equal(await evaluate("document.querySelectorAll('#timing-benefit .timing-assumed').length"), 1,
    'The chart-level assumed-rate indication appears once when both comparisons are unavailable');
  assert.match(await text('.timing-rate-explanation'), /nearest known contract rates/i);
  assert.match(await text('.timing-chart-rates'), /No device comparison.*includes affected time/i);
  assert.doesNotMatch(await text('.timing-chart-rates'), /0% of included time/,
    'Chart-only assumptions do not present an irrelevant zero share of included device time');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  await checkFits();
  await scrollTo('.timing-chart-rates');
  await capture('home-energy-timing-chart-rates-mobile');
  await tap(summary);
  await until(`!${expanded}`);
  await evaluate("document.getElementById('range-today').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07'");
  await checkOpen(false);
  assert.equal(await evaluate("document.querySelector('.timing-chart-rates') === null && document.querySelector('.timing-rate-explanation') === null"), true,
    'Known-rate dates remove obsolete explanations about assumed contract rates');
  await tap(summary);
  await until(expanded);
  // Wait for a real background status poll while the reader leaves the fold open.
  await evaluate(`window.timingFoldFixture.fetch = window.fetch.bind(window);
    window.timingFoldFixture.polls = 0;
    window.fetch = async (...args) => {
      const response = await window.timingFoldFixture.fetch(...args);
      if (args[0] === '/api/status') window.timingFoldFixture.polls++;
      return response;
    }; true`);
  try {
    await until('window.timingFoldFixture.polls > 0', 650);
    await until("document.getElementById('history').dataset.ready === 'true'");
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    await checkOpen(true);
    assert.equal(await evaluate("document.getElementById('timing-details') === window.timingFoldFixture.details"), true,
      'Background polling preserves the native fold');
  } finally {
    await evaluate('window.fetch = window.timingFoldFixture.fetch; delete window.timingFoldFixture; true');
  }
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
}
