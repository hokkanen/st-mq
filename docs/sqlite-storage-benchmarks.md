# SQLite storage benchmarks

These fixtures measure adaptive recording, compact transaction retention and
configured-peer catch-up using disposable synthetic databases. They do not read
installation configuration, contact equipment or open household databases. The
correctness and retention rules are in [the journal contract](sqlite-journal.md),
[recording](recording.md) and [learning reconstruction](reconstruction-and-versioning.md).

## Reproduce

Run from the repository root after installing dependencies:

```sh
node scripts/benchmarks/adaptive-journal.js
node scripts/benchmarks/adaptive-journal.js --peer-mode=coalesced --offline-cycles=5760
node scripts/benchmarks/adaptive-journal.js --cycles=30240 --workloads=constant,nearly-constant --peer-mode=coalesced --offline-cycles=30240
node scripts/benchmarks/adaptive-journal.js --cycles=128 --workloads=constant --peer-mode=coalesced --history-rows=131072
node --test --test-timeout=180000 test/extended/adaptive-journal-scale.test.js
node --test test/journal-admission.test.js test/history-import-worker.test.js
```

Each workload runs in its own child process and prints JSON. `--source-root=` can
point at a separate source checkout with its own dependencies; it imports that
checkout's storage and recorder modules while creating a new synthetic database.
It never opens a database from that checkout. The historical comparisons below
used source-only exports of `ada3330` and `9ac9cc2`, with their matching fixture
helpers. This is benchmark instrumentation, not support for opening old databases.

Useful options include `--cycles=`, `--large-cycles=`, `--workloads=`,
`--history-rows=`, `--replicate-every=`, `--offline-cycles=` and `--verify-every=`.
Replication uses the configured-peer worker protocol. `--replicate-every=64`
enables regular catch-up; explicit `--peer-mode=coalesced` also enrolls a peer when
only a final offline catch-up is wanted. A run without either remains unpaired.
Historical source comparisons may use `--peer-mode=transaction`; current source
rejects that removed replay API. `--verify-every=512` starts full-verification workers while
recording continues. Initial synthetic seeding is excluded from elapsed work,
wire bytes and process I/O; full initial seeds remain a separate cost.

The script reports:

- SQLite allocation by table/index, logical transaction payload, reusable free
  pages, database/WAL/SHM sizes and a final recursive inventory of other files.
- Per-operation maximum/p99, timer and event-loop delay, process peak RSS,
  `/proc/self/io` and serialized transfer bytes. Peer transfers additionally report
  export, apply and acknowledgement time and I/O.
- Quarterly physical-allocation samples, commit counts and exact retained values.
  Checks include coverage end/sample counts, conserved phase energy, explicit
  gaps, current learning entries, exact seed reconstruction and actual replica
  rows. Retained event rows are independently hashed after the I/O measurement.

`dbstat` scans and final independent integrity/reconstruction checks are benchmark
instrumentation, outside the operation timing. Reports arrive at maximum synthetic
speed, with an event-loop yield every 16 operations: heartbeat delay includes that
deliberate batch. Historical transaction-mode runs also include synchronous
transaction export/apply. It is not a
measurement at real one-minute arrival cadence. Process I/O includes SQLite calls
served from cache; physical I/O counters depend on the kernel cache. Peak RSS is
per child, including its worker threads. Other files are a final inventory, not
a peak of operating-system scratch usage. Wire sizes omit transport framing.

## Workloads and acceptance

The default run sends 5,760 minute reports (four synthetic days), or 300 edits for
the large-state case. Constant supply temperature must retain one observation and
one continued reporting interval. Nearly constant voltage varies by 0.01 V inside
the recorder's 0.5 V floor and must likewise retain one observation. These fresh
reports still advance persisted reporting coverage and statistics.

The large-state case first saves a 256 KiB high-entropy document, then changes one
counter. It preserves the exact document and counter on the replica. The no-op
case performs identical state saves and equal SQL updates; both allocated growth
and WAL writes must remain zero. The append case retains every synthetic event.

The mixed case combines changing temperature, three phase-energy streams, a
15-minute observed gap, durable synthetic control intent, audit events and valid
current Home learning samples every 15 minutes. It computes the real checkpoint
at that cadence and verifies the complete final checkpoint against seed replay.
It does not validate household thermal physics or manufacture command authority.

Extended tests require at most 2,048 retained commits and 8 MiB logical journal
payload for these bounded transactions after repeated maintenance. Those limits
describe disposable transaction history, not required learning inputs, peer
changes or retained source history. One oversized worker transaction may exceed
the retention byte target while remaining within its 64 MiB admission limit.
No-op growth must be zero; 64 small edits to the seeded 256 KiB document must
transfer under 256 KiB and allocate under 1 MiB. A peer offline for 6,144 reports
must catch up in fewer than 256 changed rows and 256 KiB, with nearly equal wire
size whether or not 32,768 unrelated historical events were seeded first.

These criteria compare preserved information and absolute costs. Append-only
history must grow; a universal storage multiplier would not be meaningful.

## Observed allocation

Measured on 2026-10-08, Linux x64, AMD Ryzen 5 1600 (six cores, 12 hardware
threads), 15.53 GiB RAM, Node 26.8.2. Results describe this development host, not
Raspberry Pi storage or Home Assistant scheduling. Some runs overlapped other
synthetic validation. Timing outliers therefore need the controlled durability
investigation below; allocation and semantic assertions are the primary comparison.

The table gives **additional allocated SQLite bytes** after initial setup. No
vacuum was used. The large-state document was seeded before measurement. `ada3330`
is the implementation before incremental journalling; `9ac9cc2` is the original
incremental implementation; current is the compact implementation with ordinary
rowid `journal_changes`, bounded retention and sparse learning checkpoints.

| Workload | Before incremental (`ada3330`) | Original incremental (`9ac9cc2`) | Current, unpaired | Compact, configured peer¹ |
| --- | ---: | ---: | ---: | ---: |
| Constant, 5,760 reports | 24,576 | 37,130,240 | 5,713,920 | 5,738,496 |
| Nearly constant, 5,760 reports | 24,576 | 38,174,720 | 5,758,976 | 5,791,744 |
| 256 KiB state, 300 small edits | 262,144 | 159,039,488 | 77,824 | 344,064 |
| Mixed, 5,760 reports / 384 learning samples | 6,266,880 | 339,619,840 | 19,275,776 | 21,061,632 |
| Append, 5,760 events | 4,161,536 | 9,764,864 | 7,086,080 | 7,741,440 |
| No-op, 5,760 repetitions | 0 | 2,813,952 | 0 | 0 |

Paired runs enroll once, take a deliberate initial seed, then leave the peer
offline until the end of the workload. Their additional allocation includes pages
made reusable after acknowledgement. Thus the state case's 344,064 bytes are not
344,064 retained bytes of extra information. ¹ These paired measurements preceded
final removal of three empty unused raw archive tables and their index. The
current unpaired column was rerun after that cleanup; current replication tests
also use the final schema. Initial empty allocation fell from 528,384 to 507,904
bytes. This cleanup changes fixed overhead and page layout, not the peer protocol.

For current unpaired recording, final physical categories were:

| Category, allocated bytes | Constant | Large state | Mixed | Append |
| --- | ---: | ---: | ---: | ---: |
| Observations | 4,096 | 4,096 | 1,961,984 | 4,096 |
| Learning tables, including sparse caches | 20,480 | 20,480 | 3,567,616 | 20,480 |
| Reporting coverage | 4,096 | 4,096 | 495,616 | 4,096 |
| Durable state | 4,096 | 266,240 | 368,640 | 4,096 |
| Bounded transaction journal tables | 3,842,048 | 475,136 | 7,680,000 | 2,093,056 |
| Configured-peer backlog tables | 12,288 | 12,288 | 12,288 | 12,288 |
| Protected net-branch tables | 8,192 | 8,192 | 8,192 | 8,192 |
| All indexes | 1,052,672 | 290,816 | 2,867,200 | 892,928 |
| Other tables, including recorder statistics/events | 200,704 | 188,416 | 245,760 | 4,128,768 |
| Reusable free pages | 1,073,152 | 102,400 | 2,576,384 | 434,176 |

Indexes are reported separately from their owning table. Branch allocation in
these fixtures holds no archived branch data. The mixed useful learning inputs
remain complete; cache allocation does not replace them. Current constant
recording still has several MiB of bounded journal overhead compared with the
pre-incremental implementation's roughly 24 KiB growth. The improvement is bounded
retention and reduced amplification, not zero replication cost.

Peak WAL was 4.53 MiB for constant recording, 3.96 MiB for large state, 6.76 MiB
for mixed and 4.48 MiB for append. No-op WAL stayed empty. Each isolated fixture
ended with an explicit successful truncating checkpoint; that is not an assurance
that a live WAL shrinks while readers pin it. SHM was reported separately. The
unpaired fixtures created no transfer files or backup archives. Paired fixtures
create worker transfer files; these are inventoried independently of SQLite and
removed with the disposable fixture.

Changing the `journal_changes` primary layout mattered physically: a controlled
5,000-row, 1,200-byte-payload fixture occupied 23,580,672 bytes with the former
`WITHOUT ROWID` layout versus 7,094,272 bytes with an ordinary rowid table including
its extra primary-key index. SQLite overflow-page allocation made logical payload
alone a poor proxy for disk space. These values describe that fixture, not every
row size.

## Transfer and I/O costs

The final configured-peer transfers were 55,229 bytes / 101 changed rows for
constant recording, 58,035 / 101 for nearly constant, 812 / one row for the state
counter, 10,452,533 / 12,356 for mixed, 4,570,582 / 5,760 for append and 460 / zero
for no-op. Appended source and learning records remain actual new information.
Peer metadata grows with distinct unacknowledged changed keys, including necessary
tombstones; it does not retain every superseded image of one changing row.

The earlier transaction-export comparison exercised exact compact patches: the original
incremental code transferred 157,827,238 bytes for 300 small state edits with
catch-up every 32 edits, while compact transaction export transferred 193,840.
That comparison used the same cadence, before removal of the now-unused raw
transaction replay API. Current replication tests use configured-peer catch-up.
The 812-byte configured-peer figure uses one final consolidated catch-up and must
not be presented as the same wire test.

A sustained configured-peer run covered 30,240 reports, or 21 synthetic days,
without any intermediate catch-up. Constant recording allocated 6,275,072 /
6,344,704 / 6,365,184 / 6,365,184 bytes at the quarter boundaries. Nearly constant
recording allocated 6,340,608 / 6,438,912 / 6,443,008 / 6,447,104 bytes. Both retained
one observation and one reporting interval, and ended with 2,025 commits;
logical transaction payload was 3,638,702 and 4,105,187 bytes. Final peer catch-up
transferred 174 changed rows: 94,492 and 99,344 bytes respectively. This crosses
the recorder statistics retention interval as well as repeated transaction
maintenance. Those measurements preceded removal of three empty unused raw
archive tables; the current schema removes their fixed allocation, without
changing retained data or the peer protocol.

For 6,144 offline reports on the final schema, actual catch-up was 108 changed rows and 58,997 bytes
with no earlier events versus 58,998 bytes with 32,768 earlier events. In a
separate 128-report run before the fixed empty-table cleanup, increasing the unrelated prefix from 32,768 to 131,072
events grew the initial database from 56,176,640 to 198,074,368 bytes. Catch-up
still sent eight rows, 5,202 versus 5,171 bytes. Export read 2.62 million bytes
in either case; acknowledgement read 2.60 million bytes. More
precisely, export read character counts were 2,619,394 / 2,614,696 and apply read
23,443,710 / 22,574,112. Receiver apply must clear its own bounded retained
transaction suffix; that cost explains its larger read count, and did not grow
with the fourfold historical prefix. The empty-history receiver read 2,604,780
bytes. This proves measured independence from that prefix, not zero local I/O.

The final extended suite passed all five cases using the current coalesced
protocol. Regular catch-up every 64 reports transferred 371,048 bytes over 6,144
reports, retaining 2,040 commits / 3,642,687 logical bytes. Sixty-four counter edits
of the seeded large document transferred 6,504 bytes and allocated 274,432 bytes.
The mixed 2,048-report case completed four concurrent full verifications and exact
seed replay, with a 136 ms maximum recorder operation in that run. The complete
suite took 319.5 seconds while other synthetic tests ran; per-transfer worker
startup and admission costs are included. None of those measurements is a hard
latency guarantee.

The current unpaired process read/write character counts, in MiB, were 53.32 /
435.21 for constant, 51.96 / 11.78 for large state, 1,150.71 / 3,208.22 for mixed
and 33.96 / 297.89 for append. Original incremental state edits read 1,518.92 MiB
and wrote 508.70 MiB. Compact journal storage substantially reduces retained
images, but still hashes and serializes changed rows and incurs SQLite index/WAL
work. The mixed case's retained size improvement is much larger than its write
I/O improvement. Neither cached reads nor free pages should be reported as zero
cost. Current unpaired peak RSS was 263 MiB constant, 170 MiB state, 343 MiB mixed
and 114 MiB append; these are observed process peaks, not memory guarantees.

## Controller admission and remaining durability stalls

`test/journal-admission.test.js` keeps the reproduced 48 MiB document. Before
admission, a main-thread write blocked this host for roughly 2.3 seconds because
large row capture repeatedly parsed, hashed and serialized the image. Current
admission rejects atomically with `journal_main_thread_transaction_too_large`,
preserving the previous state, journal checkpoint and saved control authority.
The measured timer delay was 421 ms, and 555 ms when rerun alongside import tests,
including creation of the original SQL/JSON input. The same 48 MiB document
completes in a storage worker and verifies exact persisted bytes; main-thread
heartbeat stayed below 13 ms in those runs.
The independent large-value read happens after the responsiveness measurement.

The main thread admits at most 2 MiB per encoded row and 4 MiB of cumulative raw
OLD+NEW capture input per transaction, checked before parsing/hashing. A separate
4 MiB compact-payload cap also applies. Raw work counts even when a text patch is
tiny: 128 attempted edits of a 1 MiB document now reject on the second edit in
27 ms, rolling back the transaction. The former compact-only limit allowed that
case to block for about 2.2 seconds. Ordinary 256 KiB updates remain supported.
The final admission/import run passed all eight tests in 8.4 seconds.
Worker transactions retain their 64 MiB compact-payload bound. CLI CSV import runs
the existing supported importer in a worker, preserving progress, interruption,
retry idempotency and source bytes; its 4,000-row test retains all 20,000 accepted
observations.

Small synchronous commits have a different remaining limit. Reproduce controlled
filesystem pressure, optionally with an isolated pre-refactor source checkout:

```sh
node scripts/benchmarks/journal-pressure.js --reference-root=/path/to/ada3330-checkout
strace -f -qq -ttt -T -e trace=pwrite64,pread64,fdatasync,fsync,ftruncate -o pressure.trace node scripts/benchmarks/journal-pressure.js --reference-root=/path/to/ada3330-checkout
```

The fixture runs a separate writer inserting 131,072 2 KiB events in batches of
256, alongside 6,144 constant recorder reports in each sample process. Every
process uses `synchronous=FULL`; only one diagnostic sample disables automatic
WAL checkpoints. It yields after every recorder operation and records absolute
start/end timestamps for slow calls. Trace WAL frame writes and file descriptors
to distinguish WAL commit synchronization from database checkpoint synchronization.

In the controlled trace, old and current recorder calls stalled during the same
wall-clock interval. Their main-thread WAL `fsync` calls took 1,339.8 ms and
1,334.4 ms; current with automatic checkpoints disabled took 1,342.1 ms. Maximum
recorder operations were 1,341.5 ms old, 1,501.4 ms current and 1,440.4 ms current
with checkpoints disabled. Another current WAL synchronization took 1,412.8 ms.
Turning off checkpoints therefore did not remove the stall. It would be incorrect
to call that a solved journal CPU defect or to weaken FULL durability to hide it.

The incremental implementation still writes more: in that traced workload the
old process wrote 97.73 MiB, current 460.39 MiB and the diagnostic without automatic
checkpoints 416.66 MiB. Bounded compaction also produced roughly 60–145 ms bursts
under tracing. Tracing overhead and unequal run duration preclude a clean latency
ratio. Concurrent recovery validation can still exceed the runtime's one-second
warning threshold; asynchronous lock admission cannot remove time spent inside
a successful synchronous filesystem commit. Hardware-specific latency, memory
pressure and Raspberry Pi storage remain separate qualification work.

One broad concurrent routine run also had a 1,195 ms latency assertion failure;
the affected seven-test focused suite passed on rerun. That individual failure
was not traced, so the controlled filesystem-pressure result is a consistent
explanation rather than proof of its particular cause. Recovery validation under
concurrent synthetic load likewise reported a 1,448 ms main write / 1,449 ms
heartbeat, while preserving exact replay and original records. Keep these results
visible instead of relaxing the latency assertions or claiming every stall is
fixed.
