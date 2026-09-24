import test from 'node:test';
import assert from 'node:assert/strict';
import { timingDisplay, chargingTimingDisplay, timingExplanations, timingPercent } from '../chart/timing-model.js';

const from = Date.parse('2026-09-08T00:00:00+03:00');
const hour = 3_600_000;
const payload = { now: from + 10 * hour, range: { from, to: from + 24 * hour, startDate: '2026-09-08', endDate: '2026-09-08' } };
const result = {
  value: 0, coverage: 0.07, provisional: true,
  coverageDetails: { from, to: payload.now, elapsedMs: 10 * hour, includedMs: 0.7 * hour, powerMs: hour, missingPowerMs: 9 * hour, incompletePriceMs: 0.3 * hour },
  evidence: { energyBasis: 'reconstructed-equipment', sources: [{ key: 'observed', share: 1, durationMs: 0.7 * hour, firstAt: from + 8 * hour, lastAt: from + 9 * hour }] },
};
const chargerResult={...result,evidence:{energyBasis:'power-snapshots',sources:result.evidence.sources.map(source=>({...source,key:'currents'}))}};

test('today reconstructed zero comparison explicitly separates equipment evidence from elapsed-time coverage', () => {
  const display = timingDisplay('heatPump', result, payload);
  assert.equal(display.amount, '€0.00');
  assert.equal(display.outcome, 'timing difference');
  assert.equal(display.basis, 'Operation estimate');
  assert.equal(display.sources[0].percentage, '100%');
  assert.equal(display.coverageLabel, '7% of time included');
  assert.equal(display.periodLabel, 'Today so far');
  assert.match(display.smallDifferenceExplanation, /energy use can still be nonzero/);
  assert.match(display.energyExplanation, /whole-house power is not used/i);
  assert.match(timingExplanations.coverage.join(' '), /from Finnish midnight to the calculation time/);
  assert.match(display.coverageExplanation, /valid, fresh equipment observations/);
  assert.match(display.coverageSummary, /device history or daily prices are incomplete/);
  assert.match(display.sources[0].explanation, /recorded compressor activity.*not separately metered/);
  assert.equal(display.includedTimeLabel, 'included time');
  assert.equal(display.coverageHeading, 'Time included');
});

test('included-time evidence shares preserve mixed assumptions and original sample dates', () => {
  const mixed = { ...chargerResult, evidence: { energyBasis:'recorded-and-legacy', sources: ['recorded', 'currents', 'unknown', 'simulated'].map((key, index) => ({
    key, share: 0.25, durationMs: 0.175 * hour, firstAt: from - 10 * 60_000 + index * hour, lastAt: from + index * hour,
  })), auxiliaryAssumedMs: hour / 4, auxiliaryAssumedShare: 0.25, auxiliaryUnknownMs: hour / 4, auxiliaryUnknownShare: 0.25 } };
  const display = timingDisplay('charger', mixed, payload);
  assert.equal(display.basis, 'Mixed basis');
  assert.deepEqual(display.sources.map(source => source.percentage), Array(4).fill('25%'));
  assert.match(display.sources[0].dates, /7 Sept 2026, 23:50/);
  assert.match(timingExplanations.evidence.join(' '), /shares of included time, not energy or accuracy/);
  assert.match(timingExplanations.evidence.join(' '), /can contain gaps/);
  assert.deepEqual(display.auxiliaryNotes,[]);
});

test('unsupported old timing responses remain unavailable without invented source or coverage', () => {
  for(const unsupported of [{value:236.98,coverage:.29,estimated:true},
    {...result,evidence:{sources:[{key:'modelled',share:1,durationMs:hour}]}},
    {...result,evidence:{energyBasis:'power-snapshots',sources:[{key:'measured',share:1,durationMs:hour}]}}]){
    const display=timingDisplay('heatPump',unsupported,{...payload,observations:{heatPumpPowerKw:{source:'measured'}}});
    assert.equal(display.available,false);assert.equal(display.amount,null);assert.deepEqual(display.sources,[]);
    assert.match(display.energyExplanation,/Needs recorded compressor activity/);
  }
});

test('unavailable identifies missing power, incomplete prices and future time separately from a zero amount', () => {
  const unavailable = changes => timingDisplay('charger', { ...result, value: null, coverageDetails: { ...result.coverageDetails, includedMs: 0, ...changes } }, payload);
  assert.equal(unavailable({ powerMs: 0 }).unavailableReason, 'No usable device power history');
  assert.equal(unavailable({ powerMs: hour }).unavailableReason, 'Full-day prices missing');
  assert.equal(unavailable({ elapsedMs: 0 }).unavailableReason, 'No elapsed time in this selection');
  assert.equal(unavailable({ powerMs: 0 }).amount, null);
  assert.match(timingExplanations.coverage.join(' '), /Unavailable means there is no supported total, not zero energy use/);
  assert.equal(timingDisplay('charger', null).available, false);
});

test('rates explain historical spot prices and the included-time effect of an assumed daily average', () => {
  const display = timingDisplay('charger', { ...result, value: 236.98, assumedPrices: true,
    evidence: { energyBasis:'power-snapshots', sources: [{ key: 'currents', durationMs: hour, share: 1 }] },
    priceAssumptions: { durationMs: hour / 2, share: 0.5, firstAt: from, lastAt: from + hour } }, payload);
  assert.equal(display.basis, 'Current estimate');
  assert.equal(display.assumedRates, true);
  assert.match(timingExplanations.rates.join(' '), /nearest known contract rates/);
  assert.match(timingExplanations.rates.join(' '), /with the original historical spot prices/);
  assert.match(display.rateSummary, /50% of included time.*own price or the full-day average/);
  assert.match(display.ratePeriod, /Affected included periods: 8 Sept 2026, 00:00/);
  assert.equal(timingDisplay('charger', { ...result, value: null, assumedPrices: true }, payload).assumedRates, false);
});

test('small included shares remain visible and near-complete coverage does not round to complete', () => {
  assert.equal(timingPercent(0), '0%');
  assert.equal(timingPercent(0.00001), '<1%');
  assert.equal(timingPercent(0.996), '>99%');
  assert.equal(timingPercent(1), '100%');
  const display = timingDisplay('heatPump', { ...result, coverageDetails: { elapsedMs: hour, includedMs: 0.002 * hour } }, payload);
  assert.equal(display.coverageLabel, '<1% of time included');
});

test('sub-cent differences preserve direction and cannot appear as a measured zero saving', () => {
  for (const [value, amount] of [[0.004, '+<€0.01'], [-0.004, '−<€0.01']]) {
    const display = timingDisplay('charger', { ...chargerResult,value }, payload);
    assert.equal(display.amount, amount);
    assert.match(display.smallDifferenceExplanation, /less than half a cent.*sign shows cheaper \(\+\) or dearer \(−\)/);
    assert.doesNotMatch(display.smallDifferenceExplanation, /rounds to €0\.00/);
  }
  assert.equal(timingDisplay('charger', { ...chargerResult,value: -0 }, payload).amount, '€0.00');
  assert.equal(timingDisplay('charger', { ...chargerResult,value: -12.34 }, payload).amount, '-€12.34');
  assert.equal(timingDisplay('charger', { ...chargerResult,value: -12.34 }, payload).smallDifferenceExplanation, null);
});

test('completed history with missing periods says partial data without promising backfill', () => {
  const display = timingDisplay('heatPump', result, { ...payload, now: from + 48 * hour });
  assert.equal(display.periodLabel, 'Partial data');
  assert.match(timingExplanations.evidence.join(' '), /Date spans can contain gaps/);
  assert.match(display.periodExplanation, /not extrapolated/);
  assert.match(display.calculationPeriod, /8 Sept 2026, 10:00/);
  assert.equal(timingDisplay('heatPump', { ...result, value: null }, { ...payload, now: from + 48 * hour }).periodLabel, null);
});

test('the evidence ladder keeps its ordering when the earliest contributing source changes', () => {
  const display = timingDisplay('charger', { ...chargerResult,value: 1, evidence: { energyBasis:'recorded-and-legacy',sources: ['unknown', 'currents', 'recorded', 'simulated'].map(key => ({ key, durationMs: hour, share: 0.25 })) } }, payload);
  assert.deepEqual(display.sources.map(source => source.key), ['recorded', 'currents', 'unknown', 'simulated']);
});

test('reconstructed heat-pump explanation describes recorded equipment and dated powers without suggesting a model fallback', () => {
  const display = timingDisplay('heatPump', { ...result, evidence: {
    energyBasis: 'reconstructed-equipment', timeBasis: 'recorded-interval-time',
    sources: [{ key: 'observed', durationMs: hour, share: 1, firstAt: from, lastAt: from + hour }],
  } }, payload);
  assert.equal(display.basis, 'Operation estimate');
  assert.match(display.sources[0].explanation, /verified auxiliary output.*dated nominal compressor/);
  assert.match(display.energyExplanation, /space heating and domestic hot water/);
  assert.match(display.sources[0].dates, /Contributing intervals: 8 Sept 2026, 00:00/);
  assert.match(display.evidenceExplanation, /original interval boundaries/);
  assert.match(display.energyExplanation, /Model predictions and requested modes cannot fill missing equipment evidence/);
  assert.match(display.coverageExplanation, /valid, fresh equipment observations/);
  assert.doesNotMatch(display.coverageExplanation, /30 minutes|estimated and modelled/);
  assert.doesNotMatch(display.energyExplanation, /first uses dedicated power/);
});

test('unavailable reconstructed heat-pump energy still explains the required equipment evidence', () => {
  const display = timingDisplay('heatPump', { value: null,
    coverageDetails: { elapsedMs: hour, includedMs: 0, powerMs: 0 },
    evidence: { energyBasis: 'reconstructed-equipment', sources: [] },
  }, payload);
  assert.equal(display.available, false);
  assert.match(display.energyExplanation, /Needs recorded compressor activity, verified auxiliary output and dated nominal powers/);
  assert.doesNotMatch(display.energyExplanation, /dedicated heat-pump power reading or a stored/);
});

test('recorded charger intervals retain their estimated energy basis and original interval dates', () => {
  const display = timingDisplay('charger', { ...result, evidence: {
    energyBasis: 'recorded-intervals', timeBasis: 'recorded-interval-time',
    sources: [{ key: 'recorded', durationMs: hour, share: 1, firstAt: from - hour, lastAt: from + hour }],
  } }, payload);
  assert.equal(display.basis, 'Recorded energy estimate');
  assert.equal(display.sources[0].key, 'recorded');
  assert.match(display.sources[0].explanation, /reported active power or recorded voltage and current/);
  assert.match(display.sources[0].explanation, /cumulative meter checks do not revise/);
  assert.match(display.sources[0].dates, /Contributing intervals: 7 Sept 2026, 23:00/);
  assert.match(display.coverageExplanation, /Saved energy intervals are used without extending into gaps/);
  assert.doesNotMatch(display.coverageExplanation, /30 minutes|modelled power/);
});

test('mixed charger history explains interval energy and the bounded legacy snapshot hold separately', () => {
  const display = timingDisplay('charger', { ...result, evidence: {
    energyBasis: 'recorded-and-legacy', timeBasis: 'mixed-recorded-time',
    sources: ['currents', 'recorded'].map(key => ({ key, durationMs: hour / 2, share: 0.5,
      firstAt: from, lastAt: from + hour })),
  } }, payload);
  assert.equal(display.basis, 'Mixed basis');
  assert.deepEqual(display.sources.map(source => source.key), ['recorded', 'currents']);
  assert.match(display.sources[0].dates, /Contributing intervals and samples/);
  assert.match(display.sources[1].explanation, /phase-current readings at 230 V/);
  assert.match(display.coverageExplanation, /Saved energy intervals are used without extending into gaps.*Older power samples are held for at most 30 minutes/);
});

test('simulated reconstructed intervals remain explicitly simulated', () => {
  const display = timingDisplay('heatPump', { ...result, evidence: {
    energyBasis: 'reconstructed-equipment', timeBasis: 'recorded-interval-time',
    sources: [{ key: 'simulated', durationMs: hour, share: 1 }],
  } }, payload);
  assert.equal(display.basis, 'Simulated');
  assert.match(display.sources[0].explanation, /simulated input, not measured household consumption/);
});

test('shared comparison copy preserves the daily baseline, sign and limits for both devices', () => {
  assert.match(timingExplanations.comparison.join(' '), /Each day’s included energy is priced twice.*full day’s time-weighted average all-in price/);
  assert.match(timingExplanations.comparison.join(' '), /Positive means cheaper timing; negative means dearer timing/);
  assert.match(timingExplanations.comparison.join(' '), /not scaled up.*does not prove savings caused by the controller/);
  assert.match(timingExplanations.coverage.join(' '), /elapsed time for heating and each charger.*Combined charging uses charger-time/);
  assert.match(timingExplanations.coverage.join(' '), /Heating includes valid zero-use periods; charging excludes idle periods/);
  assert.match(timingExplanations.coverage.join(' '), /Missing readings are unknown, not idle/);
  assert.match(timingExplanations.coverage.join(' '), /Future hours do not reduce the percentage, but the price average still needs the full day/);
  assert.match(timingExplanations.evidence.join(' '), /today’s sensors do not reclassify/);
});

test('unavailable rate metadata does not suggest a supported device comparison', () => {
  const display = timingDisplay('charger', { value: null, assumedPrices: true,
    coverageDetails: { elapsedMs: hour, includedMs: 0, powerMs: hour, firstPowerAt: from, lastPowerAt: from + hour },
    priceAssumptions: { durationMs: hour, share: 1, firstAt: from, lastAt: from + hour },
  }, payload);
  assert.equal(display.assumedRates, false);
  assert.equal(display.rateSummary, null);
  assert.equal(display.ratePeriod, null);
  assert.match(display.availablePowerPeriod, /Available power samples: 8 Sept 2026, 00:00.*Gaps may exist/);
  assert.equal(display.smallDifferenceExplanation, null);
});

test('heating and individual chargers use elapsed-time coverage and included-time source labels', () => {
  const selection = { value: 1.25, coverage: 0.5,
    coverageDetails: { elapsedMs: 10 * hour, includedMs: hour, powerMs: 8 * hour,
      chargingMs: 2 * hour, idleMs: 6 * hour, missingPowerMs: 2 * hour,
      incompletePriceMs: hour, minimumPowerKw: 0.1, coverageBasis: 'elapsed-time' },
    evidence: { energyBasis:'power-snapshots',sources: [{ key: 'currents', durationMs: hour, share: 1 }] },
  };
  for (const [key, name] of [['heatPump', 'Heating'], ['charger1', 'Charger 1']]) {
    const selected=key==='heatPump'?{...selection,evidence:{energyBasis:'reconstructed-equipment',sources:[{key:'observed',durationMs:hour,share:1}]}}:selection;
    const display = timingDisplay(key, selected, payload);
    assert.equal(display.name, name);
    assert.equal(display.coverageLabel, '10% of time included');
    assert.equal(display.includedTimeLabel, 'included time');
    assert.equal(display.coverageHeading, 'Time included');
    assert.equal(display.coverageSummary, 'Some periods are excluded because device history or daily prices are incomplete.');
    assert.doesNotMatch(display.coverageSummary, /hours|detected charging|Idle:/);
    assert.equal(display.sources[0].percentage, '100%');
    assert.equal(display.noChargingDetected, false);
  }
  assert.match(timingDisplay('charger', selection, payload).coverageExplanation, /at or below 100 W counts as idle and is excluded/);
});

test('idle-only charger history has zero time included without a zero-valued timing total', () => {
  const display = timingDisplay('charger', { value: null, coverage: 0,
    coverageDetails: { elapsedMs: 10 * hour, includedMs: 0, powerMs: 10 * hour,
      chargingMs: 0, idleMs: 10 * hour, missingPowerMs: 0, incompletePriceMs: 0 },
  }, payload);
  assert.equal(display.available, false);
  assert.equal(display.amount, null);
  assert.equal(display.noChargingDetected, true);
  assert.equal(display.unavailableReason, 'No charging detected');
  assert.equal(display.coverageLabel, '0% of time included');
  assert.equal(display.coverageSummary, null);
  assert.equal(display.availablePowerPeriod, null);
  assert.equal(display.smallDifferenceExplanation, null);
});

test('unknown charger history is visibly distinguished from confirmed idle time and missing charging prices', () => {
  const unavailable = changes => timingDisplay('charger', { value: null,
    coverageDetails: { elapsedMs: 10 * hour, includedMs: 0, powerMs: 6 * hour,
      chargingMs: 0, idleMs: 6 * hour, missingPowerMs: 4 * hour, incompletePriceMs: 0, ...changes },
  }, payload);
  const partialIdle = unavailable({});
  assert.equal(partialIdle.noChargingDetected, false);
  assert.equal(partialIdle.unavailableReason, 'No charging detected in available data');
  assert.match(partialIdle.coverageSummary, /device history is missing/);
  const unknown = unavailable({ powerMs: 0, idleMs: 0, missingPowerMs: 10 * hour });
  assert.equal(unknown.noChargingDetected, false);
  assert.equal(unknown.unavailableReason, 'No usable device power history');
  const missingPrices = unavailable({ chargingMs: hour, idleMs: 5 * hour, incompletePriceMs: hour });
  assert.equal(missingPrices.noChargingDetected, false);
  assert.equal(missingPrices.unavailableReason, 'Full-day prices missing');
  assert.equal(missingPrices.coverageLabel, '0% of time included');
});

test('coverage gap notes describe only missing inputs and disappear for complete history', () => {
  for (const key of ['heatPump', 'charger']) {
    const display = changes => timingDisplay(key, { value: 1,
      coverageDetails: { elapsedMs: hour, includedMs: hour, powerMs: hour,
        missingPowerMs: 0, incompletePriceMs: 0, ...changes },
    }, payload);
    assert.equal(display({}).coverageSummary, null);
    assert.equal(display({ missingPowerMs: hour / 2 }).coverageSummary,
      'Some periods are excluded because device history is missing.');
    assert.equal(display({ incompletePriceMs: hour / 2 }).coverageSummary,
      'Some periods are excluded because daily prices are incomplete.');
    assert.equal(display({ elapsedMs: 0, includedMs: 0 }).coverageLabel, '0% of time included');
  }
});

test('charging scope selects each charger or combined comparison without substituting a missing meter', () => {
  const data = { ...payload, timingBenefit: { charger1: { ...chargerResult, value: 1.2 },
    charger2: { ...chargerResult, value: 2.4 }, charger: { ...chargerResult, value: 3.6,
      coverageDetails: { ...chargerResult.coverageDetails, coverageBasis: 'charger-time' } } } };
  for (const [scope, amount] of [['charger1', '€1.20'], ['charger2', '€2.40'], ['total', '€3.60']]) {
    const display = chargingTimingDisplay(data, scope);
    assert.equal(display.key, 'charger'); assert.equal(display.amount, amount);
    assert.match(display.coverageLabel, scope === 'total' ? /charger-time/ : /of time/);
  }
  delete data.timingBenefit.charger2;
  assert.equal(chargingTimingDisplay(data, 'charger2').available, false);
  assert.throws(() => chargingTimingDisplay(data, 'unknown'), RangeError);
});
