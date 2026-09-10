# Testing configured providers live

Normal `npm test` and `npm run check` use fixtures and do not contact your accounts.
The separate live section checks the configured providers with real requests:

```bash
npm run test:live
```

Run it from the repository. It reads public `config.json` defaults and
`~/.config/st-mq/secrets.json` (honoring `XDG_CONFIG_HOME`), or the private file
named by `STMQ_CONFIG`. With `STMQ_ADDON=1`, the default is `/data/options.json`, and
`STMQ_CONFIG` still takes precedence. Both a plain connection object and the add-on's `options` wrapper
are accepted. It reports each provider separately, so a working backup cannot
hide a broken primary. The live checks cover:

| Service name | What a passing check proves |
| --- | --- |
| `entsoe` | The configured key and bidding zone return prices covering now. |
| `elering` | Elering's own endpoint returns prices covering now, without a key. |
| `fmi-forecast` | FMI returns usable temperature and solar radiation forecasts extending at least six hours. |
| `fmi-observation` | FMI returns a recent outdoor temperature observation. |
| `openmeteo-forecast` | Open-Meteo ICON returns usable temperature and solar radiation forecasts without a key. |
| `openmeteo-current` | Open-Meteo ICON returns a recent outdoor temperature model estimate without a key. |
| `easee` | Every configured charger/equalizer returns all three phase currents. |

Open-Meteo uses the configured latitude and longitude; no API key is needed.
Its current temperature is a model estimate, while FMI current temperature comes
from a nearby weather station. H66 outdoor temperature has first priority in the
controller; these provider checks do not connect to or verify H66.

Missing optional device IDs and missing optional API tokens are explicitly
skipped. A configured provider returning an error, missing readings or invalid
data fails its check. Device source ages are printed separately: access can work
while a device's last reported state is stale. Temperature diagnostics apply the
controller's 30-minute age limit separately from provider flags. When both price
sources pass, their overlapping prices are compared in memory without another
request. Forecasts and regional outdoor
observations do not verify the temperature at the house itself.

To check only a repaired service, select it explicitly:

```bash
npm run test:live -- --services fmi-forecast,fmi-observation
npm run test:live -- --services openmeteo-forecast,openmeteo-current
```

Use the service names in the table. Checks and HTTP requests run serially. A run
has at most 20 requests, each with a 12-second timeout and a 4 MiB response limit.
There are no general retries. Easee permits at most one refresh and one login
fallback, with one data retry after successful authentication.
Rate limiting stops the affected host, including calls already queued locally.

The runner uses a local lock to prevent overlapping live test runs. It waits at
least 60 seconds before repeating a selected service. An authorization denial or
HTTP 429 imposes a 30-minute host cooldown, extended for a longer provider
`Retry-After` up to 24 hours. Other services remain available via `--services`.
Wait out a cooldown instead of repeatedly retrying a rejected key.

The only persistent files are in ignored `var/live-test/`: the lock, numeric
cooldown state and a separate Easee token cache. The directory is owner-only and
token files have mode `0600`. Tokens may rotate during Easee authentication; the
original options and production token file are never rewritten. Stop other
provider processes before this check if they share the same Easee refresh token.
With `STMQ_ADDON=1`, the default cache is `/data/st-mq/live-test`. A custom
`STMQ_DATA_DIR` puts the cache in its `live-test` subdirectory.
`STMQ_LIVE_DATA_DIR` overrides either default with another private directory.

The suite does not start the controller, open the household database, connect to
MQTT, change heating/DHWR or send charger/device commands. The transport rejects
all writes except the two Easee account authentication endpoints. It prints
sanitized status codes and counts; keys, URLs, coordinates, device IDs and raw
responses are excluded. A successful live check verifies the present account
setup, not future provider availability.

Easee's [observations API](https://developer.easee.com/reference/getobservations)
returns the last reported values. Its phase currents are listed as event fields
in the [charger observation definitions](https://developer.easee.com/docs/charger-observation-ids).
An old current timestamp therefore does not, by itself, prove the device is
offline. It also does not prove that the old current is still accurate. This
controller preserves source timestamps and quality flags; polling the API does
not turn an old reading into a fresh measurement.
