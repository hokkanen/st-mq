# Model reconstruction, corrections and software versions

This is the agreed engineering contract. Changes to it require the owner's explicit
agreement. The fireplace feature keeps the existing scope of reproducible learning;
it does not add a general archive for reproducing every historical control choice.

## What can be reconstructed

Given an intact committed learning journal, its saved configuration and initial
seed, the selected fireplace event revision, and the matching learning algorithm,
replay must produce the same model checkpoint. Live learning and reconstruction
must use the same ordered entry function. Checkpoints are replaceable caches with
integrity digests and journal cursors; they are not the only source of model history.
Original discarded polls are not required once their resolved learning inputs have
been committed. Imported CSV provenance and interpretation remain unchanged.

This guarantee is conditional on retaining those inputs and the corresponding
software. Corrupt or lost source history cannot always be repaired by replay, and
size limits or deliberate history removal can limit the recoverable interval.
Checksums detect accidental changes; they neither authenticate data nor replace
backups. A SQLite transaction prevents a partial checkpoint publication, but cannot
guarantee survival of every hardware or storage failure.

Existing control plans, observations, command attempts and available acknowledgements
remain useful evidence. Exact replay of every past choice is outside this contract:
we do not capture every transient provider response, scheduler state or complete
runtime snapshot. A recorded command attempt is not proof that the heat pump received
or applied it. Readback and measured behavior must remain distinct from intent.

## Manual source corrections

`fireplace_events` stores a load once and a removal once, with server timestamps,
input source and retry identifiers. The original load remains after removal, even
for an immediate mistake. This small uniform log avoids ambiguous deletion races.
A revision is the last included event ID for that source. A removed load contributes
no heat anywhere in that revision's corrected history; selecting an older revision
recovers the earlier interpretation. Raw observations and learning journal payloads
are never rewritten by the fireplace interface.

Learning derives fireplace inputs in memory from the event revision. Corrected
replay can change fitted parameters, reserve estimates and comfort/evidence state.
Affected cycle assessments lose their savings/recovery claims; their actual
observations, command history and original frozen forecasts remain recorded.
Coefficient charts replay with the current corrected fireplace revision and the
configuration recorded with each journal entry. They describe reconstructed model
history, not a complete account of every model instance used by past decisions.

If no subsequent learning window consumed a load, removal needs no coefficient
rebuild. Otherwise a worker replays the corrected history while the existing model
continues serving control. Planning uses the corrected fireplace source immediately;
the temporary reserve observer is recalculated using the active coefficients.
The worker catches up new journal entries and must match both source revision and
journal head before the engine atomically publishes its complete checkpoint and
completion status. Newer corrections supersede stale workers. Pending work survives
restart. A failed worker retains the previous model and reports failure; restarting
the service or recording another correction retries it.

## Version discipline

`committed-house-v4-fireplace` introduced the pooled fireplace response and its
original evidence rules (Git revision `a3390ad`). `committed-house-v5-fireplace`
adds meaningful-tail learning gates and fitting against retained, validated house
coefficients. The fixed response curve remains version 1. The v4 journal remains
an archive requiring its matching code; the current runtime does not relabel it.
The first v5 record establishes the new algorithm's explicit seed/learning epoch.
Existing experimental SQLite contents do not require a compatibility migration.
Changes to numerical interpretation,
training selection, corrections, seeds or fitting rules require an explicit learning
algorithm version change and appropriate replay tests. Configuration changes remain
recorded with their configuration digest and snapshot. SQLite schema versioning is
separate from learning algorithm versioning.

Never interpret an old journal as a newer algorithm while claiming identical
reconstruction. Support an older version explicitly, or preserve its history as an
archive with the matching Git revision/release and establish an explicit new seed
or new learning epoch. Old implementations do not have to run beside the current
controller. Reproduction of an archived unsupported version requires checking out
its corresponding code; the current runtime must report unsupported history honestly.

The fireplace addition must remain compact: source events are stored once, input
projections are derived, and rolling model state remains bounded. Do not add repeated
full histories, per-minute model snapshots or comprehensive decision-input archives
without a separately agreed change of scope and a measured storage budget.

Retrospective firewood savings are a separate, read-only calculation under the
current corrected model and normal heating policy. A model update can revise them.
They do not claim to reconstruct a past controller's forecast or control choice,
and must remain labelled as estimated rather than measured savings.
