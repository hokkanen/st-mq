// The response's decoded byte size is transport bookkeeping, not chart evidence.
// A WeakMap avoids adding it to the semantic payload or retaining discarded data.
const sizes = new WeakMap();
export function rememberChartResponseSize(data, bytes) {
  if (data && typeof data === 'object' && Number.isSafeInteger(bytes) && bytes >= 0) sizes.set(data, bytes);
}
export function chartResponseSize(data) { return sizes.get(data); }
