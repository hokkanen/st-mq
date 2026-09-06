# ST-MQ

ST-MQ is a local home-energy controller under development for a Raspberry Pi 5
Home Assistant add-on and standalone Linux. The authoritative project brief is
`CODEX/ST-MQ-Codex-handoff.md`; implementation status and remaining work are in
[docs/PROGRESS.md](docs/PROGRESS.md).

Version 0.8.0 provides an offline, tested foundation: SQLite history, conservative
heating decisions, incremental thermal learning, a monitoring dashboard and
read-only H66 acquisition. **Default startup uses simulated devices in shadow
mode. No physical heat-pump command transport is enabled in the new application.**
Read-only market, weather, SmartThings and Easee providers plus dated contract
setup are integrated and tested with offline fixtures. No household API connection
or physical equipment has been commissioned by this development work.

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

The UI has monitoring, shadow and simulated active modes, selectable observations,
price/weather outlooks, requested/actual state, stale-data indication, learning
health, explicit occupancy and timed normal-heating overrides. The default 21 °C
**demo** target is confined to simulation, not inferred as the real house's target.
Overrides are persistent; changing one in shadow mode does not operate equipment.
Away mode currently preserves normal fallback; return times are recorded but
return-aware optimization is pending.

For UI development run `npm start` and `npm run dev` in separate terminals. Vite
proxies `/api` to the backend. `npm run preview` alone does not provide the API.

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
schemas are rejected. Queries are bounded to at most 5,000 observations. The HTTP
history endpoint limits a request to 31 days. Source history is retained; there
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

`STMQ_INPUT=providers` selects the new read-only provider path. It reuses
`geoloc`, `entsoe`, `openweathermap`, `smartthings` and `easee` connection fields
from the existing options JSON. Configure only the services in use: SmartThings
indoor/outdoor device IDs and Easee acquisition are optional. The garage is outside
heating optimization. Device requests run every five minutes; market and weather
requests run hourly on separate schedules. Outages retain cached observations and
forecasts with their original timestamps, so restart or refresh does not make old
data fresh. Failed polls back off automatically, and retries survive restart.
Provider input cannot enable physical active control.

ENTSO-E is the primary day-ahead market source. Its currency, energy units,
quarter-hour/hourly resolution, positions and document revisions are validated.
OpenWeather supplies the three-hour forecast; its valid timestamps and downloaded
snapshot time are stored separately. Its JSON response does not document an
issuance timestamp, so the application marks that uncertainty. Rolling updates
retain still-fresh near-term forecast blocks with their original snapshot provenance;
missing intervals remain visible as gaps in charts. SmartThings
timestamps and Easee current observations retain their quality flags. Current
snapshots are not metered energy or heat-pump power. Easee login/token renewal is
the only provider authentication mutation; it does not change charging settings.

The contract form accepts dated retailer margin and electricity tax in **c/kWh
excluding VAT**, VAT as a **percentage**, and the day/night or seasonal transfer
tariff. Transfer already includes VAT. No tax/VAT values are silently filled in,
and no seasonal switch is scheduled automatically. Confirm effective dates against
the actual contract and applicable tax tables. Missing historical rates prevent
historical billing; applying current charges to old readings is a scenario. The
example outlook in simulation remains unrelated to the actual contract.

Elering fallback remains limited: the public API schema did not establish terminal
interval duration and VAT semantics clearly enough to enable it automatically.
It requires vetted endpoint semantics in developer configuration, outside normal
household setup. No missing prices are filled by guessing the next interval's end.
See [provider fixture provenance](test/fixtures/providers-README.md) for the checked
documentation and remaining verification limits.

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
