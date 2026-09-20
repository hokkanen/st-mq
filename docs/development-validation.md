# Development validation

Run checks from the repository root. Ordinary tests, browser fixtures, container
checks and Garage simulations use synthetic data. The separately invoked live
suite contacts configured providers; see [live testing](live-testing.md).

## Automated tests and build

```sh
npm ci
npm run check
```

CI runs the tests on Node 22 and 24. To require the real replication checks
instead of silently skipping unavailable prerequisites, install OpenSSH client
and server tools, prepare the host's SSH privilege-separation directory, and
build the pinned SQLite tool:

```sh
node scripts/build-sqlite-rsync.js --output /tmp/stmq-tools/sqlite3_rsync
PATH="/tmp/stmq-tools:$PATH" STMQ_REQUIRE_RSYNC_TESTS=1 STMQ_REQUIRE_SSH_TESTS=1 npm test
```

The SSH tests create their own keys, server configuration and loopback listener.
They do not use household SSH credentials. `STMQ_TEST_RSYNC` selects the binary
for transport tests; `STMQ_SQLITE_RSYNC_PATH` selects it for SSH tests. Putting the
tool on `PATH` supplies both.

For sensor bookkeeping performance as recorded history grows, run:

```sh
node scripts/benchmark-sensor-queries.js
```

This uses synthetic history and reports timings without machine-specific pass
thresholds. Sensor-boundary queries must read the selected input's contexts once,
not rescan the full learning journal for every correction. Periodic report
coverage must resolve its preceding span once per query, and acquisition's
measurement-existence check must not reconstruct report availability. These
paths run on the server's main thread: regressions can delay HTTP responses and
provider downloads even when chart calculations run in a worker.

## Browser suites

Build first with `npm run build`. All browser scripts create isolated application
servers and temporary databases. Never point them at a household application.

These scripts start their own disposable Chrome processes:

```sh
node scripts/browser-equipment-smoke.js
node scripts/browser-garage-smoke.js
node scripts/browser-fullscreen-smoke.js
```

The fullscreen suite checks the page controls, chart entry/exit restoration,
external fullscreen changes and fallback behavior with synthetic data.

They default to `/opt/google/chrome/chrome`; set `STMQ_CHROME_BIN` if needed. The
remaining Chrome checks expect a separately started browser with a disposable
profile and a local DevTools listener:

```sh
stmq_chrome_profile=$(mktemp -d)
/opt/google/chrome/chrome --headless --disable-gpu \
  --user-data-dir="$stmq_chrome_profile" --remote-debugging-port=39125 about:blank
```

Leave it running in its terminal and run these serially from another terminal:

```sh
node scripts/browser-learning-smoke.js http://127.0.0.1:39125
node scripts/browser-sensors-smoke.js http://127.0.0.1:39125
node scripts/browser-ingress-smoke.js http://127.0.0.1:39125
```

The chart and pairing suites use Firefox WebDriver BiDi:

```sh
stmq_firefox_profile=$(mktemp -d)
firefox --headless --no-remote --profile "$stmq_firefox_profile" \
  --remote-debugging-port 39124 about:blank
```

For Snap Firefox, create the disposable profile inside
`~/snap/firefox/common/` instead; host `/tmp` profiles are not visible inside the
Snap. Each Firefox suite closes its browser session, so start Firefox again with
a new disposable profile before the next suite:

```sh
node scripts/browser-chart-smoke.js ws://127.0.0.1:39124/session
node scripts/browser-pairing-smoke.js ws://127.0.0.1:39124/session
```

`scripts/browser-smoke.js` is an alias for the chart suite. Stop any remaining
disposable browser processes and remove their profiles afterward. Screenshots
from synthetic fixtures go to ignored `var/` or reported temporary paths.

## Containers and Garage simulations

```sh
docker build -t st-mq:validation .
bash scripts/test-addon-container.sh st-mq:validation linux/amd64
node scripts/garage-simulation-audit.js --json /tmp/stmq-garage-model.json
node scripts/garage-planning-simulation.js --json /tmp/stmq-garage-planning.json
node scripts/garage-planning-simulation.js --bootstrap --json /tmp/stmq-garage-bootstrap.json
node scripts/garage-pipe-simulation.js
```

The container suite uses temporary mounts and disables container networking.
It checks the shipped startup command, authentication, assets, restart,
backup/export/restore, shared files, provider fixtures and replica viewer.
CI separately builds and runs both amd64 and arm64 images. Running arm64 locally
requires an arm64 host or working emulation and a matching image.

## September 2026 development review

Validation on 2026-09-16 covers dashboard/backend consistency, configuration,
replication, documentation and the available test suites:

| Check | Result |
| --- | --- |
| Node 22.19.0 complete test suite | 2,139 passed; no failures, skips or cancellations. |
| Node 24.21.0 complete test suite | 2,139 passed; no failures, skips or cancellations. |
| Real SQLite sync and isolated SSH | Required and included in both complete runs. |
| Production UI builds | Passed on Node 22 and 24. |
| Browser suites | All seven passed: chart, equipment, Garage, ingress, learning, pairing and sensors. Garage covered 320–1920 px and both themes. |
| Native amd64 add-on | Build and complete container suite passed on Node 22.23.2. |
| Live configured providers | Nine checks passed, no skips; nine bounded HTTP requests, no MQTT/device commands. |
| Garage simulations | 21 model scenarios / 84 frozen forecasts, 20 planning cases, 54 bootstrap opportunities, 432 pipe cases and 18 pulses completed. |
| Dependency audit | `npm audit` reported zero known vulnerabilities. |
| Static/document checks | JavaScript syntax, installed dependency tree, edited local documentation links, translation YAML and whitespace checks passed. |

The review fixed snapshot workers forwarding process-only Node flags, missing
charger configuration schema, duplicate Garage energy without source identity,
future sensor evidence, stale charger readiness, hidden pending recirculation
stop delivery and Firefox popup dismissal on unchanged scroll offsets. It also
updated obsolete browser fixtures and documentation, and closed background
workers before provider-test fixture cleanup. Learning algorithms and historical
CSV interpretation were unchanged.

Remaining limits: arm64 container execution was unavailable on this host; CI
retains its separate arm64 job. Vite reports an existing main-bundle size warning
above 500 kB. Live Easee access passed but its returned current measurements were
stale, which remains distinct from fresh evidence for control. Software fixtures
and simulations do not establish installed equipment performance or confirm
physical commands. A source archive made with `git archive` includes committed
files, excluding local credentials, runtime data, dependencies and Git history.
