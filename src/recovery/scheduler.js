import { parentPort } from 'node:worker_threads';

let sequence = 0;

/** Call only after releasing a write transaction. The controller acknowledges
 * after servicing its pending progress/storage callbacks and an event-loop turn,
 * so this worker cannot repeatedly reacquire SQLite while control waits to write.
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
