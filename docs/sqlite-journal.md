# SQLite checkpoints, recording and peer catch-up

The current development schema is **26**; the transaction format is **2**.
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

An installation has one configured paired or mirror counterpart. Its common
checkpoint is explicitly enrolled during the initial seed. Retained peer evidence
is part of the database, so restart and role changes do not lose the common base.
It does not imply that an arbitrary older backup or unrelated database was a peer.

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

The controller thread admits rows up to 2 MiB of capture input and up to 4 MiB of
cumulative before/after input or compact capture payload per transaction.
Counting input bytes also bounds repeated tiny edits to a large document.
Oversized work fails with an
actionable worker/batching error and rolls back. Worker transactions retain the
64 MiB bound. This is an execution admission limit, not a reduction in observation
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
transaction window has advanced.

The receiver verifies its starting checkpoint, each expected row fingerprint,
transport digest and resulting whole-content fingerprint before committing the
rows, target checkpoint and common peer anchor together. A durable publication
receipt resolves a crash after commit but before acknowledgement. No partial
transfer becomes visible as an accepted source state.

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

Sparse supported checkpoints are saved atomically with learning, initially for a
new epoch/source revision and then after at least 256 input entries or six hours
of source time. They are indexed by input, source revisions, time and cursor and
replicate as ordinary cache rows. This is not a per-minute model snapshot stream.

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
