import { chartGeometryKey, prepareChartGeometry } from './chart-geometry.js';

/** A single lazily-created preparation worker, four cached variants at most.
 * New source/viewport work cancels obsolete preparation by terminating it. */
export function createChartGeometryCache({ maxEntries = 4, maxVertices = 160_000,
  workerFactory = typeof Worker === 'function'
    ? () => new Worker(new URL('./chart-geometry-worker.js', import.meta.url), { type: 'module' }) : null } = {}) {
  const cache = [];
  let worker, active, serial = 0, closed = false;
  function cancel() {
    if (!active) return;
    const previous = active; active = undefined;
    worker?.terminate(); worker = undefined;
    previous.reject(new DOMException('Newer chart preparation requested', 'AbortError'));
  }
  function remember(source, key, datasets) {
    const vertices = datasets.reduce((sum, item) => sum + item.data.length, 0);
    if (vertices > maxVertices) return;
    cache.push({ source, key, datasets, vertices });
    while (cache.length > maxEntries || cache.reduce((sum, item) => sum + item.vertices, 0) > maxVertices) cache.shift();
  }
  function prepare(input) {
    const source = input.series, key = chartGeometryKey(input.descriptor, input.visibility, input.interpolation, input.view);
    const index = cache.findIndex(item => item.source === source && item.key === key);
    if (index >= 0) {
      cancel(); const [hit] = cache.splice(index, 1); cache.push(hit); return Promise.resolve(hit.datasets);
    }
    if (active?.source === source && active.key === key) return active.promise;
    cancel();
    if (closed) return Promise.reject(new DOMException('Chart closed', 'AbortError'));
    if (!workerFactory) {
      const datasets = prepareChartGeometry(input); remember(source, key, datasets); return Promise.resolve(datasets);
    }
    const request = { source, key, id: ++serial };
    request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    active = request;
    try {
      if (!worker) {
        const instance = worker = workerFactory();
        worker.onmessage = ({ data }) => {
          if (worker !== instance || !active || data.id !== active.id) return;
          const completed = active; active = undefined;
          if (data.error) completed.reject(new Error(data.error));
          else { remember(completed.source, completed.key, data.datasets); completed.resolve(data.datasets); }
        };
        worker.onerror = error => {
          if (worker !== instance) return;
          const failed = active; active = undefined; worker?.terminate(); worker = undefined;
          failed?.reject(new Error(error.message || 'Unable to prepare chart'));
        };
      }
      worker.postMessage({ id: request.id, input });
    } catch (error) {
      active = undefined; worker?.terminate(); worker = undefined; request.reject(error);
    }
    return request.promise;
  }
  return { prepare, cancel, clear() { cancel(); cache.length = 0; }, close() { closed = true; cancel(); cache.length = 0; worker?.terminate(); worker = undefined; } };
}
