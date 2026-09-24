import { heatingDisplay, heatingExplanations } from './heating-benefit.js';
import { timingDisplay } from './timing-model.js';

const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' });
const finite = Number.isFinite;
const names = { home: 'Home', garage: 'Garage', total: 'Total' };
export const garageHeatingExplanations = [
  'Garage compares completed episodes with their frozen normal-heating reference. Preparation, the pause, recovery and residual heat debt belong to the same assessment. Weather and EV assumptions are shared by both alternatives.',
  'This counterfactual is provisional, including when native electrical readings are available. It is separate from the same-energy timing comparison; the two amounts are never added.',
  'Full episodes are counted on their Finnish completion date. An active forecast and an incomplete episode cannot become completed savings.',
];

export function heatingScopeDisplay(payload, scope = 'home', mode = 'model') {
  const selected = payload?.heatingSavings?.[scope]?.[mode === 'model' ? 'model' : 'timing'];
  const result = selected ?? (scope === 'home' ? mode === 'model' ? payload?.heatingBenefit : payload?.timingBenefit?.heatPump : {}) ?? {};
  // Preserve the existing Home figures and copy; scope switching is display-only.
  const display = mode === 'model' ? heatingDisplay(result.status === 'partial' ? { ...result, status: 'estimated' } : result, payload)
    : timingDisplay(scope === 'home' ? 'heatPump' : scope === 'garage' ? 'garageHeatPump' : 'totalHeatPump', result, payload);
  // Scope selects the evidence contract, while all scopes reuse the same
  // mounted Heating card and its persistent disclosures and controls.
  display.key = 'heatPump';
  display.scope = scope;
  display.explanations = scope === 'home' ? heatingExplanations : scope === 'garage' ? garageHeatingExplanations
    : [heatingExplanations[0], ...garageHeatingExplanations, 'Total adds compatible Home and Garage completed-cycle amounts for the same reporting period. A partial total names any missing component.'];
  if (scope === 'home') return display;
  display.name = 'Heating';
  const partial = result.partial && display.available;
  const missing = (result.missingScopes ?? []).map(key => names[key]).join(' and ');
  display.qualification = partial ? `Partial total${missing ? ` · ${missing} unavailable` : ' · some assessments excluded'}`
    : result.provisional ? 'Provisional estimate' : null;
  display.periodLabel = names[scope];
  display.unavailableReason = ({
    'no-qualified-electrical-intervals': 'No qualified garage electricity intervals. Temperature learning can continue without a meter.',
    'overlapping-electrical-sources': 'Conflicting garage electricity intervals are excluded.',
    'overlapping-or-unknown-scope': 'Home and Garage sources overlap or their separation is unknown. A total is unsupported.',
    'incompatible-period-or-basis': 'The reporting periods or assessment methods are not comparable.',
    'missing-component': 'No supported contributions are available for this period.',
  })[result.reason] ?? display.unavailableReason;
  if (mode === 'timing') {
    display.basis = scope === 'garage' ? result.sourceQuality === 'simulated-electrical' ? 'Simulated electrical intervals' : result.sourceQuality === 'verified-electrical' ? 'Verified electrical intervals' : 'Provisional electrical intervals' : 'Separate Home and Garage comparisons';
    display.energyExplanation = scope === 'garage'
      ? 'Uses only dedicated garage electricity intervals with qualified units and intraday timing. Compressor frequency, runtime and coarse counter totals do not count as recorded energy. Native accuracy remains provisional unless independently checked.'
      : 'Adds Home and Garage timing amounts for the same Finnish dates. Each system uses its own included daily energy and the same full-day all-in price benchmark. Home operation estimates retain their qualification.';
    display.coverageExplanation = scope === 'garage'
      ? 'Includes full electrical intervals of at most fifteen minutes and complete daily prices. Missing or overlapping intervals are excluded, and valid zero-use intervals remain included.'
      : 'Coverage is included Home plus Garage time divided by their combined elapsed time. The breakdown shows each system separately; missing evidence is never zero and is not extrapolated.';
    if (scope === 'garage') display.sources = display.sources.map(item => ({ ...item, explanation: item.key === 'simulated' ? 'Simulated electrical intervals; no household energy measurement.' : 'Dedicated garage electrical intervals with qualified units and intraday timing. Accuracy retains the original recorded qualification.' }));
    if (scope === 'total') { display.sources = []; display.auxiliaryNotes = []; }
    if (scope === 'total') display.coverageLabel = `${Math.round((result.coverage ?? 0) * 100)}% of combined system time`;
  }
  display.breakdown = scope === 'total' ? ['home', 'garage'].map(key => {
    const item = payload?.heatingSavings?.[key]?.[mode === 'model' ? 'model' : 'timing'] ?? {};
    const value = mode === 'model' ? ['estimated', 'partial'].includes(item.status) ? item.valueEuro : null
      : item.status !== 'unavailable' ? item.value : null;
    const evidence = mode === 'model' ? `${item.counts?.assessed ?? 0} assessed cycles`
      : `${Math.round((item.coverage ?? 0) * 100)}% elapsed time included`;
    const quality = mode === 'timing' ? item.sourceQuality ?? item.evidence?.sources?.map(source => source.key === 'observed' ? 'operation estimate' : source.key).join(', ') : null;
    return `${names[key]}: ${finite(value) ? money.format(value) : 'unavailable'} · ${evidence}${quality ? ` · ${quality.replaceAll('-', ' ')}` : ''}${item.provisional ? ' · provisional' : ''}.`;
  }) : [];
  return display;
}
