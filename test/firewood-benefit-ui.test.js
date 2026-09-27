import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { firewoodDisplay, firewoodExplanations } from '../chart/firewood-benefit.js';
import { createTimingBenefit } from '../chart/timing-benefit.js';
import { historyDatasets, historyValueLabel, firewoodPointDetail } from '../chart/history-model.js';
import { learningDisplay, modelCoefficientDescriptions } from '../chart/learning-status.js';

const HOUR = 3_600_000, from = Date.parse('2026-09-09T00:00:00+03:00');
const payload = { now: from + 12 * HOUR, range: { from, to: from + 24 * HOUR,
  startDate: '2026-09-09', endDate: '2026-09-09' } };
const estimate = { status: 'provisional', valueEuro: 1.25, electricityAvoidedKwh: 4.5, woodCostEuro: 0,
  range: payload.range, generatedAt: payload.now, loads: { kg: 8, count: 1 },
  coverage: { elapsedMs: 12 * HOUR, includedMs: 6 * HOUR, missingMs: 6 * HOUR, firstAt: from + HOUR, lastAt: from + 8 * HOUR },
  estimateRange: { lowerEuro: -0.25, upperEuro: 2.5 }, assumptions: ['Synthetic scenario assumption.'] };

// Current API evidence for the UI-only money/focus fixtures. One included hour
// per physical scope; aggregate comparisons sum the included and elapsed times.
function timing(value, scope = 'home') {
  const systems = scope === 'total' || scope === 'charger' ? 2 : 1;
  const energyBasis = scope === 'home' ? 'reconstructed-equipment'
    : scope === 'total' ? 'separate-system-intervals' : 'recorded-intervals';
  return { value, energyKwh: systems, actualCostEuro: 5 * systems, uniformCostEuro: 5 * systems + value,
    provisional: true, coverage: 1 / 12,
    coverageDetails: { from, to: payload.now, elapsedMs: 12 * HOUR * systems,
      includedMs: HOUR * systems, powerMs: HOUR * systems, missingPowerMs: 11 * HOUR * systems,
      incompletePriceMs: 0, coverageBasis: scope === 'charger' ? 'charger-time' : 'elapsed-time' },
    evidence: { energyBasis, timeBasis: 'recorded-interval-time', sources: scope === 'total' ? [] : [{
      key: scope === 'home' ? 'observed' : scope === 'garage' ? 'measured' : 'recorded',
      durationMs: HOUR * systems, energyKwh: systems, share: 1, firstAt: from + HOUR, lastAt: from + 2 * HOUR }] } };
}

test('firewood presentation keeps the reported money, electricity, coverage and provisional status separate', () => {
  const display = firewoodDisplay(estimate, payload);
  assert.equal(display.amount, '€1.25'); assert.equal(display.electricity, '4.5 kWh electricity avoided');
  assert.equal(display.statusLabel, 'Provisional model estimate');
  assert.equal(display.coverageLabel, '50% of time included');
  assert.match(display.coverageExplanation, /not scaled up/);
  assert.equal(display.woodCost, 'Wood cost: €0.00');
  assert.match(display.uncertainty, /-€0.25–€2.50; not a statistical confidence interval/);
  assert.match(display.calculationPeriod, /9 Sept 2026, 00:00.*9 Sept 2026, 12:00/);
  assert(!display.calculationPeriod.includes('10 Sept'), 'the displayed calculation stops at elapsed time');
  assert.match(display.loads, /8 kg in 1 addition/);
  assert.match(display.loadExplanation, /earlier additions/);
});

test('unavailable results never infer savings from logged kilograms or neighbouring timing cards', () => {
  const display = firewoodDisplay({ status: 'unavailable', valueEuro: 0, electricityAvoidedKwh: 0,
    loads: { kg: 16, count: 2 }, reason: 'No supported model-input history exists for this source.' },
  { ...payload, timingBenefit: { heatPump: { value: 50 }, charger: { value: 50 } } });
  assert.equal(display.available, false); assert.equal(display.amount, null);
  assert.equal(display.electricity, 'Electricity avoided: unavailable');
  assert.match(display.unavailableReason, /No supported model-input history/);
  assert.equal(display.coverageLabel, 'Coverage unavailable');
  assert.equal(firewoodDisplay(undefined, payload).available, false);
});

test('validated zero remains a supported zero and negative electricity cost remains negative', () => {
  const zero = firewoodDisplay({ ...estimate, status: 'validated', valueEuro: 0, electricityAvoidedKwh: 0,
    evidence: { electricalValidated: true, independentBurns: 3, independentDays: 4, normalObservedHours: 25 } }, payload);
  assert.equal(zero.available, true); assert.equal(zero.amount, '€0.00');
  assert.equal(zero.electricity, '0 kWh electricity avoided');
  assert.equal(zero.statusLabel, 'Validated model estimate');
  assert.match(zero.evidence.join(' '), /Heating-electricity response: validated.*3 independent firing groups across 4 later days/);
  const negative = firewoodDisplay({ ...estimate, valueEuro: -2.5 }, payload);
  assert.equal(negative.amount, '-€2.50');
  assert.equal(negative.outcome, 'estimated electricity cost increase');
  assert.equal(firewoodDisplay({ ...estimate, valueEuro: 0.001 }, payload).amount, '+<€0.01');
  assert.equal(firewoodDisplay({ ...estimate, valueEuro: -0.001 }, payload).amount, '−<€0.01');
  assert.equal(firewoodDisplay({ ...estimate, valueEuro: -0 }, payload).amount, '€0.00');
  assert.match(firewoodExplanations.join(' '), /Negative electricity prices/);
});

test('remaining release and projected savings never enter the elapsed selection total', () => {
  const display = firewoodDisplay({ ...estimate,
    remaining: { status: 'partial-forecast', kgEquivalent: 3, valueEuro: 10, kwh: 30, through: from + 72 * HOUR,
      reason: 'Only the available fresh forecast is priced; later residual heat is excluded.' } }, payload);
  assert.equal(display.amount, '€1.25'); assert.equal(display.electricity, '4.5 kWh electricity avoided');
  assert.match(display.remaining.amount, /€10.00/); assert.match(display.remaining.energy, /30 kWh/);
  assert.match(display.remaining.explanation, /separate from the figures above.*not yet realised/);
  assert.match(display.remaining.reason, /Only the available fresh forecast is priced/);
  const unpriced = firewoodDisplay({ ...estimate, remaining: { status: 'unpriced-residual', kgEquivalent: 3,
    reason: 'Fresh forecast coverage is unavailable.' } }, payload);
  assert.equal(unpriced.remaining.amount, null); assert.match(unpriced.remaining.fuel, /fuel-equivalent/);
  assert.match(unpriced.remaining.unavailable, /not yet available/);
  assert.equal(unpriced.remaining.reason, 'Fresh forecast coverage is unavailable.');
});

test('Fireplace forecasts describe cost increases, zero and uncertainty without promising savings', () => {
  const negative = firewoodDisplay({ ...estimate, remaining: { status: 'partial-forecast',
    valueEuro: -2.5, kwh: -1.25, lowerEuro: -4, upperEuro: 0.5 } }, payload);
  assert.equal(negative.remaining.label, 'Remaining forecast');
  assert.equal(negative.remaining.amount, '-€2.50 estimated electricity cost increase');
  assert.equal(negative.remaining.energy, '1.3 kWh estimated additional electricity');
  assert.match(negative.remaining.uncertainty, /-€4.00–€0.50.*not a statistical confidence interval/);
  assert.doesNotMatch(negative.remaining.explanation, /savings/);
  assert.equal(negative.amount, '€1.25', 'The forecast remains separate from elapsed results');
  const zero = firewoodDisplay({ ...estimate, valueEuro: 0,
    remaining: { status: 'partial-forecast', valueEuro: 0, kwh: 0 } }, payload);
  assert.equal(zero.outcome, 'estimated electricity cost difference');
  assert.equal(zero.remaining.amount, '€0.00 estimated electricity cost difference');
  const increasedElectricity = firewoodDisplay({ ...estimate, electricityAvoidedKwh: -2 }, payload);
  assert.equal(increasedElectricity.electricity, '2 kWh additional electricity');
});

test('Fireplace assumption status uses structured included-price evidence only', () => {
  assert.equal(firewoodDisplay({ ...estimate, priceAssumptions: { durationMs: HOUR } }, payload).assumedRates, true);
  assert.equal(firewoodDisplay({ ...estimate, priceAssumptions: { durationMs: 0 } }, payload).assumedRates, false);
  assert.equal(firewoodDisplay({ ...estimate, status: 'unavailable',
    priceAssumptions: { durationMs: HOUR } }, payload).assumedRates, false);
  assert.equal(firewoodDisplay(estimate, payload).assumedRates, false);
});

test('manual additions and daily outcomes use visible event markers and never connect across missing data', () => {
  const load = historyDatasets({ firewood_load: [{ x: from, y: 8 }, { x: from + 1000, y: 2 }] }, CHART_VIEW_BY_KEY.firewood)[0];
  assert.equal(load.showLine, false); assert.equal(load.pointStyle, 'triangle'); assert.equal(load.pointRadius, 5);
  assert.equal(load.spanGaps, false); assert.equal(load.unit.split(' · ')[0], 'kg');
  const outcomes = historyDatasets({ firewood_savings: [{ x: from, y: 1, status: 'provisional' },
    { x: from + 24 * HOUR, y: 0, status: 'validated' }] }, CHART_VIEW_BY_KEY.fireplace_cost)[0];
  assert.equal(outcomes.showLine, false); assert.equal(outcomes.pointStyle, 'rectRot');
  assert.equal(outcomes.pointBackgroundColor[0], 'transparent'); assert.notEqual(outcomes.pointBackgroundColor[1], 'transparent');
  assert.equal(historyValueLabel('firewood_savings', 0, outcomes.unit), '0 €/day');
  assert.match(firewoodPointDetail('firewood_load', { loadCount: 2 }), /total of 2 additions at this time/);
  assert.match(firewoodPointDetail('firewood_savings', { status: 'provisional', coverage: 0.5 }), /Provisional.*daily total.*50%.*wood cost €0/);
  assert.match(firewoodPointDetail('model_fireplace_release'), /fuel equivalent, not measured heat/);
});

test('House model explains manual fuel, delayed release, effective coefficient units and separate validation evidence', () => {
  const learning = { readiness: { fireplaceValidated: false }, adaptive: { model: {
    parameters: { fireplaceCPerKg: 0.15 }, validation: { accepted: true,
      fireplace: { accepted: false, trainingBurns: 2, validationBurns: 1 }, fittedParameters: [] } } } };
  const coefficient = modelCoefficientDescriptions(learning)[0];
  assert.equal(coefficient.title, 'Fireplace response'); assert.equal(coefficient.value, '0.150 °C/kg');
  assert.match(coefficient.detail, /not measured fireplace efficiency/);
  assert.match(coefficient.provenance, /not independently identified/);
  const display = learningDisplay(learning);
  assert(display.inputs.some(row => row.key === 'firewood_load' && row.sources.includes('whole kilograms')));
  assert(display.inputs.some(row => row.key === 'model_fireplace_release' && row.sources.includes('overlap')));
  assert.match(display.evidence.join(' '), /Fireplace response: provisional.*2 training firing groups and 1 later validation groups/);
});

function dom(storage = new Map()) {
  let disconnected = false;
  const document = { activeElement: null,
    createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    defaultView: { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      ResizeObserver: class { observe() {} disconnect() { disconnected = true; } } } };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.ownerDocument = document;
      this.style = { setProperty() {} }; this._text = ''; this.attributes = {}; this.listeners = new Map(); }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
    append(...children) { for (const child of children) this.children.push(...(child.tagName === 'fragment' ? child.children : [child])); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
    click() { this.listeners.get('click')?.({ currentTarget: this }); }
    pressKey(key) {
      let prevented = false;
      this.listeners.get('keydown')?.({ currentTarget: this, key, preventDefault() { prevented = true; } });
      return prevented;
    }
    getBoundingClientRect() { return { height: 200 }; }
    focus() { document.activeElement = this; }
  }
  return { root: new Element('div'), document, disconnected: () => disconnected };
}

function findByLabel(node, label) {
  if (node.attributes['aria-label'] === label) return node;
  for (const child of node.children) {
    const found = findByLabel(child, label);
    if (found) return found;
  }
}

test('three cost cards retain their folds and focus across updates and keep the saved timing baseline scoped', () => {
  const { root, document, disconnected } = dom(new Map([['stmq.heatingSavingMode', 'timing']]));
  const panel = createTimingBenefit(root);
  const data = { ...payload, firewoodBenefit: estimate, timingBenefit: { heatPump: timing(1), charger: timing(2,'charger') } };
  panel.render(data);
  const devices = root.children[1];
  assert.deepEqual(devices.children.map(card => card.dataset.device), ['heatPump', 'charger', 'firewood']);
  const wood = devices.children[2], fold = wood.children[1], summary = fold.children[0];
  fold.open = true; summary.focus();
  assert.match(root.children[0].textContent, /Heating by model estimate or timing cost/);
  assert.match(root.children[0].textContent, /different baselines and are not added together/);
  assert.match(wood.textContent, /€1.25/); assert(!wood.textContent.includes('€4.25'), 'there is no sum of the three cards');
  panel.render({ ...data, firewoodBenefit: { ...estimate, valueEuro: 2.25,
    remaining: { status: 'unavailable', reason: 'Fresh forecast coverage is unavailable.' } } });
  assert.equal(devices.children[2], wood); assert.equal(wood.children[1], fold);
  assert.equal(fold.open, true); assert.equal(document.activeElement, summary);
  assert.match(wood.textContent, /€2.25/);
  assert.match(wood.textContent, /Fresh forecast coverage is unavailable/);
  assert.match(devices.children[0].textContent, /€1.00/); assert.match(devices.children[1].textContent, /€2.00/);
  panel.close(); assert.equal(disconnected(), true);
});

test('heating choice changes its amount and details while preserving focus, folds and the other cards', () => {
  const storage = new Map(), { root, document } = dom(storage);
  const panel = createTimingBenefit(root);
  const data = { ...payload, heatingBenefit: { status: 'estimated', valueEuro: 3.5, counts: { assessed: 2, completed: 2 } },
    firewoodBenefit: estimate, timingBenefit: { heatPump: timing(1), charger: timing(2,'charger') } };
  panel.render(data);
  const [heating, charger, fireplace] = root.children[1].children;
  const overview = heating.children[0].children[0];
  const comparison = findByLabel(overview, 'Heating cost comparison');
  const [modelButton, timingButton] = comparison.children;
  const fold = heating.children[1]; fold.open = true;
  assert.equal(modelButton.attributes['aria-pressed'], 'true');
  assert.match(heating.textContent, /Estimated cost difference.*€3.50/);
  timingButton.focus(); timingButton.click();
  assert.equal(timingButton.attributes['aria-pressed'], 'true');
  assert.equal(document.activeElement, timingButton); assert.equal(fold.open, true);
  assert.match(heating.textContent, /Timing cost difference.*€1.00/);
  modelButton.focus(); modelButton.click();
  assert.equal(modelButton.attributes['aria-pressed'], 'true');
  assert.equal(timingButton.attributes['aria-pressed'], 'false');
  assert.equal(document.activeElement, modelButton); assert.equal(fold.open, true);
  assert.match(heating.textContent, /Estimated cost difference.*€3.50/);
  assert.doesNotMatch(heating.textContent, /€1.00|Energy used in the comparison/);
  assert.match(heating.textContent, /2 assessed cycles.*Cycles included/);
  assert.match(charger.textContent, /Timing cost difference.*€2.00/);
  assert.match(fireplace.textContent, /Estimated cost difference.*€1.25/);
  panel.render({ ...data, heatingBenefit: { status: 'unavailable', reason: 'no-completed-cycles' } });
  assert.equal(comparison.children[0], modelButton);
  assert.equal(document.activeElement, modelButton); assert.equal(heating.children[1], fold);
  assert.match(heating.textContent, /Estimate unavailable.*No completed heating cycles/);
  assert.doesNotMatch(heating.textContent, /€3.50|€1.00/);
  const reload = dom(storage), reloaded = createTimingBenefit(reload.root); reloaded.render(data);
  assert.match(reload.root.children[1].children[0].textContent, /Estimated cost difference.*€3.50/);
  timingButton.click(); assert.match(heating.textContent, /Timing cost difference.*€1.00/);
  const timingReload = dom(storage), reloadedTiming = createTimingBenefit(timingReload.root); reloadedTiming.render(data);
  assert.match(timingReload.root.children[1].children[0].textContent, /Timing cost difference.*€1.00/);
  panel.close(); modelButton.click(); assert.match(heating.textContent, /Timing cost difference.*€1.00/);
  reloaded.close(); reloadedTiming.close();
});

test('heating defaults to the model estimate with missing, blocked or invalid browser preferences', () => {
  for (const storage of [new Map(), new Map([['stmq.heatingSavingMode', 'invalid']]), {
    get() { throw new Error('Storage unavailable'); }, set() { throw new Error('Storage unavailable'); },
  }]) {
    const { root } = dom(storage), panel = createTimingBenefit(root);
    panel.render(payload);
    const heating = root.children[1].children[0];
    assert.match(heating.textContent, /Estimated cost difference.*Estimate unavailable/);
    const comparison = findByLabel(heating, 'Heating cost comparison');
    comparison.children[1].click();
    assert.match(heating.textContent, /Timing cost difference/);
    comparison.children[0].click();
    assert.match(heating.textContent, /Estimated cost difference.*Estimate unavailable/);
    panel.close();
  }
});

test('Home/Garage/Total changes only heating scope and keeps both comparison controls and folds stable', () => {
  const { root, document } = dom(), panel = createTimingBenefit(root);
  const data = { ...payload, heatingSavings: {
    home: { model: { status: 'estimated', valueEuro: 3 }, timing: timing(1) },
    garage: { model: { status: 'estimated', valueEuro: -1, provisional: true }, timing: timing(-0.5,'garage') },
    total: { model: { status: 'estimated', valueEuro: 2, provisional: true }, timing: timing(0.5,'total') },
  }, firewoodBenefit: estimate, timingBenefit: { charger: timing(2,'charger') } };
  panel.render(data);
  const [heating, charger, fireplace] = root.children[1].children, overview = heating.children[0].children[0];
  const scopes = findByLabel(overview, 'Heating cost comparison scope');
  const comparisons = findByLabel(overview, 'Heating cost comparison');
  const [home, garage, total] = scopes.children;
  assert.equal(home.attributes['aria-pressed'], 'true'); assert.match(heating.textContent, /€3.00/);
  const fold = heating.children[1]; fold.open = true;
  garage.focus(); garage.click(); assert.equal(document.activeElement, garage); assert.equal(fold.open, true);
  assert.match(heating.textContent, /-€1.00.*Provisional/);
  comparisons.children[1].click(); assert.match(heating.textContent, /Timing cost difference.*-€0.50/);
  total.click(); assert.match(heating.textContent, /Timing cost difference.*€0.50/);
  home.click(); assert.match(heating.textContent, /Timing cost difference.*€1.00/);
  assert.equal(home.pressKey('ArrowLeft'), true);
  assert.equal(document.activeElement, total); assert.match(heating.textContent, /Timing cost difference.*€0.50/);
  total.pressKey('Home'); assert.equal(document.activeElement, home);
  home.pressKey('End'); assert.equal(document.activeElement, total);
  total.pressKey('ArrowRight'); assert.equal(document.activeElement, home);
  home.pressKey('ArrowDown'); assert.equal(document.activeElement, garage);
  assert.match(heating.textContent, /Timing cost difference.*-€0.50/);
  garage.pressKey('ArrowUp'); assert.equal(document.activeElement, home);
  comparisons.children[1].pressKey('ArrowRight');
  assert.equal(document.activeElement, comparisons.children[0]);
  assert.match(heating.textContent, /Estimated cost difference.*€3.00/);
  assert.equal(comparisons.children[0].pressKey('Tab'), false, 'Ordinary Tab navigation is left to the browser');
  assert.equal(fold.open, true);
  assert.match(charger.textContent, /€2.00/); assert.match(fireplace.textContent, /€1.25/);
  panel.close();
  assert.equal(home.pressKey('ArrowRight'), false, 'Closing removes keyboard handlers as well as click handlers');
});

test('visible rate assumptions follow Heating scope and Fireplace while shared copy never denies them', () => {
  const { root } = dom(new Map([['stmq.heatingSavingMode', 'timing']]));
  const panel = createTimingBenefit(root);
  const assumed = { durationMs: HOUR, share: 1, firstAt: from, lastAt: from + HOUR };
  const data = { ...payload, meta: { priceAssumptions: { used: true } }, heatingSavings: {
    home: { timing: timing(1) },
    garage: { timing: { ...timing(2, 'garage'), assumedPrices: true, priceAssumptions: assumed } },
    total: { timing: { ...timing(3, 'total'), assumedPrices: true, priceAssumptions: assumed } },
  }, firewoodBenefit: estimate };
  panel.render(data);
  const heating = root.children[1].children[0];
  const scopes = findByLabel(heating, 'Heating cost comparison scope');
  for (const index of [1, 2]) {
    scopes.children[index].click();
    assert.match(heating.textContent, /Assumed rates/);
    assert.doesNotMatch(root.textContent, /no device comparison here includes/);
  }
  findByLabel(heating, 'Heating cost comparison').children[0].click();
  panel.render({ ...data, meta: {}, firewoodBenefit: { ...estimate, priceAssumptions: assumed } });
  assert.match(root.children[1].children[2].textContent, /Assumed rates/);
  assert.match(root.children[2].textContent, /When contract rates are assumed/);
  panel.render({ ...data, meta: {}, firewoodBenefit: estimate });
  assert.doesNotMatch(root.children[2].textContent, /When contract rates are assumed/,
    'Hidden timing scope assumptions do not qualify an unaffected visible model comparison');
  panel.close();
});

test('details expose numerical operands and preserve the methodology disclosure across updates', () => {
  const { root, document } = dom(new Map([['stmq.heatingSavingMode', 'timing']]));
  const panel = createTimingBenefit(root);
  const data = { ...payload, timingBenefit: { heatPump: { ...timing(1), energyKwh: 5,
    actualCostEuro: 2.5, uniformCostEuro: 3.5 } } };
  panel.render(data);
  const heating = root.children[1].children[0], methodology = root.children[2];
  assert.match(heating.children[1].textContent, /Included electricity.*5 kWh.*€3.50.*€2.50.*€1.00/);
  assert.match(heating.children[1].textContent, /minus.*timing difference/);
  assert.equal(methodology.tagName, 'details');
  const summary = methodology.children[0]; methodology.open = true; summary.focus();
  panel.render({ ...data, meta: { priceAssumptions: { used: true } } });
  assert.equal(root.children[2], methodology); assert.equal(methodology.open, true);
  assert.equal(methodology.children[0], summary); assert.equal(document.activeElement, summary);
  panel.close();
});
