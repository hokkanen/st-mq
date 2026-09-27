# September owner review implementation tracker

The Easee local-access assumptions and commissioning limits in this historical
record are superseded by [automatic OCPP setup and native control](OCPP-SETUP.md).
The validation counts below describe this earlier review and remain unchanged.

Correction from the subsequent Mitsubishi review (2026-09-24): the compressor
change below used an outdated fixture assumption. The current Pill MQTT
publisher sends actual booleans with `unit:"boolean"`, not `null`. Rejecting that
format hid working activity reports. Current decoding now matches the publisher,
and reviewed provisional diagnostic values can be recorded/charted without
becoming control or learning evidence. See [garage adapter](../garage-adapter.md#electrical-accounting).

Fold styling follow-up (2026-09-24): removed the blanket open-summary tint and
inset stripes introduced in this review. Open disclosure arrows now use the theme
accent; closed native markers use the same muted color as custom chevrons. Arrow
direction, component borders, hover/focus treatment and fold behavior are retained.
Validation: 118 theme/equipment/provider/Garage UI tests passed; the production
build and `node scripts/browser-garage-learning-smoke.js` passed. Light/dark
screenshots were reviewed at mobile and desktop widths; the browser check covers
320, 390 and 1440 pixels. Its outdated Mitsubishi fallback wording assertion now
checks the current inline status and the existing explanation in its popover.

Reviewed the observations from `f017684f70` against the audited `ee74801` baseline.
All implementation and validation uses offline fixtures; no household device,
private configuration, export or broker was opened or operated.

| Request | Current result |
| --- | --- |
| External room-temperature UI | Separate saved room target, native pump setting, pump interpreted indoor reading and acknowledged supplied temperature. Explain pending activation and sensor choice in the relevant details. |
| Heating control layout | Home and Garage share heating/pause-control structure and terminology; existing control features are preserved. |
| Learning detail parity | Garage rows now expose equations, assumptions, eligibility, limits and reconstruction requirements alongside Home's detailed learning explanations. |
| Sensor replacement | Remove the global model-evidence/comfort reset. Preserve coefficients, validation, episodes and unaffected measurements; mask the affected sensor while settling and break thermal fitting across the boundary. Shared styled confirmation for sensor, pairing and heating actions. |
| Pump compressor unavailable | Accept the actual Pill boolean wire unit. Charts require qualified reports; the captured provisional firmware fixture cannot establish compressor history. Unsupported/stale compressor frequency stays unknown instead of being inferred from electrical power or requested mode. |
| Garage local temperatures | Keep a full Shelly RPC response when an unrelated partial notification races it, preserving newer per-component values. Retry status immediately after authenticated identity is established. Do not extend source freshness or infer a hardware fault from offline evidence. |
| Added charging energy | Use the recorded plugged-in connection total. Fresh vehicle charge references, charging completion and ready-by do not reset it; confirmed disconnection does. |
| Chart dates and inspection | Two immediate date inputs, same-day selection on start change, bounded end date, visible in inspection. Remove unused zoom toolbar; keep gestures and keyboard navigation. Mobile inspection has a collapsible, scrollable legend. |
| Chart catalogue and styling | Preserve Garage rear on the right axis in All temperatures; thinner temperature curves, square left-axis markers and separate legend groups. Use native Garage compressor shading and interpreted indoor/external-feed series with bounded coverage. |
| Charging cost comparison | Select Charger 1, Charger 2 or their total without mixing their per-device coverage. |
| Caravan dehumidifier | BLU temperature hysteresis off at or below 1 °C / on at or above 2 °C. Fresh BLU/appliance temperature within 4 °C and humidity within 20 percentage points gate caravan history and automatic starts. Missing room evidence requests OFF only for an appliance previously managed in this runtime. Show temperature control and unknown/location states. |
| Database export | Separate server-local save and browser download after Meter accuracy checks. Both use UTC timestamped single-file SQLite snapshots. Online backup incorporates committed WAL contents; only the private copy switches to DELETE journal mode. Server destination is configured, defaulting to the server account’s home folder. |
| Caravan topics and order | Use `stmq/garage/caravan_air`, identify Shelly as the source and place the dehumidifier between air and energy. Update the generated BLU bridge contract together. |
| Dashboard folds | Clicking Home Energy closes open folds; open arrows use the theme accent. The added header tint and inset stripes were removed. Saved settings and form drafts are unchanged. |
| Outdoor source | FMI first, Open-Meteo backup. Exclude H66 outdoor from selection, learning, recorder history and right-axis weather. |
| Storage review | Retain original measurements, coverage, replay inputs, immutable corrections and original assessments for their different semantics. Derive chart curves, shading, coefficients, powers and comparisons on demand; add no chart-summary tables, duplicate polls, backfills or deletion passes. |
| Floor valve guidance | MQTT inventory uses concise device state. Put thermostat topology, commissioning, local expiry/auto-off and restoration limitations with Home heating and the installation guide. |
| Easee local access | Prefer authenticated native OCPP charger electrical telemetry, falling back to cloud. Identify transport per data source. Equalizer and native schedule ownership/readback remain cloud capabilities; do not replace those guarantees with guessed OCPP profile semantics. |

## Current contract and deliberate limits

Home learning is now `committed-house-v13-scoped-sensor-changes`. An incompatible
Home journal/checkpoint requires an intentional fresh development database; no
migration, old interpreter, compatibility decoder or automatic erasure is added.
The current SQLite schema, same-version backup/restart, immutable source events,
reversal/replay and transactional publication remain supported. Read-only import
of the two specified v0.7.5 CSV formats remains the historical import boundary.

Local OCPP requires explicit installation commissioning, a private password and
permitted authorization tags. The native cloud scheduler remains because local
OCPP profiles do not supply the existing schedule ownership/readback contract.
No OCPP control/profile migration, automatic device commissioning or assertion of
household firmware behavior is included. See [setup and limits](../charging-easee.md#direct-local-ocpp-telemetry-firmware-344-or-later).
The BLU publisher must be regenerated/reinstalled with the new topic contract;
there is no retired-topic alias. Temperature agreement supports the caravan
association but cannot physically prove that two devices share a room.
The dehumidifier bridge must supply its own actual temperature/humidity in a
complete snapshot; it must not copy BLU values. The demand/association latch is
deliberately transient: startup in the 1–2 °C band starts with OFF demand, and an
appliance first seen away from the caravan receives no automatic command.
Master authority, live subscriptions and fresh appliance readback gate every
write. Offline appliances cannot be switched or confirmed. The host policy does
not replace native appliance protection. Matching repeated commands are limited
to one attempt per 30 seconds; a change to OFF after confirmed ON is immediate.
Garage probe freshness remains 120 seconds, with 30-second polling. The protocol
fix preserves relay packet-order fencing while accepting independent probe
updates from overlapping snapshots. Neither these tests nor the Pill fixture
establish physical device health or prove that the hardware needs replacement.

## Validation

All checks use synthetic observations, temporary databases and isolated local
services. They do not establish household device health or commissioning.

| Command/check | Result |
| --- | --- |
| `npm test` | 2,774 passed; zero failures, skips or cancellations. |
| `npm run test:extended` | 9 passed; zero failures or skips. Includes isolated MQTT and actual local SSH/SQLite replication. |
| `npm run build -- --configLoader native` | Production bundle built successfully. Vite retains its existing large-chunk advisory. |
| `node scripts/browser-chart-smoke.js <isolated-Firefox-BiDi-WebSocket-URL>` | Passed date/range selection, inspection, gestures/fullscreen, mobile legends/layout, timing comparisons, export and provider/manual-control checks. |
| `node scripts/browser-garage-learning-smoke.js` | Passed at 320, 390 and 1440 pixels in light/dark themes; screenshots inspected. |
| `node scripts/browser-sensors-smoke.js <isolated-Chrome-DevTools-URL>` | Passed sensor availability, scoped changes, styled confirmations and layout checks. |
| `node --test test/equipment-ui.test.js` | 22 passed after the final caravan help-text adjustment; slave/authority explanations remain visible. |
| `git diff --check` | Passed. |

The normal test suite includes OCPP authentication, freshness, authority loss,
durable transaction retries, configuration replies and transport handoff;
WAL-inclusive single-file export, authorization, slave reader lifetime and concurrent
export rejection; and acquisition, scoped sensor correction, history coverage and
dehumidifier hysteresis regressions. A real firmware 344 charger, Pill and caravan
appliance were not exercised.
