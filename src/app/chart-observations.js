import { RECORDED_EVIDENCE_SIGNALS } from '../domain/history-series.js';
import { EVENT_CONTACT_SIGNALS } from '../domain/recording-policy.js';

// Native scalar projection needs full raw evidence only for these signals or
// an explicit source-clock admission. Keep SQL and resident reads in agreement.
export const NATIVE_CHART_RAW_SIGNALS = Object.freeze([
  'heat_pump_power', 'charger_power', 'solar_radiation', 'auxiliary_output',
  'compressor_active', 'dhw_routing', 'operating_mode', 'controller_phase', 'dhwr_request',
  'learning_profit', 'learning_aux_profit', 'learning_recovery_error', 'learning_indoor_temperature',
  ...RECORDED_EVIDENCE_SIGNALS,
  ...EVENT_CONTACT_SIGNALS,
]);
