import { parentPort } from 'node:worker_threads';
import { updateLearning } from '../control/learning.js';

parentPort.on('message', ({ checkpoint, sample, now }) => {
  try { parentPort.postMessage({ checkpoint: updateLearning(checkpoint, [sample], { now }) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
