export const REPLICA_CHECKPOINT_MISMATCH = Object.freeze({
  code: 'replica_checkpoint_mismatch',
  error: 'The read-only snapshot no longer matches its database checkpoint. Wait for verified synchronization, then refresh.',
});

/** Only this locally authored refusal identifies a verified read-fence mismatch.
 * Native error codes or messages cannot acquire the same public explanation. */
export class ReplicaCheckpointMismatchError extends Error {
  constructor() {
    super(REPLICA_CHECKPOINT_MISMATCH.error);
    this.statusCode = 503;
    this.code = REPLICA_CHECKPOINT_MISMATCH.code;
  }
}
