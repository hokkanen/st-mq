import { withReadDeadline } from './network.js';
import { readChartResponse } from './chart-stream.js';
import { rememberChartResponseSize } from './chart-response-size.js';

export const CHART_READ_TIMEOUT_MS = 15 * 60_000;

/** Fetch and parse the large result away from the UI thread. The monitor still
 * owns authentication and cancellation; credentials never enter a URL or cache. */
export function fetchChartResponse(url, options = {}, { onProgress, prefetch = false,
  timeoutMs = CHART_READ_TIMEOUT_MS, workerFactory = typeof Worker === 'function'
    ? () => new Worker(new URL('./chart-request-worker.js', import.meta.url), { type: 'module' }) : null,
  fetchImpl = fetch } = {}) {
  return withReadDeadline(signal => {
    const headers = { ...options.headers, Accept: 'application/x-ndjson', ...(prefetch ? { 'X-Chart-Prefetch': '1' } : {}) };
    if (!workerFactory) return fetchImpl(url, { ...options, headers, signal }).then(response => readChartResponse(response, onProgress));
    return new Promise((resolve, reject) => {
      const worker = workerFactory();
      let settled = false;
      const finish = (callback, result) => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', cancel); worker.terminate(); callback(result);
      };
      const cancel = () => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', cancel);
        // Let the worker abort fetch before terminating it. This closes the
        // HTTP request so the server immediately cancels its computation too.
        worker.postMessage({ type: 'cancel' });
        setTimeout(() => worker.terminate(), 50);
        reject(signal.reason ?? new DOMException('Chart cancelled', 'AbortError'));
      };
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if (data.type === 'progress') onProgress?.(data.progress);
        else if (data.type === 'result') finish(resolve, { response: data.response, result: data.result, decodedBytes: data.decodedBytes });
        else finish(reject, Object.assign(new Error(data.message || 'Unable to load chart'), { name: data.name || 'Error' }));
      };
      worker.onerror = error => finish(reject, new Error(error.message || 'Unable to start chart worker'));
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      const { signal: ignored, ...request } = options;
      worker.postMessage({ type: 'load', url, options: { ...request, headers } });
    });
  }, { signal: options.signal, timeoutMs }).then(result => {
    rememberChartResponseSize(result.result, result.decodedBytes); return result;
  });
}
