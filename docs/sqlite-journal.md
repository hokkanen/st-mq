# SQLite transaction checkpoints

The current development schema records database mutations as an ordered transaction
journal. An ordinary restart checks the schema, current saved control state, and
indexed journal head. It does not read every historical measurement or run SQLite's
full integrity checks. Incompatible development databases are rejected before
mutation; select a new empty development database deliberately. No migration or
automatic reset is provided.

Every writable Store connection captures actual inserted, updated and deleted rows
with schema-defined triggers. The outer SQLite transaction saves the row changes,
a SHA-256 commit linked to its predecessor, and the durable head together. Nested
savepoint rollback removes its captured effects. FULL synchronous WAL commits own
the durability boundary. A process failure cannot publish a head without its data
or commit data without its journal. Unexpected pending capture from an external
writer is rejected at startup. Primary keys are stable record identities.

A checkpoint identifies the database lineage, transaction sequence and commit hash.
It is continuity evidence, not a claim that every historical page was re-read or
that copied device state is fresh. Existing command ownership, source quality,
equipment identity and restoration gates still apply independently.

Replication exports a bounded suffix of whole transactions. A transaction is never
split into separately visible application states. Receivers verify lineage,
sequence, predecessor and content hashes and compare each row's prior value before
applying a batch atomically. Repeated delivery of an already committed prefix is
idempotent. Disconnection or incomplete transfer leaves the previous checkpoint
available. Transport fragments may split bytes, but publication waits for the
complete verified transaction. Transactions have a 64 MiB serialized limit;
producers batch large imports rather than building an unlimited transaction.

On a shared-lineage rejoin, the divergent suffix can be archived and undone in the
same database transaction before applying the selected master's suffix. Its before
and after images remain inactive evidence. They do not restore old control authority.
Only the changed suffix consumes extra retention space; ordinary rejoin does not
need a second complete copy of shared history. An unrelated lineage or damaged
journal requires explicit exceptional repair or a full seed.

Full backups and full verification remain separate operations. The optional verifier
pins SQLite read transactions and checks the complete schema, historical contracts,
foreign keys, journal and materialized rows. A paired comparison requires identical
transaction checkpoints before comparing canonical table contents. A moving or
different checkpoint is reported as a comparison mismatch, never proof of damage.
Exporter metadata and internal journal archives are outside the active-row content
comparison; retained branch hashes are still checked independently. SQLite's
AUTOINCREMENT high-water marks may remain higher after a
retained branch; existing row identities and active contents are authoritative.

Recovery and recovery revert reuse durable learning checkpoints from committed
state images. A matching checkpoint before the first affected input preserves the
unchanged prefix as compact ranges of immutable journal rows. The existing learning
update function then replays the affected suffix. Each range uses indexed, bounded
reads, including the first-entry seed check; an outer SQL LIMIT alone does not
guarantee that a union avoids scanning its complete prefix. A correction without
a matching prior checkpoint still requires reconstruction from the saved seed.

The journal retains before and after images and therefore adds storage proportional
to changed data. It currently has no automatic retention expiry. Required learning
source records and current-format correction history remain intact. A compact head
is a durable checkpoint, not a replacement for backups or a promise to detect
latent corruption without a full check. Full verification, initial seeding, and
reconstruction of an affected learning history can legitimately read substantial
history; routine continuity checks and unchanged-peer scans must not do so.
