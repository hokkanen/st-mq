# Automation and manual heating

The header identifies Live, Simulation or History viewer. It does not grant
control. History viewers and read-only replicas cannot send equipment commands.

## Independent choices

| Feature | Dashboard choice | Scope |
| --- | --- | --- |
| Home heating | Automatic / Paused | Home heating plan and automatic circulation |
| Garage heating | Normal / Away | Permanent real room target; no automatic schedule |
| Charging | Automatic charging Off / On | Each charger's scheduling permission |
| Caravan | Automatic power Off / On | Independent dehumidifier control |

Home starts paused without a resume time. This single durable choice is bound to
the current equipment. Selecting Pause restores automatic changes to Normal;
subsequent manual choices use the pause scope. Selecting Automatic clears the
pause and restores owned manual changes before reassessing the plan.
`POST /api/automation` accepts Home only (`enabled: true` for Automatic, `false`
for indefinite Pause). `POST /api/temporary` sets an optional `pauseUntil` or
`pauseUntilLocal`; clearing it keeps Pause without an end. A scheduled deadline
resumes Automatic for the same equipment. There is no separate plan-only mode or
`/api/override` endpoint. Configuration defaults remain separate.

## Home manual heating

The folded **Manual heating override** requests Normal, Reduced or Preheat using
the same immediate equipment actions as the corresponding automatic phase.
Normal restores owned native settings and tariff control. Reduced requests tariff
reduction, applies available native hot-water/auxiliary restrictions and suppresses
automatic circulation. A hot-water circulation run already in progress finishes
before reduction starts, for both manual and automatic requests. These actions bypass savings/forecast selection, while
retaining device readiness, native limits and restoration checks. Automatic phase
selection is situation dependent; a phase's equipment actions share one path.

In Automatic, Normal and Reduced are reassessed on the next controller update.
During Pause, they remain until another selection, Automatic, or the scheduled
resume time. An indefinite Pause gives them no application end time. Native
parameter edits remain separate persistent device commands.

Manual Preheat raises ROOM and opens commissioned floor circuits for one original
floor lease. Polling does not renew that lease. Normal or Reduced ends it sooner.
At the deadline the controller restores ROOM independently of floor feedback and
checks whether the device-local floor lease restored circulation. Missing or failed
restoration triggers the controller fallback and remains unresolved until fresh
readback confirms it. With no floor integration, the configured bounded preheat
duration applies. A report distinguishes device-local expiry, controller fallback
and missing evidence; software cannot prove restoration through a broken link.

Action receipts, including Garage and equipment controls, remain visible for
24 hours unless replaced by a newer action on the same control. Device feedback
updates pending messages; completed receipts describe past actions, not active
ownership. Ongoing faults/restoration are visible until resolved regardless of age.

## Garage manual heating

Normal selects the saved normal target; Away selects the configured preset.
Neither expires. `POST /api/garage/heating` accepts the mode and optional normal
target. Raising the effective requested target shows a condensation advisory:
avoid wet or snowy cars and substantial added moisture for roughly 24 hours,
and longer while surfaces and stored contents remain cold.

The Pill stores the real target and external-control enable, without mode labels.
It uses native BTHome temperature components for its local loop. With fresh input
in HEAT it confirms native 17°C and feeds measured temperature + 17°C - effective
target. It preserves OFF. Other native modes suspend the override; returning to
HEAT with fresh evidence resumes it. A sensor timeout clears external sensing
and selects native 16°C in HEAT while preserving power.

Power, mode, fan and vane edits are explicit one-shot commands with readback.
They have no automatic replay or expiry. Independent local frost protection can
request HEAT/ON and a higher minimum target. The sender owns the pipe estimates;
MQTT carries its settings/status, while Bluetooth carries local protection.
The BLU H&T test feed supplies temperature only. Missing protection is displayed
as unavailable. Neither receipt of a command nor a model estimate proves heating.

See [Home control](learning-and-control.md), [Garage control](garage.md),
[adapter contract](garage-adapter.md), [charging](charging.md), and
[equipment controls](mqtt-equipment.md).
