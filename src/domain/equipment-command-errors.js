/** Only these authored, known-unsent outcomes cross the equipment API/UI boundary. */
export const EQUIPMENT_COMMAND_ERRORS = Object.freeze({
  EQUIPMENT_COMMAND_WAIT_EXPIRED: 'The request was not sent because recording did not catch up in time. Try again shortly.',
  EQUIPMENT_COMMAND_RECORDING_FAILED: 'The request was not sent because an observation could not be saved. Check recording status.',
  EQUIPMENT_COMMAND_CANCELLED: 'The request was not sent because the device state, connection or control request changed. Check its current state before trying again.',
});

export function unsentEquipmentCommand(cause, expired = false) {
  const code = cause?.code === 'MQTT_STORAGE_FAILED' ? 'EQUIPMENT_COMMAND_RECORDING_FAILED'
    : expired || cause?.code === 'MQTT_STORAGE_PENDING' ? 'EQUIPMENT_COMMAND_WAIT_EXPIRED' : 'EQUIPMENT_COMMAND_CANCELLED';
  return Object.assign(new Error(EQUIPMENT_COMMAND_ERRORS[code]), { code, statusCode: 409, sent: false });
}
