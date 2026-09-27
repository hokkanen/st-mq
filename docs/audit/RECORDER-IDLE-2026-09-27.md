# Recorder and database audit — 27 September 2026

The audit starts from `H66` commit `10f0c4a`. The supplied charger-idle report was
used to identify cases to reproduce, then checked against current producers,
recorders, restart state, history/accounting readers, charts and configuration.
All observations and databases used here are synthetic. No household database,
private configuration, provider account or actuator was accessed. Counts below
are fixture results, not estimates of the installation's current database.

## Changes

**Charger idle noise:** phase-cohort recording could turn a 1–3 W fluctuation into
hundreds of observations per hour, including zero rows for unused phases. A
10 W per-channel selection floor now applies to Charger 1, Charger 2 total and
Charger 2 estimated phases. This is a choice of history boundaries: every accepted
kWh still accumulates, including standby energy. The floor also prevents small
zero/nonzero toggles from forcing rows. Starts/stops above the floor, material
phase changes, unavailable intervals and actual measurement-basis changes remain
boundaries. Property and Caravan power keep their existing learned thresholds.

**Native counter quantization:** selecting intervals by instantaneous power but
comparing against power reconstructed from a zero native-counter increment caused
repeated zero saves. Native charger streams now keep a bounded, durable
instantaneous-power selection reference separately from their exact accumulated
counter energy. A changed meter increment is never inferred from instantaneous
power. The three estimated phases and authoritative total remain separate; they
must not be summed together as consumption.

**Quality bookkeeping:** `held_source_values` and `last_reported_observations`
now accumulate as a conservative union within otherwise equivalent energy
intervals. They no longer split every fresh/held poll. A reported exact-zero
interval needs no phase weights; their absence alone is neutral. Actual
nonzero allocation-method changes, held stale-power evidence, transport changes
and outages retain their boundaries. The unused producer `force` hint was
removed; the recorder owns interval selection.

**Circulation feedback:** the direct every-report writer for `dhwr_active` is
replaced by the shared change-only recorder. Raw watts remain live-only. Repeated
OFF or ON reports extend one availability span. Exact ON/OFF transitions,
invalidity, transport failure and recovery are saved. Periodic sources retain
their configured reporting deadline; an event-only feed retains its reported
state until a later report or explicit outage. Host-clock replies in the same
millisecond remain ordered; repeating a device measurement timestamp cannot
renew periodic coverage. Live command confirmation still uses received device
readings, independently of history compression.

**Charts:** auxiliary zeros and heat-pump compressor/routing/mode states were
already compressed correctly, but some chart projections ignored their fresh
coverage spans. Long unchanged states could disappear after the original scalar
expired. Charts now consume the compact coverage with the original observation
identity, source deadline and unknown gaps. An earlier as-of request does not
borrow a later span confirmation. Circulation uses the same coverage. Cache
revisions include relevant span and durable pending-energy changes; chart
endpoints remain derived display geometry, not additional stored observations.

**Database robustness:** backup/export copies are created privately under a
temporary name and published only after SQLite completes, without overwriting a
concurrent destination. Failure removes the staging file and leaves no partial
final export. Existing WAL/SHM companions also block reuse of a destination.
Schema discovery now excludes only the literal reserved `sqlite_` prefix. The
previous SQL LIKE wildcard could ignore a table such as `sqliteXcustom` and
misclassify a nonempty, unversioned database as empty. Writable, read-only and
restore paths reject such malformed databases before mutation.

## Other idle data and retained storage costs

The same one-hour synthetic acquisitions were run against the baseline and
updated recorder. Counts include the full three-phase cohort (or Charger 2 total
plus three phases). They exclude a final explicit flush, which adds three or
four closing rows. The durable open tail already supplies the remaining energy
and coverage to chart/accounting readers before that flush.

| One-hour fixture | Cadence | Baseline rows | Updated rows |
| --- | --- | ---: | ---: |
| Charger 1 stable 0 W | 15 s | 3 | 3 |
| Charger 1 stable 2 W | 15 s | 3 | 3 |
| Charger 1 alternating 1/3 W | 15 s | 720 | 3 |
| Charger 1 alternating 0/2 W | 15 s | 720 | 3 |
| Actual Easee accumulator: 0 W, source clock refreshed every 60 s | 15 s | 540 | 3 |
| Actual Easee accumulator: alternating one-minute 0/2 W blocks | 15 s | 540 | 3 |
| Actual paused Shelly adapter: 2 W, unchanged native counter | 15 s | 960 | 4 |
| Actual paused Shelly adapter: 2 W, unchanged native counter | 5 s | 2,880 | 4 |

"Actual adapter" means production adapter code with mocked transport and invented
data, not real hardware. Counter-derived energy remains exactly zero in the flat
counter fixture; instantaneous power never manufactures counter energy. Other
fixtures assert conservation of the small nonzero accepted energy. These savings
do not imply a corresponding percentage reduction for the entire database.

| Dataset | Current behavior and judgment |
| --- | --- |
| Auxiliary output/power, compressor, routing, operating mode | Exact changes plus coverage. Steady zero is one saved observation per stream; keep zero to distinguish verified idle from missing telemetry. |
| Heat shading and interval-power chart endpoints | Derived from source records and coverage; there is no separate shading table or saved copy of chart endpoints. |
| Hot-water circulation feedback | Fixed here: repeated ON/OFF reports previously appended rows. A synthetic hour with 721 OFF reports now stores one observation and one coverage span. |
| Room temperatures, floor override outputs, door contacts, tariff relay and native Boolean states | Exact changes plus availability coverage. Unchanged values do not require repeated scalar rows. Preserve source deadlines and actual state transitions. |
| Property phase energy | Adaptive integrated intervals; source bookkeeping compacts, but real small household power changes remain eligible. Applying a charger standby floor indiscriminately could obscure small household loads. |
| Caravan metered energy | Adaptive counter intervals with durable pending sums. Stable zero compacts already. Generic explicitly mapped equipment meters retain completed hourly totals, including covered zero hours. |
| Dedicated Garage energy | Each qualified original interval, including zero. OFF evidence is required for electrical/thermal qualification; merging these intervals requires a coordinated learning/provenance contract change. Kept intact. |
| Raw charger currents/power, raw circulation watts, redundant heat-pump total power, Garage power, external-temperature feed renewals | Already live-only or reconstructed; no second fast scalar history was added. |
| Recorder statistics and state | Statistics aggregate into per-stream hourly buckets with seven-day pruning. State overwrites bounded checkpoints. Frequent writes remain, but they do not append a history row per poll. |
| Weather/prices | Forecast content is deduplicated; fetch/issuance references remain for causal source age and reconstruction. Distinct forecasts and publication revisions legitimately grow history. |
| Home/Garage learning journals, frozen cycle plans and corrections | Retained to reconstruct current learning and assessments. No indiscriminate retention limit or deletion was added. |
| Decision events | Still one event per controller decision, even when summaries repeat. At a hypothetical one-minute cadence this is 525,600 events/year. Further compaction needs a separate explicit decision/heartbeat representation because slave status reads the latest event; a simple dedup would age that status incorrectly. |
| Property meter audits | Source timestamp/value pairs deduplicate; fresh cumulative meter reports remain for counter comparisons, resets and provenance. They are not charger idle power rows. |

There are additional storage opportunities, but their tradeoffs are different
from dropping idle observations:

- `observations_recovery_energy` supports recovery overlap lookups but indexes
  scalar rows too. In an isolated fixture with 30,000 scalar observations and
  300 energy rows, it used 1,122,304 bytes of a 9,453,568-byte database (11.9%).
  A partial index could reduce this cost. This audit retains schema 15 and its
  current recovery contract; changing the structural schema requires an explicit
  fresh development database, not a migration or automatic reset.
- Every accepted electrical interval still durably updates its pending sum and
  acquisition cursor. Deferring these writes would introduce crash-loss or
  duplicate-counting risks. WAL/FULL synchronization and composed transactions
  remain enabled. No physical flash-write reduction is claimed from row counts.
- Learning samples repeat resolved configuration alongside their digest. Future
  content deduplication could help, but must preserve immutable journal identity,
  current correction/replay and saved initial seeds. It is not safe to delete
  configuration payloads as redundant telemetry.
- The annual recording budget is a soft growth objective, not a hard cap.
  Mandatory state changes, imports, journals and diagnostics can exceed it.
  Existing history is retained; these changes reduce future unnecessary rows and
  do not reclaim already allocated database pages or rewrite past observations.

## Compatibility and validation

The database schema remains 15. There is no old-format decoder, schema migration,
backfill, automatic reset or per-minute chart-summary table. Same-version
restart, atomic interval/cursor updates, recovery provenance, current learning
replay and the supported read-only v0.7.5 CSV import remain intact. The removed
every-report policy and unused energy force hint have no aliases.

Focused offline regression coverage includes idle noise, energy conservation,
phase coherence, native counters, outages, restart/rollback, multi-day and zoomed
charts, periodic/event-only circulation, chart caching, export failures and
pre-mutation schema rejection. Event-only circulation is exercised through the
real equipment producer and recorder so missing persisted deadline metadata
cannot be hidden by a direct-insert chart fixture.

Final integrated validation on Node 26.8.2: `npm run build` passes (the existing
large-bundle warning remains), followed by all **3,635 routine tests passing**,
with no failures or skips. The earlier full run had one static-dashboard 404
because the new worktree had not been built; the build, isolated authority test
and final complete run resolve it without changes to that test or application
route. Staged changes also pass the repository's secret-checking pre-commit hook.
