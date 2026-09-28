# Caravan dehumidifier

The **electriQ DESD8LW** appears below air and energy readings in
**Garage → Sensors & More equipment → Caravan**. Its native Home Assistant
entities connect through the [MQTT automation generator](../integrations/homeassistant/dehumidifier.js).
Use **Tuya Local** entities for local-network operation. Install and commission
Tuya Local in Home Assistant first, using its
[setup instructions](https://github.com/make-all/tuya-local#configuration).
Account-assisted setup retrieves the local key once; runtime device control uses
the LAN. This implementation uses the verified DESD8LW data points: 1 for power,
2 for target humidity, 4 for fan speed and 6 for measured relative humidity.
The DESD9LW and Qlima profiles describe different data-point types or settings.

The bridge currently maps native power, 30–80% target humidity in increments of
five, and Low/Medium/High fan settings. Unsupported modes, Auto fan and louvre
settings are omitted. Controls use the bridge's advertised capabilities; missing
or unsupported options cannot be requested through either the UI or HTTP API.
Capabilities do not prove successful execution: confirmation requires a fresh
matching device report. Never use the Caravan energy plug as the appliance power
control; native shutdown allows its cooling cycle to finish.

The card starts with reported power and the supported native humidity and fan
controls. **Automatic power** shows the saved enabled state and thresholds;
expand it to edit the switch and thresholds, then use **Save changes** or
**Discard**. Unsaved edits do not change the active policy. Recording status
stays visible, and **Compare readings** expands the live readings and agreement
criteria. Family and replica views keep their read-only restrictions.

Installation entity IDs and credentials stay outside the repository. Set up the
local integration and bridge in this order:

1. Install the [DESD8LW profile](../integrations/homeassistant/tuya-local-desd8lw.yaml)
   as `custom_components/tuya_local/devices/electriq_desd8lw_dehumidifier.yaml`
   and select that profile for the appliance. It creates a native humidifier,
   a **Fan speed** select and a measured-humidity sensor. The select writes only
   fan speed, so changing it does not implicitly switch the appliance on.
2. Apply the [received-observation adapter](../integrations/homeassistant/tuya-local-observation.md).
   Its installer checks the exact reviewed Tuya Local 2026.9.2 source hashes and
   preserves private backups before changing Python files. A separately reviewed
   Home Assistant restart loads the patch. The adapter exposes confirmed raw
   device replies in the humidifier's `local_observations` attribute.
3. Generate the two automations using `dehumidifierAutomations({ id, label,
   prefix, humidifierEntity, fanSpeedEntity, deviceIdentity })`, with prefix
   `stmq/garage/caravan_dehumidifier`. `humidifierEntity` must be the native
   `humidifier` entity and `fanSpeedEntity` its same-device `select` entity.
   Review and install their full JSON through Home Assistant's automation
   configuration interface. Its MQTT integration must use the controller's broker.

`deviceIdentity` is the lowercase SHA-256 digest of the UTF-8 Tuya Local native
`unique_id`; for this appliance without a child device ID, that is the configured
Tuya device ID. It is not the Home Assistant entity ID or device-registry ID.
The observation adapter computes this digest from the actual configured native
device. The bridge requires it to match the privately selected digest before
publishing usable observations or accepting a command. Replacing the appliance
invalidates the earlier saved policy and comparison evidence.

Normal Tuya Local entity values may temporarily include pending command values.
The bridge reads all actual values and clocks from `local_observations`, while
native entity metadata establishes the supported controls. Missing adapter data,
restored states or a different physical identity leave the bridge unavailable.
Home Assistant's `last_reported` and a successful `update_entity` call cannot
substitute for received device evidence.

## MQTT contract

The prefix is `stmq/garage/caravan_dehumidifier`, separate from the native
Caravan energy plug prefix `stmq/garage/caravan`.

| Suffix | Direction | Payload |
| --- | --- | --- |
| `/state` | Bridge → ST-MQ | Full JSON snapshot shown below |
| `/availability` | Bridge → ST-MQ | `online` or `offline` |
| `/get` | ST-MQ → bridge | `{}` requesting a read-only status snapshot |
| `/set` | ST-MQ → bridge | One setting, physical identity and request deadline |

Example full snapshot, with an illustrative timestamp:

```json
{
  "identity": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "power": "on",
  "targetHumidity": 55,
  "fanSpeed": "low",
  "temperature": null,
  "humidity": 52,
  "timestamp": 1789992000000,
  "fieldTimestamps": {
    "power": 1789992000000,
    "targetHumidity": 1789992000000,
    "fanSpeed": 1789992000000,
    "humidity": 1789992000000,
    "temperature": null
  },
  "capabilities": {
    "power": ["off", "on"],
    "targetHumidity": [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80],
    "fanSpeed": ["low", "medium", "high"]
  }
}
```

Each `fieldTimestamps` value is the original UTC epoch millisecond at which Tuya
Local received that datapoint from the appliance. This is a native-report receipt
clock, not the sensor's internal sampling clock or an HA entity-update clock.
Partial native replies advance only the datapoints they contain. The aggregate
`timestamp` is their maximum and cannot renew an older field's evidence. This
model has no appliance temperature datapoint, so its value and clock are null.

The automation publishes on source changes, every 30 seconds, on startup and
reconnection, and in response to `/get`. Queries and periodic publications
preserve the original clocks. Snapshots use QoS 1 with retention disabled. The
bridge publishes `offline` when its source is unusable and during Home Assistant
shutdown; an `online` transport marker never extends measurement freshness.
Every required field still expires after the configured 180 seconds. Retained
data alone cannot establish availability, and connection loss clears the
adapter's old device observations.

Advance a field's clock only when a new native reply contains that datapoint.
Conflicting values at the same field clock are rejected. Each snapshot replaces
the previous settings; omitted/invalid values are unknown,
not merged with older settings. Reported power independently establishes the
recorded Off/On state; a missing fan setting does not make known power unknown.
Fan settings are displayed live and are never stored as telemetry history.

| Setting | Allowed values |
| --- | --- |
| `power` | `off`, `on` |
| `targetHumidity` | 30 through 80, in increments of 5 |
| `fanSpeed` | `low`, `medium`, `high` |

Only options listed in the current snapshot's `capabilities` can be sent.
These are the verified controls exposed by this local DESD8LW profile.

For example, a fan change sends
`{"fanSpeed":"medium","identity":"<the current 64-character identity>","requestedAt":1789992000000,"expiresAt":1789992010000}`
on `/set`. Commands are not retained and expire after ten seconds. The bridge
rejects unknown or multiple setting fields, invalid values, future or expired
requests, mismatched device identities and replayed request times. Its native actions target only the privately
selected entities. Power uses the humidifier's native on/off services, humidity
uses its humidity-setting service, and fan speed uses `select.select_option`.
A successful publish or native service response is not confirmation: the controller
waits for a matching independently received datapoint clocked at or after the
request. It does not record
requested settings as actual observations or retry old commands after reconnect.
Manual controls respect the existing master-control and read-only slave restrictions.
The request deadline fences bridge dispatch. Once a request reaches Tuya Local,
that integration's native delivery and retry behavior applies; the deadline is
not a device-local cancellation guarantee through a broken link.

## Automatic power and humidity agreement

The public equipment entry associates `temperature_control.sensor_device_id`
with `blu_ht`; configuration owns that wiring only. **Automatic power**, **Off
at** and **On at** are saved dashboard choices for this appliance and sensor
connection. They survive restart without changing configuration defaults. An
unrecognized/replaced connection starts with enabled, 1°C Off and 2°C On.
Thresholds accept −10 through 30°C in 0.1°C steps, with On at least 0.5°C above
Off. Authority is required to edit the policy; editing while the appliance is
unavailable grants no permission to command it. The first device identity must
be observed before saving choices; a previously bound identity permits edits
while offline.

With Automatic power enabled, fresh Caravan air temperature at or below **Off
at** requests native Off; at or above **On at** requests native On. Between the
thresholds the previous demand remains. Startup in the band uses Off demand.
Disable Automatic power to expose supported manual power controls and leave
native power unchanged. Other supported native controls remain available.
Disabling the policy does not disable the recording evidence check.

Appliance humidity must be within **10 percentage points** of Shelly BLU humidity
for **two minutes**, supported by advancing source reports from both devices.
Cached publications and time passing alone cannot establish agreement. If the
appliance also provides a temperature, it must be within 4°C of Shelly BLU;
an absent appliance temperature is allowed. The current HA bridge provides
humidity only and never substitutes the BLU reading for appliance evidence.

The UI reports matching, differing or unavailable readings and **Recording
active/paused**, without guessing where the appliance is. Humidity agreement is
a plausibility check, not proof of physical location: similar humidity in two
places can pass. Missing, stale or disagreeing evidence immediately prevents On
and ends caravan history coverage. Recovery requires a new qualifying period
and fresh appliance state; it never fills the earlier gap backwards.

Loss of comparison evidence requests Off only for an appliance previously
managed in this runtime. An appliance first seen with nonmatching readings
receives no automatic commands. Pending On or setting acknowledgements cannot
block protective Off. Offline devices cannot be switched or confirmed. Authority
loss prevents all writes. An uncertain request is reassessed before retrying,
with a 30-second minimum interval for the same demand. Commands never switch the
energy plug or replace native low-temperature protection and shutdown behavior.

## Recording

The single `caravan_dehumidifier_state` series uses stable numeric codes
with categorical labels in both Caravan charts, tooltips and the series explorer:

| Code | Label |
| --- | --- |
| 0 | Off |
| 1 | Low |
| 2 | Medium |
| 3 | High |
| null / gap | Unknown, unavailable or stale |

Off requires fresh reported power Off and does not depend on the fan setting.
Low, Medium and High require fresh reported power On plus the corresponding
fresh native fan report. Missing, stale or unsupported fan values while On leave
a gap; there is no Auto category. These states describe the appliance's power
and selected fan level, not measured airflow or proof of water removal. A humidity
target, full tank or shutdown cycle can affect physical operation.

The recorder retains only this combined state, appliance identity, required
power/fan receipt clocks and comparison qualification provenance. Separate fan
settings, mode, humidity target, louvre setting and the appliance's own
temperature/humidity remain live-only; commands do not generate history points.
There is no alias or conversion from either retired dehumidifier history series.
With the Caravan sensor association configured, every recorded state requires
the fresh, qualified comparison, including when Automatic power is disabled.
Coverage ends at the earliest expiry of the required appliance and comparison
reports. Missing comparison evidence produces a gap instead of a claimed state.

The same Caravan fold records `caravan_temperature` and `caravan_humidity` from
the Shelly BLU H&T. Battery and Bluetooth signal strength are live-only.
The Caravan plug records `caravan_energy` as measured interval kWh through the
shared adaptive recorder. It automatically balances recording frequency against
load changes, just like property and charging energy; instantaneous power, current
and plug state remain live-only. Daily totals still update on each meter report. None of these
Caravan series enters the Home or Garage heating learner.

The public `config.json` supplies all topics. If private configuration replaces
`equipment.devices`, copy the public caravan entries into that list as well;
private arrays replace defaults rather than merging by device ID.
