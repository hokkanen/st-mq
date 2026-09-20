# BMW CarData through Home Assistant

Home Assistant publishes measured BMW inputs to the existing Charger 1 vehicle
topic, `stmq/garage/charger1/vehicle`, as retained JSON with QoS 1. This is a
telemetry feed: the automation never starts, stops or wakes a vehicle. The normal
charging controller selects Tesla telemetry when Tesla is identified at Easee.

The automation builder is
[`scripts/lib/bmw-cardata-automation.js`](../scripts/lib/bmw-cardata-automation.js).
Supply three Home Assistant sensor entity IDs from the same BMW CarData vehicle:

| Input | CarData descriptor | Meaning |
| --- | --- | --- |
| `socEntity` | `vehicle.powertrain.electric.battery.stateOfCharge.displayed` | Measured dashboard battery percentage |
| `targetEntity` | `vehicle.powertrain.electric.battery.stateOfCharge.target` | Vehicle charge target |
| `capacityEntity` | `vehicle.drivetrain.batteryManagement.maxEnergy` | Current usable energy capacity, kWh |

Use measured SoC rather than CarData's predicted SoC sensor: STMQ already accounts
for recorded charging energy. `batterySizeMax` is a separate nominal-size field;
the installed feed uses the available `maxEnergy` measurement. The upstream
[CarData integration](https://github.com/kvanbiesen/bmw-cardata-ha) also gives
`maxEnergy` priority for capacity-based prediction.

For example, create an automation configuration with invented sensor names:

```js
import { bmwCardataAutomation } from './scripts/lib/bmw-cardata-automation.js';
const automation = bmwCardataAutomation({
  socEntity: 'sensor.example_battery_soc',
  targetEntity: 'sensor.example_charge_target',
  capacityEntity: 'sensor.example_usable_capacity',
});
```

Install the returned configuration as a Home Assistant automation. Check the
rendered condition and payload through Home Assistant's template API first, then
read back the installed automation and verify a publication through MQTT.
The automation uses Home Assistant's standard
[`mqtt.publish`](https://www.home-assistant.io/integrations/mqtt/#examples)
action and [automation triggers](https://www.home-assistant.io/docs/automation/trigger/).
It publishes when any source changes, at Home Assistant startup, on the default
MQTT birth message, and every five minutes for recovery after a broker outage.
Repeating a publication keeps the original measurement identity and timestamps.

Each sensor's CarData `timestamp` attribute is preserved. SoC supplies the
top-level `measuredAt` and `readingId`; target and capacity carry their own values
under `fields.chargeLimitSoc` and `fields.usableCapacityKwh`, each with
`measuredAt` and `readingId`. Independently newer target/capacity readings can
update while SoC is unchanged, without resetting session progress or renewing
SoC's age. Replayed and older optional fields cannot replace newer ones.

Unknown source timestamps remain unknown. Unavailable or invalid SoC suppresses
publication. Invalid optional readings are omitted, retaining the last accepted
value and its original age in STMQ rather than substituting zero. Existing
manual fallbacks remain available if a measurement has never been received.

The household installation was configured and its enabled state, rendered
payload and live QoS 1 MQTT delivery verified on 2026-09-20. Private entity
mapping, readbacks and deployment evidence stay outside Git under
`~/.config/st-mq/bmw-cardata/` (directory `0700`, files `0600`). Credentials are
read only from the owner-provided private token file and never embedded in the
automation or repository.
