import assert from 'node:assert/strict';
import { recordHeatPumpConfiguration } from '../../src/app/chart-heat-pump.js';
import { Recorder } from '../../src/storage/recorder.js';

// Invented observations only. These days deliberately separate operating evidence,
// missing telemetry, and incomplete prices without accessing a household database.
export function seedTimingBrowserFixture(store) {
  const historicalStart = Date.parse('2026-09-06T00:00:00+03:00');
  store.transaction(() => {
    for (let slot = 0; slot <= 96; slot++) {
      const at = historicalStart + slot * 15 * 60_000;
      const add = (signal, value, unit) => store.observation({ source: 'browser-fixture',
        device: 'synthetic-historical-charger', signal, value, unit,
        sourceTime: at, receivedAt: at, quality: [], raw: { fixture: true } });
      if (slot < 96) add('spot_price', slot < 4 ? 0 : 20, 'c/kWh_ex_vat');
      if(slot<96)for(let phase=1;phase<=3;phase++)store.observation({source:'easee',device:'synthetic-historical-charger',
        signal:`ev1_energy_l${phase}`,value:slot<4?6.9/12:0,unit:'kWh',sourceTime:at+15*60_000,receivedAt:at+15*60_000,
        quality:['estimated'],raw:{intervalStart:at,intervalEnd:at+15*60_000}});
    }
  });
  const quarter = 15 * 60_000;
  const recorder = new Recorder(store);
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
        } else if (date === '2026-09-05' && slot < 48) {
          // Current snapshots precede the first saved energy interval. Six hours
          // of later standby intervals remain idle; unrecorded hours stay unknown.
          const at=from+slot*quarter,power=slot<12?3:slot<24?1:.05;
          if(slot<12)for(let phase=1;phase<=3;phase++)add(`ev1_current_l${phase}`,power/(3*.23),'A',at);
          else recorder.recordEnergy({source:'easee',device:'synthetic-timing-charger',prefix:'ev1',
            start:at,end:at+quarter,receivedAt:at+quarter,energies:Array(3).fill(power/12),
            powers:Array(3).fill(power/3),quality:['estimated']});
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
      if (date === '2026-09-03') {
        for (let phase = 1; phase <= 3; phase++) add(`ev1_current_l${phase}`, null, 'A', from + 96 * quarter);
      }
    }
    // Invented saved assessments exercise the model comparison independently of
    // timing telemetry, including a complete recovery across Finnish midnight.
    const cycle = (id, startedAt, endedAt, assessment, status = 'completed') => store.cycle('providers', {
      id: `synthetic-browser-${id}`, status, startedAt: Date.parse(`${startedAt}+03:00`),
      endedAt: Date.parse(`${endedAt}+03:00`),
      ...(assessment ? { assessment: { basis: 'estimated-space-heating-execution-and-reference', ...assessment } } : {}),
    });
    cycle('model-zero', '2026-09-01T01:00:00', '2026-09-01T03:00:00', { profitCents: 0, uncertaintyCents: 10 });
    cycle('model-negative', '2026-09-02T01:00:00', '2026-09-02T03:00:00', { profitCents: -45, uncertaintyCents: 15 });
    cycle('model-saving', '2026-09-04T23:00:00', '2026-09-05T02:00:00', {
      profitCents: 210, uncertaintyCents: 25, referenceCostCents: 450, actualSpaceHeatingCostCents: 240,
    });
    cycle('model-extra-cost', '2026-09-05T06:00:00', '2026-09-05T08:00:00', {
      profitCents: -35, uncertaintyCents: 10, referenceCostCents: 220, actualSpaceHeatingCostCents: 255,
    });
    cycle('model-unassessed', '2026-09-05T08:00:00', '2026-09-05T09:00:00');
    cycle('model-incomplete', '2026-09-05T10:00:00', '2026-09-05T11:00:00', null, 'incomplete');
  });
}

export async function checkTimingBrowser({ command, evaluate, until, capture, context }) {
  const card = device => `.timing-device[data-device="${device}"]`;
  const detail = device => `.timing-device-detail[data-device="${device}"]`;
  const comparison = mode => `${card('heatPump')} .timing-comparison-option[data-mode="${mode}"]`;
  const text = css => evaluate(`document.querySelector(${JSON.stringify(css)})?.textContent ?? ''`);
  const expanded = "document.getElementById('timing-details').open";
  const summary = '#timing-details > summary';
  const chooseDate = async date => {
    await evaluate(`document.getElementById('date-start').value=${JSON.stringify(date)}; document.getElementById('date-start').dispatchEvent(new Event('change')); true`);
    await evaluate(`document.getElementById('date-end').value=${JSON.stringify(date)}; document.getElementById('date-end').dispatchEvent(new Event('change')); true`);
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
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#timing-details .timing-device, #timing-details .timing-device-detail, #timing-details .timing-explanations, #timing-details .timing-source')).flatMap(element => {
      if (!element.checkVisibility()) return [];
      const r = element.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1 ? []
        : [{ element: element.className, device: element.dataset.device, left: r.left, right: r.right,
          width: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }];
    })`), [], 'Inline explanations wrap inside their cards and the viewport');
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.heating-selection .timing-comparison-option')).every(button => {
      const r = button.getBoundingClientRect();
      return r.height >= 40 && button.scrollWidth <= button.clientWidth + 1;
    })`), true, 'Both heating selectors keep readable labels and full touch targets');
  };
  const scrollTo = css => evaluate(`document.querySelector(${JSON.stringify(css)}).scrollIntoView({ block: 'start' }); true`);
  const checkOpen = expected => evaluate(expanded).then(actual => assert.equal(actual, expected,
    'Timing expansion follows the reader’s choice'));
  const checkDetailOpen = async (device, expected) => {
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(detail(device))}).open`), expected,
      `${device} details follow the reader’s choice independently`);
  };
  const checkComparison = async mode => {
    for (const option of ['model', 'timing']) {
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(comparison(option))}).getAttribute('aria-pressed')`),
        String(option === mode), `The ${option} selector announces whether it is selected`);
    }
    for (const [device, label] of [['heatPump', mode === 'model' ? 'Estimated cost difference' : 'Timing cost difference'],
      ['charger', 'Timing cost difference'], ['firewood', 'Estimated cost difference']]) {
      assert.equal((await text(`${card(device)} .timing-comparison-label`)).trim(), label,
        `${device} labels the displayed comparison without changing the other cards' baselines`);
    }
  };
  const switchComparison = async (mode, activate = () => tap(comparison(mode))) => {
    const before = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#timing-details details')].map(fold => fold.open))`));
    const fixedResults = await evaluate(`JSON.stringify(['charger', 'firewood'].map(device =>
      document.querySelector('.timing-device[data-device="' + device + '"] .timing-result').textContent))`);
    await activate();
    await until(`document.querySelector(${JSON.stringify(comparison(mode))}).getAttribute('aria-pressed') === 'true'`);
    await checkComparison(mode);
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#timing-details details')].map(fold => fold.open))`)), before,
      'Changing the heating comparison preserves every device detail expansion');
    assert.equal(await evaluate(`JSON.stringify(['charger', 'firewood'].map(device =>
      document.querySelector('.timing-device[data-device="' + device + '"] .timing-result').textContent))`), fixedResults,
    'Changing the heating comparison leaves charging and fireplace results unchanged');
    await checkOpen(true);
  };
  const layout = async () => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    return JSON.parse(await evaluate(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('.timing-device')].map(card => {
    const box = card.getBoundingClientRect();
    return [card.dataset.device, {
      height: box.height, top: box.top, left: box.left, bottom: box.bottom,
      headingOffset: card.querySelector('.timing-device-heading').getBoundingClientRect().top - box.top,
      summaryOffset: card.querySelector('.timing-device-detail > summary').getBoundingClientRect().top - box.top,
    }];
    })))`));
  };
  const checkClosedLayout = async () => {
    for (const device of ['heatPump', 'charger']) await checkDetailOpen(device, false);
    const { heatPump, charger } = await layout();
    for (const key of ['top', 'height', 'headingOffset', 'summaryOffset']) {
      assert.ok(Math.abs(heatPump[key] - charger[key]) < 1,
        `Closed side-by-side cards have matching ${key}, including unequal available data`);
    }
  };
  const checkToggle = async (device, open, toggle = () => tap(`${detail(device)} > summary`)) => {
    const before = await layout();
    await toggle();
    await until(`${open ? '' : '!'}document.querySelector(${JSON.stringify(detail(device))}).open`);
    const after = await layout();
    const other = device === 'heatPump' ? 'charger' : 'heatPump';
    assert.ok(Math.abs(before[other].height - after[other].height) < 1,
      `Toggling ${device} details leaves the ${other} card height unchanged`);
    assert.ok(open ? after[device].height > before[device].height + 1 : after[device].height < before[device].height - 1,
      `Only the toggled ${device} card ${open ? 'expands' : 'contracts'}`);
    for (const key of ['headingOffset', 'summaryOffset']) {
      for (const device of ['heatPump', 'charger']) assert.ok(Math.abs(before[device][key] - after[device][key]) < 1,
        `Toggling a detail preserves the ${device} ${key}`);
    }
  };
  const checkContentOrder = async () => {
    assert.equal(await evaluate(`(() => {
      const notes = document.querySelector('.timing-explanations');
      const cards = [...document.querySelectorAll('.timing-device')];
      return notes.parentElement.lastElementChild === notes
        && cards.every(card => {
          const fold = card.querySelector('.timing-device-detail');
          return fold?.tagName === 'DETAILS' && fold.querySelector(':scope > summary')
            && notes.getBoundingClientRect().top >= card.getBoundingClientRect().bottom - 1;
        }) && document.querySelector('.timing-evidence-devices') === null;
    })()`), true, 'Each card contains its own native details fold and shared explanations come last');
  };

  assert.equal(await evaluate("document.getElementById('timing-details').tagName"), 'DETAILS');
  assert.equal((await text(summary)).trim(), 'Energy cost comparisons');
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
  assert.equal(await evaluate("document.querySelectorAll('.timing-popover, #timing-benefit .timing-help, #timing-benefit button:not(.timing-comparison-option), #timing-benefit [role=dialog]').length"), 0,
    'Results use only the inline comparison selector and native details controls');
  assert.equal(await evaluate("document.querySelectorAll('#timing-benefit .timing-comparison-option[data-mode]').length"), 2,
    'Only Heating has a two-option comparison selector');
  for (const [device, name] of [['heatPump', 'Heating'], ['charger', 'Charging'], ['firewood', 'Fireplace']]) {
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(detail(device))}).tagName`), 'DETAILS');
    assert.equal((await text(`${detail(device)} > summary`)).trim(), `${name} details`);
    assert.equal((await text(`${card(device)} .timing-device-name`)).trim(), name);
    await checkDetailOpen(device, false);
  }
  await evaluate(`window.timingFoldFixture.devices = Object.fromEntries(['heatPump', 'charger', 'firewood'].map(device => {
    const details = document.querySelector('.timing-device-detail[data-device="' + device + '"]');
    return [device, { details, summary: details.querySelector(':scope > summary') }];
  })); true`);
  await evaluate(`window.timingFoldFixture.comparisons = Object.fromEntries([...document.querySelectorAll('.timing-comparison-option[data-mode]')]
    .map(button => [button.dataset.mode, button])); true`);
  await checkComparison('model');
  assert.equal(await evaluate("document.querySelector('.timing-explanations').open"), false, 'Shared methodology starts closed');
  await tap('.timing-explanations > summary');
  await switchComparison('timing');
  await evaluate(`document.querySelector(${JSON.stringify(comparison('model'))}).focus(); true`);
  await switchComparison('model', () => key('\uE007'));
  assert.equal(await evaluate('document.activeElement === window.timingFoldFixture.comparisons.model'), true,
    'Selecting the model estimate keeps keyboard focus on its persistent button');
  assert.match(await text(`${card('heatPump')} .timing-unavailable`), /unavailable/i,
    'Historical periods without model evidence show an unavailable estimate');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${card('heatPump')} .timing-amount`)}) === null`), true,
    'Missing model evidence never presents a zero saving or the timing amount');
  await evaluate(`document.querySelector(${JSON.stringify(comparison('timing'))}).focus(); true`);
  await switchComparison('timing', () => key(' '));
  assert.equal(await evaluate('document.activeElement === window.timingFoldFixture.comparisons.timing'), true,
    'The comparison selector also supports Space without losing keyboard focus');
  await switchComparison('model', () => key('\uE012'));
  assert.equal(await evaluate('document.activeElement === window.timingFoldFixture.comparisons.model'), true,
    'Arrow keys move focus and selection together within the comparison group');
  await switchComparison('timing', () => key('\uE010'));

  assert.match(await text(card('heatPump')), /unavailable/i);
  assert.match(await text(`${card('charger')} .timing-amount`), /€[\d.]+/);
  assert.match(await text(`${card('charger')} .timing-coverage`), /2% of charger-time included/,
    'Combined coverage includes the second charger’s unknown history in its explicit denominator');
  assert.match(await text(`${card('charger')} .timing-assumed`), /assumed rates/i);
  assert.match(await text('.timing-rate-explanation'), /nearest known contract rates/i);
  assert.match(await text('.timing-rate-explanation'), /historical spot prices/i);
  assert.match(await text(detail('charger')), /100%.*of included charger-time/i);
  assert.match(await text(card('charger')), /2026/);
  assert.match(await text(detail('charger')), /100\s*W/i);
  const chargingFigures = await text(`${card('charger')} .timing-figures`);
  for (const scope of ['charger1', 'charger2']) {
    await evaluate(`document.querySelector('[data-charging-scope="${scope}"]').click(); true`);
    assert.equal(await evaluate(`document.querySelector('[data-charging-scope="${scope}"]').getAttribute('aria-pressed')`), 'true');
    assert.match(await text(`${card('charger')} .timing-coverage`), /of time included/);
  }
  assert.match(await text(`${card('charger')} .timing-figures`), /Comparison unavailable/,
    'Missing second-charger history is not replaced with the first charger or combined total');
  await evaluate(`(() => { const button = document.querySelector('[data-charging-scope="charger2"]');
    button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true; })()`);
  assert.equal(await text(`${card('charger')} .timing-figures`), chargingFigures, 'Total restores its own complete comparison');
  assert.equal(await evaluate("document.activeElement.dataset.chargingScope"), 'total');

  assert.match(await text('.timing-explanations'), /idle/i);
  assert.match(await text('.timing-explanations'), /missing readings|missing data/i);
  assert.match(await text('.timing-explanations'), /whole day|full.day|daily average/i);
  assert.match(await text('.timing-explanations'), /does not prove|not proven/i);
  assert.match(await text(card('heatPump')), /power|energy/i);
  assert.doesNotMatch(await text('#timing-benefit'), /of detected charging included|out of .*detected charging|included charging time/i,
    'Heating and charging use the same time terminology without a second detected-charging denominator');
  await checkClosedLayout();
  await checkContentOrder();
  await checkFits();
  await scrollTo(summary);
  await capture('home-energy-timing-historical-desktop');
  await evaluate(`document.querySelector(${JSON.stringify(`${detail('charger')} > summary`)}).focus(); true`);
  await checkToggle('charger', true, () => key('\uE007'));
  await checkDetailOpen('heatPump', false);
  await checkToggle('charger', false, () => key(' '));
  await checkClosedLayout();
  await checkToggle('charger', true, () => key('\uE007'));
  assert.equal(await evaluate('document.activeElement === window.timingFoldFixture.devices.charger.summary'), true,
    'Nested native summary keeps keyboard focus while toggling');
  await checkOpen(true);
  await scrollTo(summary);
  await capture('home-energy-timing-one-detail-desktop');

  await command('browsingContext.setViewport', { context, viewport: { width: 844, height: 1100 }, devicePixelRatio: 1 });
  await checkToggle('charger', false);
  await checkClosedLayout();
  await checkFits();
  await scrollTo(summary);
  await capture('home-energy-timing-unavailable-closed-844');
  await checkToggle('heatPump', true);
  await checkDetailOpen('charger', false);
  await checkToggle('heatPump', false);
  await checkToggle('charger', true);
  await checkFits();
  await scrollTo(summary);
  await capture('home-energy-timing-unavailable-charging-open-844');
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await switchComparison('model');
  await evaluate(`document.querySelector(${JSON.stringify(`${detail('charger')} > summary`)}).focus(); true`);

  await chooseDate('2026-09-05');
  await checkOpen(true);
  await checkComparison('model');
  assert.equal((await text(`${card('heatPump')} .timing-amount`)).trim(), '€1.75',
    'Model saving totals supported completed cycles for the selected date');
  assert.match(await text(`${card('heatPump')} .timing-outcome`), /estimated cost avoided/i);
  assert.match(await text(detail('heatPump')), /2 assessed cycles/);
  assert.match(await text(detail('heatPump')), /€1\.40.*€2\.10/);
  assert.match(await text(detail('heatPump')), /began before the selected dates/);
  assert.match(await text(detail('heatPump')), /completed cycle without a supported assessment/);
  assert.match(await text(detail('heatPump')), /incomplete cycle/);
  for (const mode of ['model', 'timing']) {
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(comparison(mode))}) === window.timingFoldFixture.comparisons.${mode}`), true,
      'Changing dates preserves the comparison buttons and the selected mode');
  }
  assert.equal(await evaluate("document.getElementById('timing-details') === window.timingFoldFixture.details && document.querySelector('#timing-details > summary') === window.timingFoldFixture.summary"), true,
    'Changing dates updates the contents without replacing the fold or its summary');
  for (const device of ['heatPump', 'charger', 'firewood']) {
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(detail(device))}) === window.timingFoldFixture.devices.${device}.details
      && document.querySelector(${JSON.stringify(`${detail(device)} > summary`)}) === window.timingFoldFixture.devices.${device}.summary`), true,
    'Changing dates updates detail contents without replacing their folds or summaries');
  }
  await checkDetailOpen('heatPump', false);
  await checkDetailOpen('charger', true);
  assert.equal(await evaluate('document.activeElement === window.timingFoldFixture.devices.charger.summary'), true,
    'Changing data preserves focus on the nested native summary');
  await switchComparison('timing');
  assert.match(await text(`${card('heatPump')} .timing-basis`), /operation estimate/i);
  assert.match(await text(`${detail('heatPump')} .timing-source[data-source="observed"]`), /100%/);
  assert.match(await text(detail('heatPump')), /reconstruct|recorded equipment/i);
  assert.match(await text(`${card('charger')} .timing-basis`), /mixed/i);
  for (const [source, share] of [['recorded', '50%'], ['currents', '50%']]) {
    const sourceText = await text(`${detail('charger')} .timing-source[data-source="${source}"]`);
    assert.ok(sourceText.includes(share), `${source} is weighted by active charging time, excluding standby readings`);
    assert.match(sourceText, /of included charger-time/i);
    assert.match(sourceText, /2026/, 'Contributing dates remain next to each source explanation');
  }
  assert.match(await text(`${detail('charger')} .timing-source[data-source="recorded"]`), /saved interval/i);
  assert.match(await text(`${detail('charger')} .timing-source[data-source="currents"]`), /230 V/i);
  const coverage = JSON.parse(await evaluate(`fetch('/api/chart?start=2026-09-05&end=2026-09-05').then(response => response.json()).then(data => JSON.stringify(data.timingBenefit.charger.coverageDetails))`));
  assert.equal(coverage.chargingMs, 6 * 3_600_000);
  assert.equal(coverage.idleMs, 6 * 3_600_000);
  assert.equal(coverage.missingPowerMs, 36 * 3_600_000);
  assert.match(await text(`${card('heatPump')} .timing-coverage`), /100% of time included/);
  assert.doesNotMatch(await text(`${card('heatPump')} .timing-period`), /Partial data/);
  assert.match(await text(`${detail('heatPump')} .timing-calculation`), /Included electricity.*kWh.*Cost at daily average prices.*Cost at recorded times.*Timing difference/);
  assert.match(await text(`${card('charger')} .timing-coverage`), /13% of charger-time included/);
  assert.match(await text(detail('charger')), /unknown|missing/i,
    'The charging detail still explains unrecorded time separately from idle time');
  await checkContentOrder();

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
      if (viewport.width > 800) {
        assert.ok(Math.abs(positions[0].top - positions[1].top) < 1 && positions[0].left < positions[1].left,
          'Desktop presents heat pump left and charger right');
      } else if (viewport.width <= 390) {
        assert.ok(positions[1].top >= positions[0].bottom && Math.abs(positions[0].left - positions[1].left) < 1,
          'Narrow screens stack the device cards in reading order');
      }
      await scrollTo(summary);
      await capture(`home-energy-timing-${theme}-${viewport.width}`);
      await switchComparison('model');
      await checkFits();
      await scrollTo(summary);
      await capture(`home-energy-model-${theme}-${viewport.width}`);
      await switchComparison('timing');
      await scrollTo(`${detail('charger')} .timing-source`);
      await capture(`home-energy-timing-evidence-${theme}-${viewport.width}`);
      await scrollTo('.timing-explanations');
      await capture(`home-energy-timing-explanations-${theme}-${viewport.width}`);
      await checkToggle('charger', false);
      if (viewport.width > 800) await checkClosedLayout();
      await scrollTo(summary);
      await capture(`home-energy-timing-closed-${theme}-${viewport.width}`);
      await checkToggle('heatPump', true);
      await checkDetailOpen('charger', false);
      await scrollTo(summary);
      await capture(`home-energy-timing-heating-open-${theme}-${viewport.width}`);
      await checkToggle('charger', true);
      await checkDetailOpen('charger', true);
      await checkOpen(true);
      await checkFits();
      await checkContentOrder();
      await scrollTo(summary);
      await capture(`home-energy-timing-both-details-${theme}-${viewport.width}`);
      await checkToggle('heatPump', false);
      await checkDetailOpen('charger', true);
      await tap(summary);
      await until(`!${expanded}`);
      await capture(`home-energy-timing-folded-${theme}-${viewport.width}`);
      await tap(summary);
      await until(expanded);
      await checkDetailOpen('heatPump', false);
      await checkDetailOpen('charger', true);
    }
  }

  await switchComparison('model');
  await chooseDate('2026-09-01');
  await checkComparison('model');
  assert.equal((await text(`${card('heatPump')} .timing-amount`)).trim(), '€0.00',
    'A supported zero model difference remains distinguishable from missing evidence');
  assert.match(await text(`${card('heatPump')} .timing-outcome`), /estimated cost difference/i);
  await chooseDate('2026-09-02');
  await checkComparison('model');
  assert.match(await text(`${card('heatPump')} .timing-amount`), /[-−]€0\.45/);
  assert.match(await text(`${card('heatPump')} .timing-outcome`), /estimated extra cost/i,
    'Negative model savings clearly describe an estimated extra cost');
  await checkFits();
  await scrollTo(summary);
  await capture('home-energy-model-negative-mobile');
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await chooseDate('2026-09-04');
  await checkComparison('model');
  assert.match(await text(`${card('heatPump')} .timing-unavailable`), /unavailable/i);
  await switchComparison('timing');
  await checkOpen(true);
  await checkDetailOpen('heatPump', false);
  await checkDetailOpen('charger', true);
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
  assert.match(await text('.timing-chart-rates'), /Affected comparisons are marked.*Assumed rates/i);
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
  await switchComparison('model');
  await evaluate(`document.querySelector(${JSON.stringify(`${detail('charger')} > summary`)}).focus(); true`);
  // Wait for a real background status poll while the reader leaves the fold open.
  await evaluate(`window.timingFoldFixture.fetch = window.fetch.bind(window);
    window.timingFoldFixture.polls = 0;
    window.fetch = async (...args) => {
      const response = await window.timingFoldFixture.fetch(...args);
      if (new URL(args[0], location.href).pathname === '/api/status') window.timingFoldFixture.polls++;
      return response;
    }; true`);
  try {
    await until('window.timingFoldFixture.polls > 0', 650);
    await until("document.getElementById('history').dataset.ready === 'true'");
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    await checkOpen(true);
    await checkComparison('model');
    assert.equal(await evaluate("document.getElementById('timing-details') === window.timingFoldFixture.details"), true,
      'Background polling preserves the native fold');
    await checkDetailOpen('heatPump', false);
    await checkDetailOpen('charger', true);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(detail('charger'))}) === window.timingFoldFixture.devices.charger.details
      && document.activeElement === window.timingFoldFixture.devices.charger.summary`), true,
    'Background polling preserves the nested fold and keyboard focus');
  } finally {
    await evaluate('window.fetch = window.timingFoldFixture.fetch; delete window.timingFoldFixture; true');
  }
  await switchComparison('model');
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  await checkComparison('model');
  await checkOpen(false);
  await tap(summary);
  await until(expanded);
  await checkFits();
  await switchComparison('timing');
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });

  // Exercise all three populated cards together, including Fireplace, with an
  // invented API result. The simulation remains isolated from household data.
  await evaluate(`window.comparisonFixtureFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await window.comparisonFixtureFetch(...args);
      if (new URL(args[0], location.href).pathname !== '/api/chart') return response;
      const data = await response.clone().json();
      data.firewoodBenefit = { status: 'provisional', valueEuro: 0.65, electricityAvoidedKwh: 3.1,
        range: data.range, generatedAt: data.now, woodCostEuro: 0,
        coverage: { elapsedMs: data.range.to - data.range.from, includedMs: data.range.to - data.range.from,
          firstAt: data.range.from, lastAt: data.range.to }, loads: { kg: 6, count: 1 },
        estimateRange: { lowerEuro: 0.2, upperEuro: 1.1 }, assumptions: ['Synthetic browser fixture.'] };
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    }; true`);
  try {
    await chooseDate('2026-09-05');
    await switchComparison('model');
    await evaluate(`document.querySelectorAll('#timing-benefit details').forEach(fold => fold.open = false); true`);
    assert.match(await text(`${card('firewood')} .timing-amount`), /€0.65/);
    for (const width of [1440, 1024, 844, 390, 320]) {
      await command('browsingContext.setViewport', { context, viewport: { width, height: 1100 }, devicePixelRatio: 1 });
      for (const theme of ['dark', 'light']) {
        await evaluate(`if (document.documentElement.dataset.theme !== '${theme}') document.getElementById('theme-toggle').click(); true`);
        await evaluate('new Promise(resolve => setTimeout(() => resolve(true), 200))');
        await checkFits();
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        assert.equal(await evaluate(`(() => {
          const nodes = ['charger', 'firewood'].map(device => document.querySelector('.timing-device[data-device="' + device + '"] .timing-comparison-fixed'));
          return ['backgroundColor', 'color', 'fontSize', 'fontWeight', 'padding', 'border'].every(key =>
            getComputedStyle(nodes[0])[key] === getComputedStyle(nodes[1])[key]);
        })()`), true, 'Charging and Fireplace comparison indicators share the same visual treatment');
        if (width >= 1000) {
          const resultTops = await evaluate(`[...document.querySelectorAll('.timing-saving-result')].map(node => node.getBoundingClientRect().top)`);
          assert.ok(Math.max(...resultTops) - Math.min(...resultTops) < 1, 'All three desktop results align below their comparison controls');
        }
        await scrollTo(summary);
        await capture(`energy-comparisons-populated-${theme}-${width}`);
        if (width < 801) {
          await scrollTo(card('firewood'));
          await capture(`energy-comparisons-fireplace-${theme}-${width}`);
        }
      }
    }
  } finally {
    await evaluate('window.fetch = window.comparisonFixtureFetch; delete window.comparisonFixtureFetch; true');
  }
  // Restore the provider chart used by the broader smoke test after the
  // isolated historical layout fixture.
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await evaluate("document.getElementById('range-today').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07'");
  await switchComparison('timing');
}
