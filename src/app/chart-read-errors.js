/** A queued replica read must acquire a new verified lease before retrying. */
export const REPLICA_CHECKPOINT_ADVANCED = 'replica_checkpoint_advanced';

export class ReplicaCheckpointAdvancedError extends Error {
  constructor() {
    super('The replica checkpoint advanced. Retry the request.');
    this.code = REPLICA_CHECKPOINT_ADVANCED;
  }
}
