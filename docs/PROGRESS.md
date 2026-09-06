# ST-MQ implementation progress

Authoritative brief: `CODEX/ST-MQ-Codex-handoff.md` (6 September 2026).
Baseline: `8c701d6`, v0.7.5, branch `H66`. The pre-existing change to
`data/options.json` and supplied CSVs are owner data and must be preserved.

## Reviewable stages

1. **Offline safety and data foundation.** Default simulated/shadow startup,
   an explicit legacy live gate, deterministic Node tests, versioned SQLite,
   bounded idempotent CSV import, provenance, quality checks and backup/export.
2. **Verified semantics and conservative decisions.** Effective-dated all-in
   prices, Helsinki calendar rules, read-only H66 decoding, comfort/recovery
   protection, independent DHWR recency, versioned incremental learning.
3. **Working application.** One backend owns plans, simulated commands and
   persistent state; an authenticated monitoring interface exposes observations,
   requested/actual state, learning health and timed normal overrides.
4. **Evidence and packaging.** Historical import benchmark, restart/outage and
   end-to-end checks, standalone and ARM64 add-on build paths and operating docs.

## Scope and evidence limits

Development starts offline. No deployment, external automation messages or live
heat-pump writes are authorized. The existing controller is retained for a
separately authorized migration. A shadow plan is not proof of bill savings.
The house's learned comfort reference, contract charges/effective dates, installed H66
register scaling and actual equipment behavior remain unverified. No battery
dispatch or assumed battery savings enter the controller.

## Inspection

- No repository `AGENTS.md` or existing automated tests were found.
- Legacy scheduler starts the MQTT publisher immediately and periodically spawns
  separate acquisition/build/server processes.
- DHWR uses the handoff's Berlin daytime window and `heaton60`, `heaton15`
  sequence; its last-pulse timestamp currently disappears on restart.
- Easee already uses the replacement `/state/{id}/observations` endpoint.
- Local Node is v22.19.0; `node:sqlite` works (experimental warning on Node 22).
- Current configuration has connections/geolocation but no house comfort target.
- The legacy Vite build watches indefinitely; production builds need a finite
  build and must not embed historical household CSVs into browser assets.

Stage outcomes and validation are appended as implementation completes.

## Accepted owner steering

The indoor reference is to be inferred from the temperature achieved during
sustained normal operation under the house's existing knobs. Default preferred
drop: **1 °C**. Learn a stable reference from credible occupied normal-operation
plateaus; hold it through setbacks, recovery and temporary preheating. Do not
require the owner to enter a target, or ratchet the reference down with cooling.

## Implemented and validated, 6 September 2026

- **Data foundation:** committed as `8329d2f`. Streaming CSV import with source
  digest/row provenance, quality flags, interruption recovery, bounded queries,
  manual counters/annotations, CSV export and SQLite backup/restore.
- **Domain/control foundation:** committed as `e636585`. Explicit dated price
  components and Helsinki tariffs/DST; read-only H66 decoding; soft comfort cost,
  severe-deviation fallback, recovery reserve and conservative schedule evaluator;
  stable reference inference and bounded chronological learning/checkpoints.
- **Integrated offline application:** committed as `36fdd96`. One backend owns decisions and simulated
  execution, SQLite state, authenticated HTTP interface and the revised chart.
  Timed overrides and DHWR recency survive restart. Monitoring and shadow never
  issue commands. Active mode operates only the simulator. The legacy publisher
  now fails before reading configuration unless its separate live gate is set.
- **Packaging:** Node 22 Alpine container built locally on x86_64; container smoke
  verifies startup, built UI, persistent override and restart with networking
  disabled and temporary `/data`. Both `aarch64`/`amd64` are declared; multiarch CI
  build is added but has not been run remotely. No HA deployment occurred.
- **Dependencies:** compatible lockfile updates fixed the audit's 7 high / 1
  critical findings. `npm audit fix` finished with **0 reported vulnerabilities**;
  clean container installs also report zero. No major-version forcing was used.
- **UI:** Firefox 155 headless WebDriver BiDi verified rendered backend data,
  chart, setting changes, timed override, desktop/mobile layouts and no browser
  console errors. Screenshots are local ignored artifacts in `var/`.

### Actual historical-data benchmark

| Check | Measured result |
| --- | --- |
| ST-MQ CSV | 56,980 source rows; no rejected source records |
| Easee CSV | 287,585 source rows; no rejected source records |
| Normalized observations | 2,010,410 |
| Import wall time / maximum RSS | 20.01 s / 109,024 KiB (106.5 MiB) |
| Repeat import | Both SHA-256 digests skipped; no duplicates |
| Dated handoff counter observations | 84 |
| Background reconstruction | 56,980 ST-MQ rows in 14.58 s total; at most 768 learned samples retained |
| Application readiness during reconstruction | 205 ms |
| Process RSS peak including workers | 127.8 MiB |
| Largest sampled event-loop delay | 186 ms, including initial startup |
| Ordinary restart | 42 ms readiness; 0 historical rows reprocessed |
| Ordinary restart RSS / sampled delay | 86.7 MiB / 23 ms |

These are measurements from the available x86_64 host with Node v22.19.0, not Pi
performance claims. The built x86 container ran Node v22.23.2. The import preserves
anomalous values with quality flags; zero rejected *source records* does not mean
zero anomalous observations. Local imported DB: `var/st-mq.sqlite` (ignored).

### What the learning evidence establishes

The bounded replay accepted 4 candidate thermal models and rejected 182 refits.
The most recent candidate's chronological error was about 0.228 °C/h, worse than
temperature persistence at about 0.168 °C/h; it was rejected. The retained older
model is stale for present dispatch. Therefore this stage establishes application
behavior and conservative rejection, **not a production-ready learned optimizer**.

The replay also identified a provisional historical normal-temperature reference
of 22.9 °C, last updated in summer 2025. This is not installed as the current house
target: passive/solar summer gains and later knob/settings changes still need
separation from heat-pump-driven equilibrium. Live baseline reconciliation is an
explicit remaining step. No savings are inferred by replaying altered commands
against unchanged electricity consumption.

### Remaining implementation stages

1. Migrate existing market/weather/SmartThings/Easee acquisition into the backend
   with protocol fixtures, issued-forecast persistence, timestamp/freshness
   validation, token refresh and outage recovery. The legacy scripts remain
   available but are not launched by default; no live providers were queried.
2. Add compact effective-dated electricity-contract setup and wire the tested
   all-in pricing module to actual provider intervals. Current UI prices are
   explicitly simulated; no unverified tax defaults or seasonal switch exist.
3. Reconcile the inferred comfort reference with contemporary occupied heating
   behavior and distinguish warm passive plateaus. Improve thermal/energy models
   on chronological holdouts; do not require heat-pump metering as a prerequisite
   for all further work. The first experimental evaluator currently requires
   verified energy response and cannot dispatch economically from these CSVs alone.
4. Add verified actual-state/readback ingestion and incremental online learning
   for the real plant. Current online learning covers the simulator; imported
   history rebuild runs independently. Plain H66 MQTT observations preserve their
   unknown source time and unverified scaling. Installed hardware is unconfirmed.
5. Verify auxiliary/recovery attribution, hygiene completion, panel changes,
   device-side failure behavior, setting ownership/expiry and bounded H66 writes
   before implementing/authorizing a physical executor. No such writes are enabled.
6. Add return-aware away behavior, richer planned/actual signal history, bill
   reporting and appropriate retention after useful data volume is measured.
7. Run ARM64 image/runtime checks and a representative Pi soak test; then assess
   shadow prediction quality before any separately authorized live deployment.

### Repeatable validation

```sh
npm test
npm run build
node scripts/history.js import --db var/st-mq.sqlite
node scripts/benchmark-history.js var/st-mq.sqlite
docker build -t st-mq:development .
docker run --rm --network none --tmpfs /data st-mq:development node scripts/smoke-container.js
```

The automated suite covers unit, persistence, API and entry-point integration;
**68 automated tests pass**, in addition to the browser and container smoke checks.
browser smoke is an additional optional script requiring a separately started
isolated Firefox BiDi instance and simulated application. In this Codex sandbox,
subprocess/loopback tests required normal subprocess/network-listener support;
the full suite was run with the approved test-command escalation.
