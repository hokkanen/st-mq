import { parentPort } from 'node:worker_threads';
import { chooseCycle } from './planner.js';

parentPort.on('message', ({ id, input }) => {
  try { parentPort.postMessage({ id, result: chooseCycle(input) }); }
  catch { parentPort.postMessage({ id, error: true }); }
});
