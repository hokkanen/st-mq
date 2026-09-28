# Caravan dehumidifier

The **electriQ DESD8LW** appears below air and energy readings in
**Garage → Sensors & More equipment → Caravan**. Its native Home Assistant
entities connect through the [MQTT automation generator](../integrations/homeassistant/dehumidifier.js).
Use **Tuya Local** entities for local-network operation; the ordinary Tuya
integration depends on the cloud. Install and commission Tuya Local in Home
Assistant first, using its [setup instructions](https://github.com/make-all/tuya-local#configuration).
Account-assisted setup retrieves the local key once; runtime device control uses
the LAN. A similar model name is insufficient to select a profile: verify the
actual data points, entity capabilities and readback before connecting it.

The bridge currently maps native power, 30–80% target humidity in increments of
five, and Low/Medium/High fan settings. Unsupported modes, Auto fan and louvre
settings are omitted. Controls use the bridge's advertised capabilities; missing
or unsupported options cannot be requested through either the UI or HTTP API.
Capabilities do not prove successful execution: confirmation requires a fresh
matching device report. Never use the Caravan energy plug as the appliance power
control; native shutdown allows its cooling cycle to finish.

Installation entity IDs and credentials stay outside the repository. Generate the
two automations using `dehumidifierAutomations({ id, label, prefix,
humidifierEntity, fanEntity, humidityEntity, deviceIdentity })`, with prefix
`stmq/garage/caravan_dehumidifier`. Review and install their full JSON using
Home Assistant's automation configuration interface. Enable its MQTT integration
on the same broker as the controller. Verify the generated template against the
chosen local entities before enabling the command automation. `deviceIdentity`
is the SHA-256 digest of the stable HA appliance identity, never a raw private
identifier. It binds observations, saved policy and commands to the appliance;
replacing it resets the earlier policy and comparison evidence.

## MQTT contract

The prefix is `stmq/garage/caravan_dehumidifier`, separate from the native
Caravan energy plug prefix `stmq/garage/caravan`.

| Suffix | Direction | Payload |
| --- | --- | --- |
| `/state` | Bridge → ST-MQ | Full JSON snapshot shown below |
| `/availability` | Bridge → ST-MQ | `online` or `offline` |
| `/get` | ST-MQ → bridge | `{}` requesting a read-only status snapshot |
| `/set` | ST-MQ → bridge | JSON containing the setting(s) to change |

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
  "capabilities": {
    "power": ["off", "on"],
    "targetHumidity": [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80],
    "fanSpeed": ["low", "medium", "high"]
  }
}
```

`timestamp` is the original device observation time in UTC epoch milliseconds.
A full device snapshot may use this single clock. The Home Assistant bridge
also supplies `fieldTimestamps` for power, targetHumidity, fanSpeed, humidity
and temperature; each field uses its actual entity's original `last_reported`.
The aggregate clock orders snapshots and cannot renew older field evidence.
Repeated `/get` requests and periodic publications preserve those clocks.
Publish live snapshots with QoS 1 and retention disabled, on state changes and
regularly enough to stay within the configured 180-second expiry. A query must
preserve the original observation time unless the device was actually read again.
Send a live `online` report and a live snapshot after connecting/reconnecting;
retained data alone cannot establish availability. Publish `offline` when device
feedback is lost and configure a broker will for bridge disconnection.

Advance the observation timestamp when a setting changes. Conflicting values
with the same timestamp are rejected. Each snapshot replaces the previous settings; omitted/invalid values are unknown,
not merged with older settings. Power Off gives running state Off even if fan
speed is absent; Power On requires a valid fan speed to establish running state.

| Setting | Allowed values |
| --- | --- |
| `power` | `off`, `on` |
| `mode` | `auto`, `dehumidify`, `heater`, `fan_only` |
| `targetHumidity` | 30 through 80, in increments of 5 |
| `fanSpeed` | `low`, `medium`, `high`, `auto` |
| `swing` | `fixed_90`, `fixed_45`, `oscillate` (0–90°) |

Only options listed in the current snapshot's `capabilities` can be sent.
The table lists the canonical vocabulary, not a promise of support for every model.

For example, a fan change sends
`{"fanSpeed":"medium","identity":"<the current 64-character identity>","requestedAt":1789992000000,"expiresAt":1789992010000}`
on `/set`. Commands are not retained and expire after ten seconds. The bridge
rejects unknown or multiple setting fields, invalid values, future or expired
requests, mismatched device identities and replayed request times. Its native actions target only the privately
selected entities. The bridge must apply only requested fields, reject unsupported
options and then report actual device settings on `/state`. A successful publish
is not confirmation: ST-MQ waits for fresh matching telemetry. It does not record
requested settings as actual observations or retry old commands after reconnect.
Manual controls respect the existing master-control and read-only slave restrictions.

## Automatic power and humidity agreement

The public equipment entry associates `temperature_control.sensor_device_id`
with `blu_ht`; configuration owns that wiring only. **Automatic power**, **Off
at** and **On at** are saved dashboard choices for this appliance and sensor
connection. They survive restart without changing configuration defaults. An
unrecognized/replaced connection starts with enabled, 1°C OFF and 2°C ON.
Thresholds accept −10 through 30°C in 0.1°C steps, with ON at least 0.5°C above
OFF. Authority is required to edit the policy; editing while the appliance is
unavailable grants no permission to command it. The first device identity must
be observed before saving choices; a previously bound identity permits edits
while offline.

With Automatic power enabled, fresh Caravan air temperature at or below **Off
at** requests native OFF; at or above **On at** requests native ON. Between the
thresholds the previous demand remains. Startup in the band uses OFF demand.
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
places can pass. Missing, stale or disagreeing evidence immediately prevents ON
and ends caravan history coverage. Recovery requires a new qualifying period
and fresh appliance state; it never fills the earlier gap backwards.

Loss of comparison evidence requests OFF only for an appliance previously
managed in this runtime. An appliance first seen with nonmatching readings
receives no automatic commands. Pending ON or setting acknowledgements cannot
block protective OFF. Offline devices cannot be switched or confirmed. Authority
loss prevents all writes. An uncertain request is reassessed before retrying,
with a 30-second minimum interval for the same demand. Commands never switch the
energy plug or replace native low-temperature protection and shutdown behavior.

## Recording

The single `caravan_dehumidifier_running_state` series uses stable numeric codes
with categorical chart labels:

| Code | Label |
| --- | --- |
| 0 | Off |
| 1 | Low |
| 2 | Medium |
| 3 | High |
| 4 | Auto |
| null / gap | Unknown, unavailable or stale |

This combines reported power and fan setting, making it sufficient for reviewing
when the appliance was enabled and at which fan setting. It does not prove that
water was being removed: a humidity target, full tank, automatic fan selection or
shutdown cycle can affect physical operation. Operating mode, humidity target and
louvre setting remain live-only; commands do not generate history points.
With the Caravan sensor association configured, every recorded state requires
the fresh, qualified comparison, including when Automatic power is disabled. Coverage ends at the earliest expiry of
either device. Missing comparison evidence produces a gap instead of a claimed Off or On state.

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
