function text(parent, tag, content, className) {
  const element = document.createElement(tag); element.textContent = content;
  if (className) element.className = className;
  parent.append(element); return element;
}
const number = (reading, digits = 2) => !reading || reading.stale || !Number.isFinite(reading.value) ? 'Unavailable' : reading.value.toFixed(digits);

export function renderShellyEquipment(root, status) {
  if (!root) return;
  root.replaceChildren(); root.hidden = !status?.configured;
  for (const device of status?.devices ?? []) {
    const section = text(root, 'section', '', 'equipment-group');
    text(section, 'h3', device.label);
    text(section, 'p', device.available ? 'Available · Direct MQTT' : 'Needs attention · Awaiting fresh device readings', 'muted');
    const list = text(section, 'dl', '', 'shelly-equipment-readings');
    const readings = device.readings ?? {};
    const active = readings[device.role === 'caravan' ? 'caravan_active' : device.role === 'garage' ? 'garage_relay_active' : 'heat_savings_active'];
    const row = (label, value) => { text(list, 'dt', label); text(list, 'dd', value); };
    row('Switch', !active || active.stale || ![0, 1].includes(active.value) ? 'Unavailable' : active.value ? 'On' : 'Off');
    if (device.role === 'caravan') {
      row('Power', `${number(readings.caravan_power, 3)}${readings.caravan_power?.stale || readings.caravan_power?.value == null ? '' : ' kW'}`);
      const current = readings.caravan_current;
      row(current?.estimated ? 'Current estimate' : 'Current', `${number(current)}${current?.stale || current?.value == null ? '' : ' A'}`);
      const energy = device.energy;
      row('Energy today', !Number.isFinite(energy?.observedAt) ? 'Awaiting meter readings' : `${energy.dailyKwh.toFixed(3)} kWh${energy.partial ? ' · partial coverage' : ''}`);
      text(section, 'p', 'Daily total uses Europe/Helsinki. Completed hourly meter totals are available in the chart.', 'muted');
    } else if (device.role === 'garage') row('Garage temperature', `${number(readings.garage_temperature, 1)}${readings.garage_temperature?.stale || readings.garage_temperature?.value == null ? '' : ' °C'}`);
    if (device.controlsHeat) text(section, 'p', 'Configured as a heating reduction relay. Commands require fresh switch readback.', 'muted');
  }
}
