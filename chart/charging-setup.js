import { isReadOnlyReplica } from './replica-status.js';
import { vehicleObservationAdmissionStatus } from './vehicle-feed-status.js';

const VEHICLES = ['bmw', 'tesla'];
const numeric = value => Number.isFinite(value) ? Number(value.toFixed(1)) : null;
const labels = { bmw: 'BMW', tesla: 'Tesla' };

export const BMW_SETUP_DESCRIPTORS = Object.freeze([
  ['Battery percentage', 'vehicle.powertrain.electric.battery.stateOfCharge.displayed', 'Automatic current charge'],
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

const DOCS = 'https://github.com/hokkanen/st-mq/blob/main/docs/';
const docLink = (path, label) => `<a href="${DOCS}${path}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;

/** Static trusted content is mounted once, so opening a guide survives polling. */
export function chargingSetupMarkup() {
  const readings = vehicle => `<details class="equipment-fold"><summary>Received vehicle fields</summary><dl class="charging-setup-facts">${fieldRows(vehicle).map(([key, label]) => `<div><dt>${label}</dt><dd id="charging-setup-${vehicle}-${key}">Unavailable</dd></div>`).join('')}</dl></details>`;
  const hardware = (id, model, connection, extra = '') => `<div><dt>${id === 'charger1' ? 'Charger 1' : 'Charger 2'}</dt><dd><strong>${model}</strong><span id="charging-setup-${id}-connection">${connection}</span><small id="charging-setup-${id}-firmware">Reported firmware unavailable</small><small id="charging-setup-${id}-firmware-source" hidden></small>${extra}<a href="#charging-setup-${id}-details" data-charging-setup-link="charging-setup-${id}-details">Setup &amp; capabilities →</a></dd></div>`;
  const facts = (id, rows) => `<dl class="charging-setup-facts">${rows.map(([key, label]) => `<div><dt>${label}</dt><dd id="charging-setup-${id}-${key}">Unavailable</dd></div>`).join('')}</dl>`;
  return `<p class="muted">Set up charger connections, check device capabilities and connect vehicle feeds here. Use the charger cards in Garage for schedules, readings and session controls.</p>
    <nav class="charging-setup-links" aria-label="Charging documentation">${docLink('charging.md', 'Charging guide')}${docLink('charging/user-guide.md', 'Controls &amp; everyday use')}</nav>
    <dl class="equipment-setup-hardware charging-setup-hardware">
      ${hardware('charger1', 'Easee', 'Cloud scheduling or local OCPP', '<small>Local OCPP requires firmware 344 or later</small>')}
      ${hardware('charger2', 'Top AC Portable EV Charger', 'Shelly XT1 · MQTT RPC', `<small>${docLink('charging/integrations/shelly.md#hardware-verification-still-required', 'Limited checks on firmware 1.7.1')}</small>`)}
    </dl>
    <p class="charging-setup-firmware-note muted">Reported firmware describes the device connection. The hardware-check guide records the tested version and scope; installation checks remain separate.</p>
    <details class="equipment-fold charging-setup-device" id="charging-setup-charger1-details">
      <summary><span>Charger 1 · Connection &amp; capabilities</span><small id="charging-setup-charger1" class="equipment-device-status">Waiting for charger status</small></summary>
      <p>Choose one control backend in configuration: Easee cloud scheduling or local OCPP. Equalizer keeps control of charging current and native electrical limits.</p>
      ${facts('charger1', [['model', 'Reported model'], ['readiness', 'Scheduling control'], ['current', 'Current control']])}
      <p>Local OCPP also owns charging authorization. Configure plug-and-charge or permitted RFID tags. Stopping this application keeps OCPP enabled; new charging can wait for authorization while the controller is offline. An installed pause can expire without restoring cloud authorization.</p>
      <div id="charging-setup-ocpp"></div>
      <p>${docLink('charging/integrations/easee.md', 'Easee setup &amp; connection guide')}</p>
    </details>
    <details class="equipment-fold charging-setup-device" id="charging-setup-charger2-details">
      <summary><span>Charger 2 · Connection &amp; capabilities</span><small id="charging-setup-charger2" class="equipment-device-status">Waiting for charger status</small></summary>
      <p>Configure the Shelly MQTT device identity and topic. The supported EVSE profile is checked from the device’s advertised components; a generic Shelly relay does not provide these capabilities.</p>
      ${facts('charger2', [['model', 'Reported model'], ['readiness', 'Start/stop control'], ['current', 'Household current control'], ['identification', 'Identification current'], ['fallback', 'Controller loss']])}
      <p>Household current control needs configured supply and hardware limits, usable load measurements and a fallback. Verify the installation’s phase mapping separately for recorded phase energy. It operates independently of Automatic charging and Charge now. Configuration and command confirmation do not prove physical load sharing.</p>
      <p>Application pauses have no charger-side expiry. After a controller or MQTT outage, charging can remain paused until control returns or you resume it in Shelly. Running charging can continue past a planned pause. Native restrictions and protection remain in force.</p>
      <p>${docLink('charging/integrations/shelly.md', 'Shelly setup &amp; electrical requirements')}</p>
    </details>
    <section class="charging-setup-group" aria-labelledby="charging-setup-vehicles-title">
      <h4 id="charging-setup-vehicles-title">Vehicle feeds</h4>
      <p class="muted">Either vehicle can use either charger. Vehicle feeds supply battery and identification evidence; the charger supplies electricity measurements and charging control.</p>
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
        <p>${docLink('charging/integrations/bmw.md', 'BMW feed setup &amp; evidence')}</p>
      </details>
      <details class="equipment-fold charging-setup-vehicle" id="charging-setup-tesla-details">
        <summary><span>Tesla · TeslaMate</span><small id="charging-setup-tesla-state" class="equipment-device-status">Waiting for feed</small></summary>
        <p id="charging-setup-tesla-health">Waiting for vehicle feed status.</p>
        <p id="charging-setup-tesla-association">No vehicle association confirmed.</p>
        <p id="charging-setup-tesla-connection-context" hidden></p>
        <p>Connect TeslaMate to the MQTT broker and match its car ID, optional namespace and home geofence in private configuration. The logger’s live health is separate from the vehicle’s sleep state. A healthy sleeping vehicle need not be woken just to open this guide.</p>
        <details class="equipment-fold"><summary>TeslaMate fields to check</summary>
          <p><code>healthy</code> establishes logger health. <code>battery_level</code> and <code>charge_limit_soc</code> provide battery inputs. Identification uses <code>geofence</code>, <code>plugged_in</code>, <code>charging_state</code> / <code>state</code> and <code>charger_power</code>, together with fresh physical charger evidence.</p>
          <p><code>charger_actual_current</code> and <code>charger_power</code> can corroborate a live charging connection when the plug field has not updated. The original plug reading remains visible. <code>charge_current_request</code> and <code>charge_current_request_max</code> are limits, not measured current. <code>scheduled_charging_start_time</code> provides a next start. Configured usable battery capacity remains an assumption.</p>
          <p>Field times are MQTT receipt times; unchanged or retained values do not become new identification events.</p>
        </details>
        ${readings('tesla')}
        <p class="charging-setup-limit">The next-start field does not describe a complete weekly schedule or every end time. A missing start is not proof that all vehicle timers are off.</p>
        <p>${docLink('charging/integrations/teslamate.md', 'TeslaMate setup &amp; evidence')}</p>
      </details>
    </section>
    <details class="equipment-fold" id="charging-setup-assessment-details">
      <summary>Guided assessments &amp; installation checks</summary>
      <p>Guided assessments observe normal charging from connection through completion. Select a vehicle and physical charger, then choose immediate charging or a vehicle-timer assessment. Assessment inputs do not change charging settings or operate the vehicle.</p>
      <p>Start with the charger unplugged, Automatic charging on and Charge now off. Review native charger instructions and vehicle timers. The guide checks battery headroom; use a naturally suitable session instead of charging to 100% or discharging solely for a test.</p>
      <div class="charging-setup-actions"><button id="charging-setup-bmw-test" class="secondary-button" type="button">Guided BMW test</button><button id="charging-setup-tesla-test" class="secondary-button" type="button">Guided Tesla test</button></div>
      <p>${docLink('charging/guided-assessments.md', 'Guided assessment instructions')}</p>
      <p class="muted">The development runbook also provides command-line tools for bounded observation and offline assessment of physical tests. Hardware operations are performed separately; a software test or device acknowledgement alone does not establish charging or electrical protection.</p>
      <p>${docLink('charging/testing.md', 'Physical testing &amp; evidence tools')}</p>
    </details>`;
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
  const storage = vehicleObservationAdmissionStatus(reception.reason);
  if (storage) return storage;
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

function chargerSetup(charger, status, id) {
  const shelly = charger?.provider === 'shelly-evse' || !charger && id === 'charger2', snapshot = charger?.control?.snapshot;
  const commissioning = charger?.telemetry?.commissioning ?? snapshot?.commissioning;
  const local = charger?.telemetry?.transport === 'ocpp' || snapshot?.transport === 'ocpp' || charger?.control?.kind === 'ocpp-tx-pause';
  const readOnly = status.readOnly === true || charger?.recorded === true || isReadOnlyReplica(status);
  const unavailable = !charger || readOnly || commissioning?.profileSupported === false || charger.control?.phase === 'unavailable'
    || charger.telemetry?.providerConnected === false || snapshot?.controlReady === false;
  const readiness = !charger ? 'Status unavailable' : commissioning?.profileSupported === false ? 'Charger profile unsupported'
    : readOnly ? 'Recorded status · current readiness unknown'
      : unavailable || commissioning?.controlReady === false ? 'Control unavailable'
        : shelly ? commissioning?.controlReady === true ? 'Start/stop available' : 'Readiness unavailable'
          : charger.capabilities?.scheduling === true ? 'Scheduling supported' : 'Monitoring only';
  const current = !charger ? 'Unavailable' : !shelly ? 'Native Equalizer'
    : charger.configuration?.limiterEnabled === false ? 'Disabled in configuration'
      : unavailable ? 'Readiness unavailable'
        : commissioning?.currentControlReady === true && charger.capabilities?.currentControl === true ? 'Available'
          : 'Unavailable · check capability and electrical configuration';
  const identity = charger?.device;
  const reported = typeof identity?.firmware === 'string' && identity.firmware.length > 0;
  const source = ({ 'shelly-device-info': 'Shelly device discovery', 'ocpp-boot': 'OCPP boot report' })[identity?.source];
  const received = time(identity?.receivedAt);
  const available = identity?.available === true && !readOnly;
  return { state: readiness,
    connection: shelly ? 'Shelly XT1 · MQTT RPC' : !charger ? 'Cloud scheduling or local OCPP'
      : local ? 'Local OCPP · native Equalizer' : 'Easee cloud · native Equalizer',
    firmware: reported ? `${available ? 'Reported' : 'Last reported'} firmware ${identity.firmware}` : 'Reported firmware unavailable',
    firmwareSource: reported ? [source, received ? `Received ${received}` : 'Receipt time unavailable',
      !available ? 'Current device report unavailable' : null].filter(Boolean).join(' · ') : '',
    model: identity?.model || 'Not reported', readiness, current,
    identification: unavailable ? 'Readiness unavailable'
      : charger?.telemetry?.identificationCurrentReady === true ? 'Temporary minimum available'
        : charger?.telemetry?.identificationCurrentReady === false ? 'Temporary minimum unavailable' : 'Readiness unavailable',
    fallback: 'Autonomous fallback unverified' };
}

/** Open the exact setup disclosure without replacing mounted controls or drafts. */
export function openChargingSetup(document, id = 'charging-setup-details', { navigate = true } = {}) {
  if (!/^charging-setup-(?:details|charger[12]-details|bmw-details|tesla-details|assessment-details)$/.test(id)) return false;
  const target = document.getElementById(id);
  if (!target) return false;
  for (let fold = target; fold; fold = fold.parentElement?.closest('details')) fold.open = true;
  if (navigate && document.defaultView?.location?.hash !== `#${id}`)
    document.defaultView?.history?.pushState(null, '', `#${id}`);
  target.querySelector('summary')?.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start' });
  return true;
}

export function chargingSetupView(status = {}) {
  const chargers = status.charging?.chargers ?? [];
  return { chargers: Object.fromEntries(['charger1', 'charger2'].map(id => [id, chargerSetup(chargers.find(charger => charger.id === id), status, id)])),
    vehicles: Object.fromEntries(VEHICLES.map(vehicle => {
      const feed = status.charging?.vehicleFeeds?.find(item => item.id === vehicle);
      const association = chargers.find(charger => charger.id === feed?.usedByChargerId
        && charger.vehicle?.state === 'identified' && charger.vehicle.id === vehicle && charger.values?.connected?.value === true);
      const lastHome = feed?.setup?.homeContext;
      const homeNote = lastHome?.source === 'last-known' && time(lastHome.measuredAt)
        ? ` Current location is unknown. Last confirmed home context (${time(lastHome.measuredAt)}) remains usable without a time limit, including across reconnects, until a valid away report replaces it. Matching charging evidence is still required for each connection.` : '';
      return [vehicle, { ...feedState(feed, vehicle),
        connectionContext: vehicle === 'tesla' && feed?.setup?.connectionContext?.source === 'live-charging'
          ? 'Connection inferred from live vehicle charging, measured current and power. The reported plug field below has not confirmed it; identification still requires matching physical charger evidence.' : '',
        association: association ? `${labels[vehicle]} is identified at ${association.id === 'charger1' ? 'Charger 1' : 'Charger 2'} for this connection.${homeNote}`
          : `No current physical charger association is confirmed.${homeNote}`,
        fields: Object.fromEntries(fieldRows(vehicle).map(([key]) => [key, readingText(feed?.setup?.fields?.[key], key)])) }];
    })) };
}

export function initializeChargingSetup(document, { onStartTest } = {}) {
  const container = document.getElementById('charging-setup-content');
  if (container) container.innerHTML = chargingSetupMarkup();
  for (const link of container?.querySelectorAll?.('[data-charging-setup-link]') ?? []) link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); openChargingSetup(document, link.dataset.chargingSetupLink);
  });
  const openHash = () => openChargingSetup(document, document.defaultView?.location?.hash?.slice(1) ?? '', { navigate: false });
  document.defaultView?.addEventListener('hashchange', openHash);
  openHash();
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
    for (const [id, value] of Object.entries(view.chargers)) {
      set(`charging-setup-${id}`, value.state);
      for (const key of ['connection', 'firmware', 'model', 'readiness', 'current', 'identification', 'fallback']) set(`charging-setup-${id}-${key}`, value[key]);
      const source = document.getElementById(`charging-setup-${id}-firmware-source`);
      if (source) { source.textContent = value.firmwareSource; source.hidden = !value.firmwareSource; }
    }
    for (const [vehicle, value] of Object.entries(view.vehicles)) {
      const state = document.getElementById(`charging-setup-${vehicle}-state`);
      if (state) { state.textContent = value.label; state.dataset.state = value.state; }
      set(`charging-setup-${vehicle}-health`, value.detail);
      set(`charging-setup-${vehicle}-association`, value.association);
      const context = document.getElementById(`charging-setup-${vehicle}-connection-context`);
      if (context) { context.textContent = value.connectionContext; context.hidden = !value.connectionContext; }
      for (const [key, reading] of Object.entries(value.fields)) set(`charging-setup-${vehicle}-${key}`, reading);
    }
    return view;
  } };
}
