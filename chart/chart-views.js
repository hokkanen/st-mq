import { CHART_VIEWS, CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import { EXPLORER_SERIES_BY_KEY, explorerSelection } from './series-explorer.js';
export { CHART_VIEWS, CHART_VIEW_BY_KEY };
export const CHART_PREFERENCES_KEY = 'home-energy-chart-views';
const prices = ['all_in_price', 'spot_price'];

export function chartSelectionKey(selection) {
  return selection.view ?? `series:${selection.series ?? selection.left}`;
}
export function selectedChartView(selection) {
  const definition = selection.view ? Object.hasOwn(CHART_VIEW_BY_KEY, selection.view) && CHART_VIEW_BY_KEY[selection.view] : explorerSelection(selection.series ?? selection.left);
  if (!definition) throw new RangeError('Choose a chart view.');
  return { ...definition, rightSignals: [...new Set([...definition.rightSignals, ...prices.filter(key => !definition.leftSignals.includes(key))])] };
}
export function readChartPreferences(storage) {
  const empty = { view: 'power', series: 'garage_native_indoor_temperature', views: {}, prices: {}, interpolation: true };
  try {
    const saved = JSON.parse(storage.getItem(CHART_PREFERENCES_KEY) ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return empty;
    const booleans = value => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      .filter(([key, value]) => /^[a-zA-Z0-9_]{1,100}$/.test(key) && typeof value === 'boolean'));
    return { view: saved.view === 'explorer' || Object.hasOwn(CHART_VIEW_BY_KEY, saved.view) ? saved.view : empty.view,
      series: Object.hasOwn(EXPLORER_SERIES_BY_KEY, saved.series) ? saved.series : empty.series,
      interpolation: saved.interpolation !== false,
      prices: Object.fromEntries(Object.entries(booleans(saved.prices)).filter(([key]) => prices.includes(key))),
      views: Object.fromEntries(Object.entries(saved.views && typeof saved.views === 'object' ? saved.views : {})
        .filter(([key]) => Object.hasOwn(CHART_VIEW_BY_KEY, key) || key.startsWith('series:') && Object.hasOwn(EXPLORER_SERIES_BY_KEY, key.slice(7)))
        .map(([key, value]) => [key, Object.fromEntries(Object.entries(booleans(value)).filter(([signal]) => !prices.includes(signal)))])) };
  } catch { return empty; }
}
export function chartViewPreferences(view, preferences) {
  return { ...view.defaults, ...preferences.views[view.key], ...preferences.prices };
}
export function setChartVisibility(preferences, view, key, shown) {
  if (prices.includes(key)) preferences.prices[key] = shown;
  else (preferences.views[view.key] ??= {})[key] = shown;
}
export function chartSubjectAvailability(view, datasets, payload, preferences) {
  const subject = datasets.filter(dataset => !prices.includes(dataset.key) || view.leftSignals.includes(dataset.key));
  const enabled = subject.filter(dataset => !dataset.hidden);
  const tracks = view.tracks.filter(key => preferences[key] !== false);
  if (!enabled.length && !tracks.length) return 'All view series are hidden';
  const hasValues = dataset => dataset.data.some(point => Number.isFinite(point.y));
  const primary = enabled.filter(dataset => view.leftSignals.includes(dataset.key));
  if (primary.length && !primary.some(hasValues) && enabled.some(hasValues)) return `No ${view.unit} values in this period · temperature context shown`;
  if (enabled.some(hasValues)) return '';
  if (tracks.some(key => key === 'shellyLimiter' ? payload.limiterHistory?.spans?.length : key === 'operatingMode' ? payload.operatingModes?.length
    : payload.shading?.[key]?.length || payload.series?.[key]?.some(point => Number.isFinite(point.y)))) return '';
  return 'No recorded values for the visible subject in this period';
}
