# ST-MQ

ST-MQ is a local home-energy controller under development for a Raspberry Pi 5
Home Assistant add-on and standalone Linux. The authoritative project brief is
`CODEX/ST-MQ-Codex-handoff.md`; implementation status and remaining work are in
[docs/PROGRESS.md](docs/PROGRESS.md).

The controller provides SQLite history, adaptive thermal learning, complete
preheat/reduction/recovery planning, a monitoring dashboard and H66 readback/control.
**Default startup uses simulated devices in shadow mode.** With live input,
configured transport and active mode, the controller can operate heating and
supported H66 settings. Explicit manual MQTT and timed H66 tests are also available.
Read-only market, weather, MQTT temperature and Easee providers plus dated contract
setup are integrated. ENTSO-E has a direct Elering backup; FMI supplies temperature
and solar forecasts, with Open-Meteo as backup. Current outdoor temperature uses
the H66 sensor first, then FMI station observations, then Open-Meteo estimates. Offline
regressions and a separate opt-in live suite verify the provider paths. See the
[progress log](docs/PROGRESS.md) for actual live-check results and remaining limits.
Physical equipment control has not been commissioned.

An independent recording optimizer targets a configurable **10 GB/year** rolling
growth rate with a **five-minute maximum interval when fresh measurements exist**.
Electricity history stores three estimated phase-energy increments per device;
occasional accumulated meter readings are audit-only. The house learner uses
committed windows and a versioned replay journal. See
[adaptive recording and migration](docs/recording.md), including SmartThings removal.

The comfort reference is inferred from sustained occupied normal-temperature
plateaus under the house's existing controls. The preferred maximum drop defaults
to **1 °C**. References stay fixed during cooling, recovery and preheating. A
missing reference keeps the requested heating mode normal. Initial model estimates
retain uncertainty and limit the duration and cost of learning trials.
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
live gate is explicitly enabled. Existing `data/options.json` supplies permanent
settings; without an explicit input selection the application uses simulation.
Simulation and offline modes do not connect to providers. The server serves the completed UI build; it does not
rebuild historical CSVs or run a permanent Vite build watcher.

The Home Energy UI has monitoring, shadow and active modes, combined
history and price/weather outlooks, requested/actual state, stale-data indication, learning
health, explicit occupancy and timed normal-heating overrides. The default 21 °C
**demo** target is confined to simulation, not inferred as the real house's target.
Overrides are persistent; changing one in shadow mode does not operate equipment.
**Away until** removes the occupied temperature-drop requirement until the chosen
return time. The planner compares cost with continuous native operation, including
recovery and auxiliary energy. Occupied requirements resume at the return time
within the available forecast horizon; forecasts are never invented beyond it.
The existing evidence/freshness gates still apply. **Pause until** requests normal
native operation without price reductions. Both controls use Finnish time, survive
restarts, expire at their deadlines and can be cancelled independently.
Live active mode applies the plan; monitoring and shadow show it without automatic
equipment commands.

Under **Away & pause**, the **Test heating commands** section starts closed. With
`providers` or `mqtt` input and an existing `mqtt.address` configuration, its
`heatoff`, `heaton15` and `heaton60` buttons send the selected real command to
`from_stmq/heat/action`, using the controller's executor and QoS 1 without retain.
Each button sends exactly one command; the normal recirculation sequence is
`heaton60` followed by `heaton15`. A successful test confirms broker acknowledgement,
not equipment response. Tests are logged, do not change Away/Pause or enable
automatic control, and are unavailable in simulation/offline mode. Failed or
timed-out tests are not retried automatically; delivery may be unconfirmed.
Enabled buttons mean MQTT is configured; the connection is checked when a test
is sent. Connection failures distinguish an unreachable broker, refused connection,
DNS, login or TLS problems and report that no command was sent. If a connection
fails after publishing begins, check device state before retrying because delivery
is unconfirmed.

**Test H66 settings** offers timed ROOM (`0203`), DHW start (`0212`), DHW stop
(`0208`) and operating-mode (`2201`) tests when the connection and fresh writable
readbacks are ready. The current baseline is saved and restored after expiry.
The UI distinguishes a sent request from device readback and a pending restore.
These are real manual commands with live input, including in shadow mode.

For UI development run `npm start` and `npm run dev` in separate terminals. Vite
proxies `/api` to the backend. `npm run preview` alone does not provide the API.

## Using the chart

The interface opens in a green dark theme on every page load. The header's **Light
theme / Dark theme** button changes it for the current page. The chart is
directly below the current readings.

- **Dates:** the default is today, midnight to midnight in **Europe/Helsinki**.
  Choose **Start date** to view a single day; the greyed-out end date follows it.
  Check **End date** to select a range of inclusive Finnish calendar days, including
  daylight-saving changes. Date changes apply automatically; **Show dates** also
  applies the selection. **Yesterday – today**, **Today** and **Today – tomorrow**
  provide quick navigation and set the end-date checkbox accordingly. To see
  tomorrow alone, leave End date unchecked and choose tomorrow as Start date.
  Forecasts and known electricity prices appear only
  inside the selected dates; they never extend the horizontal axis automatically.
- **Left axis:** **Power** shows combined property power as a line, estimated
  auxiliary power as a red fill and charger power as a fill over it. Fills overlap
  from zero; they are not stacked. **Phase currents** shows the three property phase lines
  in amperes with corresponding charger fills. **Phase energy per interval** shows
  the three saved kWh increments per device. The drawer groups all retained H66
  parameters, garage temperature, control, weather and learning series. **Heating
  integral** selects the integral instead. Four **Learning** choices show profit after recovery, profit
  with observed auxiliary recovery, recovery cost prediction error and learned
  normal indoor temperature. **Solar radiation** shows archived and future FMI
  forecasts in W/m², not a solar sensor. Only that group's legend items appear.
  New property/charger power comes from phase-energy increments divided by their
  actual intervals. Equivalent chart currents assume 230 V and unity power factor;
  they are not the acquired current snapshots. Older current-only history retains
  its `230 × (L1 + L2 + L3) / 1000` estimate. Neither path measures heat-pump consumption.
- **Right axis:** indoor, garage and outdoor temperatures and electricity prices
  stay available with every left-axis selection. The dashed outdoor continuation
  is forecast. All-in and **Spot price** start visible; spot excludes VAT and other
  charges. Explicit saved legend choices are preserved. All-in prices combine
  historical spot prices with the contract rates for that date, or the nearest
  known rates when the date is uncovered. An **Assumed rates** explanation identifies these assumptions;
  missing spot prices stay unavailable.
- **Shading:** crosshatched **Heat Off** represents requested reduction; yellow
  **Compressor · house** and blue **Compressor · hot water** require concurrent
  compressor/routing readbacks. Brown **DHWR** marks requested ten-minute pulses
  and starts hidden. A separate **Pump mode** strip shows categorical H66 readback.
  Unknown or stale operation leaves gaps. Dated runtime counters cannot identify
  individual auxiliary episodes.
- **Timing comparison:** below the chart, each device compares the cost of its
  included energy at the recorded timestamps with the same daily energy at the
  whole Finnish day's average all-in price. Heat-pump electricity is reconstructed
  from recorded compressor activity and auxiliary output using the nominal powers
  saved for that time. Charger electricity uses recorded phase-energy intervals;
  older current-only history retains its 230 V estimate. The visible basis and
  source details identify those estimates and simulation. Missing equipment data
  or dated heat-pump power assumptions leave gaps. Heat-pump power is never
  property consumption minus charger consumption.
  **Time included** describes the share of the selected elapsed time that enters
  the calculation, including valid zero-power intervals. It is not
  runtime, the share of charging days or a confidence score. The evidence mix
  describes shares of that included time, so frequent samples do not receive
  extra weight. Missing power periods and days with incomplete spot prices are
  excluded; the result is not extrapolated to missing periods. For today, the
  denominator runs from Finnish midnight to the calculation time.
  Calculations use the underlying energy and equipment intervals independently
  of chart point reduction and the selected left axis.
  Hover, focus or tap the underlined labels for the calculation, source mix,
  timestamps, price assumptions and missing-time details. Missing historical
  contract rates use the nearest known rates with historical spot prices;
  **Assumed rates** includes assumptions affecting the daily average even when
  the device ran during a period with known rates. This comparison does not
  establish savings caused by the controller.

Chart changes affect the display only. Viewing history neither polls providers
nor sends equipment commands. Large ranges use bounded display resolution,
preserving extremes and missing-data breaks; dense shading represents recorded
activity within each display interval. Queries run in a background worker and
recent selections are cached. A newer selection cancels an obsolete request.
For date ranges containing now, temperature, power, phase-current and integral
lines extend their last recorded value to the current time on each status refresh,
even when the history response is cached. Hover text identifies the original
recording time. These display extensions do not add measurements to history or
make old readings fresh for control. Missing/invalid values retain their gaps;
prices, forecasts and equipment-state shading keep their recorded time bounds.
Auxiliary output has a five-minute freshness bound. Learning histories keep the
estimate assessed at the time and never rewrite old points using a later model.

**Data & learning** separates **Connection & provider details** from **Learning
details**. The latter explains current parameters, temperature-validation evidence,
completed-cycle counts and the four chartable metrics. See the detailed
[learning and control explanation](docs/learning-and-control.md).
**Recording details** lists achieved recording intervals, learned thresholds,
freshness and storage growth independently of model importance. Its **Energy audit**
compares occasional meter counters with integrated estimates without correcting
history or training/calibrating the house model.

## Persistence and historical data

Standalone databases are in `var/`; Home Assistant uses `/config/st-mq/` in the
public add-on folder, accessible through SSH under
`/addon_configs/<repository-id>_st-mq/st-mq/`. Simulation
uses `simulation.sqlite`; real/offline household history uses `st-mq.sqlite`.
Override the database directory with `STMQ_DATABASE_DIR`. Private provider token
caches remain in `STMQ_DATA_DIR` (`/data/st-mq` in HA). Existing HA databases migrate
through SQLite's backup API to the public folder; the original is retained and an
existing destination is never overwritten. `/share/st-mq` remains the exchange
folder for historical CSVs and exported backups. See [SSH access and backups](DOCS.md#ssh-database-access-and-backups).
These databases and supplied CSVs are
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
endpoint accepts inclusive `start`/`end` calendar dates and left-axis keys from
the shared catalogue, including `power`, `phases`, `phase_energy`, `integral`,
`solar_radiation`, individual H66 signals and the four `learning_*` signals,
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
| `STMQ_INPUT` | `simulated`; also `offline`, `mqtt`, or `providers` |
| `STMQ_MODE` | `shadow`; also `monitoring`, or `active` with supported live transport or simulation |
| `STMQ_DATA_DIR` | `./var`, or `/data/st-mq` in the add-on |
| `STMQ_DATABASE_DIR` | Same as data directory on Linux; `/config/st-mq` in HA |
| `STMQ_PORT` | `1234` |
| `STMQ_HOST` | `127.0.0.1`; add-on listens on `0.0.0.0` |
| `STMQ_API_TOKEN` | Required, at least 24 characters, when listening beyond loopback |
| `STMQ_CONFIG` | Settings and connections JSON; defaults to `data/options.json`, or `/data/options.json` in add-on |
| `STMQ_MAX_DROP_C` | Occupied preferred drop; overrides `controller.max_drop_c` (default 1°C) |
| `STMQ_H66_DEVICE` | Exact H66 topic prefix; enables H66 alongside a configured MQTT broker |
| `STMQ_H66_VERIFICATION` | Optional JSON path with verified register scaling/evidence |

Use a trusted local network or an authenticated HTTPS reverse proxy for remote
access. API authentication protects both household data and setting changes;
credentials are never returned in API responses. The browser keeps an entered
API token in session storage for its tab. There is no internet exposure configured
by this project.

MQTT reuses the existing broker address/user/password and subscribes to
`<device>/HP/#` and configured indoor/garage temperature topics alongside online providers. Supported active control and
explicit manual tests can publish SET requests. Plain H66 values lack a source
measurement timestamp: non-retained receipt time is labeled as the communication
freshness basis, with the source timestamp still unknown. Retained, duplicate and
invalid messages are handled explicitly. A documented C60 profile does not prove
installed-device semantics. See [learning and H66 control](docs/learning-and-control.md).

Start read-only collection with:

```sh
STMQ_INPUT=providers npm start
```

This reuses `geoloc`, `entsoe`, `mqtt` and `easee` connection fields from
the existing options JSON. FMI, Open-Meteo and Elering need no API key or additional
provider configuration. Weather uses the configured latitude/longitude;
Elering uses the market country (FI, EE, LV or LT), or a matching explicit ENTSO-E
bidding zone. SmartThings acquisition is removed; its old configuration is ignored
and historical readings are preserved. Indoor temperature can come from H66;
replacement indoor/garage sensors can publish on configured MQTT topics. The garage
is recorded independently of heating optimization. Provider input in shadow mode observes
and plans; active mode can use a configured command transport.

| Data | Primary → backup | Normal collection interval |
| --- | --- | --- |
| Electricity prices | ENTSO-E → Elering's own public API | 1 hour; 15-minute retry when next-day horizon is missing |
| Temperature and solar forecast | FMI HARMONIE → Open-Meteo ICON Seamless | 30 minutes |
| Outdoor temperature | H66 outdoor sensor → FMI nearby station → Open-Meteo model estimate | H66 messages; weather every 5 minutes |
| Indoor/garage temperatures | H66 indoor; configured MQTT sensors | MQTT publications; H66 GETALL every 60 seconds |
| Property/charger electrical observations | Easee REST | 15 seconds, one batched request per device |

These are collection schedules, not guarantees that each provider publishes a new
measurement that often. FMI and Open-Meteo forecasts use hourly valid times.
Market prices retain each actual hourly or
quarter-hour delivery interval. The recorder saves changed observations adaptively
and deduplicates unchanged forecast/market payloads while preserving acquisition
references. Source timestamps remain separate from receipt time. Successful device downloads count even when values have not changed
or source timestamps are old. Reading-quality warnings remain visible without
slowing the configured collection cadence; failed or malformed downloads still
back off. Restarts preserve the last result and retry details.

Market fallback starts on a failed request, missing current price, or incomplete
current-day coverage. Tomorrow being unpublished is normal; it shortens the next
scheduled check to the configured retry interval without forcing a backup request.
Elering is contacted directly, with validated currency,
VAT and terminal-interval semantics; no intermediary service is used. Neither
source fills missing prices or extends them past the published horizon. See
[the Elering verification evidence](test/fixtures/market-elering-evidence.md).

Temperature and solar forecasts use FMI first and Open-Meteo ICON Seamless as
backup. Missing FMI solar intervals can use Open-Meteo radiation while keeping
available FMI temperatures; each solar value retains its provider provenance.
Solar radiation is global shortwave radiation on a horizontal surface in W/m²,
including cloud effects. Open-Meteo's hourly radiation averages the preceding hour
and is aligned to that interval rather than shifted into the next hour.

Current outdoor temperature uses a fresh **H66 outdoor sensor** reading (register
`0007`) first, then a fresh **FMI nearby station** reading, then an **Open-Meteo
model estimate**. Source priority takes precedence over a slightly newer backup
timestamp. Missing or stale H66 readings fall back automatically and fresh H66
readings regain priority. FMI selects the nearest fresh station among up to three
returned candidates within 50 km. The station and model estimate describe the
surrounding area. Weather forecasts and current-temperature acquisition are
independent; an unavailable station therefore does not discard a good FMI forecast.
No new SmartThings outdoor readings enter this chain.

[Open-Meteo](https://open-meteo.com/en/docs/dwd-api) supplies DWD ICON forecasts
without registration or a key for noncommercial use within the free API limits.
The application requests ICON Seamless explicitly to use a forecast system
independent of FMI. Current Open-Meteo weather is modeled, not a sensor observation.

**Data connections** shows the selected provider, **Using backup** when applicable,
and the primary provider's next retry. Requests are bounded and failures back off
per source, respecting rate-limit delays through restarts. One failed primary
cannot cause rapid repeated calls while a backup works. Outages retain cached data
with its original age; restart or refresh does not make old data fresh. FMI model
publication, analysis and forecast-valid times are separate. Open-Meteo does not
supply a documented forecast issuance timestamp, so that field remains unknown;
its generation duration is not treated as an issuance time.
Still-fresh near-term forecast blocks retain their original snapshot provenance.

Easee readings retain original source ages. Reported active power is integrated
between polls and allocated to three estimated phase energies; raw currents and
voltages remain acquisition-only. Lifetime/session/import kWh counters are stored
separately for accuracy diagnostics and never correct or calibrate those estimates.
Charger voltage terminal mapping requires explicit verification before voltage
weights are used. Easee authentication can refresh tokens; it does not change
charging settings. See [recording configuration and limitations](docs/recording.md).

Normal `npm test` and `npm run check` stay offline. To verify current service access
and the configured keys explicitly, use the [bounded live test suite](docs/live-testing.md):

```sh
npm run test:live
npm run test:live -- --services fmi-forecast,fmi-observation
```

Each primary and backup is checked separately, so a working fallback cannot hide
a rejected key. The suite uses no MQTT and sends no equipment commands.

## Permanent configuration and prices

Edit add-on options in Home Assistant, or `data/options.json` on Linux, and restart.
`config.json` defines add-on metadata, defaults and schema; it is not the owner's
credentials file. The dashboard reports the active values; Away/Pause and explicit
timed tests are available there. Configuration takes precedence over old browser-saved mode/drop
settings. `temp_to_hours` is obsolete and has been removed.

`recording.max_interval_minutes` defaults to `5` and
`recording.annual_budget_gb` to `10`. Acquisition intervals have separate options;
the complete example and MQTT replacement sensor payloads are in
[docs/recording.md](docs/recording.md). A storage target is not a calendar quota or
an automatic deletion policy.

All monetary options under `electricity` are **c/kWh excluding VAT**. VAT is entered
as a percentage and applied once to spot, margin, tax and transfer. Default values:

| Option | Excluding VAT | Including 25.5% VAT |
| --- | ---: | ---: |
| `margin_ct_per_kwh_ex_vat` | 0.33 | 0.41415 |
| `tax_ct_per_kwh_ex_vat` | 2.325 | 2.917875 |
| `day_transfer_ct_per_kwh_ex_vat` | 2.66 | 3.3383 |
| `night_transfer_ct_per_kwh_ex_vat` | 1.56 | 1.9578 |
| `winter_day_transfer_ct_per_kwh_ex_vat` | 3.32 | 4.1666 |
| `other_transfer_ct_per_kwh_ex_vat` | 1.65 | 2.07075 |

The numeric VAT-exclusive defaults are in `config.json`. `vat_percent` defaults to `25.5`; `transfer_tariff` defaults to
`day-night`. Daytime is 07:00–22:00 Finnish time. Seasonal winter daytime is
November–March, Monday–Saturday 07:00–22:00; Sundays and all other times use the
lower seasonal rate. Seasonal is available but is not activated automatically.

`controller.max_drop_c` defaults to 1°C for occupied operation; it does not constrain
away cooling. The comfort reference remains learned from native occupied operation.
`controller.input` and `controller.mode` are also configuration-owned.

The optional `electricity.effective_date` is a Finnish calendar date. First-use
rates begin today if no date is supplied; subsequent changes begin when loaded.
Rates, transfer amounts and VAT are saved per period so future changes preserve
historical calculations. Unstarted scheduled changes can be revised in options.
For chart history and timing comparisons, missing historical contract periods
use the nearest known rates while preserving historical spot prices. If only
today's rates are known, those rates apply to earlier readings. The historical
local time determines the day/night or seasonal transfer rate. These price
assumptions are labelled in the interface; known dated rates remain unchanged.
Simulation prices remain labelled synthetic and independent of the household
contract.

## Learning and control limits

The adaptive model fits bounded chronological temperature samples and checks
later trajectories against the previous model and temperature persistence.
Historical work runs separately from the control loop. Initial estimates support
bounded learning trials, with explicit energy uncertainty and cost budgets.
Cycle assessments include full recovery and remaining reserve; incomplete cycles
do not enter profit or prediction-error averages. Estimated electricity and the
planned shorter-reduction comparison reference do not establish actual bill savings.

Live H66 control captures and restores existing ROOM/DHW/mode baselines, checks
readback and retains restoration obligations through restarts. A1/A2 and native
hysteresis are configured prediction inputs, not values read from integral
register `8105`. The configured defaults are A2 −990 and auxiliary hysteresis
30 °C; A1 and compressor hysteresis remain unknown until configured. The DHW stop
register `0208` is not a physical compressor temperature cap.

DHWR retains ten-minute legacy pulses and its modeled coupling to house heat.
The native periodic hygiene cycle remains unchanged, with an explicitly accepted
possibility of delayed auxiliary availability during temporary control. No claim
of a verified hygiene outcome or commissioned hardware follows from the tests.
Read [the full assumptions and limits](docs/learning-and-control.md) before interpreting
cycle metrics. No battery dispatch is implemented.

## Deployment paths

See [Home Assistant setup](DOCS.md). A local container build needs no `BUILD_FROM`
argument:

```sh
docker build -t st-mq:development .
```

The same Node core and SQLite schema run in both targets. The container supports
`amd64` and `aarch64`; this development host validates x86 execution only. CI
builds and runs the isolated mounted add-on smoke check for both architectures.
Run `scripts/test-addon-container.sh st-mq:development` to check a local image.
[deploy/st-mq.service](deploy/st-mq.service)
is an example standalone systemd unit to adapt to an installation; it has not been
installed or enabled by development. Stop the old command owner before any future
live migration. [Legacy documentation](docs/LEGACY.md) is retained for reference.
