# SQLite checkpoints, recording and peer catch-up

The current development schema is defined in
[`src/storage/schema.js`](../src/storage/schema.js); the transaction format is **2**.
Incompatible development databases are rejected before mutation. Select a fresh
empty development database deliberately; no migration or automatic reset exists.
Current-schema restart, backups, correction replay and source-only recovery remain
supported. The Home learning algorithm is unchanged.

## Retained information

| Information | Lifetime and purpose |
| --- | --- |
| Selected observations, report coverage, original learning inputs, source events, corrections, recovery ownership and decisions | Historical evidence, retained independently of transaction compaction. Required F2 inputs are not replaced by model coefficients. |
| Recorder counters, open coverage endpoints, adaptive state, current permissions and restoration obligations | Current durable state. New receipts can extend coverage without adding a measurement; their genuine clocks and acquisition gaps remain unchanged. |
| Recent transaction effects | Bounded local audit and recent-checkpoint lookup, including reversible text patches for large documents. |
| Configured peer's unacknowledged changes | One consolidated entry per changed record, including deletions and its original baseline. Repeated updates replace the current hash instead of retaining every intermediate value. |
| Frozen outgoing and incoming transfers | Temporary, durable receipts and changed-row staging until publication/acknowledgement completes. |
| Inactive divergent branches | Protected unique evidence, retained after explicit rejoin. It never grants control authority. |
| Sparse learning checkpoints | Derived replay caches, independent of disposable transactions; the immutable learning inputs remain authoritative. |

Charging's durable control, session, battery reference and restoration state
still writes in the accepting transaction. Its derived card view has a
30-second save cadence: subsequent accepted writes refresh the complete view
when due, and important control, session, plan, restriction and source-availability
changes force an earlier view. The previous complete view and its plan references
remain intact between saves. Each newly saved view carries its own `recordedAt`;
a replica uses that date rather than the newer database publication time and
does not overlay newer control or plan fragments onto an older card. A genuinely
absent date is unknown. Receipt clocks and already-recorded metering/progress
can wait for the view cadence, as can unchanged coordination and Shelly allowance
calculation clocks. This comparison preserves the complete original dated payload;
it never renews native evidence or changes live assessment freshness. Native
allowance clocks, source epochs, allocation results and plan dates remain fences.
A quiet final presentation tail need not survive
restart; durable facts remain authoritative and the running controller computes
a fresh view. This adds no timer, writer, format migration or schema reset.

Optional recorder poll/error totals and repeated unchanged charging-allowance
coverage are buffered with the bounds and failure semantics in
[the recording contract](recording.md#charger-current-allowances). This does not
batch learning inputs, measured energy, source corrections, permissions or
restoration obligations.

Unchanged session-cost and Shelly limiter calculation dates can remain in RAM
without rewriting their complete durable payload. The comparison uses only the
last successfully committed state in the same equipment/session and excludes
precisely `sessionCost.updatedAt` or `limiter.evaluatedAt`; all other fields retain
their normal writes. First admission, pending transaction/retirement and rollback
keep the existing atomic boundary. Native instruction/readback/source clocks are
never covered by this optimization. Cost suppression still shares the ordinary
runtime transaction; fewer logical effects do not prove fewer physical writes
or faster COMMIT. See [charging persistence](charging/architecture.md#charging-persistence).

The main Store's memory-only slow-attempt ring dates up to 16 attempts of at
least one second with their measured stages and prepared journal change counts,
bytes and table names. Preparation and committed outcome remain separate; no
row identities or values enter this diagnostic evidence. It performs no extra
SQL and changes neither journal retention nor SQLite synchronization/checkpoint
policy. See [storage timings](recording.md#storage-health) for unknown, no-effect
and failed-attempt meanings.

An installation has one configured paired or mirror counterpart. Its common
checkpoint is explicitly enrolled during the initial seed. Retained peer evidence
is part of the database, so restart and role changes do not lose the common base.
It does not imply that an arbitrary older backup or unrelated database was a peer.

## Dedicated runtime writer

The live file-backed Store starts one persistent SQLite writer worker before
constructing the runtime. The controller retains a separate read-only connection
for committed WAL reads. Existing storage workers and offline callers use the
same current Store and journal format; this adds no schema migration or alternate
persisted representation.

`runWrite` reserves the writer through asynchronous `BEGIN IMMEDIATE`, one
synchronous callback, asynchronous journal sealing and native `COMMIT`, then
committed follow-up work. Dependent statements inside that callback run on the
reserved worker connection through bounded synchronous messages, so reads observe
the transaction's earlier writes and nested savepoints retain their rollback
semantics. The callback is never replayed. Callbacks remain synchronous and must
not perform network waits. Ordinary reads outside the callback see committed
state through the read-only connection while the worker seals or commits.

Admission retains the 2,048-entry/8 MiB queue, bounded control priority, original
source clocks, cancellation checks and failure reporting. Controller capture
keeps its 2 MiB per-row and 4 MiB per-transaction limits even though SQLite now
executes in a worker; offloading does not silently admit oversized controller
work. Statement messages have an 8 MiB envelope and a bounded statement cache.
Synchronous statement requests have a deadline and fail closed; they are not
automatically retried after an uncertain outcome.

The Store fences command dispatch while a runtime write is settling. Registered
commit effects run only after durability is established, while rollback effects
restore provisional application state on failure. Receipt, equipment identity,
authority and expiry checks still govern commands after storage waiting. Network
processing and timers can continue during a slow native commit; durability-bound
commands still wait for it. A disconnected source must remain unavailable when
an earlier pending transaction completes or rolls back.

The prepared journal checkpoint is the durable receipt for a transaction with
logical changes. If the worker loses its reply, the owner joins its termination
and checks the committed checkpoint before settling application effects. It never
repeats the callback or treats a lost reply as proof of rollback. A failed writer
remains fenced until restart even when its durable result can be established.
Shutdown rejects pending jobs, joins the active transaction and closes the worker
before releasing its reader. Specialized correction, recovery and peer workers
retain their existing publication fences; a local exclusive publication reserves
the same admission queue through durable publication and adoption.

Synchronous replies publish bounded response bytes and readiness through one
shared-memory atomic boundary. A notification alone never completes a request;
late wakes do not restart its deadline or replay SQL. Result collection is
bounded before materialization, and returned byte values own their storage.
Closing during writer startup joins that worker before releasing the database
path. Current explicit journal compaction runs on the owning worker; peer
maintenance and full archive verification retain their independent native
worker connections. Calling those native-only operations with the runtime
facade rejects before mutation with guidance to use the existing service.

While a save is pending, status preserves the complete committed view and its
original timestamps. Recording health reports an ordinary pending save as neutral
activity; actual writer-lock contention retains its storage warning. Transport
withdrawal still takes effect immediately for command permission and survives
an older save's rollback.

This isolates ordinary native COMMIT waits from the event loop; SQLite still has
one committing writer. FULL synchronous WAL and retained evidence remain
unchanged. Runtime checkpoint admission is described below. Synchronous callback work, bounded statement RPC and
main-thread read queries can still delay the event loop. See the
[responsiveness benchmark](sqlite-storage-benchmarks.md#dedicated-writer-responsiveness)
for measured benefits, overhead and installed-validation limits.

### Background storage admission

The runtime Store's existing queue admits control and ordinary saves before
queued background storage steps. Mirror staging, acknowledgement, wire-file
output and transfer reads share this admission, as do ordinary learning-cache
writes and history-reader SQL. A worker requests a turn before native I/O and
releases it afterwards; cancellation retains an admitted reservation until that
worker actually exits. CPU processing and network waits need no storage turn.
Exact-head learning publication retains its existing exclusive authority fence.
After 32 foreground jobs, one pending background step may precede ordinary
ingestion to prevent maintenance starvation; a pending urgent control save
continues to take priority.

Read cursors release admission after at most 64 returned rows or about 8 ms of
iteration work. Their original read transaction remains coherent between turns;
a pinned reader can still prevent a checkpoint from completing. Mirror staging
uses private transactions of at most 16 records, approximately 128 KiB, or 8 ms
of preparation work before COMMIT. One legal larger record is handled alone.
Private intermediate batches grant no publication authority: the complete frozen
target, fingerprints, source clocks, file synchronization and pending receipt
are still required. Source acknowledgement uses the same small row/byte limits.
The receiver continues to apply each verified transfer atomically.

The persistent runtime writer and admitted background writers disable independent
automatic checkpoints. One runtime owner polls at most every 250 ms and admits
PASSIVE checkpoint work through the background lane when at least 100 frames
remain, or a smaller tail has waited five seconds. SQLite's status-only NOOP mode
avoids checkpoint I/O during polls. Supported Node builds without that capability
use a periodic PASSIVE call at most once a second. Offline Stores retain native
checkpoint ownership. Shutdown closes the maintenance timer before the writer.

These are work/admission budgets, not latency guarantees. A SQLite query step,
transaction COMMIT, file sync or checkpoint cannot be interrupted to enforce a
wall-clock budget. A large atomic transaction can exceed the frame target.
Checkpoint and background-step samples remain bounded in RAM; no extra database
rows, persisted format, retention reduction or schema conversion is introduced.

## Local writes and compaction

Schema triggers capture every actual application row effect. Equal SQL updates
produce no capture; cancelling effects on the same key within a transaction are
coalesced. Capture immediately encodes changed columns and reversible text splices,
so a small document edit does not stage two complete document copies. Full-row
SHA-256 fingerprints check both sides of each change. Primary keys stay stable.
Unsupported external writers without the capture functions fail before mutation;
unsealed capture remains a startup error.

Capture passes SQLite's typed column values directly to JavaScript and uses the
same serialization as row verification. SQLite JSON rendering is not a lossless
encoding of REAL values on every supported runtime: rounding a value before
hashing would make an intact database fail verification. Numeric precision, TEXT
bytes and NULL remain unchanged. Unsupported nonfinite or binary values, and TEXT
containing an embedded NUL that older supported Node bindings truncate on read,
fail atomically rather than being normalized into another value. Existing development
journals with rounded fingerprints are preserved and rejected, never silently
rehashed or translated.

The row effects, linked commit hash, current materialized-content fingerprint,
peer change index and durable head commit together under FULL synchronous WAL.
Savepoint rollback discards captured effects. Explicit receiver apply/undo already
validates and publishes these effects atomically, and disables redundant trigger
staging only within that boundary.

The main Store's memory-only diagnostics split its complete commit boundary
duration into journal sealing and the raw SQLite COMMIT call. With the dedicated
writer, BEGIN, callback, complete commit and total durations describe elapsed
operation time including worker messaging; journal sealing and native COMMIT
are measured on the owning worker. Sealing includes
capture coalescing, validation, hashing, peer-index updates, retention and journal
SQL; capture performed by row triggers remains within transaction-body timing.
Raw SQLite COMMIT can include WAL synchronization and an automatic checkpoint;
it is not an fsync-only measure. Unreached and uninstrumented bootstrap stages are
null. The split changes no journal bytes, transaction boundaries, FULL/WAL
settings, checkpoint policy, rollback or publication authority. Dedicated runtime
writer measurements belong to its owning Store summary; independent recovery,
replication and cache-worker transactions remain outside that summary.

The superseded transaction-by-transaction receiver/rewind path and its separate
branch archive are removed. The recent suffix remains readable for verification
and checkpoint lookup; all active peer application and rejoin use the same
consolidated change mechanism below.

Recent transaction retention has high limits of **8 MiB serialized commits** and
**2,048 commits**. Exceeding either trims toward 6 MiB and 1,536 commits; the newest
complete transaction is kept even if it exceeds 8 MiB. The absolute transaction
limit is 64 MiB. The floor checkpoint, content fingerprint, counters and indexed
prefix deletion publish in one SQLite transaction. Interruption exposes either the
old floor and rows or the new floor and rows, never a partially advanced floor.
No transaction records are needed below that floor for peer catch-up.

Cleanup reads only the disposable prefix and deletes it with indexed range
operations. Its amortized cost follows removed effects, not total observations.
Freed SQLite pages are reused. **Deletion does not shrink the physical file**;
there is no automatic VACUUM, historical rewrite or recurring full-database copy.
Allocated pages, unused/reusable space, indexes and WAL can exceed serialized
payload limits. Long pinned readers can hold a larger WAL until they release.

Controller transactions admit rows up to 2 MiB of capture input and up to 4 MiB of
cumulative before/after input or compact capture payload per transaction.
Counting input bytes also bounds repeated tiny edits to a large document.
Oversized work fails with an
actionable worker/batching error and rolls back. Dedicated runtime writes retain
these controller bounds. Specialized background transactions retain the 64 MiB
bound. This is an execution admission limit, not a reduction in observation
precision. Supported CSV CLI imports run in a worker. Consolidated peer application
streams individually bounded records in a receiver worker and publishes the whole
accepted source checkpoint atomically; it does not accumulate the transfer in JS.

## Offline peers and divergent history

**Time offline never requires a new full snapshot of an intact configured peer.**
Routine pair and mirror transfers use the consolidated change index. Transfer and
lookup work follows keys changed since the acknowledged checkpoint, not all rows
in the database and not every intermediate transaction. Insert/delete pairs with
no remaining effect can disappear from that index. A real deletion of a record the
peer holds remains represented until acknowledgement.

The source pins a read snapshot and stages only those changed records in a private
SQLite file, retaining full target values for later acknowledgement. The wire file
contains compact changes and a source checkpoint/content fingerprint. File and
directory synchronization precede publishing the pending-transfer receipt. Staging
does not hold the source's write lock. Transfer frames are bounded; interrupted
transfers leave the receiver's previous checkpoint available. Retrying uses the
same immutable pending target even if recording has continued or the recent
transaction window has advanced. The current consolidated delivery format is
version 2. Its `sourceStartedAt` and `sourceAt` are captured around the same
pinned read that supplies its target checkpoint. Private staging metadata, the
saved pending receipt, wire header and public descriptor retain those exact
clocks. Reading a previously exported static seed retains the seed's original
clocks and requires its exact checkpoint; it never dates the old file anew.

Receiver publications use the delivered target and its frozen clocks together,
including a retained delivery older than a later checkpoint query. Pairing,
standalone SSH mirrors and protected release/rejoin follow this rule. A snapshot
clock does not renew any device report or saved charging-view date. Charging and
learning views newer than their publication boundary remain unavailable.

There is no untimestamped delivery decoder or clock repair. Before deploying this
transient-format change, complete and acknowledge existing deliveries with the
matching earlier software, quiesce synchronization at that acknowledged boundary
and update both peers together. An existing untimestamped pending delivery fails
with `journal_peer_format_incompatible` before staging cleanup or receipt mutation.
Preserve its database and staging files; use the matching software to finish it,
or an explicitly approved deliberate fresh development start. This format change
does not migrate, replace or reset the same-schema application database.

The receiver verifies its starting checkpoint, each expected row fingerprint,
transport digest and resulting whole-content fingerprint before committing the
rows, target checkpoint and common peer anchor together. A durable publication
receipt resolves a crash after commit but before acknowledgement. No partial
transfer becomes visible as an accepted source state.
The next manifest's private temporary file is written and synchronized before
the receiver's final authority checks and SQLite apply. After successful apply,
the receiver renames it into view and synchronizes the directory, then removes
and synchronizes the pending receipt. The temporary file alone never grants
publication authority. Recovery checks the actual database against the durable
receipt and reconstructs the accepted manifest; it does not trust abandoned or
incomplete temporary bytes. The next owned preparation replaces its exact
temporary file. Startup recovery does not gain new permission to delete a file
that another current owner could still be preparing.

The delivered target and source clocks are unchanged. The existing local
`verifiedAt` is assigned while preparing that receipt, before apply; it is not a
measured SQLite commit timestamp. A post-commit rename failure, lost apply reply
or uncertain directory synchronization retains recovery duties rather than
acknowledging success. Coherent readers still refuse a real checkpoint mismatch.

Source acknowledgement rebases only transferred keys, in transactions bounded by
both row count and bytes (one legal oversized record is handled alone). It
yields to controller write admission. Target rows saved in the pending spool
preserve updates arriving after the frozen target. The cleanup cursor survives
restart. Consecutive ordinals, row identities and an accumulated content checksum
reject missing or damaged staging before completing the acknowledgement.
New exports wait while the common anchor is being rebased; the new anchor
publishes only after all its keys are consistent. Completed/orphan staging is
reclaimable; a missing or corrupt required pending source remains an error rather
than authorizing a guessed checkpoint or silent replacement.

A completed initial-seed acknowledgement retains its source-file cleanup receipt
until the owning transport has released the snapshot pin. Restart or a lost reply
can repeat that cleanup without pinning a full database copy indefinitely. Export
waits for this cleanup, including when the next peer request proves acceptance of
the earlier seed.

For explicit protected rejoin, both peers first establish the retained common
anchor. The selected master's complete changed-row transfer is staged **before**
the donor is rewound. Undo retains unique divergent before/after rows and a checked
branch fingerprint in the same transaction. Subsequent active-row deletion and
transaction compaction cannot make that archived evidence uninterpretable. Rejoin
then applies the staged target through the same publication mechanism. The archive
and saved release receipt survive interruption and lost replies.

An offline peer's backlog is bounded by its **distinct changed records**, not a
fixed byte allowance. New useful history and unacknowledged deletions can grow it;
repeated bookkeeping cannot create unlimited versions of one row. Divergent
archives and independent backups also have separate retention. A full initial
seed, explicitly requested full verification, or repair of damaged/unrelated
history can legitimately read/copy substantial data. Ordinary peer catch-up,
source checking, rejoin and handover must not use such a copy merely because the
transaction log expired.

## Learning recovery and reversal

Sparse supported checkpoints are saved atomically with their validated model
cache, initially for a new epoch/source revision and then after at least 256 input entries or six hours
of source time. They are indexed by input, source revisions, time and cursor and
replicate as ordinary cache rows. This is not a per-minute model snapshot stream.

Current and sparse caches store the complete numerical checkpoint with ordered
references to shared, content-addressed prepared samples. Episode archives retain
their exact sample membership, including warmup windows and invalid endpoints.
The shared bodies preserve the original normalized sensor/fireplace interpretation;
loading never substitutes current configuration or current source selection.
Indexed batches hydrate only the saved working set and verify each body's digest.
Sample bodies and their cache manifest publish in the same transaction and
replicate as ordinary changed rows. Required bodies must exist at the receiver's
checked base or arrive in its changed-row transfer before the target is accepted.
Ordinary peer transfers can only insert these immutable bodies; protected rejoin
owns their separate rewind/removal path and preserves divergent values in branch
evidence. The receiver streams body validation and stages affected manifest keys
in disk-backed private TEMP storage, avoiding a JavaScript collection of the
entire offline backlog. Existing bodies at the checked base are trusted during
catch-up; hydration verifies their hashes, and full verification audits retained
bodies and archived branch references. A matching checkpoint alone is not a full
database integrity check.

Sparse checkpoint cadence and retained recovery evidence are unchanged. Shared
prepared bodies remain available even after a recovery is reverted or a cache is
superseded; they are derived caches, not replacement source history. Future growth
includes unique prepared bodies (including distinct corrected interpretations)
and small sparse manifests, rather than another complete fitting archive per
checkpoint. This does not bound total database size or automatically reclaim the
physical size of an existing file. Development schema 32 supports only this
current representation; there is no older cache decoder or database migration.
Read-only history viewers may still expose independently valid recorded evidence
when a derived model cache is unavailable. Model access rejects malformed or
unsupported cache representations; writable startup and full verification remain
strict, and no older checkpoint is interpreted.

For ordinary live learning, caches above 128 KiB (including replacement of an
already larger cache) save through a worker after the controller transaction.
Their sparse checkpoint and active cache publish together at the same validated
journal boundary, which may precede newer committed inputs. The existing worker
transaction limit still applies. A failed cache save leaves the previous cache
and immutable journal intact; it cannot undo committed charging intent or stop
the controller update loop. Shutdown joins the cache writer before releasing the
database. Recovery and source corrections retain atomic selection and caught-up
model publication.

Recovery and reversal select a validated checkpoint before the earliest affected
input and reuse the unchanged immutable prefix as indexed ranges. Ordered replay
rebuilds the affected suffix using the same learning function as live operation.
The lookup pins a coherent read snapshot; it cannot combine an older saved state
with newer patches. Sparse caches remain available after transaction compaction.
A removed fireplace load is effective from its original load time; a reversed
sensor change is effective from its original boundary. Later correction receipt
time cannot justify retaining already affected learning. Source revision and
prefix checks still govern reuse. Changes reaching the supported seed, absent or
invalid usable caches, or actual early-history corrections can require a longer
replay. No required source inputs or immutable decisions are deleted to save space.

## Independent full verification

Normal startup validates current schema, saved control state and indexed committed
boundaries; it does not scan historical measurements. A checkpoint does not prove
fresh equipment data or replace physical command/readback obligations.

The optional full verifier pins a read transaction and checks SQLite integrity,
foreign keys, supported historical contracts, retained commit chains and branch
evidence. It independently recomputes the XOR accumulator of domain-separated
SHA-256 row fingerprints over **all current application rows**, including those
older than the compacted transaction floor. This detects missing, changed or extra
materialized rows against the committed fingerprint. The accumulator is a content
checksum; authenticated transport and authority rules remain separate.

The retained transaction audit proves continuity from its saved floor to the
current head, not the discarded sequence of intermediate mutations. Peer baseline
rows and indexed payload keys are checked independently. Exporter metadata and
machine-local peer receipts are outside active-content comparison; protected branch
evidence is checked separately. Same-checkpoint comparisons additionally hash
canonical application tables. Different moving checkpoints are incomparable, not
proof of corruption. AUTOINCREMENT high-water marks may remain above active IDs
after undo without changing active historical contents.

Manual, scheduled and manual-operation verification remain available. All full
checks in one application process share a bounded queue with visible origin,
waiting/running status and cancellation; independent CLI processes have separate
queues. Full checks and backups remain intentionally proportional to retained
history and can compete for storage bandwidth. Observation precision budgets
remain separate from total physical allocation, journal, peer backlog and backups.
