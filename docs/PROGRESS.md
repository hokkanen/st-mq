# ST-MQ implementation progress

Current development validation and reproducible commands are recorded in
[Development validation](development-validation.md). The dated results below
describe historical checkpoints; use [README](../README.md) and the feature
guides for current behavior.

## Current implementation, 7 September 2026 — 0.9.0

The owner authorized the full active controller and UI implementation after the
planning discussion. The dated sections below describe earlier releases and are
retained as history; their former "active simulator only" restriction is superseded.
Validation completed on 8 September 2026: all **376 tests passed** in the
applied checkout, the production build succeeded, and `git diff --check`
passed. Synthetic Chrome checks covered desktop/mobile rendering and a
timed H66 write, readback and restoration through the application API.

Current behavior and evidence limits are documented in
[Learning and control](learning-and-control.md) and [setup](../DOCS.md).
Development uses synthetic data and mocked device transports; installed H66 and
relay behavior has not been tested against the household equipment.

The implementation connects live observations, adaptive thermal fitting, bounded
preheat/reduction plans, execution readback, recovery assessment and historical
learning metrics. Native settings are captured before overriding and restored
with persistent obligations. A missing gateway retains conservative relay control.


Authoritative brief: `CODEX/ST-MQ-Codex-handoff.md` (6 September 2026).
Baseline: `8c701d6`, v0.7.5, branch `H66`.
Private configuration lives outside Git in `~/.config/st-mq/secrets.json`.
Supplied CSVs are owner data and must be preserved.

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

### Remaining implementation stages after the initial offline release

1. Commission real API access and source freshness for the tested provider/contract
   stage below. Offline fixtures
   do not establish access to the household's accounts or current devices.
2. Reconcile the inferred comfort reference with contemporary occupied heating
   behavior. New candidates exclude unsupported warm-weather plateaus, but the
   current house reference remains unverified. Improve thermal/energy models
   on chronological holdouts; do not require heat-pump metering as a prerequisite
   for all further work. The first experimental evaluator currently requires
   verified energy response and cannot dispatch economically from these CSVs alone.
3. Add verified actual-state/readback ingestion and incremental online learning
   for the real plant. Current online learning covers the simulator; imported
   history rebuild runs independently. Plain H66 MQTT observations preserve their
   unknown source time and unverified scaling. Installed hardware is unconfirmed.
4. Verify auxiliary/recovery attribution, hygiene completion, panel changes,
   device-side failure behavior, setting ownership/expiry and bounded H66 writes
   before implementing/authorizing a physical executor. No such writes are enabled.
5. Add return-aware away behavior, richer planned/actual signal history, bill
   reporting and appropriate retention after useful data volume is measured.
6. Run ARM64 image/runtime checks and a representative Pi soak test; then assess
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
**68 automated tests passed in the initial offline release**, in addition to its
browser and container smoke checks. These counts and the benchmark above predate
the provider stage below.
Browser smoke is an additional optional script requiring a separately started
isolated Firefox BiDi instance and simulated application. In this Codex sandbox,
subprocess/loopback tests required normal subprocess/network-listener support;
the full suite was run with the approved test-command escalation.

## Provider and contract stage, 6 September 2026 — offline integration verified

- **Read-only provider path:** `STMQ_INPUT=providers` / add-on
  `controller.input: providers` reuses existing connections. ENTSO-E market and
  the original forecast acquisition run hourly; optional Easee device
  acquisition runs every five minutes independently. Durable cache timestamps
  preserve age across failures and restart. Physical writes remain disabled.
- **Protocol semantics:** offline fixtures cover ENTSO-E A01/A03 curves,
  quarter-hour/hourly resolution, 92/100-quarter DST days, missing values,
  duplicates/revisions and ex-VAT normalization. Weather valid time is distinct
  from fetch time; unknown forecast issuance stays explicit. The Easee
  adapter validates timestamps/units and preserves uncertainty in current snapshots.
  Easee authentication renewal and secret persistence are isolated from observations
  and browser responses; they do not alter charger settings.
- **Compact contract setup:** dated margin/tax excluding VAT, VAT percentage and
  supplied transfer tariff feed backend all-in pricing. There are no unverified
  tax defaults, automatic seasonal switches or invented historical charges.
- **Reference learning:** unsupported warm-weather plateaus are excluded from
  new comfort-reference candidates. The earlier 22.9 °C historical result belongs
  to the initial replay above and is not evidence of a commissioned house target.
- **Elering limitation:** documentation did not resolve the endpoint's interval-end
  and VAT semantics. Automatic fallback remains unavailable until those semantics
  are vetted in developer configuration; ordinary setup adds no engineering knobs.
- **Validation:** all **145 automated tests** pass. Firefox browser checks pass
  for dated rates/VAT conversion, settings, overrides, backend data, charts and
  desktop/mobile layout, with no console errors. The rebuilt x86 container
  (`7543d04f6119`, Node v22.23.2) passes its network-disabled startup/UI/restart smoke
  test. No user credentials were used, no live household APIs or devices were
  queried, and no Pi/Home Assistant runtime claim is made.
- **Review regressions:** a future sensor timestamp cannot pin the current value;
  UI and control share the 30-minute temperature freshness boundary; converted
  Fahrenheit remains usable provenance. Outages retain original observation ages.
  Five-minute polling cannot bypass a longer persisted retry backoff. SQLite
  rollback also restores the in-memory observation view. Rejected HTTP responses
  cancel their unread bodies. Each retained forecast block expires independently;
  neither a newer envelope nor a restart makes it fresh again. Chart gaps and
  terminal interval ends follow the backend's actual durations.
- **Focused commits:** `d284ea4` tightens baseline inference and chronological
  validation; `2ef334c` adds bounded read-only adapters, fixtures and schema-v2
  immutable provider snapshots. The following integration commit connects polling,
  dated pricing, quality-aware startup/UI and the regression tests.

### Updated checkpoint replay and restart

The incompatible old reference checkpoint rebuilt once from the same 56,980
historical ST-MQ rows. Replay completed in **5.56 s**, with **26 ms** application
readiness, **141.4 MiB** peak process RSS including workers and **8.6 ms** largest
sampled event-loop delay on this x86 development host. It retained at most 768
samples. Ordinary restart was ready in **21 ms**, processed **0** old rows, peaked
at **99.7 MiB** RSS and sampled **2.1 ms** worst loop delay. These are local run
measurements, not Raspberry Pi or long-term soak results.

Stricter learning accepted 6 candidate models and rejected 217. The latest
candidate's chronological error was **0.2235 °C/h**, worse than persistence at
**0.1601 °C/h**, so it was rejected; the retained May 2025 model is stale. The
24-hour train/validation embargo and invalid-reading continuity barriers prevent
nearby or missing observations from creating misleading validation evidence.

The new provisional reference is **21.6 °C**, supported by December 2024 occupied
normal-operation plateaus with mean outside temperature **3.17 °C**. It is labelled
a cool-weather heating-demand proxy, not verified continuous compressor activity
or a commissioned current-house target. The default preferred drop remains **1 °C**.
The former passive-summer reference is no longer retained by compatible checkpoints.
No household bill savings or validated contemporary energy response are established.

Primary-source verification and fixture limitations are recorded in
`test/fixtures/providers-README.md`. Documentation/schema inspection establishes
the implemented protocol interpretation, not successful live API commissioning.
That provider-stage checkpoint used version 0.8.0.

## Interface upgrade — v0.8.1, 7 September 2026

The private dashboard now uses **Home Energy**, with the promotional title and
footer removed. A green dark theme is the default; a visible theme button restores
the green/white light theme and remembers the choice in the browser. The small
external theme script applies that choice before CSS paints, under the existing
content security policy. Production script/style filenames include content hashes
so an upgrade loads assets matching its new HTML.

The combined history chart moves directly below the current readings and restores
the multi-signal view requested from v0.7.5:

- Inclusive start/end selectors use Finnish calendar boundaries, defaulting to
  today from 00:00 to the next midnight. Quick buttons select Today, Yesterday +
  today, or Today + tomorrow. Forecasts and known market prices are clipped to
  that range, including a tomorrow-only selection; DST days retain their real
  duration.
- The left-axis selector shows estimated combined property/charger power,
  individual phase currents, or heating integral. Charger series are fills.
  Legend entries change with the selected left-axis group; temperatures and
  prices remain on the right. The power estimate uses all three contemporaneous
  phase currents at nominal 230 V, never treats current snapshots as energy,
  and is identified as an estimate in the interface.
- All-in price is visible by default. Spot price remains separate and initially
  hidden; historical all-in values require the appropriate dated contract rates.
  Outdoor forecasts are dashed and stay distinct from observations.
- Shading order is Heat Off, Aux Heat, DHWR. DHWR starts hidden and retains the
  ten-minute historical pulse-request interpretation. Heat Off means requested
  reduction rather than measured compressor activity. Aux Heat requires verified
  timestamped output readings; runtime-counter dates do not invent historical
  episodes. Integral and auxiliary history await suitable H66 observations.

`GET /api/chart` combines the selected series and shading in one authenticated,
read-only response. It accepts at most 3,660 calendar days and 100–2,000 display
time buckets per series. Every selected source row contributes to first/last,
extrema and missing-data summaries; the API does not truncate long histories to
their earliest rows. Dense shading is summarized by recorded activity per display
interval. File-backed SQLite chart queries run in a background worker. The browser
caches recent selections and cancels obsolete requests during rapid navigation.
The existing raw `/api/history` endpoint retains its 31-day/5,000-row bounds.

This stage changes display and read-only historical access. It enables no physical
control transport, invokes no providers from chart requests, and preserves the
owner's options and supplied data.

### Interface validation

The complete automated suite passes **174 tests** at this checkpoint. Isolated
Firefox checks also pass for populated charts, dark/light persistence, the three
left-axis groups, shared legend preferences, rapid date changes, tomorrow-only
forecasts, mobile portrait/landscape layout, settings, overrides and dated contract
entry. The synthetic fixture includes all three activity layers; it is confined
to the test script and is never seeded into the household database.

The production build passes. The amd64 image `61b22e47ab09` (Node 22.23.2)
passes its network-disabled startup, built theme asset, chart API and restart
smoke check with temporary storage. No household providers or devices were
contacted, and no ARM64 runtime validation is claimed.

A final regression verifies that importing CSVs after native observations cannot
change scalar source precedence when the selected range crosses the compact-query
threshold. Native scalar readings take priority in both query paths; duplicate
ordering remains consistent for temperatures, prices and individual phases.

The same supplied historical data was compared with the actual v0.7.5 chart and
data-processing code from `8c701d6`, using Firefox at 1440 × 1000 and the same
installed Chart.js 4.5.0. Times include data access, processing and chart update;
they exclude the old chart's additional approximately one-second animation.

| Selected history | v0.7.5 cold | New cold | v0.7.5 cached return | New cached return |
| --- | ---: | ---: | ---: | ---: |
| One day | 1,909 ms | 205 ms | 175 ms | 15 ms |
| Two days | 1,777 ms | 181 ms | 322 ms | 20 ms |
| One month | 2,046 ms | 508 ms | 468 ms | 49 ms |
| Entire supplied history | 2,229 ms | 6,436 ms | 887 ms | 114 ms |

Cached returns are medians of three visits after navigating to a different day.
Cold visits use a fresh browser module cache and chart worker; operating-system
file caches are uncontrolled. Historical spot and DHWR were enabled in the new
chart for this comparison; missing household contract rates were not invented.
The old cold request transferred about 14 MB of CSVs; corresponding new chart
responses were 24 KB, 46 KB and 273 KB. These desktop loopback measurements do
not establish Android, Raspberry Pi or remote-network timing.

The first uncached request for the entire 6 December 2023–6 September 2026 archive
remains slower than v0.7.5. Its read-only worker scans all 2,010,410 observations,
using compact original import rows where possible, and returns approximately
632 KiB of chart data. The measured process peak was 178 MiB RSS with a 22 ms
largest sampled main-loop delay. Reopening that range is faster from cache, but
the cold full-archive result does not meet the v0.7.5 timing target. The common
day, two-day and month selections do.

Reproduce the chart browser and read-only history comparisons with
`scripts/browser-chart-smoke.js`, `scripts/benchmark-chart.js` and
`scripts/benchmark-legacy-chart.js`. The browser smoke script expects an isolated
Firefox BiDi listener on port 39124 and creates its own temporary simulation.
The legacy comparison starts a separate Firefox instance and requires the
supplied `CODEX` CSVs and their already-imported `var/st-mq.sqlite` database.
Use `--full-only` for its separate full-archive comparison.

## Direct provider fallbacks and live verification — v0.8.2, 7 September 2026

ENTSO-E remains the primary price provider. Its fallback now calls Elering's own
endpoint directly, without a third-party relay or extra household configuration.
The adapters preserve EUR/MWh-to-c/kWh conversion, ex-VAT meaning, negative prices,
actual market interval lengths and the October 2025 quarter-hour transition.
Missing current prices, internal gaps or truncated coverage of today trigger the
fallback. Tomorrow's prices not yet being published is a normal limited horizon.
An explicit bidding zone is never silently replaced by another country's prices.

FMI is now the primary forecast and outdoor-temperature provider. Forecasts use
the HARMONIE/MEPS hourly temperature points, recording publication time separately
from model analysis time. Observations select the nearest fresh weather station
within 50 km of the configured location. The two routes fail over independently
to the original backup's forecast and current-weather endpoints (that integration
has since been removed; see the replacement note below). Regional values are
labelled as such; a forecast is never recorded as an observed house temperature.

The live test caught an FMI integration defect that the initial public city-name
probe did not reveal: the observation query silently ignored `latlon` and returned
an empty collection. The corrected adapter uses the observation endpoint's
documented `bbox`, bounds response size/station count, and filters station distance
after decoding. Configured-location verification then succeeded. Regression tests
now distinguish the observation request from the forecast request, which does
accept `latlon`.

Market and forecast polls remain hourly, outdoor observations run every ten
minutes, and Easee polls remain every five minutes. Cached values keep
their source timestamps across failures and restart. FMI recovery restores its
primary role even when the backup's calculation timestamp is slightly newer.
Provider errors are sanitized; backoff survives restart and honors bounded
`Retry-After`. Access denials and rate-limit delays are shared between a provider's
forecast and current-temperature routes. A missing station alone does not disable
a working forecast. The interface names selected providers and shows backup use,
primary failure and the next retry.

### Validation checkpoint

All **218 offline tests** pass, including the opt-in live runner's route allowlist,
serialization, request budget, authentication limits, redaction and cooldowns.
The production UI build and Firefox desktop/mobile checks pass, including actual
source labels, backup status, date navigation and settings/contract forms. The
amd64 image `96f9e2c2522d` (Node 22.23.2) passes startup/restart plus a complete
synthetic provider-to-storage/status/chart check with networking disabled. The
live-test files are included in the image; add-on configuration and private-cache
paths have dedicated tests. ARM64/Pi runtime validation remains a separate target.

The owner explicitly authorized live API-key use for this stage. Direct checks
used the existing options in memory and produced these results:

| Live service | Observed result |
| --- | --- |
| ENTSO-E | Configured key returned 100 valid Finnish price intervals covering now. |
| Elering | Direct public endpoint returned 100 intervals; all overlapping prices matched ENTSO-E within 0.000001 c/kWh. |
| FMI forecast | 48 hourly forecast intervals, with distinct publication/model timestamps. |
| FMI observation | Corrected configured-location query returned a fresh station reading, eight minutes old at verification. |
| Easee | Charger and equalizer access succeeded and returned all six phase values; all were flagged stale, with the oldest about 45 hours old. |

The retired weather integration's live-check rows were removed when its code and
configuration were removed. Those old checks do not verify Open-Meteo.

API access and measurement freshness are separate findings. Easee's endpoint
returns last-reported state; its phase-current event timestamps cannot be replaced
with the time of this successful request. Neither stale fields nor a successful
GET alone establish current device connectivity or fresh power measurements.

The keyed checks required seven read requests and no authentication renewal.
Public FMI/Elering queries also verified their protocols and the corrected
observation path. No live MQTT messages, heating/DHWR/charger commands, household
database writes or options edits were made. Browser and container tests used
isolated synthetic data. No repeated invalid-key attempts or intentional provider
rate-limit tests were performed.

`npm test` remains offline. `npm run test:live` runs the explicitly opted-in live
section, with individual services selectable for a repaired connection. It uses a
private lock and cooldown state and reports failures separately so a backup cannot
hide a broken primary. See [live testing](live-testing.md) for commands, request
bounds, token-cache handling and what a passing check proves.

## Chart appearance and simpler date navigation — 7 September 2026

Each page load now starts in the green dark theme, including browsers with an old
saved light preference. The header toggle changes the current page. Temperature
lines use blue outdoors, green indoors and orange for the garage; price lines use
the thin dotted steps from 0.7.5, with theme-dependent grey for spot and white/black
for all-in price.

The shortcuts now read Yesterday – today, Today, Today – tomorrow, with Today
selected initially. End date starts disabled and follows Start date, so browsing
one historical day requires changing only one date. A labelled checkbox enables
an inclusive end date; unchecking it returns to a single day. Date changes apply
automatically, and Show dates remains available. Shortcuts synchronize both dates
and the checkbox. An end before the start cannot replace the chart; moving Start
date beyond the existing end brings the end forward to keep a valid selection.

Validation: production build and 12 focused chart/theme tests passed. The Firefox
smoke check passed for a day two years ago, checkbox/label activation, invalid
ranges, shortcut order/state, dark-on-reload, rapid date changes, and desktop plus
390px portrait/844px landscape layouts. Existing chart, legend, forecast and form
checks passed using isolated synthetic data. No live provider or equipment calls
were needed.

## Home Assistant configuration and temporary controls — 0.8.3, 7 September 2026

Compared the deployment with 0.7.5 and current official Home Assistant config,
public add-on folder and SSH mount documentation. The old `/share/st-mq` workflow
was intentional. `/share` is retained for imports/exports; the working database is
now in `/config/st-mq` via `addon_config:rw`, visible to Terminal & SSH under
`/addon_configs/<repository-id>_st-mq/st-mq`. Tokens/options remain private. Upgrade
migration snapshots the old database with its committed WAL pages, verifies it,
publishes the result atomically without overwriting a destination, and retains the
original. Supervisor backups use cold mode. Docker pins Node explicitly, so an
old Supervisor injecting an incompatible `BUILD_FROM` cannot replace the base.

Options/schema/translations now describe current features. Removed `temp_to_hours`
and dummy device IDs; optional credential/auth alternatives remain available.
Standalone and add-on configuration both supply permanent settings. Occupied drop
defaults to 1°C; persisted browser settings cannot override options on restart.
The owner's local options file was backed up privately and updated with these
sections; all existing connection settings were preserved and it is not committed.

Every configured monetary value excludes VAT. User-confirmed margin is 0.33 c/kWh;
tax is 2.325 c/kWh, yielding 2.917875 including 25.5% VAT. Full-precision transfer
defaults retain 3.34/1.96 inclusive day/night and 4.17/2.07 seasonal. All components
are configurable and snapshotted by effective date. Existing legacy inclusive
transfer snapshots retain their meaning; unstarted configured future periods can
be corrected/cancelled without rewriting elapsed history. Permanent-setting HTTP
writes are disabled; the dashboard reports active rates, including both VAT bases.

Away/Pause now share a compact Home control card. Finnish local datetimes are
resolved on the server; DST gaps/overlaps require an unambiguous time. Atomic edits,
independent cancellation, restart restoration and exact deadline expiry are
covered. Away excludes the occupied drop penalty and relative comfort constraints,
while costing recovery/auxiliary energy against continuous native operation.
Return requirements apply inside the verified forecast horizon. Poor evidence,
faults and pause still select native normal fallback; no physical transport was
added. MQTT acquisition can now coexist with the online providers.

Validation: **248 offline tests passed**, including VAT/history, future rate
changes, expiry/restart, database migration, H66/provider coexistence and away
cost/recovery behavior. Production frontend build passed. Firefox tests passed in
both Europe/Helsinki and America/Los_Angeles browser timezones, with desktop,
390px portrait and 844px landscape layouts and no console errors. Populated chart
interactions remain responsive; the existing chart and event log were preserved.
The separate compatibility browser script now runs the maintained isolated suite.

The network-disabled AMD64 container check passed the actual image CMD, options
immutability, authentication, public database migration, configured prices/drop,
temporary controls, restart, cold backup/export/restore, restored startup and
direct shared-folder inspection in a second container. Provider fixtures exercised
FMI/Elering plumbing without HTTP access. CI now builds and runs these checks for
both AMD64 and ARM64. Local ARM64 emulation and an actual Supervisor/Pi installation
were unavailable; these results do not claim either was tested. No live provider
requests or physical MQTT/control messages were sent for this upgrade.

## Weather fallback and H66 outdoor priority — 8 September 2026

Replaced the original keyed weather backup with Open-Meteo ICON Seamless and
removed its old token option, schema entry and setup help. Both temperature and
global shortwave radiation forecasts use FMI first and Open-Meteo as fallback.
Missing FMI solar values can use Open-Meteo without replacing available FMI
temperatures; solar-provider provenance stays explicit. Open-Meteo radiation is
averaged over the preceding hour and aligned to that interval in W/m². The API
requires no key for noncommercial use within its free limits.

Current outdoor temperature now prefers fresh H66 register `0007`, then a fresh
nearby FMI station, then an Open-Meteo model estimate. Backup timestamps do not
override source priority. Fresh H66 data regains priority after an outage; an
unavailable or stale H66 sensor allows the weather fallback chain. UI labels
distinguish the house sensor, nearby station and modeled estimate. Weather source
labels and radiation provenance also remain visible in provider details.

Validation: all 394 unit/integration tests and the production build pass. Four
read-only live checks using public Helsinki city coordinates pass: FMI forecast,
FMI current observation, Open-Meteo forecast and Open-Meteo current estimate.
Both providers returned 48 hourly forecast intervals with solar radiation.
Simulated MQTT tests cover H66 priority, staleness, errors, disconnect/reconnect,
retained messages and recovery. Installed H66 hardware is not yet available for
complete physical testing. No physical device commands were sent.

## Heating savings comparison selector — 9 September 2026

The Heating cost card now switches between timing cost saving and model-estimated
saving, remembering the browser's choice. Charging remains a timing comparison;
Fireplace remains a retrospective model estimate. The selector supports keyboard
and touch, retains focus and open details during updates, and uses both themes.

The new heating total reads saved, supported space-heating cycle assessments,
including recovery, and assigns each full cycle to its Finnish completion date.
A cycle can start before the selection. Unfinished, unsupported and corrected
assessments do not contribute; no supported cycles means unavailable, not zero.
This is separate from the rolling €/cycle learning metric, and is not an estimate
for every selected hour. Details show cycle counts and saved uncertainty bounds.
Cycle corrections invalidate the chart cache. Learning semantics, original
observations, frozen forecasts and CSV imports remain unchanged.

Validation: all 755 automated tests and the production build passed. The isolated
Firefox smoke suite exercised both comparison modes, keyboard/touch selection,
refresh/reload persistence, supported positive/zero/negative results, unavailable
history, independent folds, and dark/light layouts from 320 to 1440 px.
