import { parentPort } from 'node:worker_threads';
import { chooseCycle } from './planner.js';
import { reviseHeatingCycle } from './heating-continuation.js';

parentPort.on('message', ({ id, input }) => {
  try { parentPort.postMessage({ id, result: input.continuation ? { continuation: reviseHeatingCycle(input.continuation) } : chooseCycle(input) }); }
  catch { parentPort.postMessage({ id, error: true }); }
});
