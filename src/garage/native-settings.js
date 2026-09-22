/** Ordinary Mitsubishi settings are a distinct, explicitly requested control
 * surface. These bounds never grant automatic pause or restoration authority. */
export const GARAGE_NATIVE_SETTINGS = Object.freeze({
  power: { values: ['on', 'off'] },
  mode: { values: ['heat', 'cool', 'auto', 'dry', 'fan'] },
  targetC: { min: 16, max: 31 },
  fan: { values: ['auto', 'quiet', 1, 2, 3, 4] },
  vane: { values: ['auto', 1, 2, 3, 4, 5, 'swing'] },
  wideVane: { values: ['far-left', 'left', 'center', 'right', 'far-right', 'split', 'swing'] },
});

// Unlike 16°C, the installed pump's 17°C readback is distinguishable from
// remote-selected i-save 10°C. This is the native basis for external sensing.
export const GARAGE_EXTERNAL_NATIVE_TARGET_C = 17;

export function validateGarageNativeSetting(input, targetStep = 1) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
    || typeof input.setting !== 'string' || !Object.hasOwn(input, 'setting') || !Object.hasOwn(input, 'value')
    || !Object.hasOwn(GARAGE_NATIVE_SETTINGS, input.setting)) throw new Error('Choose one supported Mitsubishi setting and value.');
  const definition = GARAGE_NATIVE_SETTINGS[input.setting];
  const valid = definition.values ? definition.values.includes(input.value)
    : [1, .5].includes(targetStep) && Number.isFinite(input.value) && input.value >= definition.min
      && input.value <= definition.max && Number.isInteger(input.value / targetStep);
  if (!valid) throw new Error('The Mitsubishi setting is outside its supported values.');
  return { setting: input.setting, value: input.value };
}

/** Missing optional choices preserve the generic contract. Invalid advertised
 * choices cannot widen it or silently recover the generic command set. */
export function garageNativeOptions(advertised) {
  const validObject = advertised === undefined || advertised && typeof advertised === 'object' && !Array.isArray(advertised);
  return Object.fromEntries(Object.entries(GARAGE_NATIVE_SETTINGS).filter(([, definition]) => definition.values).map(([key, definition]) => {
    if (!validObject) return [key, null];
    if (advertised === undefined || !Object.hasOwn(advertised, key)) return [key, [...definition.values]];
    const choices = advertised[key];
    const valid = Array.isArray(choices) && choices.length > 0 && choices.length <= definition.values.length
      && new Set(choices).size === choices.length && choices.every(value => definition.values.includes(value));
    return [key, valid ? definition.values.filter(value => choices.includes(value)) : null];
  }));
}
