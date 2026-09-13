// Source validity and operational attention are different policies. These
// defaults are shared by acquisition, recording, learning and presentation;
// changing learning validity still requires a new algorithm version.
export const H66_MAX_AGE_MS = 5 * 60_000;
export const OUTDOOR_MAX_AGE_MS = 30 * 60_000;
export const PROVIDER_CURRENT_ATTENTION_MS = 30 * 60_000;
export const PROVIDER_TEMPERATURE_ATTENTION_MS = 2 * 60 * 60_000;

export const outdoorMaxAgeMs = source => source === 'husdata-h66' ? H66_MAX_AGE_MS : OUTDOOR_MAX_AGE_MS;
