/** Authored public outcomes. Native payloads and lease capabilities stay private. */
export const FLOOR_COMMAND_ERRORS = Object.freeze({
  FLOOR_COMMAND: 'Choose a valid circuit and a timed override of one to fifteen minutes.',
  FLOOR_PENDING: 'A previous floor override still needs fresh OFF feedback. Wait for release confirmation.',
  FLOOR_UNAVAILABLE: 'Floor control needs commissioned equipment, fresh GPIO feedback and the active master.',
  FLOOR_CLOSED: 'The floor connection is closed. Check its current status.',
  FLOOR_AUTHORITY: 'Floor control authority changed. Refresh the current device status.',
  FLOOR_STATE: 'Saved floor restoration state could not be verified. A replacement override is blocked.',
  FLOOR_BUSY: 'Another floor treatment owns these outputs. End it before starting a different treatment.',
  FLOOR_STALE: 'The floor device, connection or control request changed. Refresh before trying again.',
  FLOOR_EXPIRED: 'The floor request or its original deadline has expired. Check the current outputs.',
  FLOOR_UNCONFIRMED: 'The request has no confirming GPIO report. Check the outputs; release may remain pending.',
});
