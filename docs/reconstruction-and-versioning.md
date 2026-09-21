# Model reconstruction, corrections and software versions

This is the agreed engineering contract. Changes to it require the owner's explicit
agreement. The fireplace feature keeps the existing scope of reproducible learning;
it does not add a general archive for reproducing every historical control choice.

## What can be reconstructed

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

The Home learning algorithm is `committed-house-v11-preheat-recovery`, with
thermal model version 3. Production starts from a fresh database and an explicit
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
reporting-policy changes are recorded at their effective time.

Sensor changes and reversals are compact immutable journal events. A sensor change
clears the affected measurement evidence; retained coefficients are starting
estimates until independently validated. Corrected replay uses the same pure
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

## Separate Garage learning

`committed-garage-v1-coupled` establishes Garage's own saved seed and journal
stream (`garage:<input>`). It applies this same reconstruction contract without
changing Home's learning algorithm or CSV interpretation. Ordered normalized
samples, configuration and sensor-correction events drive both live updates and
worker reconstruction. Memory publication follows successful durable checkpoint
publication; a failed write retains the previous checkpoint. A Garage failure
revokes its pause permission while Home control continues independently.

Garage's frozen episode reference and each protection location's thermal reserve are
separate from replaceable model checkpoints. A corrected reconstruction never
rewrites observed behavior, resurrects an old pause or clears physical recovery
debt. Imported rear-only history remains a separate, explicitly incomplete
reconstruction; missing front/native/OFF evidence is not fabricated. See
[Garage learning](garage.md) for its supported evidence and provisional adapter
boundary.

`committed-garage-v2-sparse` replaces v1's per-report recursive fit and short-step
readiness with a smaller duration-weighted fit, retained regime statistics,
whole OFF/recovery validation and supported-duration planning. The v1 algorithm
and `garage-exposure-v1` arithmetic remain archival at Git revision `e0b0c11`;
they are not replayed as v2. The first v2 journal entry saves a new explicit seed.
Adapter boots interrupt active evidence but do not erase completed experiments;
explicit sensor corrections still establish measurement boundaries.

An existing frozen v1 accounting episode remains an incomplete archived
assessment with an active measured restoration obligation. New code never calls
v2 prediction on its v1 model. Its original observations, frozen state and costs
remain archived; both measured locations must recover before the obligation ends.
If changed weather makes the former absolute temperatures unattainable, eight
continuous hours of verified normal native availability with both locations above
the then-configured warm-recovery threshold and local exposure repaid could close it as
incomplete. That measured restoration rule grants no comparable-service or savings
claim and never evaluates old dynamics as the new model.
Operational exposure separately upgraded to `garage-exposure-v2`, retaining at
least the previous debt and a full uncertain budget until measured warm recovery.
An explicit v1 configuration value was accepted and normalized without editing
private configuration or overriding custom numeric limits/approval. These are
recorded forward transitions, not reinterpretations of the old learning journal.

`committed-garage-v3-event-doors` replaces the fixed five-minute contact age
cutoff with confirmed event state. An unchanged door remains known while its
configured source and MQTT connection remain available. Explicit source failure,
invalid state, subscription loss, bridge outage or restart makes it unknown.
Recovery requires a live source snapshot and the configured availability evidence;
retained context and bridge birth alone cannot restore it. A recovery may confirm
the original contact timestamp without pretending that it is a new measurement.

Each resolved sample saves the door source timestamp separately from live
confirmation and the start of uninterrupted closed evidence. An opening, outage
or restart ends that closed interval. Even if the door recovers before the next
temperature sample, the interrupted interval cannot teach thermal coefficients,
baseline warmth or clean validation evidence. That learning exclusion remains
unchanged under the current protection policy. The original v3 planner also
blocked economic pauses for configured unknown or open doors; the thermal-reserve
policy removes that control veto. Frozen episode accounting preserves observed
costs and restoration debt while withholding savings qualification after a door
disturbance or gap. Historical inputs without configured contact
evidence retain their explicitly incomplete interpretation. These are compact
resolved sample inputs, not periodic door snapshots or a new telemetry archive.

The v2 journal and frozen episodes remain archival at Git revision `69a5ae4` and
are never replayed with v3 semantics. The first v3 entry saves its explicit initial
seed and begins a new learning epoch; exposure and outstanding physical recovery
obligations remain intact. Home learning, CSV formats and imported source clocks
are unchanged.

### Thermal-reserve protection policy

`garage-thermal-reserve-v1` replaces the operational degree-minute exposure index
with one continuously integrated reference temperature per protection location.
The estimated heat above the configured margin is expressed in kJ per metre of
the reference water-filled copper pipe. Cooling and warming depend on the
air/reference temperature difference and elapsed time. There is no hard air
limit, full assigned allowance, recovery dwell or fixed repayment rate.

This is a **protection and planning policy version**, not a new garage learning
algorithm. `committed-garage-v3-event-doors` retains its equations, coefficients,
door-disturbance eligibility, original ordered inputs and live/rebuild update
function. The operational transition preserves learned state and the old
journal's saved configuration and digests; it does not relabel old records as a
new algorithm. Home learning and imported CSV interpretation are unchanged.

Old `garage-exposure-v1`/`garage-exposure-v2` configuration remains readable, but
its numeric allowance and approval cannot authorize the new model. The effective
thermal policy starts unapproved with the new defaults. Old operational debt is
not converted numerically into joules. An unsupported or absent protection state
starts conservatively and requires measured recovery; the policy boundary never
grants a freshly warm reference from one air reading or forgives a persisted
restoration obligation. Old protection records remain archival under their own
arithmetic, and no private configuration file is silently rewritten.

Episode recovery checks now use the reference heat reserve, while retaining the
independent checks for measured local warmth and slow building memory. A positive
freeze-protection reserve cannot alone finish a building-recovery episode or
qualify savings. Historical frozen assessments retain their matching algorithm
and evidence; an incompatible protection baseline cannot create a comparable
recovery claim. See [protection details](garage-protection-defaults.md).


## Garage simple OFF epoch

`committed-garage-v4-simple-off` replaces the coupled v3 dynamics with two independent
OFF cooling rates, observed normal references and explicit fixed electricity /
recovery assumptions. It also replaces multi-pause preference scoring with
`garage-simple-opportunities-v1`. The v3 learner, planning and assessment code is
archival at Git revision `09618e5029d1e8a7d30af38909078b4db4c775d2`.
The first v4 journal entry records a fresh explicit seed, settings checksum and
algorithm boundary. Old records, coefficients, costs and frozen forecasts are not
replayed or relabeled as v4; original old code remains available in Git.

The operational protection policy stays `garage-thermal-reserve-v1`. Both local
pipe states and unresolved native restoration survive independently of the new
learning seed. An existing v3 episode becomes archived recovery: its frozen
accounting is not advanced by v4 and cannot report new savings or renew OFF.
Both measured locations and pipe reserves must recover, with continuous normal
availability; the established eight-hour accepted-native fallback may close
changed-weather recovery as incomplete, without savings. Gaps reset that dwell.

Changing the owner i-save assumption records a context event and stored preference
atomically and releases owned OFF permission. Normalized samples preserve whether
the accepted baseline was verified or owner-assumed. Matching configuration and
source epochs drive the same ordered update in live learning, background replay
and charts; changing the assumption cannot rewrite historical verification.

If changed weather makes the frozen pre-pause temperatures unreachable, eight
continuous hours of fresh accepted native ON with both actual locations and both
certain pipe references above the protection margin can close recovery as
**incomplete**, with no savings claim. This also respects a longer configured
minimum ON time. Closing and a normal-reference reset are committed atomically.
The reset clears reference/electricity observers and their previous input, retires
active validation as incomplete, and retains learned cooling rates. The same
context event replays deterministically; new normal-temperature evidence must
qualify before another economic pause. Brief charging disturbances, changed
baseline/source and unqualified electricity never fabricate completed savings.
