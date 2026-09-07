# ST-MQ

ST-MQ is a local home-energy controller under development for a Raspberry Pi 5
Home Assistant add-on and standalone Linux. The authoritative project brief is
`CODEX/ST-MQ-Codex-handoff.md`; implementation status and remaining work are in
[docs/PROGRESS.md](docs/PROGRESS.md).

Version 0.8.2 provides a tested foundation: SQLite history, conservative
heating decisions, incremental thermal learning, a monitoring dashboard and
read-only H66 acquisition. **Default startup uses simulated devices in shadow
mode. No physical heat-pump command transport is enabled in the new application.**
Read-only market, weather, SmartThings and Easee providers plus dated contract
setup are integrated. ENTSO-E has a direct Elering backup; FMI supplies the primary
weather forecast and outdoor observations, with OpenWeather as backup. Offline
regressions and a separate opt-in live suite verify the provider paths. See the
[progress log](docs/PROGRESS.md) for actual live-check results and remaining limits.
Physical equipment control has not been commissioned.

The comfort reference is inferred from sustained occupied normal-temperature
plateaus under the house's existing controls. The preferred maximum drop defaults
to **1 °C**. References stay fixed during cooling, recovery and preheating. A
missing reference or unreliable model keeps the requested heating mode normal.
A provisional historical reference is not automatically applied to the live house.
Warm-weather plateaus without credible heating evidence are excluded from new
reference candidates, so passive summer warmth does not establish a heating target.

## Run locally

Use Node.js **22.19 or newer** (Node 22 LTS is the container baseline). SQLite is
built into Node; Node 22 emits its experimental-feature warning. No GPU or paid
model service is used.

```sh
npm ci
npm test
npm run build
npm start
```

Open **http://127.0.0.1:1234**. The UI labels simulated readings and example prices.
`node scheduler.js` also starts the safe application unless the separate legacy
live gate is explicitly enabled. Neither default entry point reads standalone
provider credentials. The server serves the completed UI build; it does not
rebuild historical CSVs or run a permanent Vite build watcher.

The Home Energy UI has monitoring, shadow and simulated active modes, combined
history and price/weather outlooks, requested/actual state, stale-data indication, learning
health, explicit occupancy and timed normal-heating overrides. The default 21 °C
**demo** target is confined to simulation, not inferred as the real house's target.
Overrides are persistent; changing one in shadow mode does not operate equipment.
Away mode currently preserves normal fallback; return times are recorded but
return-aware optimization is pending.

For UI development run `npm start` and `npm run dev` in separate terminals. Vite
proxies `/api` to the backend. `npm run preview` alone does not provide the API.

## Using the chart

The interface opens in a green dark theme. The header's **Light theme / Dark
theme** button changes it and remembers the choice in this browser. The chart is
directly below the current readings.

- **Dates:** the default is today, midnight to midnight in **Europe/Helsinki**.
  Start and end dates are inclusive Finnish calendar days, including daylight-saving
  changes. **Show dates** applies the selected range. **Today**, **Yesterday +
  today** and **Today + tomorrow** provide quick navigation. To see tomorrow alone,
  set both dates to tomorrow. Forecasts and known electricity prices appear only
  inside the selected dates; they never extend the horizontal axis automatically.
- **Left axis:** **Total power** shows combined property power as a line and
  charger power as a fill. **Phase currents** shows the three property phase lines
  in amperes with corresponding charger fills. **Heating integral** selects the
  integral instead. Only that group's legend items appear. The power view estimates
  kW as `230 × (L1 + L2 + L3) / 1000` from contemporaneous current readings; it is
  not measured active power, metered energy or heat-pump consumption.
- **Right axis:** indoor, garage and outdoor temperatures and electricity prices
  stay available with every left-axis selection. The dashed outdoor continuation
  is forecast. All-in price is visible initially; **Spot price** is initially
  hidden and excludes VAT and other charges. All-in prices require contract rates
  covering the selected dates; an unavailable series stays empty rather than
  silently substituting spot or present-day charges.
- **Shading:** **Heat Off**, **Aux Heat**, then **DHWR**. Tap legend items to hide
  or show them; DHWR starts hidden. Heat Off represents requested historical
  reduction, not measured compressor stoppage. DHWR marks requested ten-minute
  recirculation pulses. Aux Heat needs verified timestamped auxiliary-output
  observations; dated runtime counters cannot identify individual episodes. H66
  auxiliary/integral history will remain empty until suitable readings exist.

Chart changes affect the display only. Viewing history neither polls providers
nor sends equipment commands. Large ranges use bounded display resolution,
preserving extremes and missing-data breaks; dense shading represents recorded
activity within each display interval. Queries run in a background worker and
recent selections are cached. A newer selection cancels an obsolete request.

## Persistence and historical data

Standalone databases are in `var/`; Home Assistant uses `/data/st-mq/`. Simulation
uses `simulation.sqlite`; real/offline household history uses `st-mq.sqlite`.
Override the directory with `STMQ_DATA_DIR`. These databases and supplied CSVs are
excluded from Git and Docker contexts. The owner's existing `data/options.json`
is preserved and remains governed by the repository's existing git-crypt setup.

```sh
npm run history -- import
npm run history -- summary
npm run history -- tail --follow
npm run history -- export --output /tmp/indoor.csv --signal indoor_temperature
npm run history -- backup --output /tmp/st-mq-backup.sqlite
npm run history -- restore --input /tmp/st-mq-backup.sqlite --db /tmp/restored.sqlite
STMQ_INPUT=offline npm start
```

Import defaults to the two supplied `CODEX` CSVs, with streaming batches,
SHA-256 provenance, interruption recovery and idempotence across file paths.
Importing the same file twice adds no observations. Differently edited source
files retain separate provenance; they are not silently merged into canonical
historical readings. Historical prices stay ex VAT. Missing readings stay null,
zero-current anomalies stay flagged, and commands never become compressor labels.
March–May 2026 is an approximate absence/heating-off annotation excluded from
occupied-model training. All 84 dated handoff counters are preserved; DHW runtime
is not added to compressor runtime.

Backups use SQLite's online backup API. Restore to a new path while the target
application is stopped; validate it before changing the configured path. Keep
backups on separate storage. Schema upgrades run transactionally; newer unknown
schemas are rejected. Raw observation queries are bounded to at most 5,000
observations; `/api/history` limits a request to 31 days. The separate `/api/chart`
endpoint accepts inclusive `start`/`end` calendar dates, `left=power|phases|integral`
and a `points` resolution of 100–2,000 time buckets per series. It accepts at most
3,660 calendar days and summarizes the full selected history into bounded drawing
data. Source history is retained; there
is no automatic deletion policy in this stage. Monitor disk growth and archive
through tested backups/export.

```sh
npm run history -- counter --signal auxiliary_6kw_runtime --value 447 --date 2026-09-06
npm run history -- annotate --kind absence --from 2026-03-01T00:00:00+02:00 --to 2026-06-01T00:00:00+03:00 --note 'Approximate heating-off absence'
node scripts/benchmark-history.js var/st-mq.sqlite
```

## Connections and access

| Variable | Default / purpose |
| --- | --- |
| `STMQ_INPUT` | `simulated`; also `offline`, read-only `mqtt`, or read-only `providers` |
| `STMQ_MODE` | `shadow`; also `monitoring`, or `active` for simulator only |
| `STMQ_DATA_DIR` | `./var`, or `/data/st-mq` in the add-on |
| `STMQ_PORT` | `1234` |
| `STMQ_HOST` | `127.0.0.1`; add-on listens on `0.0.0.0` |
| `STMQ_API_TOKEN` | Required, at least 24 characters, when listening beyond loopback |
| `STMQ_CONFIG` | Existing connection JSON; defaults to `data/options.json`, or `/data/options.json` in add-on |
| `STMQ_H66_DEVICE` | Exact H66 topic prefix; required for `mqtt` input |
| `STMQ_H66_VERIFICATION` | Optional JSON path with verified register scaling/evidence |

Use a trusted local network or an authenticated HTTPS reverse proxy for remote
access. API authentication protects both household data and setting changes;
credentials are never returned in API responses. The browser keeps an entered
API token in session storage for its tab. There is no internet exposure configured
by this project.

Read-only MQTT reuses the existing broker address/user/password and subscribes to
`<device>/HP/+`. There are **no SET publications**. Source timestamps, installed
register scaling and actual device/controller semantics need verification. Plain
H66 payloads lack source timestamps, so their freshness stays unknown rather than
being fabricated from receipt time. Retained/duplicate/invalid messages are
handled explicitly. See [domain semantics](src/domain/README.md).

Start read-only collection with:

```sh
STMQ_INPUT=providers npm start
```

This reuses `geoloc`, `entsoe`, `openweathermap`, `smartthings` and `easee`
connection fields from the existing options JSON. FMI and Elering need no API key
or additional provider configuration. FMI uses the configured latitude/longitude;
Elering uses the market country (FI, EE, LV or LT), or a matching explicit ENTSO-E
bidding zone. SmartThings indoor/garage sensors and Easee acquisition are optional.
The garage is outside heating optimization. Provider input cannot enable physical
active control or publish heating/DHWR commands.

| Data | Primary → backup | Normal collection interval |
| --- | --- | --- |
| Electricity prices | ENTSO-E → Elering's own public API | 1 hour |
| Temperature forecast | FMI HARMONIE → OpenWeather | 1 hour |
| Outdoor temperature | FMI nearby weather station → OpenWeather area estimate | 10 minutes |
| Indoor/garage temperatures | SmartThings | 5 minutes |
| Property/charger currents | Easee | 5 minutes |

These are collection schedules, not guarantees that each provider publishes a new
measurement that often. FMI forecasts use hourly valid times; OpenWeather's
forecast uses three-hour slots. Market prices retain each actual hourly or
quarter-hour delivery interval. Source observations and downloaded forecast/market
snapshots are saved when collected, with source timestamps kept separately from
receipt time.

Market fallback starts on a failed request, missing current price, or incomplete
current-day coverage. Tomorrow being unpublished is normal and does not itself
trigger another request. Elering is contacted directly, with validated currency,
VAT and terminal-interval semantics; no intermediary service is used. Neither
source fills missing prices or extends them past the published horizon. See
[the Elering verification evidence](test/fixtures/market-elering-evidence.md).

Forecast and outdoor observation have independent FMI → OpenWeather fallback
chains. An unavailable weather station therefore does not discard a good FMI
forecast. The outdoor card identifies a **nearby station** or an **area estimate**;
neither is a thermometer at the house. FMI selects the nearest fresh station among
up to three returned candidates within 50 km. With valid configured coordinates,
these sources own outdoor temperature; a SmartThings outdoor sensor does not
replace them. Without coordinates, an existing SmartThings outdoor sensor may
still be collected.

**Data connections** shows the selected provider, **Using backup** when applicable,
and the primary provider's next retry. Requests are bounded and failures back off
per source, respecting rate-limit delays through restarts. One failed primary
cannot cause rapid repeated calls while a backup works. Outages retain cached data
with its original age; restart or refresh does not make old data fresh. FMI model
publication, analysis and forecast-valid times are separate. OpenWeather does not
supply a documented forecast issuance timestamp, so that field remains unknown.
Still-fresh near-term forecast blocks retain their original snapshot provenance.

SmartThings and Easee readings retain their quality flags. Current snapshots are
not metered energy or heat-pump power. Easee authentication can refresh tokens;
it does not change charging settings.

Normal `npm test` and `npm run check` stay offline. To verify current service access
and the configured keys explicitly, use the [bounded live test suite](docs/live-testing.md):

```sh
npm run test:live
npm run test:live -- --services fmi-forecast,fmi-observation
```

Each primary and backup is checked separately, so a working fallback cannot hide
a rejected key. The suite uses no MQTT and sends no equipment commands.

The contract form accepts dated retailer margin and electricity tax in **c/kWh
excluding VAT**, VAT as a **percentage**, and the day/night or seasonal transfer
tariff. Transfer already includes VAT. No tax/VAT values are silently filled in,
and no seasonal switch is scheduled automatically. Confirm effective dates against
the actual contract and applicable tax tables. Missing historical rates prevent
historical billing; applying current charges to old readings is a scenario. The
example outlook in simulation remains unrelated to the actual contract.

## Learning and control limits

Learning uses bounded chronological samples and a holdout comparison against
persistence and the prior model. A versioned checkpoint retains parameters,
rollback model, current thermal estimate and processed cursor. Historical rebuild
runs in a worker after the UI/control starts; ordinary restart processes only new
rows. Bad candidate models are rejected. History is the rebuilding source.

The experimental schedule evaluator compares continuous normal operation with
modest reductions, prices their recovery and terminal reserve, penalizes comfort
deviations and includes energy uncertainty. Severe cooling, poor freshness,
unverified energy response, recovery debt, faults and overrides select normal
fallback. Native normal operation is not forced preheating. The initial evaluator
requires verified heat-pump energy samples; current snapshots do not qualify.
Consequently the supplied history alone does not authorize economic dispatch.
An uncertainty-aware estimator that can safely use weaker evidence remains work
for the next stage. No actual bill savings are established.

DHWR retains the legacy `heaton60` then `heaton15` intent sequence, ten-minute
pulses, Helsinki 05:45–19:45 window and separate persistent 52.5-minute recency.
Quarter-hour scheduling normally spaces pulses by at least one hour. No native
hygiene/integral/auxiliary settings are changed. H66 writes, verified readback,
manual panel reconciliation and physical communication-failure recovery are
pending commissioning. No battery dispatch is implemented.

## Deployment paths

See [Home Assistant setup](DOCS.md). A local container build needs no `BUILD_FROM`
argument:

```sh
docker build -t st-mq:development .
```

The same Node core and SQLite schema run in both targets. The container supports
`amd64` and `aarch64`; this development host validates x86 execution only. CI
includes a build for both architectures. [deploy/st-mq.service](deploy/st-mq.service)
is an example standalone systemd unit to adapt to an installation; it has not been
installed or enabled by development. Stop the old command owner before any future
live migration. [Legacy documentation](docs/LEGACY.md) is retained for reference.
