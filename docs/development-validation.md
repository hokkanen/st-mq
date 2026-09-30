# Development validation

Start with the [repository foundations and working rules](../AGENTS.md). Tests
validate those contracts; existing assertions do not authorize conflicting changes.
Follow the [conflict procedure](../AGENTS.md#conflicting-requests) before changing
a foundation, even when the requested implementation would require it.

Run checks from the repository root. Ordinary tests, browser fixtures, container
checks and Garage simulations use synthetic data. The separately invoked live
suite contacts configured providers; see [live testing](live-testing.md).

## Automated tests and build

```sh
npm ci
npm run check
```

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
a three-minute test deadline. They cover recovery at larger history volumes
and real SQLite mirroring through SSH. A sensor duplicate-delivery regression
also runs the installed MQTT.js client against an isolated Mosquitto broker and
packet proxy. Install `mosquitto` to run it; set `STMQ_REQUIRE_MQTT_TESTS=1` to
make a missing broker fail instead of skip. Cheap mocked transport validation stays
in the routine suite. These tests use synthetic data and local processes; they
make no paid model or provider API calls.

Pushes and pull requests run routine tests and builds on Node 22 and 24, plus the
secret-history audit. The **Extended validation** workflow runs weekly on Monday
at 03:27 UTC or manually using `workflow_dispatch`; it runs the extended Node
suite on both versions and the amd64/arm64 container checks. Run it before a
release and after changes to recovery, mirroring or packaging. This workflow
requires mirror prerequisites, so a missing tool fails instead of silently
skipping coverage. Local extended runs report missing tools as skips.

To require real mirroring locally, install OpenSSH client and server tools,
prepare the host's SSH privilege-separation directory, and build the pinned
SQLite tool:

```sh
node scripts/build-sqlite-rsync.js --output /tmp/stmq-tools/sqlite3_rsync
PATH="/tmp/stmq-tools:$PATH" STMQ_REQUIRE_RSYNC_TESTS=1 STMQ_REQUIRE_SSH_TESTS=1 npm run test:extended
```

The SSH tests create their own keys, server configuration and loopback listener.
They do not use household SSH credentials. `STMQ_TEST_RSYNC` selects the binary
for transport tests; `STMQ_SQLITE_RSYNC_PATH` selects it for SSH tests. Putting the
tool on `PATH` supplies both. Loopback access must be allowed by the test runner's
sandbox; `listen EPERM` means the fixture could not start its local server.

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

### Compiled Pill integration

After building the separate `shelly-cn105-mqtt` project, run the actual compiled
driver against the controller's production adapter with synthetic UART, MQTT,
storage and clocks:

```sh
STMQ_PILL_ARTIFACT=/path/to/shelly-cn105-mqtt/dist/driver.js \
  node --test test/extended/garage-pill-runtime.test.js
```

This exercises persistent targets, current boot/challenge fencing, local Bluetooth
freshness, native command confirmation and independent protection overrides. It opens no device or
broker connection and does not copy the external driver into this repository.
The extended suite explicitly skips these integration cases without the artifact
path; its ordinary host-only adapter coverage still runs in the routine suite.
Actual Pill heap usage and firmware scheduling require separate installed checks.

## Browser suites

Build first with `npm run build`. Browser sweeps are extended/manual checks,
separate from both Node commands; run the relevant suite for UI changes. All
browser scripts create isolated application servers and temporary databases.
Never point them at a household application.

These scripts start their own disposable Chrome processes:

```sh
node scripts/browser-access-smoke.js
node scripts/browser-equipment-smoke.js
node scripts/browser-equipment-smoke.js --caravan-only
node scripts/browser-charging-tests-smoke.js
node scripts/browser-home-controls-smoke.js
node scripts/browser-heating-explorer-smoke.js
node scripts/browser-garage-smoke.js
node scripts/browser-garage-smoke.js --temperature-hold-only
node scripts/browser-mitsubishi-smoke.js
node scripts/browser-fullscreen-smoke.js
node scripts/browser-chart-views-smoke.js
node scripts/browser-selectors-smoke.js
node scripts/browser-timing-compat-smoke.js
```

The heating-explorer suite checks the Home preview opener without toggling its
parent card, Escape and focus restoration, pinned comparisons and draft retention,
family simulation, explicit admin approval, stale-input rejection and narrow
layouts in both themes. It uses synthetic response fixtures and captures a
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

The charging-tests suite checks the Charging setup fold and BMW descriptor guide,
both guided programs, explicit charger choice, expectation-only action payloads,
draft preservation through polling, cancellation, passive/retained session
reports and read-only access. It uses synthetic status and intercepted assessment
requests in a disposable application and browser. It checks keyboard dismissal
and focus, charger-scoped/expired selections, grouped original evidence, collapsed
routine plans and open-detail/focus/scroll preservation across polling. It checks
horizontal overflow and a reachable close button at 320/390/1440px in both themes. Its
temporary screenshot directory is printed on completion. It never connects to a
vehicle or charger; overnight hardware behavior still requires an actual guided
run by the installation user.

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
# Limit this combined suite to chart, recording, dates, tooltips and zoom checks:
# node scripts/browser-chart-smoke.js ws://127.0.0.1:39124/session --chart-only
node scripts/browser-pairing-smoke.js ws://127.0.0.1:39124/session
```

Stop any remaining disposable browser processes and remove their profiles afterward. Screenshots
from synthetic fixtures go to ignored `var/` or reported temporary paths.

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

## Pairing and browser failure investigation — 21 September 2026

The two failures in `pair-runtime.test.js` both stalled at `check-recovery`.
A tiny recovery preview reproduced the stall before any substantial history
replay. On the local Node 26.8.2 runtime, registering the recovery worker's
`parentPort` message listener before its initial asynchronous SQLite backup
prevented that backup from completing. The same operation completed on Node 24.
This was a runtime compatibility defect in the recovery path, not evidence that
pairing needed longer polling deadlines. The worker now completes initialization
before attaching its catch-up listener; replies arriving after `ready` remain
queued until the listener is attached. Existing authority, history-conflict,
rejoin and replay assertions remain active.

The full-week replay (672 learning windows) and phase-energy import (6,048 rows)
remain in the extended suite. Routine tests exercise the same assertions with
80 learning windows and 192 energy rows, still crossing batch boundaries and
checking live recording, deterministic replay and original-history preservation.
Recovery fixtures use the same isolated snapshot worker as production pairing,
avoiding the same Node 26 issue during test setup. Tests pass their cancellation
signal through to worker operations, and the tiny preview regression has its
own ten-second deadline.

The browser failures came from assertions that predated intentional UI changes:
four fitted coefficients replaced an expected five; Home outcome headings were
being counted as outcome entries; chart inspection now uses its explicit Exit
control; and the vehicle connection label is Tesla. Checks now assert the actual
coefficient/outcome keys and the current keyboard behavior. No production UI
changes were needed. The dedicated Home-controls smoke test already passed.
Full chart and Garage browser checks passed after updating their assertions.
The Garage sweep alone generated 509 synthetic screenshots (about 45 MiB), so
these browser sweeps remain manual checks rather than part of every commit.

Validation after the fixes: the complete routine suite on Node 24.21.0 passed
2,411 tests in 56.8 seconds; seven optional Home Assistant template tests skipped
because Python Jinja2 was unavailable. All 25 focused pairing/recovery tests
passed on Node 26.8.2 in 13.4 seconds. The final extended suite passed all seven
tests on Node 26.8.2 in 16.2 seconds, including required real SQLite and SSH
transport checks with no skips. The fresh production build and Home-controls,
chart and Garage browser suites passed. Containers and live providers were not
rerun for this change.

## September 2026 development review

Validation on 2026-09-16 covers dashboard/backend consistency, configuration,
mirroring, documentation and the available test suites:

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

Remaining limits: arm64 container execution was unavailable on this host; the
extended workflow retains its separate arm64 job. Vite reports an existing main-bundle size warning
above 500 kB. Live Easee access passed but its returned current measurements were
stale, which remains distinct from fresh evidence for control. Software fixtures
and simulations do not establish installed equipment performance or confirm
physical commands. A source archive made with `git archive` includes committed
files, excluding local credentials, runtime data, dependencies and Git history.
