import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { serialize, deserialize } from 'node:v8';

export const WRITER_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_SYNC_TIMEOUT_MS = 5000;
const failure = (code, message) => Object.assign(new Error(message), { code });
const lost = () => failure('STORAGE_WRITER_UNAVAILABLE', 'The recording writer is unavailable. Its last save must be reconciled before recording resumes.');

function decodedError(value) {
  const error = value?.name === 'TypeError' ? new TypeError('The recording writer rejected an invalid operation.')
    : value?.name === 'RangeError' ? new RangeError('The recording writer rejected an out-of-range operation.')
      : new Error('The recording writer could not complete the operation.');
  if (typeof value?.code === 'string') error.code = value.code;
  if (Number.isInteger(value?.errcode)) error.errcode = value.errcode;
  if (value?.committed === true) error.committed = true;
  return error;
}

/** Own one worker connection. Synchronous RPC is limited to the already
 * admitted callback; BEGIN admission and journal sealing/COMMIT use request().
 * A timeout never retries SQL or invokes a callback a second time. */
export class WriterClient {
  constructor({ path, workerFactory = options => new Worker(new URL('./writer-worker.js', import.meta.url), options),
    syncTimeoutMs = DEFAULT_SYNC_TIMEOUT_MS } = {}) {
    if (typeof path !== 'string' || !path || path === ':memory:'
      || !Number.isFinite(syncTimeoutMs) || syncTimeoutMs <= 0 || syncTimeoutMs > 60_000)
      throw new TypeError('Invalid recording writer configuration');
    this.sequence = 0; this.failed = null; this.busy = false; this.started = false; this.terminated = false;
    this.pending = new Map(); this.syncTimeoutMs = syncTimeoutMs;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    // The owning Store may reconcile a synchronous timeout before it awaits ready.
    void this.ready.catch(() => {});
    try {
      this.worker = workerFactory({ workerData: { path, syncPort: port2, syncSignal: this.signal.buffer }, transferList: [port2] });
    } catch (error) {
      port1.close(); port2.close(); this.readyReject(error); throw error;
    }
    this.exitPromise = new Promise(resolve => { this.exitResolve = resolve; });
    this.worker.on('message', message => this.receive(message));
    this.worker.on('error', () => this.fail(lost()));
    this.worker.on('exit', code => {
      this.terminated = true; this.port.close();
      if (!this.closing || code !== 0) this.fail(lost());
      else if (this.pending.size) this.fail(lost());
      this.exitResolve(code);
    });
  }
  fail(error) {
    this.failed ??= error;
    this.readyReject(this.failed);
    for (const pending of this.pending.values()) pending.reject(this.failed);
    this.pending.clear();
    return this.failed;
  }
  receive(frame) {
    let message;
    try {
      if (!(frame instanceof Uint8Array) || frame.byteLength > WRITER_FRAME_BYTES) throw lost();
      message = deserialize(frame);
    } catch { this.fail(lost()); void this.terminate(); return; }
    if (message?.type === 'ready') {
      if (message.ok === true) { this.started = true; this.readyResolve(message.result); }
      else this.fail(decodedError(message.error));
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) { this.fail(lost()); void this.terminate(); return; }
    this.pending.delete(message.id);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(decodedError(message.error));
  }
  frame(op, args = {}) {
    if (typeof op !== 'string' || !args || typeof args !== 'object' || Array.isArray(args))
      throw new TypeError('Invalid recording writer request');
    const frame = serialize({ id: ++this.sequence, op, args });
    if (frame.byteLength > WRITER_FRAME_BYTES)
      throw failure('STORAGE_WRITER_FRAME_TOO_LARGE', 'The recording writer request exceeds its bounded message size.');
    return { id: this.sequence, frame };
  }
  call(op, args = {}) {
    if (this.failed || this.terminated) throw this.failed ?? lost();
    if (!this.started || this.busy)
      throw failure('STORAGE_WRITE_PENDING', 'The recording writer is completing an asynchronous boundary.');
    const { id, frame } = this.frame(op, args);
    Atomics.store(this.signal, 0, 0);
    try { this.port.postMessage(frame); }
    catch { throw this.fail(lost()); }
    const result = Atomics.wait(this.signal, 0, 0, this.syncTimeoutMs);
    if (result === 'timed-out') {
      const error = this.fail(failure('STORAGE_WRITER_TIMEOUT', 'The recording writer did not answer its bounded statement request.'));
      void this.terminate();
      throw error;
    }
    let message;
    try {
      const response = receiveMessageOnPort(this.port)?.message;
      if (!(response instanceof Uint8Array) || response.byteLength > WRITER_FRAME_BYTES) throw lost();
      message = deserialize(response);
      if (message?.id !== id) throw lost();
    } catch { const error = this.fail(lost()); void this.terminate(); throw error; }
    if (message.ok !== true) throw decodedError(message.error);
    return message.result;
  }
  async request(op, args = {}) {
    await this.ready;
    if (this.failed || this.terminated) throw this.failed ?? lost();
    if (this.busy) throw failure('STORAGE_WRITE_PENDING', 'The recording writer already owns a pending boundary.');
    const { id, frame } = this.frame(op, args);
    this.busy = true;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try { this.worker.postMessage(frame); }
        catch { this.pending.delete(id); reject(this.fail(lost())); }
      });
    } finally { this.busy = false; }
  }
  async close() {
    if (this.terminated) return this.exitPromise;
    this.closing = true;
    try { await this.request('close'); }
    catch (error) { await this.terminate(); throw error; }
    return this.exitPromise;
  }
  async terminate() {
    if (!this.terminated) {
      this.fail(lost());
      await this.worker.terminate();
    }
    return this.exitPromise;
  }
}
