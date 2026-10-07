import { prepareChartGeometry } from './chart-geometry.js';

self.onmessage = ({ data }) => {
  try { self.postMessage({ id: data.id, datasets: prepareChartGeometry(data.input) }); }
  catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
