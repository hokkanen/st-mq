export const CARAVAN_TEMPERATURE_CONTROL_DEFAULTS = Object.freeze({ enabled: true, offAtC: 1, onAtC: 2 });

export const validCaravanTemperatureControl = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 3 && Object.keys(value).every(key => Object.hasOwn(CARAVAN_TEMPERATURE_CONTROL_DEFAULTS, key))
  && typeof value.enabled === 'boolean'
  && [value.offAtC, value.onAtC].every(number => typeof number === 'number' && Number.isFinite(number)
    && number >= -10 && number <= 30 && Math.abs(number * 10 - Math.round(number * 10)) < 1e-8)
  && value.onAtC - value.offAtC >= 0.5 - 1e-8);
