import { parentPort } from 'node:worker_threads';
import { planChargers } from './planner.js';

parentPort.on('message', ({ id, options }) => {
  try { parentPort.postMessage({ id, result: planChargers(options) }); }
  catch { parentPort.postMessage({ id, error: true }); }
});
