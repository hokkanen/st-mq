// Host permission follows the original measurement clock. The driver advertises
// a larger ceiling and enforces the shorter absolute deadline in each request.
export const GARAGE_EXTERNAL_SOURCE_MAX_AGE_MS = 120_000;
export const GARAGE_EXTERNAL_DRIVER_MAX_AGE_MS = 180_000;
