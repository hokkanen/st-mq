// One current transient delivery contract. Clocks describe the same frozen
// source read as target and remain unchanged through retry/acknowledgement.
export const PEER_TRANSFER_VERSION = 2;
export const PEER_TRANSFER_FIELDS = Object.freeze(['version', 'id', 'base', 'target', 'contentHash', 'rows', 'sourceStartedAt', 'sourceAt']);
export const validPeerSourceClocks = value => Boolean(value
  && [value.sourceStartedAt, value.sourceAt].every(at => Number.isSafeInteger(at) && at > 0)
  && value.sourceStartedAt <= value.sourceAt);
