# Model reconstruction, corrections and software versions

This is the detailed engineering contract for
[F2: model reconstruction](../AGENTS.md#f2). The foundational policies and
[conflicting-request process](../AGENTS.md#conflicting-requests) in `AGENTS.md`
govern changes; [F1: current-format compatibility](../AGENTS.md#f1) governs the
supported software and database boundary. Changes to the agreed reconstruction
guarantees or scope require the owner's explicit agreement after identifying the
conflict and consequences; specific informed approval already given for the change
carries forward. Maintaining algorithm identifiers and implementation details
within those guarantees does not itself require another approval. The
fireplace feature keeps the existing scope of reproducible learning; it does not
add a general archive for reproducing every historical control choice.

## What can be reconstructed

The owner-approved [production convergence and upgrade policy](../AGENTS.md#f9)
starts production data continuity at v1.0.0. Each subsequent release owns its
specific conversion from the preceding production release; older backups may use
documented intermediate releases. This does not add historical interpreters to
the current runtime or relax pre-production format rejection. An algorithm change
must explicitly describe retained evidence, any supported rebuild and any new
learning epoch. Original observations, frozen forecasts, corrections and their
provenance keep their historical meaning throughout an upgrade.

Given an intact committed learning journal, its saved configuration and initial
seed, the selected fireplace and sensor-correction revisions, and the matching
learning algorithm and software, replay must produce the same model checkpoint
at the same committed journal boundary. This includes learned coefficients,
estimated building and slab state, comfort references and learning evidence.
Live learning and reconstruction must use the same ordered entry function.
Checkpoints are replaceable caches with integrity digests and journal cursors;
they are not the only source of model history.

Preserve a consistent backup of the full SQLite database and the corresponding
software version. The journal contains resolved learning inputs, configuration and
seed information; fireplace and sensor-correction events preserve the selected
interpretation. A temperature or telemetry CSV export alone does not contain this
complete record and cannot guarantee exact reconstruction. Imported CSV provenance
and interpretation remain unchanged. Original discarded polls cannot be recovered,
but are not required once their resolved learning inputs have been committed.

Replaying the same correction revisions reproduces the same interpretation.
Selecting a later correction intentionally reconstructs a corrected model, which
can differ from the model used at the time. The source events preserve earlier
revisions without rewriting the original measurements.

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
or applied it. Recorded observations, forecasts and outcomes remain evidence in
their own right; model replay does not recreate missing physical outcomes or turn
estimated savings into measured savings. Readback and measured behavior must remain
distinct from intent.

Heating-plan exploration keeps hypothetical snapshots only in bounded memory.
An explicit admin one-cycle approval is retained with the actual cycle's frozen
plan; qualifying completed episodes also carry that approval context in the
learning journal. Simulated alternatives do not add journal entries, consume
learning allowance or validate a duration. Actual observations use the existing
ordered learning updates and completion gates. This adds provenance without a
second learning algorithm or a comprehensive archive of hypothetical decisions.

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

## Recovery source corrections

Current-format history recovery uses the same gap merge and ordered model replay
for paired computers and SQLite backups. Each operation records immutable
contribution ownership and source fingerprints. Records that were already local
are not owned by the recovery, and retrying a donor does not duplicate its evidence.
The recovery list includes interrupted operations with accepted contributions.

Revert and restore are explicit, reviewed source-selection revisions. Revert
excludes an operation's contributions and dependent learning; it never deletes
original observations, events or journal payloads. Later local recordings and
other accepted recoveries remain selected. Restore reapplies the retained source
where current evidence permits; local evidence acquired in the meantime wins
conflicts. Rejected fingerprints prevent a different snapshot from silently
reintroducing the same source. Logical provenance remains stable across local
record IDs and compact journal projections.

A worker stages exclusions and the affected journal suffix. It reuses a validated
sparse checkpoint and immutable prefix before the earliest affected input, then
replays the current algorithm over the suffix and catches up new learning. These
caches survive transaction compaction; recovery and reversal do not copy the
database or revisit unrelated older measurements. Cache reuse proves that source
selection and corrections leave the prefix unchanged. An early correction or a
missing usable cache can require replay from the supported seed; all required
inputs remain retained. See [SQLite learning recovery](sqlite-journal.md#learning-recovery-and-reversal).
Publication checks
the source selection, fireplace and sensor revisions, authority and journal head,
then atomically selects the new history, epoch, checkpoint and immutable decision.
A concurrent local observation that changes restoration conflicts requires a new
review. Until publication, control and charts retain the prior selection; a failed
revision leaves that selection intact. Published prior epochs and decisions remain
available as evidence. Abandoned unpublished projections may be discarded.

Physical observations can be shared by multiple saved input histories. A revision
is refused if another input's selected journal depends on evidence it would
exclude; changing only the current model would leave that other history incorrect.
Keep the recovery active or use separate databases for those input histories.
Recovery does not silently translate or repair another input's saved journal.

Derived cycle savings and recovery-error claims become unknown when their inputs
or frozen model could depend on rejected learning. Original outcomes, observations
and frozen forecasts remain recorded. Recovery corrections never replay equipment
commands, revert configuration, grant control authority or erase restoration duties.
They correct the retained interpretation, not the physical actions already taken.

## Version discipline

The Home learning algorithm is `committed-house-v16-observed-input-admission`, with
thermal model version 4. Production starts from a fresh database and an explicit
initial seed. There is no compatibility migration for development databases.

The journal saves the resolved learning configuration, including the relative
ROOM preheat increase, shared recovery-hold duration, source assumptions and
selected-slab priors. The actual ROOM increase respects the native setting limit;
recorded heat delivery remains separate from the requested action. Action evidence
is matched to the hydraulic treatment used throughout charging, reduction and
recovery. Changes to equipment or treatment assumptions invalidate the relevant
action evidence; source/rating and slab changes also clear thermal validation.

One hydronic coefficient acts on routed space-heating compressor heat plus AUX
heat. Compressor thermal and electrical estimates remain separate. Domestic
hot-water production contributes zero to the space-heating thermal input by
explicit simplifying assumption. The optional slab has a persistent latent
state, fixed material capacity, room exchange and ground exchange. Configuring it
allocates selected material from the seeded reserve unless a separate remaining
capacity is supplied. Ending the override does not reset stored heat or remove its
forecast uncertainty. No slab coefficient is fitted automatically.

Fitting requires independent input evidence. Genuine temperature endpoints,
complete source-report coverage and causal thermal warmup are preserved in replay.
Repeated held readings do not add independent fitting targets; the original heat
input windows continue to integrate between reports. Warmup is at least 48 hours
(four reserve time constants, capped at 288 hours). The bounded episode cache
retains that prefix; unsupported initial storage cannot establish fit acceptance.
The recent sample cache and retained episode count remain bounded, with up to two
additional hours of input windows for a delayed genuine endpoint. These are
checkpoint fitting caches, not duplicate source journals.

Configured sensor membership and weights do not change when a reading is missing.
Held values retain their genuine source and receipt clocks, lineage and recorded
report-coverage contract. Required reporting gaps and acquisition failures exclude
those intervals even if telemetry later recovers. A reconnection can end a
transport-only gap only when the genuine reading remains valid and its saved route
matches; it never creates a new temperature observation. Configuration and
reporting-policy changes are recorded at their effective time. One-room estimates
are control-only: no inferred temperature enters the learning journal as an observed
endpoint, trains the thermal/reference learner or supplies validation outcomes.
Journal admission and both learners check explicit estimate provenance as well
as quality flags. An incomplete contributing-room report remains a thermal
barrier even when a numeric endpoint survives beside that coverage failure.
The comfort checkpoint contains one aggregate reference and its bounded continuous
learning state, including supported duration, latest evidence and intervention
settling. Ordered updates preserve the same result across restart and replay.

Sensor changes and reversals are compact immutable journal events. A sensor change
masks only the changed sensor during its settling period and prevents thermal
intervals crossing the boundary. Existing coefficients, validation, completed
episodes and comfort references remain available for gradual recalibration.
Outdoor changes keep unrelated indoor measurements. Current live and committed
outdoor selection uses FMI with Open-Meteo fallback, excluding noisy H66 reports. These source and continuous-reference semantics form the current algorithm;
old development learning checkpoints require a deliberate fresh start, not an
old-algorithm interpreter or automatic migration. Corrected replay uses the same pure
eligibility projection as live learning. It may recover preserved measurements
behind a reversed settling period, but cannot erase actual reporting gaps or
replace original frozen forecasts. Rebuilds pin correction revisions and the
journal head, catch up in the background, and atomically publish a verified
checkpoint while control remains available. Pending rebuilds survive restart.

Changes to numerical interpretation, training selection, corrections, seeds or
fitting rules require an explicit learning algorithm identifier change and replay
tests. Configuration changes are recorded with their digest and snapshot. SQLite
schema versioning is separate from learning algorithm versioning. A journal whose
algorithm is unsupported must be reported as such, never silently reinterpreted.
Historical CSV imports retain their source meaning and timestamps.

Source events are stored once, input projections are derived and rolling state
remains bounded. Do not add repeated full histories, per-minute model snapshots or
comprehensive decision-input archives without an agreed scope and storage budget.
Retrospective firewood benefit remains a read-only estimate under the corrected
model; it is separate from a forecast saved before execution or measured savings.

## Garage control and original history

Garage has no learned heat model or automatic savings planner. Its manual
mode, normal target and warm-up advisory are current device-bound state. The
heat-pump controller and protection sender retain their local
target/protection state independently. Neither a model reset nor a copied
database authorizes commands or manufactures protection reserve. Original
measurements and generic historical journal/events remain unchanged; there is
no old Garage algorithm interpreter or coefficient replay. Home's
reconstruction guarantee above is unchanged.
