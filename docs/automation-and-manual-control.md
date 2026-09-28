# Automation and manual heating

The header identifies the environment: **Live**, **Simulation**, or **History
viewer**. It does not grant equipment control. A history viewer and a read-only
replica cannot send commands. Simulation affects the synthetic plant only.

## Independent automation choices

| Feature | Dashboard choice | Scope |
| --- | --- | --- |
| Home heating | Plan only / Automatic | Applying the Home heating plan and its automatic circulation schedule |
| Garage heating | Plan only / Automatic | Applying bounded lower external room targets during expensive periods |
| Charging | Automatic charging Off / On | Each supported charger's scheduling permission |
| Caravan | Automatic power Off / On | The dehumidifier's independent power controller |

Home and Garage start on **Plan only**. These durable dashboard choices are bound
to the configured equipment. They do not rewrite configuration defaults, enable
another feature or relax readiness and protection checks. Switching a feature to
Plan only ends its automatic control and restores its owned temporary changes;
separately authorized manual actions retain their own scope. The current plan,
manual action, pause and unavailable reason remain visible in the feature section.

`GET /api/status` exposes `environment` and `automation.home` /
`automation.garage`. `POST /api/automation` accepts exactly
`{"feature":"home","enabled":true}` (or `garage` and `false`) and returns
the current dashboard status. The server checks authentication, current controller
authority and equipment binding. Charging and Caravan retain their own APIs.

The former `controller.mode` configuration and `STMQ_MODE` environment variable
are rejected, not translated into feature permissions. Remove them before
starting the current version; choose each automation permission deliberately in
the dashboard. Deployment must use the current application and adapter contracts
together; retired configuration and command fields have no compatibility aliases.

## Explicit manual heating

Home Normal / Reduction / Preheat and Garage Normal / Heating off are separate
owner requests. They remain available with automation set to Plan only when the
equipment and required evidence are ready. They do not enable automatic scheduling.
Home tariff reduction requests the relay; it does not prove the compressor stopped.
Garage OFF requires qualified device-local expiry, restoration and freeze protection.

The Pill has one local managed-pause permission, `pauseEnabled` (default false),
for explicit timed OFF. ST-MQ price automation instead changes the external room
input and does not require the OFF commissioning proofs. The adapter does not
receive a manual/automatic wire `purpose`. Current ownership, freshness and native
checks still apply to each operation. `mode: "ready"` and
`authority.controlAllowed` describe timed-OFF readiness. Disabling that capability
blocks new timed OFF and preserves existing restoration duties. The separate
`manualEnabled` permission governs ordinary persistent native settings.

Without a price-control pause, temporary heating choices end at the next
controller update, normally within a minute, with bounded expiry as a fallback.
During a pause they remain until the selected deadline or Resume, subject to
protection and restoration rules. Price-control pause is distinct from choosing
Plan only. Native heat-pump parameter edits are persistent device commands with
their own ownership; they are not temporary heating-mode overrides.

## Garage external-temperature handover

The current external-temperature design uses native HEAT at 17°C and a separately
saved room target. No i-save preservation assumption authorizes control.

Automatic savings retain native power ON and lower the effective room target
(default 0°C) without changing the saved normal target (minimum 5°C). The adjusted
external input is `rear temperature + 17 − effective target`. This suppresses
thermostat demand while the measured room is warmer than the temporary target;
it does not guarantee a stopped compressor. Every reduction is bounded by fresh
front/rear evidence, pipe reserve, available forecasts and an immutable endpoint.
The forecast retains powered consumption and possible lower-target maintenance.
These are engineering estimates, not measured OFF-period savings.

Explicit timed OFF uses a separate handover: save the room intent, request external
clear, wait for acknowledged cleanup, then request bounded OFF. Normal or expiry
restores native ON; resuming the saved target also requires fresh source evidence.
There can be a native-thermostat interval during this manual handover. External
control and a managed OFF lease are mutually exclusive. Serial ACK confirms a
command's acceptance, not direct readback of the selected thermostat sensor.

Uncertain delivery, external clearing, OFF confirmation and restoration remain
visible. Later independent native power/mode changes or changed equipment binding
supersede resumption. Expired input and restart clear the old sample and retain
native-heating recovery duties. A same-source target change keeps the original
measurement clock and cannot extend that sample's permission.

The adapter requires installed `selectivePowerVerified`, `expiryVerified` and
`restartVerified` evidence for managed OFF. Its `releaseOrdering` capability
describes software cancellation behaviour, not an additional installed proof flag:
release fences queued and partially transmitted OFF before reporting restored ON.
Host and compiled-driver tests establish software behaviour, not installed UART
timing, actual heating performance or physical pipe protection. Those evidence
limits remain explicit in the adapter's commissioning record.

## Visible confirmation

Controls distinguish the requested action from fresh device state. Garage reports
target requests, external clearing, OFF request/confirmation and restoration beside its
buttons, including unavailable reasons. Home's selected button follows confirmed
device evidence rather than an older requested mode. A failed command readback
can coexist with a newer report of the desired state; the UI identifies those
separate facts instead of diagnosing every error as an MQTT broker failure.

See [Home control](learning-and-control.md), [Garage control](garage.md),
[adapter contract](garage-adapter.md), [charging](charging.md), and
[equipment controls](mqtt-equipment.md) for the detailed readiness rules.
