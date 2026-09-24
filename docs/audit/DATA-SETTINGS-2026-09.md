# Data & settings review — 24 September 2026

| Request | Result |
| --- | --- |
| Restore four main data categories | Electricity consumption, Electricity prices, Vehicle telemetry, Main temperatures & Weather, in that order. Categories use configured sources; sparse/offline fixtures do not invent live connections. |
| Explain where readings come from | Every category starts with a concise introduction. Consumption retains Easee cloud, Easee OCPP and Shelly EVSE sections. Temperatures and forecasts retain separate reading groups within one category. |
| Remove the redundant local-connection overview row | Setup and cloud-backup details are folded within Easee OCPP. Local setup readiness remains separate from measurement health and native control ownership. |
| Move BMW and Tesla out of MQTT | Their existing named feed cards, reception status, timestamps, topics and packet diagnostics appear only under Vehicle telemetry. Quiet vehicle readings do not invent a disconnection; explicit stale/invalid feeds remain actionable. |
| Include the Shelly charger in MQTT | Charger 2 appears in Garage with its actual subscription and RPC routes, transport health, receipt time and commissioning/device status. |
| Keep device details consistent | Cards share identity/source, status and report time, then a purpose introduction, optional check results, grouped topics and folded packet diagnostics. Open cards survive status refreshes. |

The separate weather overview item, duplicate vehicle placement and local setup
summary row are removed. Current temperature freshness, forecast coverage,
source fallback, OCPP setup actions and charger controls remain supported.
No compatibility alias, configuration translation, schema migration or persisted
state conversion was introduced. MQTT diagnostics are current runtime status;
they do not change control authority, measurement timestamps or stored telemetry.

Validation uses synthetic fixtures and isolated localhost services. No private
household configuration, live household services or physical devices were used.

## Validation

- `npm test`: 2,922 tests passed, zero failures, skips or cancellations.
- `npm run build`: passed; Vite retains its existing large-bundle advisory.
- `node scripts/browser-equipment-smoke.js`: passed with no browser exceptions.
  Covers the four categories, introductory text, vehicle relocation, Shelly MQTT
  placement, temperatures-before-forecast order as new groups arrive, preserved
  open disclosures and five responsive widths. Expanded desktop (1440 px) and
  mobile (390 px) captures were visually reviewed for wrapping and overflow.
- After the final vehicle diagnostic-copy cleanup, the 37 equipment tests and
  the production build/browser checks were rerun successfully.
- `git diff --check`: passed. The repository pre-commit hook checks the final
  staged paths for prohibited private files and credential patterns.
