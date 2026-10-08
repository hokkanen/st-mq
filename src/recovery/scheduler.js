import { parentPort } from 'node:worker_threads';

let sequence = 0;

/** Call only after releasing a write transaction. The controller acknowledges
 * after an event-loop turn and admitting the controller's pending writes, so
 * delayed contention retries cannot lose every free writer slot to this worker.
 * Install the listener lazily: an idle port can stall native SQLite backup. */
export function yieldToController() {
  const id = ++sequence;
  return new Promise(resolve => {
    const receive = message => {
      if (message?.type !== 'continue' || message.id !== id) return;
      parentPort.off('message', receive);
      resolve();
    };
    parentPort.on('message', receive);
    parentPort.postMessage({ type: 'yield', id });
  });
}
