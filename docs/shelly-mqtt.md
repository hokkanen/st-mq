# Direct Shelly MQTT

ST-MQ can read the garage relay's temperature add-on, control a heating reduction
relay, and monitor the Caravan Shelly Plug directly through the existing MQTT
broker. Home Assistant can continue using its Shelly integration in parallel.
All device connections are disabled until configured. No device has been changed
or switched as part of this implementation.

## Private ST-MQ configuration

Add a `shelly` section to the existing private configuration file shown in the
application's Configuration panel. Keep broker credentials in the existing `mqtt`
section. These invented prefixes must be replaced with each device's actual
MQTT prefix; they are not discovery names, IP addresses or Home Assistant entity IDs.

```json
{
  "shelly": {
    "poll_seconds": 30,
    "max_age_seconds": 120,
    "garage": {
      "enabled": true,
      "generation": 2,
      "topic_prefix": "invented-garage-relay",
      "switch_id": 0,
      "temperature_id": 100,
      "controls_heat": false,
      "reduction_on": true
    },
    "heat_savings": {
      "enabled": true,
      "generation": 3,
      "topic_prefix": "invented-heat-mini",
      "switch_id": 0,
      "controls_heat": true,
      "reduction_on": true
    },
    "caravan": {
      "enabled": true,
      "generation": 2,
      "topic_prefix": "invented-caravan-plug",
      "switch_id": 0,
      "nominal_voltage": 230
    }
  }
}
```

Use input `mqtt` or `providers`, then Apply configuration. The device roles must
use distinct, non-overlapping prefixes. Configure `generation` from the actual
hardware: 1 uses the original API; 2, 3 and 4 use the modern RPC API.

`garage.controls_heat` defaults to false because a temperature relay is not
necessarily wired to the heat pump. `heat_savings.controls_heat` defaults to true.
If the garage relay is the only device connected to the heat reduction input,
set its `controls_heat` true and leave the separate Mini disabled. If both outputs
must follow that input, explicitly enable both controls. The Caravan plug is
monitoring only and cannot be assigned heating control.

The existing command names describe the heating intent: `heatoff` requests
reduction and `heaton15` restores normal heating. With `reduction_on: true`, these
mean relay ON and OFF respectively. Set false if the installed contact wiring
requires the opposite polarity. Confirm the correct contact function using the
heat-pump wiring documentation before enabling active control. ST-MQ sends fixed
ON/OFF requests, waits for the relay's state, and reports unconfirmed delivery
when readback fails. It does not prove that the heat pump responded to the contact.

## Shelly Plus / Pro / Gen3 / Gen4 setup

1. Open each Shelly's own local web interface. Enable MQTT, use the same broker
   as ST-MQ, and enter credentials there. Leave Home Assistant's integration in
   place. Give the device a unique MQTT prefix and copy it into ST-MQ.
2. Enable RPC over MQTT (`enable_rpc`) and RPC status notifications (`rpc_ntf`).
   Component notifications (`status_ntf`) can remain enabled as well. Reboot if
   the device reports that the configuration needs it. ST-MQ subscribes to the
   device prefix and its own temporary RPC reply topic; broker permissions must
   allow both directions. See [Shelly MQTT configuration](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt/).
3. For the garage, enable the attached temperature sensor in the device UI.
   Inspect `Shelly.GetStatus` in the device's RPC/debug interface and identify the
   external component, for example `temperature:100`. Put its numeric ID in
   `temperature_id`. The relay's internal CPU temperature is a different value
   and is never used as the garage temperature. Invalid external readings are
   unavailable. See [Temperature components](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Temperature/).
4. For the Mini, use its switch component ID (normally 0). Set its power-on
   behavior to the contact state that permits normal heating. Remove any old
   automation that independently pulses or reverses this same output; retain
   Home Assistant's separate observation access. ST-MQ does not rewrite device
   schedules or timers. Verify the switch's actual behavior in monitoring/shadow
   mode before issuing the application's explicit heating test.
5. For the Caravan plug, verify the switch status exposes power, current and its
   cumulative energy counter. ST-MQ converts `apower` W to kW and `aenergy.total`
   Wh to kWh, and reads `current` in A. No additional Shelly script is needed.
   See [Switch methods and meter values](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/).

The application requests status every 30 seconds by default. Readback after a
command uses a separate `Switch.GetStatus` request following the `Switch.Set`
reply. A broker acknowledgement alone does not establish the relay state.

## Original Gen1 devices

Use `generation: 1` and the complete original prefix, for example
`shellies/invented-garage-relay`. Set a garage add-on's `temperature_id` to its
external sensor index, normally 0; set Celsius output in the device UI. Enable
MQTT and periodic updates, preferably every 30 seconds. Keep Home Assistant's
existing CoIoT/native Shelly connection configured independently. ST-MQ uses
`relay/0`, its power/energy subtopics, and `ext_temperature/0`; it requests an
update only from the configured device. Gen1 relay confirmation uses a subsequent live output publication; this protocol
has no request ID to correlate it to a command. Gen1 energy is reported in watt-minutes
and is divided by 60000 for kWh. These plugs do not provide native current on
those topics: the displayed **Current estimate** is active power divided by
`nominal_voltage`, which does not account for power factor. Use a metering Gen2+
plug when measured current is required. See the [Gen1 API and MQTT topics](https://shelly-api-docs.shelly.cloud/gen1/).

## Availability, history and Home Assistant coexistence

Retained and duplicate MQTT packets never refresh measurements or confirm a
command. An offline message immediately invalidates live values. A broker
reconnect does not restore availability until the device answers again. Each
reading expires after `max_age_seconds`; other changing components cannot keep
an old temperature or current reading fresh.

When direct garage acquisition is enabled, it owns `garage_temperature`.
An existing `mqtt.garage_temperature_topic` remains subscribed and is recorded
separately as **Garage temperature via Home Assistant** (`garage_temperature_ha`).
It cannot overwrite the direct reading. No Home Assistant integration or MQTT
discovery entry is deleted. A pre-existing garage feed is not required to enable
the direct adapter.

Equipment shows the Caravan switch, power, current, and energy accumulated since
midnight in **Europe/Helsinki**. Energy is measured from successive plug counters.
The first partial day, missing intervals and counter resets are marked as partial
coverage. Long outages are not distributed across hours or backfilled with zeros;
the displayed total is a lower bound for the measured periods.

Completed **UTC-hour energy totals** are saved once per hour as `caravan_energy`
observations, with interval start/end and actual covered duration. Daily local
calendar boundaries still follow Helsinki, including daylight-saving changes.
A short counter interval crossing an hour is apportioned by elapsed time and
labelled time-allocated. Pending hour/day state survives application restarts;
a long outage or meter reset establishes a new baseline. The current incomplete
hour contributes to the Equipment daily total and appears in the hourly chart
when finalized. These measurements are history only and do not train the house
model or alter existing electricity allocations and imports.

Select **Caravan hourly energy**, **Caravan power**, **Caravan current**, or
**Caravan plug state** on the chart's left axis. Missing coverage remains explicit.
