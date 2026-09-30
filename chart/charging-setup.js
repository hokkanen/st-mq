const VEHICLES = ['bmw', 'tesla'];
const numeric = value => Number.isFinite(value) ? Number(value.toFixed(1)) : null;
const labels = { bmw: 'BMW', tesla: 'Tesla' };

export const BMW_SETUP_DESCRIPTORS = Object.freeze([
  ['Battery percentage', 'vehicle.powertrain.electric.battery.stateOfCharge.displayed', 'Automatic starting charge'],
  ['Vehicle charge limit', 'vehicle.powertrain.electric.battery.stateOfCharge.target', 'Automatic target and vehicle ceiling'],
  ['Usable capacity', 'vehicle.drivetrain.batteryManagement.maxEnergy', 'Optional; configured capacity is the fallback'],
  ['Plug state', 'vehicle.body.chargingPort.status', 'Identification context'],
  ['Charging state', 'vehicle.drivetrain.electricEngine.charging.status', 'Live charging start and stop evidence'],
  ['Latitude', 'vehicle.cabin.infotainment.navigation.currentLocation.latitude', 'Timestamped home-location calculation'],
  ['Longitude', 'vehicle.cabin.infotainment.navigation.currentLocation.longitude', 'Timestamped home-location calculation'],
]);

const fieldRows = vehicle => (vehicle === 'bmw'
  ? [['soc', 'Battery percentage'], ['minimumSoc', 'Vehicle charge limit'], ['capacityKwh', 'Usable capacity'], ['atHome', 'Home location'], ['pluggedIn', 'Plug state'], ['charging', 'Charging state']]
  : [['soc', 'Battery percentage'], ['minimumSoc', 'Vehicle charge limit'], ['atHome', 'Home geofence'], ['pluggedIn', 'Plug state'], ['charging', 'Charging state'], ['powerKw', 'Charging power'], ['requestedCurrentA', 'Requested current'], ['maxCurrentA', 'Maximum requested current'], ['vehicleNotBefore', 'Next vehicle start']]);

/** Static trusted content is mounted once, so opening a guide survives polling. */
export function chargingSetupMarkup() {
  const readings = vehicle => `<details class="equipment-fold"><summary>Received vehicle fields</summary><dl class="charging-setup-facts">${fieldRows(vehicle).map(([key, label]) => `<div><dt>${label}</dt><dd id="charging-setup-${vehicle}-${key}">Unavailable</dd></div>`).join('')}</dl></details>`;
  return `<p>Either vehicle can use either charger. Vehicle feeds supply battery and identity evidence; the physical charger supplies electricity measurements and charging control.</p>
    <details class="equipment-fold"><summary>Physical charger setup</summary>
      <dl class="charging-setup-facts"><div><dt>Charger 1 · Easee</dt><dd id="charging-setup-charger1">Waiting for charger status</dd></div><div><dt>Charger 2 · Shelly EVSE</dt><dd id="charging-setup-charger2">Waiting for charger status</dd></div></dl>
      <p>For Easee, configure one control backend: cloud scheduling or local OCPP. Local OCPP also owns charging authorization; configure plug-and-charge or permitted RFID tags. An expiring pause releases its restriction, but cannot restore cloud authorization after an application outage.</p>
      <p>For the Shelly EVSE, enable its MQTT connection and commission the actual model, firmware, work states, phase mapping, current range and write permissions. This is a supported EVSE profile, not a generic relay. Acquisition alone does not authorize control. Its identification pause needs the application and MQTT to resume; an outage can extend the pause.</p>
      <p>Before a guided test, leave the charger unplugged, turn Automatic charging on and Charge now off, and review native charger schedules or manual Stop. Tests keep electrical protection, commissioning and native restrictions in force.</p>
    </details>
    <details class="equipment-fold charging-setup-vehicle" id="charging-setup-bmw-details">
      <summary><span>BMW · CarData</span><small id="charging-setup-bmw-state" class="equipment-device-status">Waiting for feed</small></summary>
      <p id="charging-setup-bmw-health">Waiting for vehicle feed status.</p>
      <p id="charging-setup-bmw-association">No vehicle association confirmed.</p>
      <p>Enable the CarData sensors below in Home Assistant for the same vehicle and map them into the BMW publisher. Battery percentage and target each enable their own automatic input. Plug, charging and timestamped location reports support identification. Missing battery fields can use session settings; receiving a battery value alone does not identify a charger.</p>
      <details class="equipment-fold"><summary>CarData feeds to enable</summary>
        <dl class="charging-setup-descriptors">${BMW_SETUP_DESCRIPTORS.map(([label, descriptor, purpose]) => `<div><dt>${label}</dt><dd><code>${descriptor}</code><small>${purpose}</small></dd></div>`).join('')}</dl>
        <p>Use measured battery percentage, not predicted charge. Enable the separate latitude and longitude sensors: a restored device tracker cannot supply their original BMW timestamps. Their clocks must be within 60 seconds of each other.</p>
        <p>Map the publisher to the actual charging property using the private home reference or Home Assistant’s home zone. Publish the derived home/not-home fact and original field timestamps; keep coordinates and vehicle identifiers private. Repeated MQTT publication must preserve measurement times.</p>
      </details>
      ${readings('bmw')}
      <p class="charging-setup-limit">The BMW bridge does not send vehicle charging windows to the planner. A forecast cannot confirm that a timer in the car will allow charging. Check that timer in the vehicle or its app.</p>
      <button id="charging-setup-bmw-test" class="secondary-button" type="button">Guided BMW test</button>
    </details>
    <details class="equipment-fold charging-setup-vehicle" id="charging-setup-tesla-details">
      <summary><span>Tesla · TeslaMate</span><small id="charging-setup-tesla-state" class="equipment-device-status">Waiting for feed</small></summary>
      <p id="charging-setup-tesla-health">Waiting for vehicle feed status.</p>
      <p id="charging-setup-tesla-association">No vehicle association confirmed.</p>
      <p>Connect TeslaMate to the MQTT broker and match its car ID, optional namespace and home geofence in private configuration. The logger’s live health is separate from the vehicle’s sleep state. A healthy sleeping vehicle need not be woken just to open this guide.</p>
      <details class="equipment-fold"><summary>TeslaMate fields to check</summary>
        <p><code>healthy</code> establishes logger health. <code>battery_level</code> and <code>charge_limit_soc</code> provide battery inputs. Identification uses <code>geofence</code>, <code>plugged_in</code>, <code>charging_state</code> / <code>state</code> and <code>charger_power</code>, together with fresh physical charger evidence.</p>
        <p><code>charge_current_request</code> and <code>charge_current_request_max</code> are distinct limits, not measured current. <code>scheduled_charging_start_time</code> provides a next start. Configured usable battery capacity remains an assumption.</p>
        <p>Field times are MQTT receipt times; unchanged or retained values do not become new identification events. <a href="https://docs.teslamate.org/docs/integrations/mqtt/" target="_blank" rel="noopener noreferrer">TeslaMate MQTT reference ↗</a></p>
      </details>
      ${readings('tesla')}
      <p class="charging-setup-limit">The next-start field does not describe a complete weekly schedule or every end time. A missing start is not proof that all vehicle timers are off. For a delayed-start test, use one clear Start-at schedule at this location and remove overlapping schedules.</p>
      <button id="charging-setup-tesla-test" class="secondary-button" type="button">Guided Tesla test</button>
    </details>
    <p class="charging-setup-footnote">Guided tests use the normal charging plan and follow real charging through completion. Choose immediate charging or a vehicle-timer test, then select the physical charger. The guide checks battery headroom; use a naturally suitable session instead of charging to 100% or discharging solely for a test.</p>`;
}

function time(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(value); }
  catch { return null; }
}

function readingText(field, key) {
  const stamp = time(field?.timeBasis === 'receipt-only' ? field.receivedAt : field?.measuredAt);
  const clock = stamp ? ` · ${field.timeBasis === 'receipt-only' ? 'Received' : 'Measured'} ${stamp}` : '';
  const retained = field?.retained === true ? ' · Retained' : '';
  if (field?.available !== true || field.value == null) return `Unavailable${clock}${retained}`;
  const booleanLabels = { atHome: ['Away', 'At home'], pluggedIn: ['Unplugged', 'Plugged in'], charging: ['Not charging', 'Charging'] };
  const value = booleanLabels[key] && typeof field.value === 'boolean' ? booleanLabels[key][Number(field.value)]
    : key === 'vehicleNotBefore' ? time(field.value)
      : numeric(field.value) !== null ? `${numeric(field.value)}${['soc', 'minimumSoc'].includes(key) ? '%' : key === 'capacityKwh' ? ' kWh' : key === 'powerKw' ? ' kW' : ['requestedCurrentA', 'maxCurrentA'].includes(key) ? ' A' : ''}` : null;
  return `${value ?? 'Unavailable'}${clock}${retained}`;
}

function feedState(feed, vehicle) {
  if (!feed) return { label: 'Not configured', state: 'pending', detail: 'Configure this vehicle feed to receive automatic battery and identification evidence.' };
  const reception = feed.reception ?? {};
  const connected = reception.brokerConnected ?? reception.connected;
  if (connected === false) return { label: 'Disconnected', state: 'attention', detail: 'The MQTT connection is unavailable. Last known readings do not establish current vehicle readiness.' };
  if (['failed', 'denied', 'error', 'rejected'].includes(reception.subscriptionStatus))
    return { label: 'Subscription issue', state: 'attention', detail: 'The vehicle subscription is unavailable. Check the broker connection and topic access under MQTT.' };
  if (reception.invalidReason) return { label: 'Invalid report', state: 'attention', detail: 'The latest vehicle report could not be used. Check publisher fields and original timestamps.' };
  if ((vehicle === 'tesla' || reception.available === true) && feed.setup?.available === true) {
    const sleeping = vehicle === 'tesla' && feed.setup.state === 'asleep';
    return { label: sleeping ? 'Healthy · Sleeping' : 'Feed available', state: 'available',
      detail: sleeping ? 'TeslaMate reports healthy. Sleeping is a vehicle state, not a logger failure. Identification still needs live matching charging evidence.'
        : 'The vehicle publisher is reporting. Check the individual fields below; feed health alone does not confirm identification readiness.' };
  }
  if (vehicle === 'tesla' && (feed.setup?.healthy === false || reception.reason === 'vehicle-logger-unhealthy'))
    return { label: 'Logger health unconfirmed', state: 'attention', detail: 'A live healthy TeslaMate logger report is required. A connected broker or saved healthy value is insufficient.' };
  if (reception.reason === 'vehicle-feed-stale') return { label: 'Feed stale', state: 'attention', detail: 'The MQTT broker may be connected, but the BMW publisher has stopped providing valid live reports.' };
  return { label: 'Waiting for live feed', state: 'pending', detail: 'Waiting for usable live vehicle reports. Retained readings keep their original timestamps.' };
}

function chargerText(charger) {
  if (!charger) return 'Status unavailable';
  const snapshot = charger.control?.snapshot;
  if (charger.provider === 'shelly-evse' && snapshot?.commissioning?.verified === false) return 'Commissioning required';
  if (charger.control?.phase === 'unavailable' || snapshot?.controlReady === false) return 'Control unavailable · Review the charger card';
  if (charger.values?.connected?.available !== true) return 'Physical connection state unavailable';
  const connection = charger.values.connected.value === true ? 'Vehicle connected' : 'Unplugged';
  return `${connection} · Automatic charging ${charger.settings?.enabled === true ? 'on' : 'off'}`;
}

export function chargingSetupView(status = {}) {
  const chargers = status.charging?.chargers ?? [];
  return { chargers: Object.fromEntries(['charger1', 'charger2'].map(id => [id, chargerText(chargers.find(charger => charger.id === id))])),
    vehicles: Object.fromEntries(VEHICLES.map(vehicle => {
      const feed = status.charging?.vehicleFeeds?.find(item => item.id === vehicle);
      const association = chargers.find(charger => charger.id === feed?.usedByChargerId
        && charger.vehicle?.state === 'identified' && charger.vehicle.id === vehicle && charger.values?.connected?.value === true);
      const lastHome = feed?.setup?.homeContext;
      const homeNote = lastHome?.source === 'last-known' && time(lastHome.measuredAt)
        ? ` Current location is unknown. Last confirmed home context (${time(lastHome.measuredAt)}) is usable for at most two hours from that observation; fresh charging evidence is still required.` : '';
      return [vehicle, { ...feedState(feed, vehicle),
        association: association ? `${labels[vehicle]} is identified at ${association.id === 'charger1' ? 'Charger 1' : 'Charger 2'} for this connection.${homeNote}`
          : `No current physical charger association is confirmed.${homeNote}`,
        fields: Object.fromEntries(fieldRows(vehicle).map(([key]) => [key, readingText(feed?.setup?.fields?.[key], key)])) }];
    })) };
}

export function initializeChargingSetup(document, { onStartTest } = {}) {
  const container = document.getElementById('charging-setup-content');
  if (container) container.innerHTML = chargingSetupMarkup();
  for (const vehicle of VEHICLES) {
    const button = document.getElementById(`charging-setup-${vehicle}-test`);
    if (button) {
      button.disabled = typeof onStartTest !== 'function';
      button.addEventListener('click', () => onStartTest?.(vehicle));
    }
  }
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  return { render(status) {
    const view = chargingSetupView(status);
    for (const [id, value] of Object.entries(view.chargers)) set(`charging-setup-${id}`, value);
    for (const [vehicle, value] of Object.entries(view.vehicles)) {
      const state = document.getElementById(`charging-setup-${vehicle}-state`);
      if (state) { state.textContent = value.label; state.dataset.state = value.state; }
      set(`charging-setup-${vehicle}-health`, value.detail);
      set(`charging-setup-${vehicle}-association`, value.association);
      for (const [key, reading] of Object.entries(value.fields)) set(`charging-setup-${vehicle}-${key}`, reading);
    }
    return view;
  } };
}
