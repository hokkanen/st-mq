# Development validation

Start with the [repository foundations and working rules](../AGENTS.md). Tests
validate those contracts; existing assertions do not authorize conflicting changes.
Follow the [conflict procedure](../AGENTS.md#conflicting-requests) before changing
a foundation, even when the requested implementation would require it.

Run checks from the repository root. Ordinary tests, browser fixtures, container
checks and Garage simulations use synthetic data. The separately invoked live
suite contacts configured providers; see [live testing](live-testing.md).

History recovery checks must validate and inventory the source without making a
trial database or importing rows. Acceptance and model impact are assessed once,
against the current master during recovery. `test/recovery-scheduling.test.js`
exercises progress persistence and concurrent controller writes while import
batches yield their SQLite write lock. Reversal tests cover the same worker
scheduling during journal reconstruction. Keep phase cohorts atomic when bounding
transaction work; an event-loop yield in the worker alone does not prevent it
from repeatedly taking the lock before the controller can write.

Pair recovery validation also covers explicit outage intervals beside valid
energy, whole phase cohorts, retry idempotency and unchanged original journal
inputs. Recovery-report tests compare both category date ranges and explicitly
recorded energy gaps without inferring gaps from sparse readings; a source interval
that merely touches an outage boundary is not potential energy coverage.
They distinguish a batch of 28 retained point notifications from an energy gap,
preserve exact evidence bounds and counts under grouping, and ensure independently
bounded diagnostics cannot displace older energy gaps. Browser fixtures check the
collapsed signal groups, unknown point duration, subsecond report spans and focus
retention across refresh at narrow and wide widths in both themes.
Rejoin tests retain the original dedicated database byte-for-byte, including
excluded records, while proving that later promotion uses the verified replica
and cannot reactivate the retained database's control state. The paired MQTT
source-context tests exercise actual recording and equipment consumers across
handover and restart so a transport change cannot create a new device identity.

## Automated tests and build

```sh
npm ci
npm run check
```

`npm run check` builds the dashboard before running the routine tests. Startup
and control-authority tests verify that the actual application keeps serving its
dashboard, so run `npm run build` once before invoking `npm test` directly in a
fresh checkout. CI uses the same `npm run check` command.

`npm test` (also `npm run test:unit`) runs the routine offline regression suite
with at most four test files in parallel and a 60-second test deadline. Pairing
handover, outage promotion, recovery correctness and rejoin regressions remain
in this suite. New top-level `test/*.test.js` files are included automatically.

The optional extended Node package runs separately:

```sh
npm run test:extended
npm run test:all        # routine followed by extended
```

Extended tests live in `test/extended/`, with at most two files in parallel and
a three-minute test deadline. They cover recovery at larger history volumes,
full persisted-learning replay across a restart, and real SQLite mirroring
through SSH. Sensor duplicate delivery, independent broker routing and paired
MQTT handover regressions run the installed MQTT.js client against isolated
Mosquitto brokers and transport proxies. Install `mosquitto` to run them; set
`STMQ_REQUIRE_MQTT_TESTS=1` to make a missing broker fail instead of skip. Cheap
mocked transport validation stays in the routine suite. These tests use synthetic
data and local processes; they make no paid model or provider API calls.

Pushes and pull requests run routine tests and builds on Node 22 and 24, the
secret-history audit and the pinned Home Assistant Supervisor contract check
below. The **Extended validation** workflow runs weekly on Monday
at 03:27 UTC or manually using `workflow_dispatch`; it runs the extended Node
suite on both versions and the amd64/arm64 container checks. Run it before a
release and after changes to recovery, mirroring or packaging. This workflow
installs and requires mirror and MQTT broker prerequisites, so a missing tool
fails instead of silently skipping coverage. Local extended runs report missing
tools as skips.

To require real mirroring and broker tests locally, install Mosquitto and OpenSSH
client and server tools, prepare the host's SSH privilege-separation directory,
and build the pinned SQLite tool:

```sh
node scripts/build-sqlite-rsync.js --output /tmp/stmq-tools/sqlite3_rsync
PATH="/tmp/stmq-tools:$PATH" STMQ_REQUIRE_RSYNC_TESTS=1 STMQ_REQUIRE_SSH_TESTS=1 \
  STMQ_REQUIRE_MQTT_TESTS=1 npm run test:extended
```

The SSH tests create their own keys, server configuration and loopback listener.
They do not use household SSH credentials. `STMQ_TEST_RSYNC` selects the binary
for transport tests; `STMQ_SQLITE_RSYNC_PATH` selects it for SSH tests. Putting the
tool on `PATH` supplies both. Loopback access must be allowed by the test runner's
sandbox; `listen EPERM` means the fixture could not start its local server.

For sensor bookkeeping performance as recorded history grows, run:

```sh
node scripts/benchmarks/sensor-queries.js
```

Storage health and durability changes have focused offline checks in
`test/recording-health.test.js`, `test/storage-publication.test.js`,
`test/database-export.test.js` and `test/recorder.test.js`. They cover actual
SQLite full/busy failures, unchanged readings, read-only replicas, authenticated
health fallback, flush failures and adaptive-budget isolation from unrelated
writes. `node test/browser/recording-health-smoke.js` checks the real dashboard
health elements at narrow and wide widths in both themes, including focus,
stale status, sign-out fencing and the health-only failure view.

`node scripts/benchmarks/recorder-budget.js` compares synthetic adaptive scalar
and phase-energy traces under the default annual target and a smaller stress
target. It measures retained observations, logical adaptive payload, total SQLite
growth and scalar reconstruction error while asserting conserved accepted energy
and explicit gap records. It uses no installation configuration or data, and its
short duration does not establish annual convergence or device flash endurance.

This uses synthetic history and reports timings without machine-specific pass
thresholds. Sensor-boundary queries must read the selected input's contexts once,
not rescan the full learning journal for every correction. Periodic report
coverage must resolve its preceding span once per query, and acquisition's
measurement-existence check must not reconstruct report availability. These
paths run on the server's main thread: regressions can delay HTTP responses and
provider downloads even when chart calculations run in a worker.

For chart query and navigation performance, use isolated synthetic fixtures:

```sh
node scripts/benchmarks/chart-interaction.js --days 90 --runs 3
# Optional comparison with an unchanged checkout of the same schema:
node scripts/benchmarks/chart-interaction.js --baseline /tmp/chart-baseline --days 90 --runs 3
node test/browser/chart-performance-smoke.js
```

The query benchmark creates and deletes its own database. It reports repeated
first-worker and cached-request timings, process memory and main-loop delay for
today, yesterday, tomorrow, week and month views. When a baseline is supplied it
compares complete response hashes excluding only declared performance metadata.
The fixture contains changing phase energy, temperatures, Garage activity,
prices and acquisition gaps. It is a dense synthetic workload, not a forecast
of adaptive recording growth or coverage of every learned/imported dataset.

The browser check launches a disposable local Chromium (override its executable
with `STMQ_CHROME_BIN`), serves actual chart modules through Vite, and uses the
production chart HTTP endpoint against synthetic history. It measures load,
unchanged refresh, theme changes and frame gaps; verifies companion-cache reuse,
loading progress and aborting a stalled request by selecting Today; and checks
320/390-pixel layouts and both themes. Screenshots remain in its printed temporary
artifact directory. `--source /path/to/checkout --baseline` runs its comparable
pre-optimization workload without requiring the new prefetch/progress behavior.
These checks make no household connections and do not measure Raspberry Pi or
phone hardware. The stalled browser stream is injected; the real-worker tests
below separately cancel an active history scan.

`test/chart-query-performance.test.js` validates recent-index versus historical
streaming equality, arbitrarily long overlapping energy intervals, receipt and
source scope, bounded request-local replay and measured stage progress.
`test/chart-worker-transport.test.js` covers active cancellation, independent
speculation, worker retirement/failure, concurrent recording, response equality
and authentication revocation during streaming. `test/chart-browser-performance.test.js`
covers cache bounds, late responses, prefetch policy, stream parsing and geometry
reuse. Keep the existing chart provenance, gap, extrema, recovery, voltage,
temperature-geometry and accounting tests alongside these checks.

On Ubuntu x86-64 with an AMD Ryzen 5 1600 and Node 26.8.2, a 90-day,
596,403-observation fixture produced these median first-worker results over three
repetitions, comparing the same fixture with revision `d60f4be`:

| Selection | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Today, power | 1,175 ms | 304 ms | 74% |
| Yesterday, power | 1,245 ms | 368 ms | 70% |
| Week, power | 2,311 ms | 1,085 ms | 53% |
| Yesterday, phase loading | 626 ms | 365 ms | 42% |
| Week, phase loading | 1,857 ms | 1,130 ms | 39% |
| Yesterday, Garage | 568 ms | 328 ms | 42% |
| Week, Garage | 1,155 ms | 949 ms | 18% |
| Month, power | 6,162 ms | 5,738 ms | 7% |

All eleven tested selections retained equal response content across the three
repetitions. These service numbers include worker startup and object transfer;
they exclude browser/network work and are not device-specific guarantees. The
HTTP path separately uses worker-prepared bytes to avoid main-thread response
serialization. Compare distributions on the same host rather than imposing
these absolute timings on other machines.

For charging search throughput, run `node scripts/benchmarks/charging-planner.js`.
The synthetic 24-hour workload includes two chargers, 96 price intervals and six
household scenarios, and reports full searches and fixed forecasts for each
priority. `test/charging-planner-service.test.js` separately checks that the real
worker leaves the main thread responsive, coalesces queued requests and expires
cached results at relevant boundaries. These offline checks do not establish
native Raspberry Pi 5 timing or physical charger behavior.

`test/energy-checks-worker.test.js` exercises 100,000 synthetic property counters
through the actual HTTP route and history worker while independent timers,
committed writes and unrelated HTTP requests continue. It also covers bounded
queuing, cancellation, selected-history changes, clock rollback, replica read
lifetime and access revocation. Property-summary tests preserve counter resets,
late reports, gaps and the last complete comparison without an all-history array.

For Home heating, `test/home-planner-service.test.js` checks the real search
worker against synchronous planner output while the main thread remains able
to run timers, plus bounded queuing, timeout and shutdown. The adoption tests in
`test/app-heating-planning.test.js` and `test/live-controller-cycle.test.js`
check current evidence, authority, configuration, model and correction fences
before any result becomes an executed cycle. A worker result itself cannot send
commands. Synthetic cold/hot, negative-price, ROOM-response and Away-return
cases exercise the planner's limits without contacting installed equipment.

`test/home-learning-admission.test.js` verifies that estimated indoor values
cannot become observed journal inputs, thermal fits or comfort references, and
checks deterministic replay. `test/indoor-control.test.js` checks that the
runtime heat reserve includes covered heating before a room goes missing and
cannot advance across a source gap. These tests establish software behavior;
they do not validate the installed heat pump, house dynamics or measured savings.

`test/heating-control-state-storage.test.js` checks rejection before writable
database setup and byte-for-byte preservation of unreadable or retired heating
state. Current-format replica and reset-safety fixtures keep restoration duties
separate from actuation permission; an unreadable record must not hide an
independent known duty in the read-only reset inventory.

### Heat-pump controller and sender contracts

Run the Garage adapter, sender and configuration tests from this repository:

```sh
node --test test/garage-v2-adapter.test.js test/garage-sender.test.js test/garage-protection-config.test.js
```

These use synthetic current-contract MQTT state to exercise durable-target
confirmation, boot/challenge fencing, one-shot native commands and sender
configuration readback. They do not load the separate firmware driver's compiled
artifact or establish its UART behavior.

In the separate `shelly-cn105-mqtt` repository, run `npm run check`. Its runtime
and build tests exercise readable and generated scripts against synthetic UART,
MQTT, storage and clocks, including source freshness, native confirmation and
protection overrides. See its [development guide](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/development.md).
Both suites are offline; actual device memory, firmware scheduling, radio
reception and useful heating require separate installation checks.

## Shelly load balancing

Focused offline checks cover held Easee stream state, synchronization and
connection epochs, allocation independence, native limits and
change-only allowance history:

```sh
node --test test/easee-stream.test.js test/easee-ocpp-lifecycle.test.js test/charging-shelly-limit.test.js test/charging-limiter-evidence-policy.test.js test/charging-shelly-evse.test.js test/charging-allowance-history.test.js
node --test test/charging-ui.test.js test/chart-overlays.test.js test/chart-views.test.js test/chart-charging-currents.test.js
```

Use synthetic source observations to exercise unchanged last-change values
confirmed by healthy current reporting, missing/reconnecting feeds, unequal
Shelly phase measurements, 0 and 6–16 A entitlement, signed calibration margins,
a configurable fallback below known limits, all priorities and future forecasts
without a permanent fallback cap. Missing or contradictory Equalizer allowance
and native budget must not gate Shelly's live calculation. Hold household demand
and planned allocation fixed while varying Charger 1's current and delaying its
Equalizer response: Shelly's entitlement must stay fixed even during excess
property load that reducing Charger 1 could remove. Include separately arriving
property/charger readings in both orders: use the latest healthy measurements
immediately without requiring a later charger or property timestamp. Cover the
accepted temporary over/underestimate during transitions, unchanged healthy OCPP
and cloud values during household changes, simultaneous charger changes, original
source clocks, actual outages and recovery, Charge now, energy/deadline-weighted
Balanced sharing against actual headroom, differing forecast headroom, restart
and actual outages. Current-choice tests distinguish an initial setting carried
into a new connection from a later external selection. Cover same-session
restart/reconnect, unplug, explicit **Use automatic**, own writes, and Automatic
scheduling off with current adjustment enabled. Hardware, configured electrical
and vehicle ceilings remain binding. Native command freshness and identification
ownership remain separate checks. History checks cover exact changes, compact unchanged
coverage, restart/outage gaps, equipment replacement, malformed/overlapping
history, bounded query detail and independence from charging-report expiry.
Both plugged and unplugged chargers must record changing numeric capacity, keep
confirmed settings separate, and send no commands for an unplugged capacity
calculation. Cover active peer commitments without a fabricated unplugged request.

Physical qualification additionally needs current installation evidence and
explicitly authorized charger operations. Record requested limits, confirmed
native settings, fresh measured response and applicable peer/vehicle evidence
separately. Software or browser tests cannot establish physical property-load
sharing, Equalizer response time, fuse protection or autonomous controller-loss
behavior.

For substantial charger features, select relevant cases from the
[optional physical development runbook](charging/testing.md). It provides
bounded read-only observation and offline evidence assessment around explicitly
operated hardware. These cases are not a per-commit requirement and do not run
inside `npm run check`, CI or `npm run test:live`. The tool regression tests use
synthetic observations in the ordinary suite. Small fixes can use focused
offline coverage; record any remaining physical limits for the next relevant
development session instead of repeating the whole hardware matrix.

The OCPP identification reconnect regression exercises the production runtime,
BMW ingestion and controller through unplug, reconnect at zero draw, a future
economic start, bounded probe, transaction, physical pause and BMW match. Its
synthetic charger cannot supply a transaction until the controller has granted
start permission. Restart checks preserve the original attempt and deadline;
native restrictions remain separate. This verifies the startup dependency with
synthetic hardware, not actual charger or BMW response.

## Browser suites

Build first with `npm run build`. Browser sweeps are extended/manual checks,
separate from both Node commands; run the relevant suite for UI changes. All
browser scripts create isolated application servers and temporary databases.
Never point them at a household application.

These scripts start their own disposable Chrome processes:

```sh
node test/browser/access-smoke.js
node test/browser/configuration-smoke.js
node test/browser/configuration-recovery-smoke.js
node test/browser/equipment-smoke.js
node test/browser/equipment-smoke.js --dashboard-heights-only
node test/browser/equipment-smoke.js --caravan-only
node test/browser/charging-controls-smoke.js
node test/browser/charging-tests-smoke.js
node test/browser/ocpp-setup-smoke.js
node test/browser/charging-currents-smoke.js
node test/browser/home-controls-smoke.js
node test/browser/history-recovery-smoke.js
node test/browser/heating-explorer-smoke.js
node test/browser/garage-smoke.js
node test/browser/garage-smoke.js --temperature-hold-only
node test/browser/mitsubishi-smoke.js
node test/browser/fullscreen-smoke.js
node test/browser/chart-views-smoke.js
node test/browser/chart-views-smoke.js --voltage-only
node test/browser/selectors-smoke.js
node test/browser/timing-compat-smoke.js
```

The configuration suite uses a disposable configuration file and actual local
preview/apply endpoints. It checks validation, masked current/proposed values,
cancel, stale-review rejection, unchanged reapplication, restart-only changes,
family restrictions, logout clearing and keyboard focus through polling. It also
checks the diff at 320/390/1440 px in both themes; synthetic screenshots use
`STMQ_CONFIGURATION_SCREENSHOT_DIR` when supplied. It never reads installation
configuration or connects providers.

The HA ingress suite also checks the pair-copy guide with keyboard navigation
and at 320/390/1440 px in both themes. It confirms that reading the guide sends
no write requests and uses the same screenshot-directory option.

The history-recovery suite checks the shared Recording details/Paired computers
window, nested recording disclosure, separate recovery/history views, peer
preselection, upload and reviewed actions, operation pagination, revert/restore,
close/reopen progress, family restrictions, keyboard dismissal and focus restoration
at 320/390/768/1440 px in both themes, including short phone viewports. It uses an
isolated synthetic server and records temporary screenshots; it does not open
household backups.

The heating-explorer suite checks the Home preview opener without toggling its
parent card, Escape and focus restoration, pinned comparisons and draft retention,
family simulation, explicit admin approval, stale-input rejection and narrow
layouts in both themes. It also checks absent and partial uncertainty bands,
provisional comfort limits and the provenance of a captured indoor estimate.
It builds an isolated temporary UI unless `STMQ_UI_DIST` selects an existing
build. It uses synthetic response fixtures and captures a
temporary screenshot gallery; it never commands household equipment. The Node
explorer and live-controller-cycle tests separately exercise the production
worker, access policy, real planner and one-cycle lifecycle against offline data.

The Mitsubishi sweep builds its own temporary UI bundle unless `STMQ_UI_DIST`
is provided. It checks application dropdown keyboard commit/cancel and real
mouse/touch selection, all six typed pump controls, confirmation and held-control
status, reading availability, offline/read-only gating, and both themes at
320/390/1440px. Pump responses and commands stay inside the browser fixture.

The access suite checks password entry, keyboard and touch visibility controls,
family/admin permissions, logout and credential revocation. It audits responsive
layouts in both themes, including narrow and short login viewports. To retain
synthetic screenshots and the geometry report, set
`STMQ_ACCESS_SCREENSHOT_DIR=/tmp/access-layout` when running the script.

The equipment suite's `--dashboard-heights-only` option checks compact Home and
Garage overviews and stable Data & settings geometry at 320, 390, 600, 1024, 1180,
1280 and 1440 px. Extra evidence or wrapped prices may change the overview height;
in two-column layouts, Home and Garage must change by the same amount. Mobile
overviews fit independently. Synthetic unavailable/stale temperatures, including
one-sided stale readings, heating plans, provider contexts, missing prices, and
intercepted charging saves/errors exercise the actual renderers. It checks full
popup details, focus restoration, aligned values and captions, roof/header
clearance, buildings centered between their side groups, centered Explore content,
compact section gaps and approximately balanced desktop columns. Receipts and
popovers must not add space; returning to normal must restore the compact height.
Charging feedback must leave its current allowance visible and unobstructed.
Opening a fold must not resize neighboring cards to compensate for its content.
Set `STMQ_DASHBOARD_SCREENSHOT_DIR` to retain folded dashboard screenshots.

The equipment suite's `--caravan-only` option checks the Caravan disclosure,
advertised dehumidifier settings, automatic power thresholds and saving,
power-test recording states, and read-only control restrictions in both
themes at 320, 390 and 1440 px. It exercises keyboard access to the policy and
power-evidence disclosures, draft preservation through polling, discard without a
command, error associations, saved-policy ownership of manual power and native
setting locks during testing/restoration. Synthetic
screenshots include live automatic/paused recording, manual/active recording and
expanded threshold editing, framed around the dehumidifier. Commands terminate
in browser fixtures.

The charging-controls suite covers session controls and the route from each
charger card into its corresponding setup fold. The OCPP setup suite checks
review/confirmation, changed revisions, secret redaction and read-only restrictions
in the Charging setup area using synthetic endpoints and both themes. These
checks establish UI behavior, not native commissioning or physical authorization.

The charging-tests suite checks the Charging setup fold and BMW descriptor guide,
both vehicles and guided programs, explicit charger choice, vehicle readings and
capacity defaults and decimal precision, assessment-only input payloads, integrated
time pickers and shared dropdown controls, saved schedule confirmations, verified
targets that differ from telemetry, draft preservation through polling, early stopping,
passive/retained session reports and read-only access. It uses synthetic status
and intercepted assessment requests in a disposable application and browser. It checks keyboard dismissal
and focus, conflicting target edits from another window, checkbox alignment,
charger-scoped/expired selections, grouped original evidence, unified event
filters, saved-report controls and open-detail/focus/scroll preservation across polling. It checks
horizontal overflow and a reachable close button at 320/390/1440px in both themes. Its
temporary screenshot directory is printed on completion. It never connects to a
vehicle or charger; overnight hardware behavior still requires an actual guided
run by the installation user.

The charging-currents browser suite seeds actual allowance observations and
compact coverage in a fresh synthetic database, then reads them through the
chart API. It checks the property maximum, both chargers' allowance lines,
separate purple dash-dot fallback including zero, missing coverage, unchanged
right-axis meaning and removal of old load-balancing strips. The runtime allowance
regression also runs both production charger adapters with synthetic devices,
records Charger 1 with Automatic off and verifies both histories reach the chart.
It covers native zero, unknown evidence and replica/configuration fencing.
Charger 1 session
checks remain accessible in All series. The charging-controls suite covers
compact footer allowances, action-message replacement, unknown/inactive states,
source details, and the two-line planned-start approval label at narrow and wide
widths in both themes. These fixtures make no household or charger connections;
they validate UI and storage behavior rather than physical charger response.

The physical-test API and runtime-independence tests exercise real BMW and Tesla
acquisition with synthetic hardware. They compare all production settings, session
inputs, identity evidence, raw readings, plans and device updates around guide
actions. Target-conflict tests cover explicit verification, repeated/fluctuating
reports, unseen conflicts, stale actions, restart and storage rollback. A verified
declaration remains insufficient evidence for charging or completion by itself.

Session-report storage and API tests use fresh synthetic SQLite databases. They
cover history beyond the former event/session count limits, complete event pages,
age-based whole-report expiry, saved active/completed reports, removal from saved,
explicit completed-report deletion, restart, transaction rollback and read-only
inspection. Report actions must leave energy records, production inputs and
charger authority unchanged. Database-overview checks account for report summaries
and event rows without exposing private payloads. These checks do not establish
that installed charger confirmation chatter or replanning has been resolved.

The Tuya Local bridge tests render synthetic HA templates and verify independent
native report clocks, identity, supported controls and request expiry. The pinned
observation-adapter tests execute actual patched upstream methods and exercise
installer rejection, private backups and rollback. Profile encoding can also be
checked against an unpacked public Tuya Local 2026.9.2 source release:

```sh
STMQ_TUYA_LOCAL_SOURCE=/path/to/tuya-local-2026.9.2 \
  node --test test/tuya-local-desd8lw-profile.test.js
```

This extra parser check requires Python PyYAML and otherwise reports an explicit
skip; it never opens a device connection. Ordinary device and UI tests use
synthetic observations. Live commissioning results belong in the task record,
with private IDs and readings excluded from logs and screenshots.

The fullscreen suite checks the page controls, chart entry/exit restoration,
external fullscreen changes and fallback behavior with synthetic data.

The chart-views `--voltage-only` mode checks the dedicated Phase voltage estimates
view, all three default traces and individual series, saved source provenance,
and both themes at 320/390/1280px using synthetic data.
Voltage tests pass the first valid per-phase acquisitions through the actual
estimator, recorder and chart reader with zero accumulated coverage. They check
immediate voltage/current availability, gradual smoothing, missing phases,
restart and source-loss evidence, and rejection of retired estimator state.

The chart-views suite exercises every named view, the complete supported series
explorer, view-specific legend choices, global price visibility, reset behavior,
garage pump interpretation, line/fill conventions and aligned activity rows.
Explorer checks cover the shared selection button, searchable **Views** and
**All series** modes, selection/dismissal, keyboard navigation and centered
desktop, mobile and fullscreen layouts. Chart style checks
include cubic temperature settings, solid historical Solar estimate, dash-dot
future Solar forecast and charger fills within each individual phase. It verifies
Caravan interval-average power, original energy availability, hollow observation
markers and point targeting against nearby price samples. Real Chart.js
interaction tests also cover vertically aligned readings, overlapping markers
and synthetic edges. Browser checks cover combined home-compressor states, the
persistent title folds and complete colour keys, separate garage power-readback
and managed-pause rows, band-only mouse/touch cursor dragging, clipped cursor
segments, independent plot navigation, touch and keyboard cleanup, both themes and
320/390 px fullscreen layouts. Legend checks cover native keyboard disclosure,
scrolling with Reset view always accessible, uniform active-state swatches,
quantity-specific group labels and strip alignment as scrollbars appear. They also
check the compact Interpolation ON/OFF footer control, keyboard focus and scroll
preservation, global browser persistence, step geometry and restoration of the
existing curves and straight lines. Its synthetic screenshot gallery is written to
ignored `var/chart-views-*.png` files. The Firefox chart suite below retains broader
chart/date/detail/tooltips and related dashboard regression coverage.

Date checks also cover preserving the inactive end-date suggestion, showing just
the new start day, explicitly choosing the same or another end date, canceling
without activating a range, and fitting the end calendar on small screens.
The timing compatibility suite uses the production comparison-section markup
with native, missing and delayed `ResizeObserver` delivery. It checks visible
figures and controls, resizing, refresh, keyboard focus and unclipped content at
seven widths in both themes, including either side of the indentation breakpoint.
The comparison section uses an accessible button
and an ordinary hidden panel, keeping native inner folds mounted without placing
the cards inside a native outer disclosure. Enter/Space activation, expanded state
and hidden layout must agree. Repeated close/reopen checks include refreshes and
viewport changes while hidden, retained cached alignment until reopening,
preserved inner folds, hit testing and identical painted-card captures. Layout
checks verify that the whole expanded panel is inset beneath its header, inner
headers align with their content level, and opened bodies add one further inset
without overflowing narrow screens.
Use `STMQ_CHROME_BIN` to exercise an actual older Chromium executable; changing
a modern browser's user agent does not reproduce an older rendering engine.
These checks do not certify a particular appliance's browser.

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
node test/browser/learning-smoke.js http://127.0.0.1:39125
node test/browser/sensors-smoke.js http://127.0.0.1:39125
node test/browser/ingress-smoke.js http://127.0.0.1:39125
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
node test/browser/chart-smoke.js ws://127.0.0.1:39124/session
# Limit to recorded-energy check methods, exclusions and commissioning states:
# node test/browser/chart-smoke.js ws://127.0.0.1:39124/session --energy-checks-only
# Limit this combined suite to chart, recording, dates, tooltips and zoom checks:
# node test/browser/chart-smoke.js ws://127.0.0.1:39124/session --chart-only
node test/browser/pairing-smoke.js ws://127.0.0.1:39124/session
```

The pairing suite checks the production dashboard with synthetic API responses,
including reset choices on protected computers, cancellation and focus restoration,
explicit equipment-restoration acknowledgement before Start fresh, final confirmation,
and the retained archive receipt. Both choices are checked at desktop and 320-pixel
widths in light and dark themes. The access suite checks that only administrators
can open reset controls, including synthetic click attempts by family users.
Pairing UI unit tests additionally fence stale reset confirmations, preserve an
uncertain request across reloads and omit unrecognized error details. Backend reset
tests exercise actual storage and runtime behavior separately from these UI fixtures.

Stop any remaining disposable browser processes and remove their profiles afterward. Screenshots
from synthetic fixtures go to ignored `var/` or reported temporary paths.
The configuration recovery browser fixture checks both environment-specific
flows at 320, 390 and 1440 pixels in both themes against synthetic API responses;
real HTTP recovery tests cover authentication, startup and source persistence.
Set `STMQ_RECOVERY_SCREENSHOT_DIR` to an external temporary directory to retain
its screenshots.

## Containers and Garage simulations

```sh
docker build -t st-mq:validation .
bash scripts/test-addon-container.sh st-mq:validation linux/amd64
node scripts/garage-pipe-simulation.js
```

The container suite uses temporary mounts and disables container networking.
It checks the shipped startup command, authentication, assets, restart,
backup/export/restore, shared files, provider fixtures and slave viewer.
The weekly/manual extended workflow builds and runs both amd64 and arm64
images. Running arm64 locally requires an arm64 host or working emulation and
a matching image.

## Home Assistant Supervisor contract

```sh
bash scripts/test-homeassistant-supervisor.sh
# Reuse an existing clean checkout at the exact pinned commit:
# bash scripts/test-homeassistant-supervisor.sh /tmp/stmq-supervisor-2026.09.3
```

This needs Node.js 22.19 or newer, Git, Docker and network access to fetch public
sources and build the validator image. It pins released Supervisor **2026.09.3** at
[`64ea3be4322537fd5dcfbf620c4dc25490c1f56d`](https://github.com/home-assistant/supervisor/tree/64ea3be4322537fd5dcfbf620c4dc25490c1f56d)
and rejects a supplied checkout with another revision or local changes. The
validator then runs with networking disabled, a read-only root, dropped
capabilities and synthetic settings in a temporary filesystem. It mounts only
the public checkout, manifest, English translation, repository metadata and test
script, plus a synthetic options fixture generated by ST-MQ's production
serializer; no household data, host devices or Docker socket are mounted.

The real upstream validators check `config.json`, `translations/en.yaml`,
`repository.yaml`, nested defaults and UI descriptors. The real options handlers
exercise secret resolution, preservation of saved references, rotation,
readback and a lost save response. The fixture also validates sparse equipment
imports generated by the production serializer and Supervisor's actual web UI
URL resolution with host networking. The suite contains 16 checks, including Supervisor's actual recursive manifest
discovery against a fixture of the public `config.*` filenames. Only the root
`config.json` is an app manifest; integration packaging templates must not appear
as additional apps. The normal
push/pull-request workflow includes this runner; the application container
checks remain in extended validation.

The deployment contract checks the v1 unchanged-repository-list refresh against
upstream store scanning and metadata publication, without Git fetch or option
replacement. It also verifies that Supervisor can filter unknown fields from a
runtime response while retaining them in saved options. Application recovery
must therefore validate raw saved fields before resolving secret references.

Supervisor 2026.09.3 retains existing `!secret` references in saved options,
while `options/config` provides resolved runtime values. Current import receipts
and readback checks use that behavior. Uploads accept only actual values and
cannot introduce new `!secret` references.

These checks exercise released configuration code with synthetic registry and
persistence fixtures. They do not start Supervisor, render Home Assistant's
frontend, install the app, enforce its live AppArmor/network policy or perform a
Supervisor backup/restore. Complete those checks in a disposable Home Assistant
OS installation before claiming installed-platform validation. The app container
and ingress browser fixtures cover their own boundaries.

## Release validation and known limits

Configuration recovery checks use invalid synthetic configuration on both
platforms. Verify that no database or equipment runtime starts, HA recovery
requires the actual ingress proxy, and Linux recovery stays on authenticated
loopback access. Cover reviewed replacement of incompatible saved options,
private backup, stale reviews, retained invalid uploads and explicit restart;
keep ordinary merge-import and database-rejection coverage intact. Recovery
browser checks must use isolated fixtures, never an installed household app.

Before a release, run the routine and extended Node suites, the affected browser
suites, the application containers for each advertised architecture, and the
pinned Supervisor check. Record exact results and skips in the release/PR or
commit body. A source archive is built from committed files; it does not include
local credentials, runtime data, dependencies or Git history.

The native amd64 container, QEMU-emulated arm64 container and pinned Supervisor
validator have been exercised with synthetic mounts and settings. Native arm64
execution on a physical Raspberry Pi, installation/update through a real
Supervisor, AppArmor/network enforcement and Home Assistant backup/restore
remain separate installation acceptance work.
Configured CI jobs alone do not establish those results. Never infer physical
heat delivery, useful protection, device-local timing or actual cost savings
from software fixtures.

Current limits to retain when reviewing results:

- SQLite writes on the controller thread use asynchronous admission. A zero-wait
  `BEGIN IMMEDIATE` acquires the writer lock before invoking each synchronous
  callback exactly once; timers retry only lock acquisition, never a partially
  executed callback. Background connections retain a 5,000 ms lock timeout.
  The queue bounds pending work to 2,048 entries and 8 MiB of declared payloads;
  overflow rejects explicitly and marks recording failure. Queued telemetry keeps
  its receipt/source clocks and connection scope. Control intent commits before
  dispatch, with fresh authority, target, native-state and expiry checks after
  waiting; transactions never span network waits. Control priority is bounded so
  observations cannot starve. A pending native report blocks conflicting commands.
  Closing storage rejects remaining work. Demotion cancels obsolete runtime
  saves immediately; restorative teardown bounds pending actuator saves to five
  seconds while preserving committed restoration obligations. An outage
  cannot promise unlimited in-memory retention or persistence across process loss.
  Synchronous disk I/O can still delay timers; runtime maximum/p99 event-loop
  delay exposes stalls with a 1,000 ms warning threshold. This is not a hard
  real-time guarantee. Offline contention fixtures exercise actual SQLite locks,
  event-loop progress, ordered recording, cancellation and pre-command commits.
- Joint charging planning runs its bounded search in a background worker. Earlier
  synthetic 24-hour two-charger measurements took approximately 0.47–1.24 seconds on the
  development machine; this is historical performance evidence, not a current
  hardware deadline or proof of exact optimization. Rebenchmark material changes.
- Vite reports a large-main-bundle advisory. A successful build does not resolve
  that performance concern.
- The full Firefox chart sweep currently stops at the Garage Close keyboard
  check, after successful database download/save, recording and initial chart
  checks. The same failure reproduces before and after the access-lock fix;
  the Firefox automation cause remains unresolved. Focused Chrome Garage checks
  pass. Later landscape legend-focus and Save-view follow-ups remain open until
  the complete sweep passes; a targeted UI check is insufficient evidence to
  close them.
- The floor controller integration is pending. H66, CN105/protection and charging
  have distinct physical qualification requirements; see their maintained
  guides. OCPP recovered-transaction profile acceptance and Equalizer behavior
  under competing loads remain unverified. Synthetic Shelly recovery does not
  establish autonomous behavior during loss of the application or broker.
- Installed Android launch appearance and Samsung/DeX/fridge-browser behavior
  require their actual devices. Desktop browser fixtures cannot qualify them.

## Runtime and fixture constraints

Recovery workers finish their initial SQLite backup before attaching the
catch-up message listener. This ordering avoids a reproduced Node runtime stall;
replies arriving after `ready` remain queued until the listener attaches. Keep
small recovery-preview and cancellation regressions alongside the larger
extended replay fixtures instead of increasing timeouts to conceal a stall.

The full-week replay and larger phase-energy import belong in extended tests.
Routine tests still cross batch boundaries and verify authority, restart,
deterministic replay and original-history preservation with smaller data.
Browser assertions should identify current semantic keys and user interactions;
when an intended UI change invalidates a historical expectation, update the
fixture without weakening the behavioral check.
