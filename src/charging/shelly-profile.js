// Top AC's role protocol is described in Shelly's XT1 device documentation.
// Work-state meanings are also published by the upstream evcc TopAC driver;
// charger_end was observed while plugged in during the 2 October setup.
// Unknown states remain unavailable; they never imply a physical unplug.
export const SHELLY_WORK_STATES = Object.freeze({
  connectedStates: Object.freeze(['charger_wait', 'charger_pause', 'charger_complete', 'charger_end']),
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
