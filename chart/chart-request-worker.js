import { readChartResponse } from './chart-stream.js';

let controller;
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { controller?.abort(); return; }
  if (data.type !== 'load') return;
  controller = new AbortController();
  try {
    const response = await fetch(data.url, { ...data.options, signal: controller.signal });
    const result = await readChartResponse(response, progress => self.postMessage({ type: 'progress', progress }));
    self.postMessage({ type: 'result', ...result });
  } catch (error) {
    self.postMessage({ type: 'error', name: error.name, message: error.message });
  }
};
