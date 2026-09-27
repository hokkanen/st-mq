import { createChartLoader, dateSelection, finnishDate, selectedRange, shiftDate } from './history-model.js';
import { createDatePicker } from './date-picker.js';
import { createTimingBenefit } from './timing-benefit.js';
import { replicaSnapshotKey } from './replica-status.js';

const presets = ['week', 'month', 'year', 'previous-year'];

/** Calendar periods use Finnish dates, including across DST and year boundaries. */
export function comparisonPeriod(preset, now) {
  const today = finnishDate(now), year = Number(today.slice(0, 4));
  if (preset === 'week') return { startDate: shiftDate(today, -6), endDate: today };
  if (preset === 'month') {
    const endDate = shiftDate(`${today.slice(0, 7)}-01`, -1);
    return { startDate: `${endDate.slice(0, 7)}-01`, endDate };
  }
  if (preset === 'year') return { startDate: `${year}-01-01`, endDate: today };
  if (preset === 'previous-year') return { startDate: `${year - 1}-01-01`, endDate: `${year - 1}-12-31` };
  return selectedRange('today', now);
}

const sameDates = (a, b) => a && b && a.startDate === b.startDate && a.endDate === b.endDate;
const periodLabel = dates => dates.startDate === dates.endDate ? dates.startDate : `${dates.startDate} – ${dates.endDate}`;

/** Comparisons own their dates, requests and refresh state independently of the plot. */
export function createComparisonRange({ api, document = globalThis.document, now = Date.now }) {
  const $ = id => document.getElementById(id);
  const root = $('timing-benefit');
  if (!root) return { refresh() {}, close() {} };
  const view = createTimingBenefit(root), loader = createChartLoader({ api, now });
  const start = $('comparison-date-start'), end = $('comparison-date-end');
  const form = $('comparison-range-form'), message = $('comparison-range-status'), retry = $('comparison-range-retry');
  let selection = comparisonPeriod('today', now()), suggestedEndDate = selection.endDate;
  let activePreset = 'today', rangeActive = false, initialized = false, closed = false;
  let status, loaded, revision, recordingRevision, generation = 0;
  const listeners = [];
  function listen(node, event, handler) {
    node.addEventListener(event, handler);
    listeners.push(() => node.removeEventListener(event, handler));
  }
  function updateControls() {
    startPicker.dismiss(); endPicker.dismiss();
    start.value = selection.startDate; end.value = suggestedEndDate;
    end.min = selection.startDate; end.dataset.singleDay = String(!rangeActive);
    for (const preset of presets) $(`comparison-period-${preset}`).setAttribute('aria-pressed', String(activePreset === preset));
  }
  function setState(state, text) {
    form.dataset.state = state;
    message.textContent = text;
    root.setAttribute('aria-busy', String(state === 'loading'));
    root.dataset.stale = String(Boolean(loaded && !sameDates(selection, loaded)));
    retry.hidden = state !== 'error';
  }
  async function refresh(nextStatus = status, { force = false } = {}) {
    if (closed) return;
    status = nextStatus ?? { now: now() };
    if (!initialized) {
      if (activePreset) {
        selection = comparisonPeriod(activePreset, status.now);
        suggestedEndDate = selection.endDate;
      }
      initialized = true; updateControls();
    }
    const nextRevision = JSON.stringify([status.input, status.contract, replicaSnapshotKey(status),
      status.fireplace?.revision, status.fireplace?.rebuild?.status, status.learning?.adaptive?.model?.trainedAt]);
    if (force || revision !== undefined && revision !== nextRevision) { loader.invalidate(); force = true; }
    revision = nextRevision;
    const today = finnishDate(status.now);
    const nextRecording = JSON.stringify([status.recording?.historyRevision, status.recording?.sourceReportRevision]);
    const longRange = Date.parse(selection.endDate) - Date.parse(selection.startDate) >= 7 * 86400000;
    if (!longRange && selection.endDate >= today && recordingRevision !== undefined && nextRecording !== recordingRevision) force = true;
    recordingRevision = nextRecording;
    const requested = { ...selection }, requestGeneration = ++generation;
    if (!sameDates(requested, loaded) || form.dataset.state === 'error') {
      setState('loading', `Loading ${periodLabel(requested)}…${loaded ? ` Showing ${periodLabel(loaded)} until ready.` : ''}`);
    }
    try {
      const payload = await loader.load({ ...requested, view: 'power', points: 100 }, { force, today });
      if (closed || requestGeneration !== generation || !sameDates(requested, selection)) return;
      view.render(payload);
      loaded = requested;
      form.dataset.startDate = loaded.startDate; form.dataset.endDate = loaded.endDate;
      setState('ready', `${periodLabel(loaded)} · Finnish time${payload.input === 'simulated' ? ' · simulated data' : ''}`);
    } catch (error) {
      if (closed || requestGeneration !== generation || error.name === 'AbortError') return;
      setState('error', `Unable to load ${periodLabel(requested)}: ${error.message}.${loaded ? ` Showing ${periodLabel(loaded)}.` : ''}`);
    }
  }
  function applyDate(field) {
    const input = field === 'start' ? start : end;
    if (!input.checkValidity()) return;
    const dates = dateSelection(selection, field, input.value);
    if (!dates) return;
    selection = dates; activePreset = null; rangeActive = field === 'end';
    if (rangeActive) suggestedEndDate = dates.endDate;
    updateControls(); refresh();
  }
  const startPicker = createDatePicker(start, { label: 'Choose comparison start date', onSelect() { applyDate('start'); } });
  const endPicker = createDatePicker(end, { label: 'Choose comparison end date', onSelect() { applyDate('end'); } });
  listen(start, 'change', () => applyDate('start'));
  listen(end, 'change', () => applyDate('end'));
  listen(form, 'submit', event => event.preventDefault());
  for (const preset of presets) listen($(`comparison-period-${preset}`), 'click', () => {
    activePreset = preset; selection = comparisonPeriod(preset, status?.now ?? now());
    suggestedEndDate = selection.endDate; rangeActive = true;
    updateControls(); refresh();
  });
  listen(retry, 'click', () => refresh(status, { force: true }));
  updateControls();
  return { refresh, close() {
    closed = true; loader.close(); startPicker.close(); endPicker.close(); view.close();
    listeners.forEach(remove => remove());
  } };
}
