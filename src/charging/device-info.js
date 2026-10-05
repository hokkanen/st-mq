// Display-only product fields. Never forward a device-info payload, serial,
// account identifier or credential, and never use this metadata for authority.
const text = value => typeof value === 'string' && value.length <= 128
  && /^[A-Za-z0-9][A-Za-z0-9 ._+()/:-]*$/.test(value) ? value : null;

export function chargingDeviceInfo({ model, firmware, source, receivedAt }) {
  model = text(model);
  firmware = text(firmware);
  if ((!model && !firmware) || !['ocpp-boot', 'shelly-device-info'].includes(source)
    || !Number.isSafeInteger(receivedAt) || receivedAt < 0) return null;
  return { model, firmware, source, receivedAt };
}
