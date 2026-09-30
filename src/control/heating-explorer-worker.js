import { parentPort } from 'node:worker_threads';
import { exploreHeatingPlan } from './heating-explorer.js';

parentPort.on('message', ({ id, input, overrides, options }) => {
  try { parentPort.postMessage({ id, result: exploreHeatingPlan(input, overrides, options) }); }
  catch (error) { parentPort.postMessage({ id, error: { name: error.name, message: error.message } }); }
});
