// Top AC's role protocol is described in Shelly's XT1 device documentation.
// The upstream evcc TopAC driver supplies the common work-state meanings.
// Native enum metadata and a verified unplug/replug with Auto charge disabled
// qualify charger_insert as connected but not charging.
// Unknown states remain unavailable; they never imply a physical unplug.
export const SHELLY_WORK_STATES = Object.freeze({
  connectedStates: Object.freeze(['charger_insert', 'charger_wait', 'charger_pause', 'charger_complete', 'charger_end']),
  disconnectedStates: Object.freeze(['charger_free']),
  chargingStates: Object.freeze(['charger_charging']),
});

// These are integration constants, not installation commissioning assertions.
// Numeric writes additionally require matching live capabilities.
export function shellyProfile(config) {
  return { ...config, ...SHELLY_WORK_STATES, minimumCurrentA: 6, currentStepA: 1 };
}

export function supportedShellyStates(component) {
  return Array.isArray(component?.options) && component.options.includes('charger_free')
    && component.options.includes('charger_charging');
}
