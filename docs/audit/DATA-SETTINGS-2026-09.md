# Data & settings review — 24 September 2026

| Request | Result |
| --- | --- |
| Keep four main data categories | Electricity consumption, Electricity prices, Vehicle telemetry, Main temperatures & Weather, in that order. Categories use configured sources; sparse/offline fixtures do not invent live connections. |
| Match physical charger capabilities | Easee retains phase currents/voltages, total active power and calculated phase energy. Shelly exposes native L1–L3 current, voltage and active power, total power/counter and session energy. The official Shelly manual documents total energy only; native total-meter interval recording and finalized session checks remain separate. TeslaMate supplies vehicle evidence only. |
| Make charger connection setup coherent | The local connection and charging-control fold sits immediately beneath the Easee OCPP introduction, before the readings. Its copy separates setup, cloud measurement backup and charging authorization. It contains no project-name or property-reading references. A ready setup announces its next connection check, not a new setup attempt. |
| Restore MQTT ownership of connections | BMW and Tesla connection cards, MQTT topics and packet diagnostics appear in the MQTT Vehicles group. Open connection cards and packet disclosures survive status refreshes. Shelly EVSE remains in Garage. |
| Show vehicle feeds directly | Each configured vehicle appears directly in Vehicle telemetry with its provider, status, report time and feed description. No nested vehicle or Source details disclosure is required. BMW source timestamps and TeslaMate first-receipt timestamps are described accurately. Quiet vehicles do not invent a disconnection; explicit stale/invalid feeds remain actionable. |
| Keep device details consistent | Connection cards share identity/source, status and report time, then a purpose introduction, optional check results, grouped topics and packet diagnostics. Temperatures and forecasts retain separate reading groups within their shared category. |

The obsolete placement of vehicle connection diagnostics under Vehicle telemetry,
the detached OCPP setup fold, stale TeslaMate charger documentation and total-only
Shelly capability catalogue are removed. Current temperature freshness, forecast
coverage, source fallback, OCPP setup actions and charger controls remain supported.
New live Shelly fields preserve physical phase mapping, source/receipt clocks and
unavailable states. They do not create history channels, synthetic phase-energy
counters or additional contributions to the learning model. No compatibility
alias, configuration translation, schema migration or state conversion was added.

Validation uses synthetic fixtures and isolated localhost services. No private
household configuration, live household services or physical devices are used.

## Validation

- `npm test`: 2,932 tests passed, zero failures, cancellations or skips, against
  the final applied repository changes with isolated localhost services enabled.
- `npm run build`: passed; Vite retains its existing large-bundle advisory.
- `node scripts/browser-equipment-smoke.js`: passed with no browser exceptions.
  Covers flat vehicle feed descriptions, MQTT connection placement, OCPP fold
  placement/keyboard access/refresh persistence, complete/partial/stale/disabled
  Shelly readings, summary freshness and separate control commissioning.
  Desktop and 390/320 px captures were visually reviewed; the existing five
  responsive equipment widths also pass.
- Full chart-smoke expectations were updated; the full chart smoke was not run.
- `git diff --check`: passed. The repository pre-commit hook checks the final
  staged paths for prohibited private files and credential patterns.
