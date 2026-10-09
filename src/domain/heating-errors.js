/** Public heating causes shared by command responses and status presentation. */
const MESSAGES = {
  SHELLY_IDENTITY_UNAVAILABLE: 'The relay identity has not been confirmed. Wait for a fresh device report.',
  SHELLY_READBACK_UNAVAILABLE: 'Relay feedback became unavailable. The command may have reached the relay; check its reported state.',
  SHELLY_READBACK_TIMEOUT: 'The relay did not confirm this command before the timeout. It may already have changed; check its reported state.',
  SHELLY_COMMAND_UNCONFIRMED: 'The relay command could not be confirmed. It may have reached the device; check its reported state.',
  SHELLY_CONTROL_FAILED: 'The relay request failed. Check its current availability and reported state.',
  FLOOR_PENDING: 'Waiting for the previous floor-heating override to be restored.',
  EXECUTOR_BUSY: 'A heating request is already in progress. Wait for its result.',
  EXECUTOR_UNCONFIRMED: 'The heating request could not be confirmed. Check the reported equipment state.',

  MQTT_COMMAND_INVALID: 'Choose normal heating, reduced heating, or circulation.',
  MQTT_RELAY_UNAVAILABLE: 'Configure a direct tariff relay with live device readback before requesting heating.',
  MQTT_UNAVAILABLE: 'MQTT acknowledgement was not received. The command may have reached the device; check its state before retrying.',
  MQTT_STORAGE_PENDING: 'The device command was not sent because received readings are still waiting to be saved.',
  MQTT_STORAGE_FAILED: 'The device command was not sent because an incoming observation could not be saved. Waiting for fresh recorded evidence.',
  MQTT_CLOSED: 'MQTT command transport is closed. Check device state if a test was in progress.',
  MQTT_BUSY: 'An MQTT test is already in progress. Wait for its result before trying again.',
  MQTT_AUTHORITY_LOST: 'This instance no longer owns device control.',
  MQTT_DHWR_UNAVAILABLE: 'Configure a direct circulation relay with live device readback before starting circulation.',
  EXECUTOR_TARGET_CHANGED: 'The original heating target is unavailable or changed. Its restoration remains pending until the original target is available.',
  EXECUTOR_EXPIRED: 'The heating action expired before dispatch. Its temporary settings are being restored.',
  EXECUTOR_RESTORATION_PENDING: 'Wait for the previous heating settings to be restored.',
};
export function heatingErrorMessage(code) {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code]
    : 'The heating request could not be confirmed. Check the reported equipment state.';
}
export const heatingErrorCode = code => typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : null;
