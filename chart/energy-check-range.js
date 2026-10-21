import { comparisonPeriod } from './comparison-range.js';
import { dateSelection } from './history-model.js';
import { createDatePicker } from './date-picker.js';

/** The check period is independent of chart and cost-comparison selections. */
export function createEnergyCheckRange({ document = globalThis.document, now = Date.now, onChange }) {
  const $ = id => document.getElementById(`energy-check-${id}`);
  const start = $('date-start'), end = $('date-end'), form = $('range-form'), message = $('range-status');
  const presets = ['week', 'month', 'year', 'previous-year'];
  let dates = comparisonPeriod('week', now()), preset = 'week', initialized = false;
  function draw() {
    startPicker.dismiss(); endPicker.dismiss();
    start.value = dates.startDate; end.value = dates.endDate; end.min = dates.startDate;
    for (const key of presets) $(`period-${key}`).setAttribute('aria-pressed', String(key === preset));
    message.textContent = `${dates.startDate}${dates.endDate === dates.startDate ? '' : ` – ${dates.endDate}`} · Finnish time`;
    form.dataset.state = 'ready';
  }
  function apply(field) {
    const input = field === 'start' ? start : end;
    const selected = input.checkValidity() && dateSelection(dates, field, input.value);
    if (!selected) {
      form.dataset.state = 'error';
      message.textContent = 'Choose valid dates with the end on or after the start.';
      return;
    }
    initialized = true; preset = null; dates = selected; draw(); onChange();
  }
  const startPicker = createDatePicker(start, { label: 'Choose energy check start date', onSelect() { apply('start'); } });
  const endPicker = createDatePicker(end, { label: 'Choose energy check end date', onSelect() { apply('end'); } });
  start.addEventListener('change', () => apply('start'));
  end.addEventListener('change', () => apply('end'));
  form.addEventListener('submit', event => event.preventDefault());
  for (const key of presets) $(`period-${key}`).addEventListener('click', () => {
    initialized = true; preset = key; dates = comparisonPeriod(key, now()); draw(); onChange();
  });
  draw();
  return { selection() {
    // Use the controller's clock once it arrives; never replace a user's draft.
    if (!initialized) { dates = comparisonPeriod('week', now()); initialized = true; draw(); }
    return { ...dates };
  } };
}
