# Automation and manual heating

The header identifies the environment: **Live**, **Simulation**, or **History
viewer**. It does not grant equipment control. A history viewer and a read-only
replica cannot send commands. Simulation affects the synthetic plant only.

## Independent automation choices

| Feature | Dashboard choice | Scope |
| --- | --- | --- |
| Home heating | Plan only / Automatic | Applying the Home heating plan and its automatic circulation schedule |
| Garage heating | Plan only / Automatic | Starting and renewing automatic Garage heating pauses |
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

The former global mode configuration and environment variable are rejected, not
translated into feature permissions. Remove them before starting the current
version; choose each automation permission deliberately in the dashboard.

## Explicit manual heating

Home Normal / Reduction / Preheat and Garage Normal / Heating off are separate
owner requests. They remain available with automation set to Plan only when the
equipment and required evidence are ready. They do not enable automatic scheduling.
Home tariff reduction requests the relay; it does not prove the compressor stopped.
Garage OFF requires qualified device-local expiry, restoration and freeze protection.

Without a price-control pause, temporary heating choices end at the next
controller update, normally within a minute, with bounded expiry as a fallback.
During a pause they remain until the selected deadline or Resume, subject to
protection and restoration rules. Price-control pause is distinct from choosing
Plan only. Native heat-pump parameter edits are persistent device commands with
their own ownership; they are not temporary heating-mode overrides.

## Garage external-temperature handover

The current external-temperature design uses native HEAT at 17°C and a separately
saved room target. No i-save preservation assumption authorizes control.

Before a bounded OFF period, the controller saves the current external-control
intent and suspends numeric updates. It requests and confirms clearing external
input before admitting OFF. Normal, Resume, expiry and restart retain the
restoration obligation. After fresh ON confirmation and cleared OFF obligations,
the room-control loop resumes the saved target using fresh qualified temperatures.
It never replays a previously supplied external temperature.

Uncertain clear or OFF delivery remains visible. A failed handover cannot be
reported as confirmed OFF. Independent native power/mode/setting changes and a
changed device binding supersede automatic resumption; restoring a temporary
override must not undo a later deliberate device action.

The adapter requires installed power-only, expiry and restart evidence for managed
OFF. Its `releaseOrdering` capability describes software cancellation behaviour:
release fences queued and partially transmitted OFF before reporting restored ON.
Host and compiled-driver tests establish software behaviour, not installed UART
timing, actual heating performance or physical pipe protection. Those evidence
limits remain explicit in the adapter's commissioning record.

## Visible confirmation

Controls distinguish the requested action from fresh device state. Garage reports
external-input clearing, OFF request/confirmation and restoration beside its
buttons, including unavailable reasons. Home's selected button follows confirmed
device evidence rather than an older requested mode. A failed command readback
can coexist with a newer report of the desired state; the UI identifies those
separate facts instead of diagnosing every error as an MQTT broker failure.

See [Home control](learning-and-control.md), [Garage control](garage.md),
[adapter contract](garage-adapter.md), [charging](charging.md), and
[equipment controls](mqtt-equipment.md) for the detailed readiness rules.
