/** These actions inspect history or cancel an inspection; they never edit
 * recorded evidence, controller settings or equipment state. */
export function isRecordedDataAction(path, input) {
  const [pathname, query] = path.split('?');
  if (query !== undefined) {
    const params = new URLSearchParams(query);
    if (pathname !== '/api/energy-audits' || [...params.keys()].length !== 2
      || ['start', 'end'].some(key => params.getAll(key).length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(params.get(key)))) return false;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'action')) return false;
  return pathname === '/api/recording-overview' ? ['measure', 'cancel'].includes(input.action)
    : pathname === '/api/energy-audits' && ['refresh', 'cancel'].includes(input.action);
}
