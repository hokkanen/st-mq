# Caravan dehumidifier

The public equipment list reserves **Caravan dehumidifier** for the planned
**electriQ DESD8LW**. Its controls sit below air and energy readings in
**Garage → Sensors & More equipment → Caravan**. Until a bridge sends live status,
settings are unknown and the controls are disabled. No initial Off state or
other telemetry is invented. The history catalogue is ready before installation.

This is ST-MQ's bridge contract, not a claim that the appliance speaks MQTT.
When the appliance arrives, map its actual local or Home Assistant integration
to these fields and verify which options its firmware supports. The requested
35–80% humidity range and Auto fan option are planned capabilities; model revisions
may expose different choices. See the manufacturer's
[DESD8LW manual](https://www.electriq.co.uk/files/pdf/DESD8LW%2020210901.pdf).
Use the appliance's own power control, allowing its shutdown cycle, rather than
switching the Caravan energy plug to operate the dehumidifier.

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
  "power": "on",
  "mode": "dehumidify",
  "targetHumidity": 55,
  "fanSpeed": "low",
  "swing": "fixed_90",
  "temperature": 8.5,
  "humidity": 52,
  "timestamp": 1789992000000
}
```

`timestamp` is the original device observation time in UTC epoch milliseconds.
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
| `targetHumidity` | 35 through 80, in increments of 5 |
| `fanSpeed` | `low`, `medium`, `high`, `auto` |
| `swing` | `fixed_90`, `fixed_45`, `oscillate` (0–90°) |

For example, a fan change sends `{"fanSpeed":"medium"}` on `/set`. Commands are
not retained. The bridge must apply only requested fields, reject unsupported
options and then report actual device settings on `/state`. A successful publish
is not confirmation: ST-MQ waits for fresh matching telemetry. It does not record
requested settings as actual observations or retry old commands after reconnect.
Manual controls respect the existing primary-controller and replica restrictions.

## Temperature control and location check

The public equipment entry enables `temperature_control: { "sensor_device_id":
"blu_ht" }`. ST-MQ controls appliance power from the Caravan air BLU reading:
OFF at or below 1°C; ON at or above 2°C; retain the previous demand between
those thresholds. Startup in the 1–2°C band starts with OFF demand. The power
buttons are disabled while this policy is configured; other settings remain
available. Removing `temperature_control` returns the generic equipment entry
to manual control and its generic recording policy.

Both devices must provide fresh live reports. The appliance snapshot must include
its own measured `temperature` in °C and `humidity` in percent. Its temperature
must differ from BLU by no more than 4°C and humidity by no more than 20 percentage
points. These tolerances allow normal sensor offset and appliance warmth; they
are a location plausibility check, not proof of physical location. Missing or
disagreeing values prevent ON commands and pause caravan running-state history.
The bridge must report actual appliance readings, never copy the BLU values.

Loss of room evidence requests OFF for an appliance previously managed in this
runtime. An appliance first seen elsewhere receives no temperature commands.
Offline appliances cannot be switched or confirmed; the UI says so. Authority
loss prevents all writes. Commands are never retained or replayed, require live
feedback, and uncertain requests are retried only after a new current assessment
and a 30-second minimum interval. This host policy does not replace the appliance's
own low-temperature protection or shutdown sequence.

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
With temperature control enabled, every recorded state also requires the two
fresh, plausibly colocated readings. Coverage ends at the earliest expiry of
either device. Missing location evidence produces a gap instead of recording
activity when the appliance may have been moved elsewhere.

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
