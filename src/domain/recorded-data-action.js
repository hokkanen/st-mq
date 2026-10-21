/** These actions inspect history or cancel an inspection; they never edit
 * recorded evidence, controller settings or equipment state. */
export function isRecordedDataAction(path, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'action')) return false;
  return path === '/api/recording-overview' ? ['measure', 'cancel'].includes(input.action)
    : path === '/api/energy-audits' && ['refresh', 'cancel'].includes(input.action);
}
