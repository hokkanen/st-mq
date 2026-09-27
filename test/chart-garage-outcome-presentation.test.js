import test from 'node:test';
import assert from 'node:assert/strict';
import { historyDatasets, historySeriesAt, defaultPalette } from '../chart/history-model.js';
import { historyTooltipLabel, historyTooltipTitle } from '../chart/history-tooltips.js';
import { EXPLORER_SERIES_BY_KEY, compatibleExplorerSeries, explorerSelection } from '../chart/series-explorer.js';
import { isInterpolatedTemperature } from '../src/domain/chart-temperatures.js';

const at = Date.UTC(2026, 0, 3, 1);
const revision = 'a'.repeat(64);
const item = (key, y, raw = {}) => ({
  dataset: historyDatasets({}, explorerSelection(key)).find(row => row.key === key),
  parsed: { x: at, y }, raw: { x: at, y, modelOutcome: true, inputSource: 'Recorded garage inputs', ...raw },
});

test('garage explorer identifies replayed outcomes and completed frozen episodes separately from measurements', () => {
  for (const location of ['rear', 'front']) {
    const reference = `garage_outcome_${location}_reference`, error = `garage_outcome_${location}_error`;
    assert.equal(EXPLORER_SERIES_BY_KEY[reference].basis, 'Replayed model outcome');
    assert.equal(EXPLORER_SERIES_BY_KEY[error].basis, 'Replayed model outcome');
    assert(compatibleExplorerSeries(reference, 'garage_temperature'));
    assert(!compatibleExplorerSeries(error, reference));
  }
  assert(compatibleExplorerSeries('garage_outcome_rear_error', 'garage_outcome_front_error'));
  assert.equal(EXPLORER_SERIES_BY_KEY.garage_outcome_benefit.basis, 'Completed frozen episode estimate');
  assert(!compatibleExplorerSeries('garage_outcome_benefit', 'learning_profit'));
  assert(!compatibleExplorerSeries('garage_outcome_benefit', 'garage_energy'));
});

test('achieved garage references curve on the temperature axis while held-out errors remain stepped differences', () => {
  const points = [{ x: at, y: 0 }, { x: at + 1000, y: 1 }, { x: at + 2000, y: null }];
  for (const location of ['rear', 'front']) {
    const reference = `garage_outcome_${location}_reference`, error = `garage_outcome_${location}_error`;
    const referenceView = explorerSelection(reference), errorView = explorerSelection(error);
    const referenceRow = historyDatasets({ [reference]: points }, referenceView).find(row => row.key === reference);
    const errorRow = historyDatasets({ [error]: points }, errorView).find(row => row.key === error);
    assert(referenceView.rightSignals.includes(reference));
    assert.deepEqual(errorView.leftSignals, [error]);
    assert.equal(errorView.unit, 'Δ°C');
    assert(isInterpolatedTemperature(reference));
    assert(!isInterpolatedTemperature(error));
    assert.equal(referenceRow.yAxisID, 'right');
    assert.equal(referenceRow.cubicInterpolationMode, 'monotone');
    assert.equal(referenceRow.stepped, false);
    assert.deepEqual(referenceRow.borderDash, [12, 4]);
    const actualKey = `garage_model_${location}`;
    const actualRow = historyDatasets({}, { leftSignals: [], rightSignals: [actualKey] })[0];
    assert.equal(referenceRow.borderColor, actualRow.borderColor);
    assert.notDeepEqual(referenceRow.borderDash, actualRow.borderDash, 'Learned references stay distinguishable from their actual probe inputs');
    assert.equal(errorRow.yAxisID, 'left');
    assert.equal(errorRow.stepped, true);
    assert.deepEqual(errorRow.borderDash, []);
    assert.equal(referenceRow.spanGaps, false);
    assert.equal(errorRow.spanGaps, false);
    assert.equal(referenceRow.data, points);
    assert.equal(errorRow.data, points);
    assert.equal(referenceRow.borderColor, location === 'rear' ? defaultPalette.garage : defaultPalette.garageFront);
    assert.equal(errorRow.borderColor, referenceRow.borderColor);
  }
});

test('garage benefits retain negative and zero completed episodes as hollow events without synthetic holds', () => {
  const key = 'garage_outcome_benefit';
  const episodes = [-.25, 0, .5].map((y, index) => ({ x: at + index * 1000, y, modelOutcome: true,
    intervalStart: at - 1000, intervalEnd: at + index * 1000, provisional: true }));
  const synthetic = ['displayBoundary', 'carriedForward', 'displayContext', 'interpolated']
    .map((flag, index) => ({ x: at + 3000 + index, y: .5, [flag]: true }));
  const series = { [key]: [...episodes, ...synthetic] }, before = structuredClone(series);
  const projected = historySeriesAt({ series, range: { from: at - 1000, to: at + 10_000 }, now: at + 9000 });
  assert.equal(projected[key], series[key], 'Completed episodes never acquire a live held tail');
  const row = historyDatasets(projected, explorerSelection(key)).find(row => row.key === key);
  assert.deepEqual(row.data, episodes);
  assert.equal(row.kind, 'episode');
  assert.equal(row.showLine, false);
  assert.equal(row.stepped, false);
  assert.equal(row.fill, false);
  assert.equal(row.pointStyle, 'circle');
  assert.equal(row.pointBackgroundColor, 'transparent');
  assert(row.pointRadius >= 4);
  assert.equal(row.borderColor, defaultPalette.learning);
  assert.deepEqual(series, before);
});

test('garage outcome tooltips disclose achieved references, validation evidence and corrected replay provenance', () => {
  const reference = historyTooltipLabel(item('garage_outcome_rear_reference', 0, {
    outcomeBasis: 'continuously-available-achieved-reference', evidenceCount: 0, evidenceHours: 0,
    modelUpdatedAt: at, correctionRevision: revision,
  }));
  assert.match(reference, /0 °C.*replayed model outcome.*achieved normal-heating reference; not a thermostat setting/);
  assert.match(reference, /Recorded garage inputs.*model updated/);
  assert.match(reference, /correction revision a{12}/);
  assert.match(reference, /0 normal-heating samples.*0 h qualified normal-heating evidence/);
  const error = historyTooltipLabel(item('garage_outcome_front_error', 0, {
    outcomeBasis: 'rolling-clean-held-out-off-episode-rmse', evidenceCount: 3, evidenceHours: 1.5,
  }));
  assert.match(error, /0 Δ°C.*rolling clean held-out OFF-episode RMSE; lower is better/);
  assert.match(error, /3 clean held-out OFF validation episodes.*1.5 h held-out OFF evidence/);
  assert.doesNotMatch(error, /recorded temperature|recorded interval energy|normal-heating samples/);
});

test('episode tooltips preserve the completed interval, model uncertainty and allowlisted electricity evidence', () => {
  const raw = { outcomeBasis: 'garage-frozen-normal-reference', intervalStart: at, intervalEnd: at + 7_200_000,
    provisional: true, electricityBasis: 'recorded-and-modeled-electricity', referenceCostEuro: 0,
    actualCostEuro: .25, uncertaintyEuro: 0 };
  const episode = item('garage_outcome_benefit', -.25, raw), label = historyTooltipLabel(episode);
  assert.match(label, /-0.25 €\/episode.*completed episode estimate.*frozen normal-reference model estimate/);
  assert.match(label, /positive is benefit, negative is extra cost/);
  assert.match(label, /provisional model estimate.*recorded and modelled electricity/);
  assert.match(label, /frozen reference cost 0 €.*assessed actual cost 0.25 €.*model uncertainty 0 €/);
  assert.doesNotMatch(label, /recorded interval energy|meter check|fitted in current model/);
  const title = historyTooltipTitle([episode]).join(' ');
  assert.match(title, /03:00/);
  assert.match(title, /05:00/);
  assert.match(title, /Finland/);
  const unknown = historyTooltipLabel(item('garage_outcome_benefit', 0, {
    ...raw, outcomeBasis: 'unsupported-private-basis', electricityBasis: 'unsupported-private-electricity',
  }));
  assert.match(unknown, /0 €\/episode.*outcome basis unavailable.*electricity basis unavailable/);
  assert.doesNotMatch(unknown, /unsupported-private/);
});
