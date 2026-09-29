import { heatingDisplay, heatingExplanations } from './heating-benefit.js';
import { timingDisplay } from './timing-model.js';

const names = { home: 'Home', garage: 'Garage', total: 'Total' };
export function heatingScopeDisplay(payload, scope = 'home', mode = 'model') {
  if (scope !== 'home') mode = 'timing';
  const selected = payload?.heatingSavings?.[scope]?.[mode === 'model' ? 'model' : 'timing'];
  const result = selected ?? (scope === 'home' ? mode === 'model' ? payload?.heatingBenefit : payload?.timingBenefit?.heatPump : {}) ?? {};
  // Preserve the existing Home figures and copy; scope switching is display-only.
  const display = mode === 'model' ? heatingDisplay(result.status === 'partial' ? { ...result, status: 'estimated' } : result, payload)
    : timingDisplay(scope === 'home' ? 'heatPump' : scope === 'garage' ? 'garageHeatPump' : 'totalHeatPump', result, payload);
  // Scope selects the evidence contract, while all scopes reuse the same
  // mounted Heating card and its persistent disclosures and controls.
  display.key = 'heatPump';
  display.scope = scope;
  display.explanations = heatingExplanations;
  if (scope === 'home') return display;
  display.name = 'Heating';
  const partial = result.partial && display.available;
  const missing = (result.missingScopes ?? []).map(key => names[key]).join(' and ');
  display.qualification = partial ? scope === 'total'
    ? `Partial total${missing ? ` · ${missing} unavailable` : ' · some intervals excluded'}` : 'Some intervals excluded'
    : result.provisional ? 'Provisional estimate' : null;
  display.unavailableReason = ({
    'no-elapsed-time': 'No elapsed time in this selection',
    'incomplete-daily-prices': 'Full-day prices missing',
    'no-qualified-electrical-intervals': 'No qualified garage electricity intervals.',
    'overlapping-electrical-sources': 'Conflicting garage electricity intervals are excluded.',
    'overlapping-or-unknown-scope': 'Home and Garage sources overlap or their separation is unknown. A total is unsupported.',
    'incompatible-period-or-basis': 'The reporting periods or assessment methods are not comparable.',
    'missing-component': 'No supported contributions are available for this period.',
  })[result.reason] ?? display.unavailableReason;
  display.basis = scope === 'garage' ? result.sourceQuality === 'simulated-electrical' ? 'Simulated electrical intervals' : result.sourceQuality === 'verified-electrical' ? 'Verified electrical intervals' : 'Provisional electrical intervals' : 'Separate Home and Garage comparisons';
  display.energyExplanation = scope === 'garage'
    ? 'Compares recorded electricity timing with the same energy spread evenly over each day. It does not attribute savings to Garage control. Uses only dedicated garage electricity intervals with qualified units and intraday timing. Compressor frequency, runtime and coarse counter totals do not count as recorded energy. Native accuracy remains provisional unless independently checked.'
    : 'Adds Home and Garage timing amounts for the same Finnish dates. Each system uses its own included daily energy and the same full-day all-in price benchmark. Home operation estimates retain their qualification.';
  display.coverageExplanation = scope === 'garage'
    ? 'Includes full electrical intervals of at most fifteen minutes and complete daily prices. Missing or overlapping intervals are excluded, and valid zero-use intervals remain included.'
    : 'Coverage is included Home plus Garage time divided by their combined elapsed time. The breakdown shows each system separately; missing evidence is never zero and is not extrapolated.';
  if (scope === 'garage') display.sources = display.sources.map(item => ({ ...item, explanation: item.key === 'simulated' ? 'Simulated electrical intervals; no household energy measurement.' : 'Dedicated garage electrical intervals with qualified units and intraday timing. Accuracy retains the original recorded qualification.' }));
  if (scope === 'total') { display.sources = []; display.auxiliaryNotes = []; }
  display.breakdown = scope === 'total' ? ['home', 'garage'].map(key => {
    const component = heatingScopeDisplay(payload, key, 'timing');
    return `${names[key]}: ${component.amount ?? 'Unavailable'} · ${component.coverageLabel}${component.basis ? ` · ${component.basis}` : ''}.`;
  }) : [];
  return display;
}
