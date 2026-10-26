# Development validation

`test/easee-ocpp-approval-integration.test.js` exercises a locally refused virtual-tag
start followed by a confirmed deauthorization and suspension. Recovery requires
the same physical session, fresh stopped evidence and current permission; Pause,
external Stops, expired permission and pending input remain fenced. A real local
OCPP transport verifies the single saved recovery attempt, restart, independent
explicit requests, failed persistence and subsequent measured charging. These
synthetic tests do not establish a household charger outcome or reconstruct the
exact permission subcondition behind an earlier installed rejection.

Selected-period regressions cover exact Energy-check parity across range changes,
outside-period prior counters, long crossing intervals and pending/conflicting
evidence. `test/extended/selected-period-storage-scale.test.js` grows unrelated
counter, energy, session and cycle prefixes while holding the selected result
fixed, admitting concurrent recording and checking index/transfer bounds.
Voltage cases cover ordinary/late/missing physical streams and exact availability
ordering; proposed recovery views retain their own selection. Real writer-backed
committed-reading tests exceed the former frame limit without transferring the
retained room-setting history. These are synthetic qualification, not installed
hardware timing or a proof of every possible history distribution.
Energy-start metadata tests keep the first usable charger interval fixed while
growing unrelated property history, preserving recovery membership, pending energy
and original admission clocks with a signal-scoped index seek.
Completed-cycle summaries retain their exact latest-30 ordering and selected
assessments while incomplete-attempt archives grow, including no completed cycles.
Temperature-status regressions grow old weather and room archives while holding
the selected receipt window and exact source/device result fixed; current report,
outage, import and recovery-selection semantics remain part of the checks.
Saved charging-report pages keep their selected reports and keyset cursor meaning
while newer unsaved reports grow; the saved subset has its own sparse history index.
Replica equipment tests hold missing and inactive configured streams fixed while
another protocol's archive grows, preserving actual device IDs, selected imports
and source/receipt cutoffs in both exact-device and source-only projections.
Sensor-action cases retain direct/inherited request precedence and rollback
while ordinary controller contexts grow. Replay hydration cases compare exact
checkpoints and coefficient batches for no-op, real-tail and rebuild paths;
no-op projections return no full firewood rows.

`test/database-growth-reads.test.js` checks indexed recorder-state prefixes,
receipt-bounded indoor availability, time-bounded coefficient reads and direct
pages of selected learning prefixes, plus indexed offline report discovery.
It covers inherited payloads, fixed journal boundaries, nonmonotonic source
times, selected generations, long chart streaming and reporting gaps.
Full verification retains cursor paging; recent chart reads seek time before
sorting their selected cursors. Query plans establish the intended access paths,
not installed Raspberry Pi latency or physical equipment outcomes.

`test/chart-replica-retry.test.js` exercises queued chart reads during real
incremental and coalesced replica publication, including pruned transaction
prefixes. Only an authored forward-checkpoint hint can request one freshly
verified lease; new source arguments and an exact worker fence remain required.
Different identity, changed retained hashes, rollback, uncertain cleanup,
revocation and repeated advancement retain their refusals. Historical operation
health describes the refused attempt without claiming its cause from timing.

Event-log API and UI regressions cover privacy, selected history and source
namespaces, occurrence-time paging, visible-record membership, expired report
removal, snapshot fencing, bounded reads and failure recovery. The real dashboard
fixture `node test/browser/event-log-smoke.js` checks reading position, expanded
evidence, older navigation, local failures after successful control saves,
admin/family layouts and sign-out fencing. Add `--firefox` for the same fixture
through Firefox BiDi. Synthetic checks never establish physical equipment
outcomes. See [Event log](event-log.md) for evidence and coverage boundaries.

Event-log read regressions also cover indexed older-page query plans, selective
Important filtering without changing source rows, offscreen/hidden-tab suspension,
bounded concurrent subscribers, queued deadlines, per-subscriber cancellation and
native rollback before the last read lease is released. Replica HTTP checks reuse
one event worker across verified publication advances and replace it for a new
physical file. Run `test/event-log-service.test.js`, `test/replica-chart-owner.test.js`
and `test/replica-viewer.test.js` alongside the event-log API/UI tests. The browser
fixture explicitly opens the panel before expecting reads.

OCPP recording-admission regressions cover periodic/triggered samples sharing a
whole-second timestamp: valid total power retains exact integrated energy using
earlier labelled phase weights while current control retains the conflict.
Missing, expired and replaced connection evidence still produces gaps. The native
sampling suite also runs maintenance before the next periodic packet arrives.
HTTPS replacement tests use private synthetic installations and the same ordinary
setup flow afterward. They cover standalone-to-pair changes, new pairs and
certificate owners, opaque damaged-state preservation, stale approvals, peer
admission and retained renewal duties. `test/https-setup-replacement.test.js`
exercises real process termination, failed writes, renamed-inode recovery,
source/archive races and native helper process/socket refusal. The authenticated
TLS transport tests reject replacement through the entrance it would close.
Browser tests cover recovery-session prerequisites, confirmations, keyboard
focus, family permissions and ordinary first setup after preparation. These
offline checks never replace a live enrolled identity or prove phone DNS routing.

HTTPS runtime and UI tests cover explicit current-pair authorization, unchanged
owner/certificate/runtime, restart, stale approval, peer loss and identity races.
Ordinary Retry cannot authorize replacement identities.

`test/learning-checkpoint-display.test.js` checks the recorded-model metadata
reader: exact display parity, detached results, current manifest rejection,
missing references, indexed bounded reference batches and concurrent replacement
at one read boundary. It forbids prepared-body reads even on the first request.
The complete checkpoint reader and full verification still reject damaged sample
bodies; reading recorded metadata does not claim that verification.
`test/replica-viewer.test.js` checks cold and warm direct/HTTP status, publication
changes and unsupported models without hydrating fitting history. Complete
learning history remains in the database. Synthetic timings do not qualify
larger production workloads or particular installed hardware.

Linux installer configuration, broker authentication, prerequisite provisioning,
HA configuration and orchestration are covered by the `test/linux-setup*.test.js`
files. Fixtures use synthetic configuration and private temporary directories;
terminal tests use a real disposable PTY to check hidden paste, cancellation and
editor handoff. Privileged provisioning commands are injected in these tests.

Run the real installer, staged build and simulated application under a disposable
user systemd unit with:

```sh
STMQ_REQUIRE_SYSTEMD_TESTS=1 node --test test/extended/linux-setup-native.test.js
```

This requires a clean committed checkout, a running user systemd manager and
network access for locked npm dependencies. Authentication and lingering are
replaced in this fixture; it never changes root services or household state.
It checks real startup, authenticated status, listener ownership, managed and
stopped deployments, and preservation of private configuration and database
identity. Testing root package/helper installation additionally requires a
reviewed Ubuntu installation with sudo; the disposable test does not establish
that result.

Linux setup/deployment boundaries are covered by
`node --test test/linux-deployment.test.js`: disposable Git repositories and real
npm builds exercise staged releases, while simulated systemd and authenticated
pair status cover user/system services, role changes, failures and synchronization.
These tests never operate installed services. See [Linux deployment](linux-deployment.md)
and the [paired deployment procedure](paired-deployment.md) for runtime checks.
`test/deployment-lock.test.js` checks exact canonical paths, quoted unusual
characters, missing permissions, replaced/nonempty locks and shared HA refusal
codes. Setup/deployment fixtures verify that the locations survive error wrappers,
uncertain SSH replies and failed cleanup, with no replay or lock removal on refusal.
The live-test lock fixture blocks the runner before any provider worker can start;
it never reads installation credentials or sends live provider requests.
Setup promotion tests verify the current `nodeId` request boundary, including
the emitted HA program against an authenticated disposable listener and the Linux
producer against the real paired application API. Neither test operates equipment.
Service-preflight cases check specific mismatch diagnostics, suppression of raw
service values and rejection before building, locking or changing the runtime.
User-bus discovery checks preserve explicit session settings and reject missing,
unowned or unsafe default bus paths. Run the disposable systemd test below with
`env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR` to cover a terminal without
session variables through setup, running deployment and stopped deployment.
`test/linux-vip-helper.test.js` checks conditional helper refresh using isolated
installation files and simulated systemd metadata. Deployment tests cover the
password-free user-service path, authentication before Stop for helper changes,
system-service privileges and refusal to publish after helper drift or failed
verification. These checks never authenticate sudo or restart installed helpers.
`test/paired-deployment.test.js`, `test/ha-deploy-workflow.test.js` and
`test/ha-deploy-runtime.test.js` cover shared mode parsing/readiness, managed and
stopped HA paths, lifecycle uncertainty, container/image identity and a real
synthetic Node listener probe. No household services are used.
`STMQ_REQUIRE_SYSTEMD_TESTS=1 node --test test/extended/linux-deployment-systemd.test.js`
additionally exercises a real disposable user service and Linux listener ownership;
it creates and removes only its synthetic unit, never the household service.

Start with the [repository foundations and working rules](../AGENTS.md). Tests
validate those contracts; existing assertions do not authorize conflicting changes.
Follow the [conflict procedure](../AGENTS.md#conflicting-requests) before changing
a foundation, even when the requested implementation would require it.

`test/web-sessions.test.js` checks fixed 360-day expiry without renewal, protected
cookies, server revocation, password changes, database reopen, active-peer
forwarding, unsupported state, failed writes and authority loss. Its real TLS
fixture covers same-origin enforcement, role restrictions and expiry independent
of browser cookie handling. The access/browser suites retain ordinary tab login,
Home Assistant ingress, credential rotation and family permissions. These
checks also cover checkbox/first-line geometry, native size, a 44px label target,
HTTP hiding, stable checked/unchecked layout, 150%/200% text enlargement, short
and landscape viewports, keyboard order/focus, touch on label padding and a held
sign-in request with duplicate-submit rejection and password-error recovery.
Synthetic checks do not establish a particular phone's browser retention policy.

`test/h66-normal-room.test.js` exercises committed post-Normal ROOM evidence,
tariff-period references, user changes, restart, cancellation and final dispatch
fencing. `test/h66-write-confirmation.test.js` checks all four native settings,
late confirmation without resending and temporary-setting restoration. Executor,
floor integration, MQTT rollback and contention tests cover preparation ordering,
unchanged lease deadlines and durable feedback. Equipment browser checks cover
the preparation message and late native receipt. These synthetic checks establish
application behavior, not a new native pump measurement or physical heat delivery.

`test/charging-status-consistency.test.js` and the shared card/UI regressions
check reported and estimated target attainment, native device holds, zero draw,
missing activity, Automatic/Charge now and retained fault/recovery obligations
on both integrations without changing controller state. The charging-controls
browser fixture exercises the same completed, estimated, still-charging and fault
states at 320/390/1440px in both themes, including recorded master projections
with live native health omitted and the dated caveat retained. The learning browser
fixture checks visible CSS disclosure arrows and Enter/Space behavior rather than retired text
glyphs, awaits chart painting after legend changes and publishes synthetic provider
status before navigation. These checks do not establish physical charger behavior.

`test/recorder-metadata-batching.test.js` verifies unchanged-stream transaction
coalescing. `test/caravan-evidence-renewal.test.js` additionally checks independent
native/meter expiry, real outages, bounded renewal writes, original clocks,
historical prefixes, recovery, failed writer COMMIT, restart and real chart-worker
cache refresh without another value observation. These are offline checks; they
do not establish installed SD-card latency or annual database savings.
The metadata-batching suite retains its checks for transaction
coalescing, exact coverage endpoints/counts, immediate value/quality/gap boundaries,
rollback, failed worker COMMIT, exact retry and restart. Recording status remains
read-only and reflects committed endpoints. `test/charging-plan-snapshot.test.js`
checks that saved executable/accounting evidence retains its meaning while the
live search keeps its full scenario vectors. Charging progress, shared assessment,
session diagnostics, runtime storage and publication tests cover stable unplugged
state, honest live readiness, retained native restrictions, active report reads
after restart and final frozen summaries. No storage format or durability change
is part of these reductions.

History recovery API checks cover the metadata flush before a history mutation,
immediate confirmations while its worker runs, and resumed batching after success,
failure and cancellation. Policy-recovery fixtures explicitly commit their donor
and master endpoints before assessing conflicts.

`test/storage-partial-indexes.test.js` separately checks the current physical schema's
learning-reversal and interval-end index scope, actual query plans, interval-query
parity and reversible access to records outside the index. Current startup tests
reject incompatible schemas before mutation. The journaled data layout and hash
interpretation stay unchanged; installed conversion is not a startup capability.

`test/charging-publication-views.test.js` uses real worker-backed storage and
recorded phase energy to verify that one synchronous publication reads each
charger's history once. Report and physical-assessment results remain current,
the assessors leave their input unchanged, and the next publication sees newly
recorded energy. `test/charging-energy-reader.test.js` additionally compares the
bounded session-energy projection against the uncached reader through late and
overlapping cohorts, explicit gaps, future/admitted clocks, pending-tail flushes,
selection changes, rollback with reused IDs, failed worker COMMIT and restart.
The projection is disposable: new evidence rewinds the affected overlap cluster;
clock reversal or history-selection changes rebuild it. Oversized scopes or
change bursts use the uncached streaming reader, as do read-only and recovery
overlay stores whose source rows can be replaced by another owner. Status reads create no saved
cache, observation or event.

`test/engine-learning-ownership.test.js` checks that a recursively owned immutable
checkpoint reuses its verified digest, a new journal entry produces the same
complete reconstruction, shallow freezing cannot bless mutable data, and failed
updates restore the previous checkpoint. The shared ownership helper lives in
`src/domain/immutable.js`; mutable state still detaches and retains graph aliases.

`test/live-learning.test.js` uses the real dedicated writer and read-only learning
worker to check exact replay and canonical-window parity, unchanged immutable
identity, urgent durable saves during an unfinished calculation, changed control
instructions, joined demotion and input-commit failure. Engine correction,
sensor-reversal, publication and restart tests retain the held interpretation
until atomic correction publication. Learning inputs may commit before the final
control stage; commands still depend on that final durable stage. Offline results
do not establish installed event-loop or save-latency improvements.
The control-preparation regression holds actual writer admission after the
preparation has completed, advances the injected evaluation clock beyond its
existing age limit and requires a fresh control view with exact journal replay.
`test/app-startup-status-commit.test.js` checks recovery of an invalidated startup
view through the staged update, its actual COMMIT, rollback and joined shutdown.
The history-viewer fixture remains outside live-learning worker execution.
Live Automatic and Pause changes await a complete updated response; the same
worker fixture checks saved intent and the returned view after both actions.
With calculation deliberately held unfinished, status retains the previous
complete model, exposes already committed control intent and permits urgent saves.
The first startup view still waits for its own successful publication COMMIT.
It can explicitly report model reconstruction with an absent learned model.
Held-replay startup checks require HTTP status, saved Automatic/Pause intent,
source-clock preservation and manual Reduction/Pause-expiry restoration to work
before replay is released. Model exploration remains blocked, and complete replay
must still match the supported journal after reconstruction and publication.

`test/charging-shelly-system-permission.test.js` queues an older BMW report
behind newer native readback through the real Store publication queue, both
with and without the dedicated writer. The active identification must retain
its attempt, probe deadline and native current-test expiry, preserve the report's
source and receipt clocks, and send no interruption Stop on reconciliation.
Native field receipts precede the queued report; the later readback-round
completion reproduces the observed clock ordering. Global timers remain live.
These checks do not establish physical charger behavior or resolve a native
system-permission withdrawal after Start.

Charging copy ownership checks in `test/charging-copy-ownership.test.js`,
`test/charging-runtime-storage-ownership.test.js` and
`test/engine-charging-copy-ownership.test.js` exercise immutable calculations,
detached mutable views, nested rollback, failed COMMIT, pending committed status
and exact current-format storage publication. Existing runtime, storage,
replication and native-control suites retain scheduling and evidence fences.
`node --expose-gc scripts/benchmarks/charging-copy.js [source-root]` runs the same
synthetic in-memory workload against a selected checkout. It separates initial
adoption from repeated views, rollback snapshots, persistence and status; compares
semantic output fingerprints; and labels GC heap occupancy separately from total
allocations. These measurements do not establish live Pi savings or physical
charging behavior.

The copy benchmark also measures status JSON serialization. Raw fingerprints
describe complete representations and change when their shapes differ. Its
retained calculation fingerprint compares schedules, published prices, costs,
allocations and provenance independently of transient search vectors.

`node scripts/benchmarks/controller-reads.js [source-root]` compares unchanged
checkpoint validation, tick rollback and recorded-energy reads against a selected
checkout using synthetic current journal inputs and a real temporary writer.
It verifies complete replay/energy parity and emits a semantic fingerprint before
reporting timing. Synthetic timings do not establish installed performance.

Storage health coverage uses the current transient version-3 health/history
contract and nested version-2 local-operations contract.
`test/database-range-reads.test.js` checks time-window ingestion order, late
timestamps, cursor limits and active recovery exclusions. A file-backed writer
fixture retains more encoded temperature history than one writer response can
carry and requires selection through multiple pages of invalid candidates.
Charging-energy reader tests retain independent source, receipt and deferred
admission clocks, overlapping intervals, rollback and restart parity. Chart
coverage/recovery tests retain long spans, preceding outages, equal-start
continuations and historical as-of selection. Firewood cache tests verify that
moving the clock alone does not repeat committed-history pages. These correctness
checks complement small/year/three-year fixed-window measurements; test completion
alone does not prove bounded native SQL time or physical control responsiveness.

`test/firewood-incremental.test.js` compares cached and full-source results through
forward loads, model-revision adoption, reporting-only updates, training-boundary
changes, numerical scenario changes, deferred source clocks and restart. The
holdout checks withdraw old validation and reaccumulate complete original segments
when a boundary crosses a saved evidence cell. Real worker maintenance advances
without another chart request. `test/firewood-projection-cache.test.js` separately
checks bounded source admission, interrupted writes, source-ancestry rejection,
pruned proofs and cursor-based suffix rewind. These checks preserve exact current
results; they do not make genuine numerical model changes independent of history
or establish physical Raspberry Pi timing.

`test/storage-control-coverage.test.js` and
`test/control-attempt.test.js` check exact-once known-unsent outcomes, safe parent
rollback causes, query/post-dispatch exclusions and monitoring enable/disable
history. Adapter suites exercise the same accounting at native boundaries.
`test/storage-operation-health.test.js` and
`test/storage-operation-owners.test.js` cover bounded monotonic retention,
owner deduplication, dated refusals, failures retained after later successes,
cause-based cancellation/worker joins, passive diagnostics and publication
uncertainty. `test/database-export.test.js` includes failed outer downloads after
a successful inner copy, transfer lifetime and unconfirmed final publication.
`test/browser/recording-health-smoke.js` renders real
collector evidence against production markup at 320/390/768/1440 pixels in both
themes, including local operations in snapshot scope, focus/disclosure retention,
grouped observed tasks, a single period selector and dated historical problems
independent of writer readiness. Period changes must preserve the current overview
and keyboard focus; a snapshot retains local-task evidence without borrowing the
live controller's writer history.
These offline checks establish instrumentation behavior, not live equipment
receipt, physical outcomes or Raspberry Pi storage performance.

`test/database-overview.test.js` cross-checks the bounded inventory reader
against the direct offline calculation across source, selection and storage
fixtures, and checks the fast catalogue, explicit shared jobs and cancellation.
`node --test --test-timeout=180000 test/extended/recorded-inventory-scale.test.js`
checks 100,000 mixed synthetic observations, concurrent recording and exact
snapshot results while cheap views remain independent.
`test/energy-checks-worker.test.js` covers independent background jobs, append
cache continuity, corrections, receipt cutoffs, clock rollback and exact energy
parity, including synthetic mixed week/month/year workloads. These densities
and developer-host timings do not qualify Raspberry Pi storage. Read-only API
access on standby and safe failures are covered by
`test/recorded-data-api.test.js`; browser request cancellation and late-response
fences are covered by `test/energy-check-refresh.test.js`. Date-scoped checks
include complete meter/session boundaries, empty selections, DST days, concurrent
different periods, explicit refresh and the absence of automatic completed-job
rechecks. The recording-health browser fixture checks every nested disclosure's
responsive inset separately from outer card padding, including widths either
side of responsive layout breakpoints, compact inventory issues and their focus
retention, independent energy date controls, and mobile counter-only storage
explanations. Storage UI regressions
keep queued, background and local-task failures separate and label past-day
fallback when the selected period is unavailable. The model-verification
browser fixture also renders all History tools and recorded-data job states at
320, 390, 768 and 1440 pixels in both themes.

`node test/browser/dashboard-refresh-smoke.js` runs the complete built dashboard
against a disposable simulation. It checks matching seven-day defaults for cost
comparisons and Energy checks, lazy comparison requests, initial render, repeat
status updates, role changes, advancing standby snapshots, energy refresh and
reload. It asserts that the dashboard error banner stays hidden as well as
checking uncaught browser exceptions: errors handled inside the dashboard refresh
path must fail validation.


Run checks from the repository root. Ordinary tests, browser fixtures, container
checks and Garage simulations use synthetic data. The separately invoked live
suite contacts configured providers; see [live testing](live-testing.md).

`test/storage-priority.test.js` checks real worker-backed control/ordinary priority
between background turns, release only after worker exit, frozen peer staging
under concurrent writes, admitted urgent saves during mirror export and FULL
durability with runtime-owned checkpoints. Chart cancellation also covers a
terminated worker whose storage admission is still queued, followed by a real
urgent save. Existing queue, writer, peer, chart,
cache, recovery and pairing tests retain their current transaction/publication
contracts. These tests do not establish a maximum installed filesystem-sync time;
live trials must measure complete save latency, checkpoint duration, background
progress and storage failures together.

Floor control checks cover the current Sonoff lease protocol, independent manual
masks, immutable deadlines, stale request rejection, restart restoration, changed
device/broker identity, partial feedback and publication after storage waits.
`test/floor-learning-boundary.test.js` checks that manual activity between controller
ticks remains in the immutable learning inputs and that late feedback cannot
rewrite earlier contexts. `test/floor-controls-api.test.js` covers command shape,
admin access, master authority and private error suppression. Existing floor
planner, cycle and recording checks retain the distinction between pooled
treatment, GPIO output history and unknown physical heat delivery.
`test/browser/floor-smoke.js` uses an isolated synthetic application to exercise
individual controls, pending actions, keyboard/focus preservation, setup navigation,
read-only states and phone/desktop layouts in both themes. No floor fixture
commissions installed wiring or measures relay contacts, valves or water flow.
The floor UI checks keep live status and release obligations in Home, installation
content in Connections & configuration, and connection availability separate from
commissioning and control readiness. They also compare the shared availability
headers and preserve report clocks, keyboard focus and disclosure state.
The separate firmware repository owns its own host tests and firmware builds.

`test/charging-session-pause-runtime.test.js` exercises both charger controllers
through the runtime with synthetic native responses. It covers Pause during
Charge now, unchanged Automatic preference, ready-by expiry, same-session restart,
unplug/new connection, persistence rejection, waiting-plan resumption and peer
service. Provider suites cover native ownership, source-timed external resumption,
transaction rollover and uncertain writes. Browser charging controls fixtures
check the shared Pause/Use automatic row at 320, 390 and 1440 pixels in both themes.
These checks do not qualify physical Pause/Resume or native schedule takeover;
those require separate live testing with current device evidence.

`test/provider-http-cancellation.test.js` runs the real HTTP transport and
application reload/shutdown against held loopback responses in bounded child
processes. Explicit garbage collection covers cancellation before headers,
after headers and after a valid but incomplete JSON prefix on each test runtime.
The source socket remains open until the transport settles, so fixture cleanup
cannot mask a stuck body read. Unit transport checks preserve caller/close versus
deadline error codes, reject cancelled empty command replies and remove completed
request listeners. These fixtures make no external provider or device requests.
The Shelly lost-restoration-reply fixture expires only the selected native RPC
callback; real Store admission and yield timers continue on their usual scheduler.
Global timer freezing cannot stand in for a native deadline while persistence is
still active.

`test/charging-shelly-periodic-read.test.js` exercises the actual native adapter,
controller, runtime and Store with one manually invoked existing polling callback.
It verifies a single completed read round for an unchanged periodic episode,
independent acquisition during held Store admission and controller planning,
one-use owner/session/input fences, rollback and post-commit failure, and fresh
explicit/takeover/post-write confirmation. A round has two scoped component
requests and a schedule request. Missing, duplicate or foreign component rows,
role ownership, missing service/setting data, source-time admission and real
combined-packet COMMIT rollback are covered; control failures retain independent
physical observations. Native replies and economic results
are synthetic; reduced request count is not a measured device-latency improvement.

Time admission regressions in `test/time-evidence.test.js` and
`test/time-evidence-integration.test.js` cover original timestamp preservation,
bounded source-clock leads, causal temperature/learning prefixes, voltage restart
and native energy. Adapter suites additionally cover asynchronous receipt clocks,
automatic deferred admission, ordered session/permission transitions, disconnect
and transaction rollback. Large skew remains invalid; freshness, authorization
and physical deadlines receive no general grace. See [time and evidence](time-evidence.md).
`test/caravan-writer-source-admission.test.js` uses the actual MQTT admission and
Store queue to hold a ready report behind a writer for more than five seconds.
It also injects a synchronous delay at the real Store COMMIT entry, without
claiming a measured disk or fsync delay. Both paths preserve original clocks,
qualified demand and the historical gap; expired required evidence and a real
disconnect remain unavailable.
The temperature-control fixtures hold the actual publisher before its final
admission gate, and separately combine missing-air then warm reports in one real
Store transaction. Warm unqualified recovery preserves the native baseline,
including the hysteresis band, while cold, expired and unadmitted future room
evidence still protect Off. Known-unsent cancellation permits a later genuine
protective Off without the old attempt's retry hold, and cannot erase an earlier
dispatched uncertain command or a newer request. These synthetic orderings do
not identify the cause of an observed household power transition.
The Shelly EVSE suite holds the same writer boundary across a native permission
Stop. Its original event/source/receipt clocks remain distinct from a later
correlated setting readback; neither pending nor admitted Stop sends a Start.

History recovery checks must validate and inventory the source without making a
trial database or importing rows. Acceptance and model impact are assessed once,
against the current master during recovery. `test/recovery-scheduling.test.js`
exercises progress persistence and concurrent controller writes while import
batches yield their SQLite write lock. Reversal tests cover the same worker
scheduling during journal reconstruction. Keep phase cohorts atomic when bounding
transaction work; an event-loop yield in the worker alone does not prevent it
from repeatedly taking the lock before the controller can write.

Correction publication tests use resolved learning segments that produce roughly
1.8 MiB checkpoints through the actual Engine, recovery, revert and restore paths.
They verify exact replay, retained original history and unchanged charging control
choices. Worker boundary tests hold publication before and after commit, drop its
reply, revoke authority and inject a final-write failure. The next admitted write
must observe the adopted complete model; rollback must leave the previous model,
selection and plan intact. Cache-status tests distinguish confirmed persistence
from stale, failed and rolled-back attempts. These offline checks do not qualify
household equipment or Raspberry Pi storage latency.
The late cache-error and older-result fixtures use the actual Store, cache and
Worker listeners. They hold only the second save message while publishing and
confirming the newer inline checkpoint, then dispatch that original message once
before injecting the older event. This fixes the intended listener ordering
without introducing unrelated competition for SQLite's writer during fixture
setup; production admission, locks, retries and checkpoint fences are unchanged.

`test/acquisition-contention.test.js` injects rejected saves, full queues and
out-of-order completions. Recovery must use a later committed delivery from the
affected input/device without reconnecting; retained, duplicate, ignored and
unrelated receipts cannot clear it. Native read-only status requests can refresh
evidence while mutations stay fenced. Tests distinguish an admitted packet from
a cached reading with the same timestamp.
The circulation regressions also hold a real SQLite writer lock across queued
telemetry and native readback. They verify one dispatch after admission and no
late dispatch after expiry, authority/identity changes, disconnect, shutdown,
stale feedback, timeout or a failed save. Controller event tests check that safe
error codes survive without exposing raw transport details.

`test/mqtt-equipment-dispatch.test.js` holds a real SQLite writer lock across
door and generic switch requests. It checks one dispatch after storage admission,
post-dispatch committed feedback, Stop supersession, changed-state cancellation
and no delayed command after expiry, disconnect, shutdown, lost authority or a
failed save. Gen1 relay tests apply the same wait while requiring newly admitted
state after dispatch. H66 and Garage adapter tests exercise original deadlines,
identity/challenge changes and native readback across delayed publication. The
installed MQTT.js tests also cancel a request while its outgoing store is delayed.

Startup rejection tests exercise the real application constructor and snapshot
workers with unsupported charging state. Compare original database bytes, state
and interrupted WAL companions, not only the thrown error. Current saved state
uses shared validators; constructor ordering must not create an earlier Garage
configuration write. Writable worker opening must still permit ongoing live WAL
recording after read-only validation.

Handover preflight tests include an empty receiver, an incompatible retained
snapshot and cached/pending compatible transfers followed by incompatible current
state. Preflight always requests a fresh checkpoint before stopping the master.
`test/extended/pair-handover-scale.test.js` runs real encrypted loopback HTTP,
snapshot workers and concurrent recording with larger synthetic databases. VIP
and equipment hooks are simulated. It verifies one owner, final retained records,
integrity and failure before service interruption, while reporting total,
preflight and simulated control-gap timings separately. Its warm return handover
rejects any attempt to create a full snapshot, retains the same database inode and
reports incremental handover latency and filesystem I/O. On Linux it also bounds
`/proc/self/io` read/write bytes, so cached full-file scans cannot hide behind zero
physical read blocks. These process-wide counters also include repeated worker
module loading and schema validation: a syscall trace attributed about 30 MiB of
the roughly 36 MiB warm read total to application/dependency files. Every run
therefore includes a 1 MiB payload baseline, limits read growth to 4 MiB above it,
and retains a 48 MiB absolute read cap and 8 MiB write cap. The default larger
payloads are 32 and 128 MiB; custom scales also run the baseline. To run a larger case:

```sh
STMQ_PAIR_SCALE_MIB=512 node --test --test-timeout=180000 test/extended/pair-handover-scale.test.js
STMQ_JOURNAL_SCALE_MIB=4,512 node --test --test-timeout=180000 test/extended/incremental-storage-scale.test.js
node scripts/benchmarks/recovery.js --records=1000,10000,50000 --windows=96 --payload-bytes=128
```

Neither benchmark qualifies physical Raspberry Pi storage, HA scheduling or
device reconnect time. Keep the production source-only check contract during
benchmark adaptation: checking creates no candidate master or trial merge.

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
Shared-lineage rejoin tests retain the divergent journal branch, including
excluded records, while proving that later promotion uses the accepted checkpoint
and cannot reactivate retained control state. Independent-database repair tests
retain the original full donor. The paired MQTT
source-context tests exercise actual recording and equipment consumers across
handover and restart so a transport change cannot create a new device identity.

`test/replica-checkpoint-diagnostic.test.js` holds the actual chart-worker readiness
boundary while another verified peer publication completes. The original request
must open that current generation once, preserving its source clock. A further
publication race, failed rollback, missing or unreadable manifest still refuses
the read. The same suite holds the prepared manifest's file synchronization while
the old SQLite checkpoint remains readable through the real Store/chart worker
and HTTP. It separately holds the final rename after actual SQLite COMMIT to
retain the checkpoint refusal and unknown-error privacy checks; no cached
database or weaker fence supplies a successful response.

`test/journal-publication-ordering.test.js` uses actual transfer/apply workers and
fresh synthetic Stores under the receiver lock. Preparation write/fsync failures,
post-preparation authority/cancellation, row-application rollback, lost worker
acknowledgement, final rename/directory-sync failure and receipt-removal failure
must preserve the exact old or committed checkpoint and current recovery receipt.
Metadata-only and peer-seed publication retain original source clocks and anchor
semantics. Existing crash tests add incomplete temporary bytes to prove that
reconciliation selects the durable receipt and actual checkpoint instead of
trusting staging. These checks do not measure storage latency or identify a
particular household refusal's cause.

The same actual Store/chart-worker producer also qualifies bounded private refusal
phase logs: pending/same manifest, missing/unreadable manifest, second race and
failed rollback keep their original public bodies and SQL/manifest call counts.

Completed rechecks and close retain their original outcomes. A throwing log sink
cannot alter the real COMMIT-before-manifest refusal or recovery. The producer
checks that original reporter wall and monotonic readings fall inside the
test-owned receipt brackets of a matching refused HTTP request; this establishes
local ordering, not a unique request identifier or a publication cause.
`test/replica-read-refusal-phase.test.js` checks immutable constructor provenance,
spoofed/accessor input refusal, failed sinks and diagnostic storage, and the
on-demand 30-second cap with controlled monotonic advances. Clock tests retain
observed wall rollback, reject unsafe or throwing wall readings without forwarding
their values, reuse the existing monotonic sample and bound the full scalar record.
The cap tests do not hold wall time for 30 seconds or change request deadlines.

`test/ocpp-startup-phase-producer.test.js` uses real Store transactions and
synthetic loopback WebSockets to separate listener/TCP/Upgrade callbacks, held
writer admission, original message receipt and committed transport acceptance.
Its synchronous hold at COMMIT entry is a controlled producer delay, not a disk
or fsync measurement. Failed COMMIT, successful COMMIT with failed follow-up,
authority loss, dead queued clients, malformed first frames, replacement sockets
and throwing sinks retain the original admission and authority behavior.
`test/ocpp-startup-diagnostics.test.js` qualifies real after-commit provenance,
unknown/nontransactional adapters, fixed private scalar output and lazy finite
clock/attempt/event/byte limits. Existing OCPP contention/lifecycle suites retain
shutdown, rebind, session and no-late-write checks. None of these fixtures measures
a household charger, wire SYN, native hardware retry or physical storage latency.

`test/incremental-replication.test.js` compares identical changes over 1 and 32 MiB
of synthetic payload, verifies equal bounded transfer size and database inode
reuse, injects a disconnect during a multi-frame transaction, and exercises crash
receipts before and after SQLite commit. `test/extended/incremental-storage-scale.test.js`
measures startup, checkpoint, suffix export and mutation over larger retained
databases. `test/database-verification.test.js` checks full scan independence,
checkpoint alignment and corruption detection. Full initial seeds and optional
full checks are measured separately from routine operation; cache-dependent timing
alone is not proof of bounded I/O. These are controlled Linux fixtures, not
qualification of physical Raspberry Pi storage or household failover.

Compact learning storage is covered by `test/learning-checkpoint-storage.test.js`,
`test/learning-checkpoint-archive.test.js`, `test/learning-checkpoints.test.js`
and `test/journal-peer-audit.test.js`. They check exact normalized values,
independent duplicate samples, coherent hydration, insert-only peer bodies,
dependency arrival order, atomic rejection and retained divergent references.
The cache, Engine and recovery publication suites retain restart, control intent,
source correction and recovery revert/restore behavior. Prefix tests reject
unsuitable metadata before fetching prepared bodies, allow journal reconstruction
when a sparse cache is unavailable, and propagate unexpected database failures.
`test/extended/learning-checkpoint-storage-scale.test.js` compares accumulated
logical cache payloads across 96 segmented learning windows and measures
fresh-process hydration, one new window and incremental pairing over the same
working set in databases with 4 and 128 MiB of unrelated synthetic history.
This separates shared-body and sparse-manifest growth from unchanged source
history; it is not an annual total-size forecast or a cold operating-system-cache
benchmark. The cross-runtime suite also transfers current-algorithm compact
learning checkpoints and independently verifies them on both runtimes.

`test/extended/adaptive-journal-scale.test.js` checks sustained constant recording,
SQL no-ops, compact edits to large state, concurrent full verification and an
enrolled peer returning after several transaction-retention cycles. The
[SQLite storage benchmark](sqlite-storage-benchmarks.md) gives reproducible
commands, measured before/after allocations, full learning replay checks and the
remaining synchronous filesystem limits. Keep useful history, journal payload,
indexes, reusable pages, WAL, transfer files and serialized network bytes separate.

Journal changes must also run against the pinned add-on Node version in
`Dockerfile`, not only the developer's installed Node. SQLite numeric JSON
rendering and embedded-NUL TEXT handling differ across these runtimes.
`test/storage-journal-precision.test.js` checks exact stored values, rejected
unsupported scalars, bounded capture and independent corruption detection.

Charging write reduction is covered by `test/charging-allowance-cadence.test.js`,
`test/charging-runtime-allowance-order.test.js`,
`test/charging-runtime-allowance.test.js`, `test/charging-runtime-storage.test.js`
and `test/charging-replica.test.js`. They exercise SQL-free unchanged callbacks,
queued transition ordering, rollback, actual observed endpoints, coherent dated
views, immediate durable control/session facts and original plan references.
The storage fixtures include views produced by the production charger runtime.
`test/recorder-metrics-batching.test.js` covers pending live diagnostic totals,
immediate selected-record accounting, nested/outer rollback, committed consumer
failure, hour boundaries, bounded RAM, expiry and file-backed restart. Existing
recorder suites retain energy conservation and learning-input coverage. Write
counts and journal bytes in these controlled fixtures establish reduced work;
they do not establish installed Home Assistant stall or MQTT latency gains.

For a real process boundary between two installed runtimes, run:

```sh
STMQ_OTHER_NODE=/absolute/path/to/node22 STMQ_REQUIRE_CROSS_RUNTIME_TESTS=1 node --test test/extended/journal-cross-runtime.test.js
```

This checks initial seed verification, catch-up after compaction, exact replica
rows and reverse-direction updates. It does not replace testing the deployed HA
and Ubuntu applications, their actual transport, restart and live recording.

When adding or changing a persisted source reference, update its owning dependency
extraction and add a synthetic test with explicitly expected recovery edges. Do
not calculate the expected edges using the production extractor. Exercise
exclusion and reinstatement where that reference affects corrected learning,
while preserving original evidence and unrelated inputs.

`test/recovery-learning-prefix.test.js` grows retained learning history from 256
to 4096 entries while recovering, reverting and restoring the same recent change.
It checks exact agreement with full reconstruction, constant staged suffix size,
bounded measured I/O, authority loss before publication, and the actual SQLite
seek operands. `test/recovery-incremental.test.js` also checks aggregate query
plans: a keyed join to a union view can still materialize all historical rows,
so source inventories use private scratch rows containing only the changed keys
and their required evidence.

The charging search and replanning regressions cover exact allocator parity,
cache isolation, bounded refinement, independent flow examples, one/five-cent
replacement boundaries, quiet/max settling, idle no-work behavior and preserved
native stop/restoration duties during held numerical work. The held-worker
fixtures request a genuinely changed model; calculation age alone is not a trigger.
See `test/charging-search.test.js` and `test/charging-replanning.test.js`.

The Shelly compatibility suites cover 10/30/60-second recovery, the connection
cap, independent Charge now budgets, durable deadlines, current/zero/readiness
fences, later Stops, paused/closed schedules and sustained draw. Real adapter /
controller fixtures verify dispatch through the ordinary Start path and normal
return to Automatic after exhausted immediate charging. Session diagnostics
checks preserve brief SYS cycles, firmware context, resolved findings and dedup
across restart. The controls/report browser suites retain the existing toggle
and conditional event presentation. Synthetic results do not establish firmware
causality or prove that every physical failure recovers.

## Automated tests and build

The native OCPP background-read cases in `test/easee-ocpp.test.js` exercise an
idle charger that supplies only clock-aligned data, actual triggered zero power,
healthy periodic reporting, monotonic throttling across wall-clock changes,
silent and unsupported sampling, command preemption, late acknowledgements,
deferred-publication revalidation, demotion and reconnect. They preserve interval
exclusion, original measurement clocks and unknown readings until a genuine
native report arrives.

### UI messages and evidence

Check the complete path from the producing condition through the public response
to the displayed text. A message test must distinguish materially different
outcomes, such as a rejected request, a lost reply, an accepted operation and
confirmed device feedback. Use safe authored causes; native exceptions can contain
private paths or data. An unknown cause must stay unknown.

Recovery API/UI tests exercise malformed and working database uploads, size and
storage failures, timeout, interruption, permission changes and retained request
identity. Verification tests distinguish unsupported data, integrity failures,
interrupted checks, refused starts and failed status reads with a previous result.
Network tests distinguish malformed JSON, interrupted bodies and deliberate
cancellation. Pairing and source-correction tests retain observed receipts across
late replies, later polling failures and the 24-hour receipt lifetime.

Learning verification fixtures compare complete saved checkpoints and all four
recorded coefficient histories with independent seed replay at fixed boundaries.
Test pause/restart/resume with five-minute rolling checkpoints, cancellation,
discard after stopped-worker cleanup, uncertain request identities and source
supersession. Recovery → revert → restore and source corrections must publish the
model and its coefficient generation together, preserve unrelated later history,
and reject delayed work. Cover missing or corrupted verification files, model-only
and timeline-only mismatches, disk failure, replica replacement, and terminal
failure without automatic retry. Measure cold audit time, temporary disk/WAL use,
indexed chart latency, memory and controller responsiveness on long synthetic
history. Main database content and device authority must remain unchanged by the
verifier.

`test/live-learning-coefficient-staging.test.js` drives a large genuinely new
coefficient tail through the read-only worker and real storage writer. Every
intermediate transition must survive bounded page admission and a small atomic
final publication. Measure actual commit sizes, retain the old selected timeline
until publication, skip already recorded chart prefixes during model-cache
reconstruction, and discard a superseded worker's explicitly owned staging data
without removing source inputs or selected history.

`test/model-reconstruction-ui.test.js` checks fixed-boundary wording, independent
model/history results, exact model-mismatch counts and bounded schema paths,
finite concise deltas, diagnostic rounding-consistent presentation with unchanged
exact mismatch state, larger/structural negative cases, replay runtime, snapshot
age, safe temporary-file discard, strict current
actions, authenticated viewing and admin actions on a slave. It fences stale
responses and logout, retains uncertain request identity across reload and stops
browser polling when hidden without cancelling server work. The isolated
`test/browser/model-reconstruction-smoke.js` uses actual panel markup/styles with a
synthetic API across 320/390/768/1440 px and both themes. The
`test/browser/model-reconstruction-service-smoke.js` uses disposable file-backed
learning and actual standalone/slave endpoints. Neither accesses household data.

Charging identification tests exercise each prerequisite and its public reason
without relaxing the control gate. Cost tests distinguish complete session costs
from remaining estimates and disclose inferred energy. Home heating and Caravan
tests keep unconfirmed delivery separate from matching device readback. Recorded
views cannot use saved progress to claim a worker or physical control is active.

`test/https-storage-lock.test.js` checks one Linux kernel owner under concurrent
acquisition, separate-process and canonical-path exclusion, repeated normal
release and SIGKILL recovery without filesystem claims. Retired PID-only lock
artifacts are rejected unchanged for explicit stopped repair. Existing HTTPS
runtime and web-access checks retain certificate, identity and controller
availability boundaries; these fixtures do not enroll or operate a live helper.
`node test/container/https-lock.js IMAGE` additionally checks real bind aliases,
independent volumes at identical container paths and repeated container PID 1
crashes. It mounts only temporary synthetic directories and the HTTPS source;
host networking shares the abstract-socket namespace without opening TCP ports.

`test/https-remote-access.test.js` checks exact foreground TCP-only admission,
Funnel/Web/service/extra-handler rejection, observed shields, stable refresh,
owned-process removal, crash recovery and return to certificate-only scope.
The HTTPS manager suite covers the paired VIP and current port, restart without
reenrollment, remote failure with local TLS retained, stale exit fencing, expiry
and enabled-peer retention. Vendor runtime preflight now requires TCP Serve and
foreground/background CLI capabilities in addition to certificate operations.
These fixtures do not prove an external phone's DNS, tailnet policy or reachability.

For changed UI surfaces, run their browser fixtures at narrow and wide widths in
both themes. Preserve focus, quiet background refresh and compact normal states;
put detailed causes and provenance in existing disclosures. These fixtures use
synthetic equipment and do not establish physical delivery or device behavior.

`node test/browser/secure-web-access-smoke.js` loads the dashboard’s actual runtime
stylesheet imports in their production order. It checks optional HTTPS setup,
missing authorization links, current faults and past receipts, certificate and
listener readiness, owner/standby/admin/family boundaries, custom selectors,
keyboard focus and mounted disclosure state. Its layout cases cover both themes
at 320, 390 and 1440 px, all ten rounded section folds including Home learning,
and the distinct leading markers for comparisons and Recording details. Long
status text and a visible recording warning badge are included. The fixture uses
reported default and alternate HTTPS ports, unknown/wildcard/loopback household
destinations, application-local recovery endpoints, unknown security status despite
matching releases, retained urgent evidence and aligned label/value metadata.
Expanded DNS and helper disclosures are checked at each width and theme. It uses
synthetic endpoint responses, blocks external browser requests and never starts
a certificate helper or accesses installation configuration.

Set `STMQ_WEB_ACCESS_SCREENSHOT_DIR` to keep the synthetic screenshots and
geometry results. An optional `STMQ_WEB_ACCESS_BASELINE_DIR` can supply a separately
prepared public `index.html`, `monitor.js`, `monitor.css` and the styles imported
by that script for comparison of intentionally unchanged disclosure families.
That comparison is validation evidence, not a historical application runtime.

`node test/browser/charging-flexibility-smoke.js` uses synthetic charger cards to
check unchanged resting height at 280–1280px in both themes, guarded keyboard
interaction, retained comparison snapshots and adoption of changed display values,
active-allowance savings, earlier/approved deadline labels and checkpoint highlight
removal. Real report buttons share the comparison button's arrow geometry; checks
also cover Help & setup alignment. `STMQ_CHROME_BIN` can
select a local Chrome executable. Backend regressions separate displayed
comparison scope from live command readiness: small telemetry changes and failed
recalculations retain the prior estimate, while replacement sessions and changed
requests cannot inherit it.

The electricity-price forecast uses synthetic provider fixtures for units,
native hours, gaps, freshness, throttling and RAM-only acquisition. Charging
flexibility tests cover renewable calendar-day checkpoints, durable deadlines,
restart/identity fencing and joint cost comparisons separately from billed cost.
Normal and extra-day plans share forecast eligibility and uncertainty handling;
regressions cover equal forecast opportunities, extra time that changes the
economic choice, published-price precedence and unavailable forecasts. A real
worker regression advances the clock while a forecast-only plan calculates;
unchanged price evidence must still allow publication. Comparison caches expire
at either alternative's proposed period boundaries and deadlines. Family
access checks cover viewing/refreshing the comparison and allowing/canceling the
day without relaxing session, authority or admin-only configuration boundaries.
`node test/browser/electricity-forecast-smoke.js` checks the actual chart and
feed entry with no connected cars, sparse canvas strokes, shared colors/toggles,
unchanged date controls and 320/390/1280px layouts in both themes. Run after the
dashboard build; it creates an isolated offline database and browser profile.

```sh
npm ci
npm run check
```

`npm run check` builds the dashboard before running the routine tests. Startup
and control-authority tests verify that the actual application keeps serving its
dashboard, so run `npm run build` once before invoking `npm test` directly in a
fresh checkout. CI uses the same `npm run check` command.

`npm test` (also `npm run test:unit`) runs the routine offline regression suite
with at most four test files in parallel and a 60-second deadline per test case. Pairing
handover, outage promotion, recovery correctness and rejoin regressions remain
in this suite. New top-level `test/*.test.js` files are included automatically.
The offline runner gives every file its own Node process and applies the deadline
through the public `node:test.run()` API, preserving application signal ownership.
This preserves process isolation and the same case budget on Node 22
and newer versions; Node 22's default isolated runner also applies the command-line
timeout to the entire file, which can cancel a long file of successful short tests.
Use `npm test -- --test-name-pattern=...` to select matching cases.

For native Home Assistant / ARM64 qualification on SD storage, use the explicit
test profile (also available as `npm run test:ha` and `npm run test:ha:extended`):

```sh
node scripts/test-offline.js --profile=ha-sd --report=/private/results/routine.jsonl
node scripts/test-offline.js --profile=ha-sd --extended --report=/private/results/extended.jsonl
```

This runs two routine files or one extended file at a time, with three-minute
routine and fifteen-minute extended case budgets. Explicit bulk-fixture process
budgets use five times their standard allowance. Selected synthetic latency
guards use the larger of twelve seconds or four times their standard bound to
admit occasional several-second storage or scheduling stalls. The standard
profile retains its existing bounds. These are test qualification limits, never
changes to production freshness, device, SQLite lock or control deadlines.
CI permits forty-five minutes for each complete routine/extended job, including
setup; individual standard-profile case and latency limits remain unchanged.

Both profiles retain exact results, reconstruction, integrity, authority,
transaction ordering, bounded rows/bytes and actual concurrent-work assertions.
Always report measured timings; passing the SD allowance neither attributes a
stall to the card nor establishes normal household responsiveness. Deterministic
contention tests must still prove writer admission and progress between batches.
Fixture completion waits use the case's cancellation rather than an unrelated
short polling count; safety ordering remains asserted before held cleanup ends.
Settings-reload fixtures record identity announcements separately from the
acquisition/command connection and deliberately include discovery traffic in
the no-circulation-command case. A periodic identity heartbeat cannot become
evidence that a relay command was dispatched.
The held manual-current publication fixture controls the adapter's periodic
poll timer explicitly. Its positive case admits a normal poll before takeover;
the competing-input case injects a newer native reading during the held COMMIT.
Real RPC, persistence and instruction checks remain active in both cases.
Equipment shutdown fixtures drain received native replies and writer effects
under case cancellation before asserting restoration-before-close ordering.
The real MQTT/floor writer-boundary fixture likewise waits for actual ingress
and committed effects without a separate short poll deadline; its 1,800 ms
acquire timer, unchanged lease, known-unsent and late-release refusal checks
remain independent and active.
HTTPS replacement fixtures use the production root/non-root helper identity
location and ownership policy, including unprivileged helper state when run as
root. Restart validation must accept a faithful fixture without weakening its
path, permission or installation-binding checks.

JSONL receipts identify runtime, architecture, source revision/dirty state,
resource limits, selected budgets, file exits, failed case names, nesting and
parent/cancellation failure types. Retain original failures separately from
corrected reruns. Run in a disposable container with no household mounts or
provider network, on the native ARM64 host; an emulator is supplementary evidence.

`test/Dockerfile.qualification` packages the same pinned Node/Alpine runtime as
the add-on, locked development dependencies and native test prerequisites
(including OpenSSL, Python Jinja2/PyYAML, SSH, MQTT and SQLite replication). Build it from the selected
source on the target architecture, then run without household mounts:

```sh
docker build -f test/Dockerfile.qualification -t stmq:qualification .
docker run --detach --name stmq-qualification --network none --cpus 2 --memory 2g stmq:qualification
docker wait stmq-qualification
docker cp stmq-qualification:/qualification/. /private/results/
```

The image runs build, routine and extended checks, preserving each log and
receipt even after a failure. Its synthetic Git commit supports installer
fixtures; compare `sourceDigest` to identify the actual tested source. Retain
the exit status and inspect declared optional-prerequisite skips. Remove only
the disposable qualification container after copying its results. Do not mount
the Docker socket, installed configuration or household databases into it.

HTTPS fixture completion waits observe the original accepted operation until its
terminal state is published, under the test case's cancellation and deadline.
They do not impose a separate one-second poll limit on filesystem publication.
Controlled held-work cases verify both delayed completion and cancellation;
their owned gates release before manager cleanup even if a fake SDK ignores abort.

`test/mqtt-startup-readiness-diagnostic.test.js` drives real MQTT.js protocol
packets through an owned in-memory stream and holds a real synthetic SQLite writer.
The fixture holds CONNACK until integration construction finishes, then acquires
the competing writer before releasing CONNACK. This isolates subscription
admission from synchronous setup while retaining real native callbacks and locks.
It distinguishes delivered SUBACK callbacks from Store commit admission using the
actual twenty-second wall timer, and covers close, transport loss, absent CONNACK,
rejected grants, unknown queue evidence and stale callbacks after replacement.
A progressing-admission fixture also completes after the former ten-second
limit. Transport-loss and absent-CONNACK diagnostic tests accelerate only the
readiness timer. No household broker or equipment is contacted. `test/mqtt-startup-diagnostic.test.js`
checks bounded immutable provenance and private-value refusal; paired startup tests
retain protected fallback even when the diagnostic sink fails. These diagnostic
fixtures do not qualify native reconnect budgets or infer the cause of a live timeout.

The optional extended Node package runs separately:

```sh
npm run test:extended
npm run test:all        # routine followed by extended
```

Extended tests live in `test/extended/`, run one file at a time, and retain
a three-minute deadline per test case. Serial files keep unrelated bulk fixture writes
from contaminating another benchmark's latency measurements. Each workload still
exercises its concurrent recording, HTTP requests, transfers and failure cases;
the selected profile declares its latency guards. These measurements do not establish latency
under arbitrary competing host I/O. They cover recovery at larger history volumes,
full persisted-learning replay across a restart, and real SQLite mirroring
through SSH. Sensor duplicate delivery, independent broker routing and paired
MQTT handover regressions run the installed MQTT.js client against isolated
Mosquitto brokers and transport proxies. Install `mosquitto` to run them; set
`STMQ_REQUIRE_MQTT_TESTS=1` to make a missing broker fail instead of skip. Cheap
mocked transport validation stays in the routine suite. These tests use synthetic
data and local processes; they make no paid model or provider API calls.

The larger recovery responsiveness case uses 4,000 observations, 672 learning
windows and one attempted concurrent event write every 100 ms. Its heartbeat
still samples every 10 ms. Standard hosts retain the 1.5-second write and
2-second heartbeat/HTTP limits; the explicit SD profile uses its declared
allowance while retaining the raw measurements. This is a bounded synthetic regression workload, not a
measured household traffic profile. The shared helper defaults to the heavier
10 ms write interval for the routine workload and optional benchmark. Retain
actual write overlap, replay, backup and historical-evidence assertions when
changing these fixtures; reducing write frequency must not reduce heartbeat
sampling or manufacture overlap after an operation has finished.

A failed guard remains a failure against its declared profile even when the
baseline also shows slow storage. Compare the same workload and runtime, separating writer admission,
transaction execution and event-loop delay. Syscall tracing can attribute a wait
but changes execution timing; retain the original failure alongside diagnostic
runs. Do not weaken durability or production deadlines; change a test budget
only as an explicit supported-hardware qualification choice with retained
correctness and bounded-work checks.

`test/storage-transaction-timing.test.js` injects bounded waits separately into
the production journal seal and raw native COMMIT, checks attribution within the
unchanged total, and exercises original-error rollback, failed BEGIN, nested
savepoints and unreadable diagnostics. `test/storage-write-health-history.test.js`
covers null/unmeasured stage counts, the 128-attempt bound and five-minute expiry;
authenticated health and recording UI tests check the current public fields and
honest checkpoint/sync labels. Synthetic waits establish timing boundaries, not
Raspberry Pi filesystem performance or an isolated fsync cause.

Pushes and pull requests run routine tests and builds on Node 22 and 24, the
secret-history audit and the pinned Home Assistant Supervisor contract check
below. Both Node jobs also run the deterministic learning-publication and
circulation-restoration process-death matrices: real child processes are killed
at transaction/command boundaries and reopened against the same files. These
checks compare complete prior/published state and retained physical duties;
they do not simulate hardware power cuts. The **Extended validation** workflow runs weekly on Monday
at 03:27 UTC or manually using `workflow_dispatch`; it runs the extended Node
suite on both versions and the amd64/arm64 container checks. Run it before a
release and after changes to recovery, mirroring or packaging. This workflow
installs and requires mirror and MQTT broker prerequisites and a second supported
Node executable for real cross-runtime replication. Each matrix job retains the
other runtime's absolute path before selecting its primary runtime. A missing
required tool fails instead of silently skipping coverage. Local extended runs
report missing tools as skips unless their corresponding requirement is enabled.

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
`test/recording-health.test.js`, `test/storage-health-api.test.js`, `test/storage-publication.test.js`,
`test/database-export.test.js`, `test/backup-catalog.test.js`,
`test/backup-inspection.test.js` and `test/recorder.test.js`. They cover actual
SQLite full/busy failures, unchanged readings, read-only replicas, authenticated
health fallback, flush failures and adaptive-budget isolation from unrelated
writes. Health producer tests also distinguish current writer availability from
successful save receipts and source status, reject missing/malformed availability
evidence, and sanitize the existing in-memory application timing diagnostics.
Read-only snapshots and history have no active-master writer history or application
timing. They can show the local Store's configuration, shared queue and dated WAL
checkpoint evidence. `test/storage-scheduling-health.test.js` checks real owning
connection policy, status-only versus periodic SQLite capability, SQL-free health
reads, background/foreground failure separation, and distinct building, commit and
checkpoint measurements. UI regressions cover dynamic thresholds, active background
turns, stale evidence, standby scope, and preserved disclosure focus. The browser
fixture includes these current-contract fields and the expanded save-stage hierarchy.
`node test/browser/recording-health-smoke.js` checks the real dashboard
health elements at narrow and wide widths in both themes, including focus,
stale status, sign-out fencing and the health-only failure view. Full dashboard
checks in `node test/browser/dashboard-storage-smoke.js` exercise
pending actions, continuing status polling, independent health refresh, preserved
drafts and receipts, and late replies that must not replace newer authority or
storage evidence. Both browser fixtures use synthetic data and disposable state.
Storage and backup inventory checks also cover separate source/loop/write clocks,
partial discovery, file replacement, selected-copy verification, admin-only
inventory/downloads and inspection from a read-only server. Reset and pairing
tests retain current archive retry paths, immutable export generations and pins
under the configured persistent backup root. These offline fixtures do not test
household copies, Supervisor restore or Raspberry Pi storage.

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
pre-optimization workload without requiring the current progress behavior.
These checks make no household connections and do not measure Raspberry Pi or
phone hardware. The stalled browser stream is injected; the real-worker tests
below separately cancel an active history scan.

`test/chart-query-performance.test.js` validates recent-index versus historical
streaming equality, arbitrarily long overlapping energy intervals, receipt and
source scope, bounded request-local replay and measured stage progress.
`test/voltage.test.js` checks repeated and interleaved historical traversals,
request isolation, receipt cutoffs and exact fallback after cache eviction.
Each historical voltage reader retains at most 1,024 checked intervals and an
estimated 512 KiB per phase; source interpretation and recorded rows are unchanged.
The first-CSV-basis regression also covers two years of later estimates, late
receipt ties, simulation isolation and selected-history changes. Household cache
tests reject any voltage-history read when no completed Easee CSV exists.
`test/history-learning-lock.test.js` checks the empty CSV-learning suffix across
real worker restarts with three years of native indoor rows, a later import and
a lost model cache, retaining exact journal and numerical replay equivalence.
Indoor-learning tests cover clock-free stream probes, a three-year rejected
attempt suffix in one candidate query, scalar truthiness and H66 qualification.
One candidate query still may scan its rejected indexed range internally; these
tests do not establish constant SQLite time for arbitrarily many invalid rows.
`test/chart-worker-transport.test.js` covers active cancellation, independent
speculation, worker retirement/failure, concurrent recording, response equality
and authentication revocation during streaming. `test/chart-browser-performance.test.js`
covers cache bounds, late responses, absence of navigation prediction, stream parsing and geometry
reuse. Keep the existing chart provenance, gap, extrema, recovery, voltage,
temperature-geometry and accounting tests alongside these checks.

`test/chart-voltage-cache.test.js` checks unchanged closed-date cache hits in
resident and archive workers, physical/simulated input separation, causal native
voltage, partial/first retrospective estimates, corrections and both future clocks
without new writes. Mixed-update sequences compare each result with uncached
series and shading; voltage-reader renewal retains the same bounded energy groups.
`node scripts/benchmarks/chart-voltage-cache.js --days 35 --runs 3` measures day,
week and 22-day retries after voltage updates. Add `--baseline /path/to/source`
for matched old/new evidence and geometry comparisons. It uses only synthetic
data and does not establish household or Raspberry Pi timings.

`test/comparison-range.test.js` checks independent comparison dates, source
revision fencing and retained cards. Collapsed panels defer reads and forced
refreshes, closing aborts unfinished work, and reopening either reuses a valid
cached result or refreshes against the latest status. Late cancelled replies
cannot replace the mounted comparison.

`test/chart-comparison-summary.test.js` checks summary/full-chart accounting
equality across a Finnish DST transition, overlapping energy, unavailable prices
and physical/simulated input selection. Summary reads omit property-energy and
chart-only learning projections. Chart API checks cover authentication, request
validation, independent plot/summary cache entries and compressed streaming.
These synthetic checks do not establish phone rendering or Pi storage latency.

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
`test/charging-replanning.test.js` checks semantic input changes, the 10-second
quiet period and 60-second maximum wait, accumulated voltage/forecast changes,
and expected meter progress. Runtime checks cover prompt edits, published prices,
service failures, native boundaries and the 5-cent active/1-cent waiting hurdle.
Unchanged reporting retains accepted native schedules without another search.

`test/charging-flexibility-refresh.test.js` checks running comparisons and explicit
approval through both real native controllers, preserving the original short-run
clock and refreshing automatically when that commitment ends. The pure planner
checks equal remaining energy/cost, peer service, native period limits and worker
parity; these checks do not establish physical charging behavior.

`test/charging-service-replanning.test.js` uses the real runtime, joint planner,
OCPP controller and Shelly controller with synthetic native transports. It checks
that worsening household forecasts remove an accepted economic gap both when
ready-by can be recovered and when only an immediate provisional release can
reduce the deficit. `test/charging-plan-inputs.test.js` rejects other provisional
shapes at that release boundary. Native cloud revision and UI tests separately
check provisional release and visibility of accepted periods during target risk.
`test/charging-shelly-readiness.test.js` covers distinct work-state, permission and
current-limit deltas sharing a fractional event clock, whole-second native
readback, mismatches, duplicates and queries interrupted by another delta.
The joint service fixture also checks native acceptance of integer schedule
boundaries under all three priorities. The minimum-current runtime suite checks
BMW's own confirmation pause beside a still-identified Tesla under an accepted
economic pause, including restart, and rejects unconfirmed/unowned pauses and
nearby peer restarts.
These are offline regressions, not qualification of the installed charger's
firmware or the cause of an unexplained device-originated permission Stop.

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


Caravan native restart tests advance an explicitly injected receipt monotonic
clock separately from appliance/source/application wall clocks. The production
MQTT callback captures that elapsed point before writer admission and preserves
it through subscription and source-time buffers. Direct equipment fixtures pass
their original point explicitly; a missing point cannot establish On permission.
Forward-clock cases preserve saved timing bytes and use real Store admission;
they model elapsed time without changing global clocks or waiting five wall minutes.

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
node test/browser/spacing-smoke.js
node test/browser/access-smoke.js
node test/browser/configuration-smoke.js
node test/browser/configuration-recovery-smoke.js
node test/browser/secure-web-access-smoke.js
node test/browser/equipment-smoke.js
node test/browser/equipment-smoke.js --dashboard-heights-only
node test/browser/equipment-smoke.js --caravan-only
node test/browser/charging-controls-smoke.js
node test/browser/charging-tests-smoke.js
node test/browser/ocpp-setup-smoke.js
node test/browser/charging-currents-smoke.js
node test/browser/home-controls-smoke.js
node test/browser/history-recovery-smoke.js
node test/browser/model-reconstruction-smoke.js
node test/browser/model-reconstruction-service-smoke.js
node test/browser/heating-explorer-smoke.js
node test/browser/garage-smoke.js
node test/browser/garage-smoke.js --temperature-hold-only
node test/browser/mitsubishi-smoke.js
node test/browser/fullscreen-smoke.js
node test/browser/chart-views-smoke.js
node test/browser/chart-views-smoke.js --voltage-only
node test/browser/chart-touch-smoke.js
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
fallback including zero within Charger 2's allowance line, both allowance-basis
and highest-phase bars, matching phase colours, missing coverage, unchanged
right-axis meaning and removal of the separate fallback series. The runtime allowance
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
charger authority unchanged. Repeated-price and shared-assessment fixtures verify
lossless context reuse, original event horizons, scoped foreign keys, rejection
of damaged contexts, deletion cascades and peer journal replay. Brief processing
holds remain dated evidence without becoming new planning instructions; actual
expiry and new connections still remove current authority. Database-overview
checks account for report summaries, events and contexts without exposing private
payloads. These checks do not establish
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

`test/tuya-local-status-refresh.test.js` exercises the current native receive loop
and pinned SDK at a controlled validated-frame boundary. It checks one consumed
refresh budget per current source episode, genuine field recovery, invalid power,
poll-only behavior, original clocks and cancellation/source movement across native
lock/executor waits. Actual queued command entries and supersession are retained
through the added read's terminal failure only while that source remains current.
Separate AES/CRC socket-reopen probes validate parser reachability; neither test
boundary establishes the cause of a household withdrawal or physical delivery.

The native read-command-retention suite also drives the complete periodic status
loop through exhausted retries with a real native-lock waiter. It checks that
only current unsent entries survive, newer opposite/same-value requests supersede,
removed/sent entries stay removed, and changed physical identity/API/protocol/owner
or shutdown retains nothing. Actual initial protocol selection precedes the
source snapshot. Unmarked callbacks retain the native terminal reset behavior.

`test/tuya-local-write-command-retention.test.js` drives the actual current native
setting producer, retry handler and pinned SDK with a real native-lock waiter and
controlled memory transport. After three failed attempts, a healthy transport
serves only the newer queued entry. Same-value/opposite supersession, new
datapoints, sent/removed/initial entries, source loss, same-shaped selected-record
replacement and observed protocol
A→B→A are covered. The actual initial protocol selector and terminal automatic
protocol reset retain their native behavior. A failed following request receives
only its own existing retry budget and is not recreated. Pending entries never
become native feedback; cache/field/clock resets stay intact. These fixtures use
the validated-frame boundary, not a new encrypted-wire or household proof.

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
Interpolation checks await the replacement legend published after the actual
canvas draw, including asynchronous geometry preparation. They interrupt that
preparation with a resize and move focus to another footer control, then require
the completed plot, interpolation control and current focus to agree. Same-view
legend and footer buttons retain their DOM identity across those redraws.
Coefficient chart transport checks require indexed selected main-database history
reads, including current quality/provenance and genuine gaps. Selecting a
coefficient never schedules replay, requests preparation or changes archive-worker
idle retention. Optional full-verification tests exercise the independent worker
and source fences instead of performing model fitting in a chart request.
Explorer checks cover the shared selection button, searchable **Views** and
**All series** modes, selection/dismissal, keyboard navigation and centered
desktop, mobile and fullscreen layouts. Chart style checks
include cubic temperature settings, solid historical Solar estimate, dash-dot
future Solar forecast and charger fills within each individual phase. It verifies
Caravan interval-average power, original energy availability, hollow observation
markers and point targeting against nearby price samples. Real Chart.js
interaction tests also cover vertically aligned readings, overlapping markers
and synthetic edges. Browser checks cover combined home-compressor states, the
persistent title folds and complete colour keys, separate Garage power-setting
and Normal/Away selection rows, band-only mouse/touch cursor dragging, clipped cursor
segments, independent plot navigation, touch and keyboard cleanup, both themes and
320/390 px fullscreen layouts. Legend checks cover native keyboard disclosure,
scrolling with Reset view always accessible, uniform active-state swatches,
quantity-specific group labels and strip alignment as scrollbars appear. They also
check the compact Interpolation ON/OFF footer control, keyboard focus and scroll
preservation, global browser persistence, step geometry and restoration of the
existing curves and straight lines. Its synthetic screenshot gallery is written to
ignored `var/chart-views-*.png` files. The Firefox chart suite below retains broader
chart/date/detail/tooltips and related dashboard regression coverage.

Date checks also cover setting both fields to a newly selected start day,
choosing the same or another end date, canceling without changing the range,
selecting Today in Finnish time, and fitting the calendar on small screens.
The timing compatibility suite uses the production comparison-section markup
with native, missing and delayed `ResizeObserver` delivery. It checks visible
figures and controls, resizing, refresh, keyboard focus and unclipped content at
seven widths in both themes, including either side of responsive layout breakpoints.
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
uncertain request across reloads and omit unrecognized error details. They verify
automatic read-only receipt resolution after a shared-address change, origin loss,
overlapping polls, unknown results and changes during confirmation. The real
paired runtime tests read the original handover receipt through the new master,
repeat after origin restart and reject a misrouted POST before any new action.
The authority tests inject nested local shutdown failures, retain final source
writes beyond the receiver checkpoint and check bounded privacy-safe diagnostics.
UI and browser checks retain explicit promotion for an admitted interrupted
handover while active operations remain blocked. A real paired fixture stops the
original master, explicitly promotes its prepared receiver and verifies retained
history, cleared transition and sole control authority.
These fixtures never acquire household authority or reproduce the original
installation's hidden shutdown exception. Backend reset
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
The workflow regression injects a source change only after the successful
rebuild acknowledgment. It verifies that the pre-rebuild checks passed, the
installed-source check refuses success, and the lock and temporary evidence
remain without cleanup, a repeated rebuild or a runtime command. This offline
fault injection does not serialize Supervisor's independent repository refresh.

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

The Tuya Local withdrawal diagnostic suite executes the current clear callers and
full/conservative omission through real patched methods. It preserves unknown
native evidence, original field clocks, query/retry counts and callback behavior,
while checking profile scope, nested clears, the 30-second monotonic warning cap
and a throwing log sink. Captured API/socket/protocol movement is exercised in
every combination before and after the native call. Optional diagnostic detail
cannot add a read, render private objects, change refresh eligibility or prevent
withdrawal when comparison or logging fails. Malformed boundaries and non-boolean
protocol comparisons retain the generic category without rendering private values.
Its decoded SDK-frame boundary is explicit; separate
source-pinned AES/CRC fixtures qualify parser reachability. Neither identifies an
earlier household withdrawal cause. The strict installer continues to refuse
unknown, partially patched and earlier generated bytes before mutation.

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
  Journal capture also bounds each main-thread row to 2 MiB and each transaction
  to 4 MiB of cumulative raw before/after input or compact payload. The raw limit
  applies before parsing and hashing, including repeated tiny edits to a large
  document. Large supported imports run in storage workers. The admission tests
  retain the same 48 MiB document and verify worker completion, exact durable
  content, responsive timers and atomic main-thread rejection. They do not bound
  the operating system's latency for a `synchronous=FULL` WAL commit: under shared
  write pressure the pre-refactor and current code both exhibited over one second
  inside `fsync`, including with automatic WAL checkpoints disabled.
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
- The floor controller uses the Sonoff lease protocol; GPIO confirmation and
  software checks do not qualify physical contacts, wiring, valves or flow.
  Installed local-expiry and thermostat-path checks remain required. H66, CN105/protection and charging
  have distinct physical qualification requirements; see their maintained
  guides. OCPP recovered-transaction profile acceptance and Equalizer behavior
  under competing loads remain unverified. Synthetic Shelly recovery does not
  establish autonomous behavior during loss of the application or broker.
- Installed Android launch appearance and Samsung/DeX/fridge-browser behavior
  require their actual devices. Desktop browser fixtures cannot qualify them.

## Runtime and fixture constraints

The recovery service gives a revision preview a bounded projection of affected
source rows and the required learning suffix. Late corrections and reversals do
not copy the complete installed database. The service owns worker lifetimes and
temporary files and awaits worker exit on cancellation before cleanup.
Source-only checks need no candidate copy. Keep small recovery-preview and
cancellation regressions alongside the larger extended replay fixtures instead
of increasing timeouts to conceal a stall.

The full-week replay and larger phase-energy import belong in extended tests.
Routine tests still cross batch boundaries and verify authority, restart,
deterministic replay and original-history preservation with smaller data.
Browser assertions should identify current semantic keys and user interactions;
when an intended UI change invalidates a historical expectation, update the
fixture without weakening the behavioral check.

## Dedicated runtime writer

`test/storage-writer-worker.test.js` uses real file-backed writer threads to check
dependent reads, savepoints, committed external reads, callback-once semantics,
lock admission, cancellation, failed commits, lost replies and joined shutdown.
Its held-boundary cases delay dispatch rather than simulate physical storage.
`test/storage-health-api.test.js` holds a real writer COMMIT while authenticated
health remains responsive, showing neutral saving without hiding source startup
or inventing lock contention. It intercepts the actual successful COMMIT reply
before the writer client receives it, holds reconciliation, and checks
**Confirming last save** followed by **Writer unavailable** after proven durability.
The callback and committed effect run once; the saved date and transaction remain
successful, with no false failed-save count. Idle worker termination is visible
before another write is attempted, even with an empty queue and no failed save.
The UI checks distinguish current writer status from historical failures and
preserve separate scope for whole-process event-loop timings and the selected
past-day/past-week Store history. These diagnostics neither grant command
authority nor renew original source or save clocks.
`test/acquisition-worker-settlement.test.js` covers transport withdrawal and
rollback across asynchronous durability. The synthetic
[writer benchmark](sqlite-storage-benchmarks.md#dedicated-writer-responsiveness)
separately delays native COMMIT and probes HTTP from another process. Neither
fixture qualifies installed hardware or physical actuation. Runtime integration
needs the full relevant acquisition, charging, recovery, pairing and shutdown
suites on the developer runtime and pinned add-on Node before release.

`test/writer-independent-audit.test.js` adds worker-loss, stale atomic-notification,
response ownership, current maintenance and startup/shutdown races.
`test/writer-publication-integration.test.js` exercises real backup, peer,
correction, source-identity and recovery workers beside runtime recording.
The Executor process-death matrix repeats each retained restoration and authority
case with direct storage and the dedicated writer. The routine and extended
recovery responsiveness workloads also use the dedicated runtime writer; their
original latency, replay and historical-evidence assertions remain unchanged.

`test/chart-source-cache.test.js` checks bounded catch-up, receipt/source scope,
calendar movement, capacity convergence and disabling. Chart transport tests cover
resident/archive isolation, current-head invalidation, live reconfiguration,
released maintenance snapshots, gzip and cancellation. Storage-priority tests
verify chart warming remains behind requested work with direct and worker writers.
Replica tests cover real coalesced catch-up after journal-prefix pruning, an
archive response spanning publication, per-request checkpoint capture, rejected
replacement/rewind continuity and pinned-reader cancellation after file removal.
These are synthetic correctness checks, separate from measured host performance.

### Chart indicator coverage and performance

`test/chart-activity.test.js` checks every state/code catalogue entry, repeated
Normal requests, dense short interruptions, valid zero, source expiry, isolated
observations, phase ties and bounded code summaries. It verifies original
occupied durations independently of scalar reduction and confirms chart reads
perform no writes. The chart worker/transport and storage-priority suites retain
coverage for concurrent recording, control priority, cancellation and snapshots.
The complete catalogue fixture follows actual source formats: H66 states/codes
and native tariff relay feedback carry no invented periodic-report metadata.
`test/chart-coverage.test.js` also checks unchanged native relay/alarm reports
across day, long and zoomed selections, exact outages, expiry, earlier as-of
reads and dashboard revisions. `test/dhwr-native-chart-cache.test.js` verifies
worker-cache renewal without new observations and reuse of completed history.
Delayed event-only contact recovery also retains its unavailable interval and
original observation time in day, long and zoomed views.

Run `node test/browser/chart-performance-smoke.js --indicators-only` for actual
Chart.js/indicator rendering through the production HTTP/history worker route.
It checks desktop/mobile and light/dark overviews and zoomed views, captures
screenshots outside the checkout, and reports load/draw/frame timings.
`--source /path/to/untouched/source --record-broken-indicators` records a baseline
without asserting the known broken fill. Use the same fixtures and runtime for
comparisons; generic day/week/month performance remains covered by
`node scripts/benchmarks/chart-interaction.js --days 35 --runs 3` and the browser
performance suite without the indicator-only flag. Run `--catalogue-only` to
check all 26 state/code entries and eight built-in tracks, including painted
screenshot pixels. `node scripts/benchmarks/chart-activity.js --baseline /path/to/untouched/source --runs 3`
compares dense indicators while asserting numeric-series equality. Chart cursor
batches use at most 192 rows and retain the same eight-millisecond native-work
limit and release storage admission between batches. These synthetic local checks
do not establish Raspberry Pi or live installation performance.
