# Recording contract review — 25 September 2026

This review follows the complete path from acquisition through recording,
restart, history readers, learning provenance and the database inventory. It
uses synthetic observations and temporary SQLite databases; no installation,
private configuration, household export or physical actuator was accessed.
The implementation was developed in an isolated worktree. The owner subsequently
authorized merging after validation; no deployment or household database reset
is part of this review.

## Recording decisions

| Data | Recording policy | Reason |
| --- | --- | --- |
| Continuous outdoor, hydronic and hot-water temperatures; heating integral; pump speeds | Adaptive measurement | Compact changing curves while retaining quality and availability boundaries. |
| Caravan air/humidity; pump interpreted indoor temperature and compressor frequency | Adaptive measurement | Useful diagnostic curves, independent of the reporting deadline. |
| Property and Charger 1 phase energy | Adaptive energy | Preserve existing integrated energy and its estimation basis; choose boundaries from power changes. |
| Charger 2 total and phase energy | Adaptive energy | Native counter differences give the authoritative total; measured phase-power shares allocate estimated phase energy. |
| Caravan energy | Adaptive energy | Preserve measured counter increments with the same interval/history contract and consistent naming. |
| Upstairs, bedroom, downstairs, garage rear/front temperatures | Every exact change | Preserve original room/protection and thermal-learning values without a learned numeric tolerance. |
| Equipment on/off states, routing, alarms, settings, runtime and native meter counters | Every exact change | Discrete meaning and changed counters must not be approximated. |
| Four floor override outputs and tariff relay feedback | Every exact change | Preserve individual confirmed electrical states and unknown transitions. Contact feedback does not prove valve movement or water flow. |
| Hot-water circulation feedback | Every report | Keep all received feedback, including repeated values and unavailable reports, independently from requested circulation. |
| Dedicated garage electricity | Qualified electrical interval | Preserve the selected electrical source and its original coverage for garage learning. |
| Generic metered equipment energy | Completed UTC hour | Existing direct metering writer retains measured increments and partial-coverage meaning. |
| External temperature feed | Diagnostic event | Store abnormal onset, changed reason and recovery; remove numeric feed history and routine healthy renewals. |
| Garage power | Live only | Remove redundant scalar history; selected energy intervals and frozen learning inputs remain. |
| Prices, forecast versions, requests, calculations, journals, corrections, imports and operational state | Their own explicit writer | Adaptive numeric tolerance is inappropriate for these contracts. History and overwritten current state are distinguished. |

Hot-water **temperature** remains a continuous adaptive measurement. Hot-water
circulation **feedback** retains every report. These are different observations.
Garage native defrost is retained only when actually reported as a Boolean.
Changes in uninterpreted native diagnostic bytes remain diagnostic events, not
invented fault or defrost interpretations.

## Removal of timed duplicate writes

The maximum recording interval and its configuration are removed, not set to a
larger value. Unchanged scalar readings extend compact availability coverage.
Normal recorder flushes do not create energy observations just because time has
passed. Independent freshness limits still end stale coverage; removing a
recording timer cannot establish that a source is alive.

Energy accumulators remain durable and transactionally coupled to acquisition
checkpoints. Charts, charging totals, household phase estimates and meter checks
read finalized intervals together with the current open interval. The open
interval survives restart, is explicitly identified in the inventory and is
never counted again after finalization. Session closing finalizes only that
charger's relevant source/device/group. Shutdown can finalize outstanding work.

A newly detected power step closes the preceding steady span before adding the
changed acquisition. Otherwise a brief new load could be averaged backward
across days after removal of the old timer. Source discontinuities, quality
changes and explicit gaps likewise retain boundaries. Queries accept long
intervals crossing a narrow viewport without a one-day lookback assumption.

Read paths enforce receipt/source cutoffs, reject invalid geometry and quality,
and mark overlapping ownership unavailable. Total Charger 2 energy is credited
once; phase allocations never add a second copy of consumption. Unknown Charger
2 phase shares no longer cause an assumed one-third subtraction from household
loads. The conservative household estimate retains the unsubtracted load.

Generic completed-hour equipment can use an ID coinciding with a physical
energy signal. Its direct hourly dataset is explicitly excluded from physical
charger/property energy readers before overlap grouping, so it cannot imply an
idle charger, contribute energy or invalidate the physical series.

The final audit also traced paired history recovery. A frozen donor's open
energy is now recoverable as immutable observations with separate provenance.
Each phase cohort is accepted atomically, with conflicts checked against both
master observations and master open energy. Invalid or future evidence is
excluded, retries remain idempotent and deliberately deleted accepted rows are
not resurrected. Original donor bytes and all live control state stay untouched.
Recovered observations update local saved-record statistics without copying the
donor's learning thresholds, poll statistics or recorder state.

A resumed acquisition can straddle newly recovered history. The recorder keeps
the accepted recovery, skips that indivisible overlapping local interval and
marks any uncovered tail as missing. It advances its own integration cursor so
the next acquisition can proceed. This avoids both duplicate energy and a
permanent retry against an obsolete cursor. It does not reject days of useful
donor history merely because the master's last acquisition was long ago.

The original thermal update algorithm is unchanged. Learning journals freeze the
resolved electrical context, including any open-interval provenance; subsequent
accumulator updates cannot rewrite an earlier saved learning input. A historical
receipt cutoff does not reconstruct unavailable intermediate accumulator states.
Later evidence stays excluded rather than being backdated into earlier learning.

## Complete inventory and UI correspondence

The shared recording-policy catalogue drives recording selection and inventory
classification. Recorder observations persist their policy. Adaptive measurements
lists observed adaptive streams only, with learned thresholds, availability,
actual saving statistics and any open energy interval. Exact states and room
temperatures no longer masquerade as adaptive parameters. Device identities are
not exposed as inventory labels. Stable opaque stream references distinguish
otherwise identical sources. Changing a configurable unit or recording policy
starts a distinct stream; earlier units and policies retain their own thresholds,
statistics and entries after restart.
The saved adaptive dataset breakdown also enumerates recovered signals and units
without a recorder checkpoint, using the inventory's existing grouped scan.

Other recorded data enumerates actual non-adaptive scalar datasets and their
units, saving rules, basis, counts and dates. It also covers separate Home and
Garage journals, manual events and corrections, imported data/provenance,
forecasts/prices, meter/session references, events broken down by type, source
coverage, bounded statistics and overwritten state families. Physical accounting
lists all 18 tables and identifies the three SQL views separately; logical and
provenance counts overlap and must not be summed as physical rows.

Unknown writers, state families or tables are shown explicitly and make the
catalogue completeness check fail. A direct hourly equipment writer takes
precedence over a coinciding energy signal name. Private topics, source paths,
device IDs, payloads and configuration values do not leave the inventory API.
Detailed inventory scans run in the existing read-only worker with a cache.
Exact saving counts and mean intervals combine complete hourly metrics with
indexed boundary-hour records. This avoids scanning seven days of dense archive
rows synchronously on every control tick. Hourly extrema are updated atomically
with recording; explicitly historical requests can read the pruned portion from
original observations.

## Current contract and retained capabilities

Schema 15 is initialized directly. Incompatible or malformed development
databases are rejected before mutation, with fresh-start guidance. No migration,
backfill, deletion, reset-on-startup, retired setting alias or earlier recorder
interpreter is added. No existing database was reset during this task.

Retained capabilities include read-only import of the two supported v0.7.5 CSV
formats, original row/file provenance, idempotent import and interrupted-import
recovery, current-version restart, backup/restore, deterministic journal replay,
manual corrections, atomic publication and physical restoration obligations.
Unavailable source data remains unavailable rather than being inferred from
commands or from the fact that the controller is running.

## Validation

The final backend passed all **3,181 standard tests without skips** (`npm test`). Focused
regressions cover multi-day unchanged readings, long energy intervals and sudden
steps, pending energy restart, causal cutoffs, overlap rejection, atomic phase
records, scoped session finalization, exact/every-report policies, all four floor
contacts, external-feed failure/recovery, inventory completeness and privacy.
The inventory API and extended SQLite contention test passed (seven combined
checks); the latter measured the existing approximately five-second default
writer lock wait and its exposed event-loop delay. This remains an operating
limit, not a newly introduced hard real-time guarantee.

Two synthetic performance checks ran on an AMD Ryzen 5 1600 with Node 26.8.2:

- One million observations across 100 streams: exact counts and mean spacing
  matched for all windows. Across seven warm runs, the old full-week statistics
  scans took a median 691.8 ms; the updated **entire recorder status call** took
  73.4 ms (68.5–95.3 ms). Normal status scans at most four partial hours per stream
  and reads bounded complete-hour metrics.
- `node scripts/benchmark-recorder.js --days 30 --max-seconds 60`: 673,920 fixed-rate
  synthetic observations, 459 MB SQLite, 271 MiB peak process RSS. Day/week/month
  history queries took 2.18/5.78/21.25 seconds; a repeated month query took
  20.80 seconds. The uncached inventory took 4.89 seconds and accounted for all
  18 tables. These measurements ran alongside regression work; operating-system
  cache state and CPU contention were not controlled. Large archive queries
  remain substantial and belong in the existing cancellable worker/cache path.

Final UI validation is recorded below after the browser review.

The synthetic storage benchmark and SQLite contention check are operational
measurements, not physical commissioning or a real-time guarantee. The benchmark
deliberately inserts a fixed high-rate workload; it does not predict actual
adaptive growth or measure live acquisition throughput. The configured annual
budget remains a soft growth objective. Required exact history is never dropped
to meet it, and existing history is not deleted.
