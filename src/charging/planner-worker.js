import { parentPort } from 'node:worker_threads';
import { planChargers } from './planner.js';
import { compareChargingFlexibility } from './flexibility-comparison.js';

parentPort.on('message', ({ id, options, comparison }) => {
  try { parentPort.postMessage({ id, result: comparison ? compareChargingFlexibility(options, comparison) : planChargers(options) }); }
  catch { parentPort.postMessage({ id, error: true }); }
});
