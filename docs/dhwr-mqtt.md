# Hot-water circulation through direct Shelly MQTT

Hot-water circulation uses the standard direct Shelly connection, with a
**Shelly 1PM Gen3** relay on `switch:0`. A power-meter-only PM device cannot
operate the pump; the integration requires the native Switch component.
See [direct Shelly setup](mqtt-equipment.md) and the manufacturer's
[Switch RPC documentation](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/).

The public equipment entry uses `shelly:stmq/home/dhwr`, generation 3,
`switch_id: 0`, `record: false`, and a required live power reading from
`switch:0.apower` in watts. Configure the replacement relay's MQTT topic prefix
as `stmq/home/dhwr`, on the existing primary MQTT broker, with native RPC and
status notifications enabled. Broker credentials stay in private configuration.
A different native prefix belongs in the existing private equipment override;
an `equipment.devices` override replaces the complete public device list.

The retired `mqtt.dhwr_topic`, generic MQTT DHWR feedback entry and SmartThings
power-forwarding Rule are no longer supported. Remove the old publisher and
command subscription when commissioning the replacement. Installing this code
does not configure the relay or operate household equipment. Any outstanding
restoration bound to the previous device remains unresolved; replacement hardware
cannot satisfy an obligation belonging to the original relay.

## Commands and device evidence

The shared acquisition connection discovers native identity with
`Shelly.GetDeviceInfo`, polls `Shelly.GetStatus`, and subscribes to native status.
Commands use non-retained QoS 1 `Switch.Set` RPC on `stmq/home/dhwr/rpc`.
The matching post-command `Switch.GetStatus` response must confirm the requested
output before command completion. Broker acknowledgement, `was_on`, retained
messages and unrelated reports cannot confirm it. Request IDs, native device
identity and component ID fence replies; disconnect and authority loss prohibit
replaying queued commands.
If a newer status notification arrives before that matching response, an equal
output can still confirm the command without replacing the newer measurement or
its timestamp. A contradictory newer output prevents confirmation.

The circulation entry deliberately exposes no ordinary switch control or timed
equipment test. Its sole writer is the durable circulation executor. **Start
circulation** runs for `controller.dhwr_duration_minutes` (default 10, range 1–60),
including during Home Pause. Starting again begins a new full run; **Stop
circulation** ends it immediately. An explicit Stop can also stop fresh reported
operation started outside this application. Heating-phase changes and manual
Preheat do not shorten or start a separately requested circulation run.

Before ON, the executor saves its OFF obligation and an opaque digest binding
the broker/account, configured component and discovered native identity.
The normal run deadline begins when native ON confirmation completes. An
uncertain ON retains an OFF duty. Expiry, shutdown and restart attempt OFF;
an uncertain OFF remains pending until native OFF confirmation. A replacement
route or hardware identity cannot clear the earlier duty. Restart restores OFF
instead of resuming ON. The elapsed deadline prevents clock rollback from
extending an admitted run. Pair demotion fences commands; only the authorized
controller can discharge restoration.

Measured positive power means electrical pump operation and zero means idle.
Native output state is shown separately. Each new request needs a subsequent
power report for the dashboard's operation confirmation; relay OFF readback and
power feedback remain separate evidence. Neither proves water flow. Native
polling defaults to 30 seconds and the circulation readings expire after 120
seconds. Missing power, component errors, disconnect and stale reports remain
unknown. No cache or retained message renews physical evidence.

## Recording and commissioning

Raw relay state and power remain live-only. The recorder saves compact
`dhwr_active` changes derived from power, including exact unavailable boundaries;
unchanged reports extend recorded coverage. Actual operation stays distinct from
requested circulation. Existing historical gaps remain gaps, and supported
v0.7.5 CSV pulses retain their original ten-minute interpretation.

Configure the device's power-on state to OFF. A device-local maximum-on watchdog
above the longest configured run provides independent protection when the
application or broker cannot deliver OFF; it does not replace the executor's
normal timer. Verify native identity, current power, ON, timed OFF and restart
restoration on the installed relay before enabling active circulation. These
physical checks are separate from offline software validation.
