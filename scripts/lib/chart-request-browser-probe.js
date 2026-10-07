/** Test-only interception for browser fixtures that deliberately hold or alter
 * a chart response. Production request workers do not use window.fetch, so a
 * window fetch stub alone cannot observe them. Real request-worker streaming,
 * cancellation and prefetch are exercised by chart-performance-smoke.js.
 * Geometry workers remain real and are tracked so assertions await preparation.
 */
export async function installChartRequestProbe({ command, context }) {
  await command('script.addPreloadScript', { contexts: [context], functionDeclaration: `() => {
    const NativeWorker = window.Worker;
    const probe = window.chartRequestProbe = { active: false, geometryJobs: 0 };
    probe.settled = async () => {
      const deadline = performance.now() + 15000;
      while (true) {
        if (performance.now() > deadline) throw new Error('Chart preparation did not settle');
        while (probe.geometryJobs) {
          if (performance.now() > deadline) throw new Error('Chart preparation worker did not settle');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (!probe.geometryJobs) return true;
      }
    };
    window.Worker = class FixtureAwareWorker {
      constructor(url, options) {
        const path = new URL(url, location.href).pathname;
        if (!probe.active || !path.includes('/chart-request-worker-')) {
          const worker = new NativeWorker(url, options);
          if (path.includes('/chart-geometry-worker-')) {
            const requests = new Set(), post = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
            worker.postMessage = (message, ...rest) => {
              if (!requests.has(message.id)) { requests.add(message.id); probe.geometryJobs++; }
              return post(message, ...rest);
            };
            const finish = id => { if (requests.delete(id)) probe.geometryJobs--; };
            worker.addEventListener('message', event => finish(event.data.id));
            worker.addEventListener('error', () => { for (const id of requests) finish(id); });
            worker.terminate = () => { for (const id of requests) finish(id); terminate(); };
          }
          return worker;
        }
        this.controller = new AbortController(); this.closed = false;
      }
      postMessage(message) {
        if (message.type === 'cancel') { this.controller.abort(); return; }
        if (message.type !== 'load') throw new Error('Unexpected chart fixture worker request');
        // The current JSON representation lets existing response-transforming
        // fixtures inspect source data. This applies only inside this probe.
        const options = { ...message.options, signal: this.controller.signal,
          headers: { ...message.options.headers, Accept: 'application/json' } };
        Promise.resolve().then(() => window.fetch(message.url, options)).then(async response => {
          const result = response.status === 401 ? {} : await response.json();
          if (!this.closed) this.onmessage?.({ data: { type: 'result', response: { status: response.status, ok: response.ok }, result } });
        }).catch(error => {
          if (!this.closed) this.onmessage?.({ data: { type: 'error', message: error.message, name: error.name } });
        });
      }
      terminate() { this.closed = true; this.controller.abort(); }
    };
  }` });
}
