# Automation and manual heating

The header identifies Live, Simulation or History viewer. It does not grant
control. History viewers and read-only replicas cannot send equipment commands.

## Independent choices

| Feature | Dashboard choice | Scope |
| --- | --- | --- |
| Home heating | Plan only / Automatic | Home heating plan and automatic circulation |
| Garage heating | Normal / Away | Permanent real room target; no automatic schedule |
| Charging | Automatic charging Off / On | Each charger's scheduling permission |
| Caravan | Automatic power Off / On | Independent dehumidifier control |

Home starts Plan only. Its durable permission is bound to the current equipment.
Disabling it restores owned automatic changes while separately authorized manual
actions retain their own scope. `POST /api/automation` accepts Home only.
Configuration defaults remain separate from dashboard choices.

## Home manual heating

Home Normal / Reduction / Preheat, Away and Pause retain their bounded behavior
and restoration duties. Temporary choices outside a pause revert at the next
controller update, with bounded expiry as fallback. A pause holds a temporary
choice until its deadline or Resume. Native parameter edits are persistent
commands, separate from temporary heating actions. Tariff reduction requests a
relay; it does not establish that a compressor has stopped.

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
