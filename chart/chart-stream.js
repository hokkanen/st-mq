/** Both representations describe the current chart contract. Streaming adds
 * progress envelopes; it never fabricates intermediate chart observations. */
export async function readChartResponse(response, onProgress = () => {}) {
  if (response.status === 401) {
    void response.body?.cancel().catch(() => {});
    return { response: { status: 401, ok: false }, result: {} };
  }
  const status = { status: response.status, ok: response.ok };
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    let result;
    try { result = await response.json(); }
    catch (error) { if (response.ok) throw error; result = {}; }
    return { response: status, result };
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let fragments = [], result, finished = false, decodedBytes = 0;
  const line = text => {
    if (!text.trim()) return;
    const message = JSON.parse(text);
    if (message.type === 'progress') onProgress(message);
    else if (message.type === 'result' && !finished) { result = message.data; finished = true; }
    else if (message.type === 'error') throw Object.assign(new Error(message.message || 'Unable to load chart'), { status: message.status });
    else throw new Error('Invalid chart stream message');
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      decodedBytes += value?.byteLength ?? 0;
      if (decodedBytes > 64 * 1024 * 1024) throw new Error('Chart response is too large. Choose a shorter date range.');
      const buffer = decoder.decode(value, { stream: !done });
      let start = 0, end;
      // Scan each incoming chunk once. Joining or rescanning the growing final
      // multi-megabyte result on every packet would become quadratic work.
      while ((end = buffer.indexOf('\n', start)) >= 0) {
        fragments.push(buffer.slice(start, end)); line(fragments.join('')); fragments = []; start = end + 1;
      }
      if (start < buffer.length) fragments.push(buffer.slice(start));
      if (done) break;
    }
    if (fragments.length) line(fragments.join(''));
    if (!finished) throw new Error('Chart loading ended before the result arrived');
    return { response: status, result, decodedBytes };
  } catch (error) {
    if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599)
      return { response: { status: error.status, ok: false }, result: { error: error.message } };
    throw error;
  } finally {
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

const stages = {
  queued: 'Waiting for chart worker', 'reading-history': 'Reading history', 'reading-energy': 'Reading energy',
  'preparing-chart': 'Preparing chart', 'preparing-summary': 'Preparing summary', 'preparing-response': 'Preparing download',
  downloading: 'Receiving chart', drawing: 'Drawing chart',
};
/** The percentage describes only the named measurable stage, never a guessed
 * fraction of elapsed time or of the complete download/render operation. */
export function chartLoadingLabel(progress = {}) {
  const label = stages[progress.stage] ?? 'Loading chart';
  const measured = Number.isFinite(progress.completed) && Number.isFinite(progress.total)
    && progress.total > 0 && progress.completed >= 0 && progress.completed <= progress.total;
  return `Loading · ${label}${measured ? ` ${Math.floor(progress.completed / progress.total * 100)}%` : '…'}`;
}
