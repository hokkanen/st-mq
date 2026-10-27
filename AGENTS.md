# Repository foundations and working rules

Read this file before changing the repository. Follow the linked contracts relevant
to the work; they hold the detailed ST-MQ policies.

## Engineering discipline

Understand the underlying problem before choosing a fix. Treat reported examples
as evidence of a problem category, not automatically its entire scope. Investigate
relevant counterparts and causes, while respecting explicit user limits.

<a id="codebase-wide-consistency"></a>

Consistency is a basic requirement across the entire codebase and every kind of
change. Find the established design and responsible implementation, reuse them,
and carry a fix through equivalent affected paths and their callers. A local fix
is incomplete when the same problem remains in an equivalent path. Preserve
intentional differences required by capabilities, ownership or lifecycle; an
existing difference alone does not establish that it is intentional.

Prefer the smallest coherent change that solves the problem. Complete its affected
implementation, configuration, presentation, tests and documentation together.
Avoid unrelated cleanup, speculative frameworks and broad refactors, especially
near release. Consistency does not require a new abstraction when small aligned
changes are safer.

<a id="scoped-validation-and-reuse"></a>

Use validation proportionate to the change and its risks, including relevant
counterparts and failure paths. Reuse valid results for unchanged inputs and
dependencies; rerun affected checks when a correction invalidates them. Tests
should establish expected behavior independently of implementation formulas.
Report what was verified and what remains uncertain; a narrow check does not prove
whole-codebase correctness. Documentation-only work needs consistency, link and
diff checks rather than runtime suites. The [validation guide](docs/development-validation.md)
is a reference for selecting checks, not a checklist for every edit.

## Authority and scope

Within repository documentation, this file governs foundations; linked feature
contracts own their detailed behavior. Historical records, examples, existing code
and passing tests do not silently amend those decisions. Flag contradictions and
align work with the current contract.

Foundations protect behavior and ownership, not every algorithm identifier,
schema version, threshold, file layout or UI convention. Ordinary compliant work
needs no new approval. A routine feature request does not implicitly waive an
earlier foundation.

| ID | Foundation | Scope |
| --- | --- | --- |
| [F1](#f1) | One current development contract | Pre-v1.0.0; only v0.7.5 CSV import is historical format support. |
| [F2](#f2) | Reconstructible learning and reversible corrections | Supported journal, algorithm and retained inputs. |
| [F3](#f3) | Explicit configuration and state ownership | Defaults, overrides, native state and durable intent have distinct owners. |
| [F4](#f4) | Honest evidence and historical meaning | Provenance, unknown states and observation versus inference. |
| [F5](#f5) | Explicit control authority and restoration | Identity, fresh evidence and physical obligations govern actuation. |
| [F6](#f6) | Cost, comfort and service together | Assess complete consequences and attributable savings. |
| [F7](#f7) | Responsive local operation | Raspberry Pi 5/Home Assistant and standalone Linux are first-class targets. |
| [F8](#f8) | Private data stays private | Installation secrets and household data stay outside Git and diagnostic output. |
| [F9](#f9) | Converge toward production reliability | Focused fixes, fewer failure paths and release-owned upgrades. |

<a id="conflicting-requests"></a>

## Handling foundation conflicts

Before a conflicting edit or operation, name and link the affected foundation,
explain the concrete conflict and consequences, and offer a compliant alternative
where practical. If unresolved, ask one focused question and wait for explicit
owner approval. Silence and general instructions to work autonomously are not
approval. Do not weaken documentation or tests first to bypass the decision.

Pause only the conflicting work; continue independent authorized work. Approval
already given for the specific departure with the affected rule acknowledged is
sufficient: state its scope and proceed without asking again. Resolve only
material ambiguities with the owner, not routine implementation choices.

For a lasting approved change, update the foundation, owning contracts,
implementation and validation together. Record its reason and scope in the issue,
PR or commit body. Keep one-task exceptions explicitly limited and private data
out of the record. Report unresolved contradictions and validation limits honestly.

<a id="f1"></a>

## F1. One current development contract before v1.0.0

Until the first actual production release, v1.0.0, maintain one current internal
schema, algorithm, persisted-state, configuration and API contract. Actively remove
obsolete development representations: migration ladders, backfills or repair
passes for old data, old-path migrations, payload decoders, algorithm interpreters,
settings translators, renamed-field aliases, mixed-version bridges, old runtime
entrypoints and historical development-data presentation. Update current callers
and rejection tests together; an obsolete preservation test is not a reason to
restore prohibited compatibility.

Fresh databases initialize directly with the current final schema. Reject an
incompatible, malformed or nonempty unversioned database **before mutation**, with
actionable fresh-start guidance. Never automatically delete, truncate, recreate,
migrate or overwrite it. An intentional owner reset is an operational action, not
a reset-on-startup subsystem. Re-import supported CSV sources rather than old
development databases.

The sole historical format exception is **read-only v0.7.5 `easee.csv` and
`st-mq.csv` import**. Preserve source bytes/files, timestamp and unit meanings,
missing/invalid quality, row/file provenance, duplicate/idempotency handling and
supported interruption recovery. Normalize at the boundary into the current
schema and model-input contract. This permits no old runtime, native database
reader, configuration/API, model engine, CSV live recorder or second historical
chart application. Unverified dialects and filename variants are unsupported.
Use synthetic supported-header fixtures; never rewrite the owner's source files.

Reject unknown or retired fields and payload versions at their relevant boundary.
Documented defaults for genuinely absent optional current fields or new state do
not authorize translating old shapes. Old charger slots, associations, ownership
or permissions cannot authorize newly configured equipment.

Preserve current-version restart, same-schema backup/restore, deterministic journal
reconstruction, transactional publication, current-format correction/recovery,
replica fencing, supported external protocols/hardware, provenance, unknown states,
privacy and fail-closed validation. An earlier event in a current session is not
an older software format. Actively written `legacyOutstanding` restoration duties
and standalone SSH replication remain current capabilities regardless of naming.

Semantic changes may require a new current schema/algorithm and a deliberate
fresh development start; they do not require old interpreters, translated
checkpoints, old fitted seeds or archives of every development interpretation.
Current source corrections still require provenance and atomic replay.

The approved installation-only conversions and their exact safeguards are recorded
in [the reconstruction contract](docs/reconstruction-and-versioning.md#approved-installation-only-schema-changes).
They authorize no runtime migration or conversion of other databases. Ordinary
development uses offline fixtures, not household probing, operation or erasure.
This temporary restriction ends at the actual v1.0.0 production release, not a
package-version edit; [F9](#f9) then governs upgrades. The owner approved that
future policy on 2026-10-07. Evidence, database and authority safeguards remain.

<a id="f2"></a>

## F2. Reconstructible learning and reversible corrections

Within the supported Home journal/algorithm, an intact committed learning journal,
saved seed/configuration, selected source-correction revisions and matching
software must reproduce the complete checkpoint at the same journal boundary:
coefficients, estimated thermal state, comfort references and learning evidence.
Live learning and replay use the same ordered update function. Checkpoints are
replaceable caches, never the only learning history. Garage has no learned heat
model or economic controller.

Retain the inputs, source context and configuration history needed for corrected
reconstruction from the supported seed; telemetry CSV or fitted coefficients alone
are insufficient. Narrowing this guarantee through retention requires an explicit
scope decision. The owner-approved deliberate [Reset pairing → Start fresh](docs/pairing.md#reset-pairing)
is limited to the local history intentionally discarded, not routine retention;
restoration, safe storage and single-master requirements still apply.

Manual additions, sensor changes and corrections are compact immutable source
events. Keep originals and measurements so earlier revisions remain interpretable.
Removing firewood excludes its heat throughout the selected corrected history;
reverting a sensor change removes its boundary and settling exclusion while
preserving other corrections and actual gaps.

Change the learning algorithm identifier when numerical interpretation, training
selection, corrections, seeds or fitting rules change, and validate replay.
SQLite schema versioning is separate; F1 governs incompatible development formats.
Correction rebuilds keep control available, survive restart, reject stale work and
atomically publish a complete caught-up checkpoint with matching revisions and
journal head. Failure retains the previous model and reports the problem.

Original observations and frozen forecasts remain distinct from corrected
assessments. Reconstruction does not promise every historical control choice,
missing physical outcomes or command receipt. Do not add per-minute snapshots or
comprehensive decision-input archives without agreement. Details:
[reconstruction and corrections](docs/reconstruction-and-versioning.md).

<a id="f3"></a>

## F3. Explicit configuration and state ownership

Choose a value's owner and lifetime before its storage. Configuration exclusively
owns controller defaults; dashboard edits must not rewrite them or persist
replacement defaults. Reload/restart derives defaults from current configuration.
Temporary overrides need an explicit physical session or expiry, or the documented
Home Pause scope. Show their scope, preserve only its remaining validity across
restart and restore configured behavior when it ends. Validate equipment/session
identity; a new physical connection inherits no previous session's override.

Keep native observations and commands, durable dashboard intent, commissioning,
restoration duties, pairing state and historical records distinct from defaults.
Environment scope is not actuation permission; there is no global operating mode.
Home, Garage, charging and Caravan retain their documented independent ownership.
Native parameter edits are explicitly labeled device actions, not default edits.

Shared defaults remain in `config.json.options`, with sparse private/Supervisor
overrides. Keep non-secret common topics/equipment definitions public and private
identifiers external. Settings and schema stay beside related fields in matching
order; change current paths and callers together without aliases. Another layer or
format needs a concrete requirement. Feature tests configure their own relevant
synthetic integrations, with separate public-default/sparse-merge coverage.

Owning contracts: [configuration and section map](docs/configuration.md),
[Home controls](docs/automation-and-manual-control.md), [Garage](docs/garage.md),
[charging policies and subsystem contracts](docs/charging/policies.md),
[Caravan](docs/caravan-dehumidifier.md). Their equipment-specific lifetimes,
precedence, defaults and approved exceptions remain binding.

<a id="f4"></a>

## F4. Honest evidence and historical meaning

Distinguish observations, engineering assumptions, estimates, forecasts, requests,
acknowledgements, native readback and physical outcomes. Preserve source identity,
units, source/receipt clocks, quality and the meaning effective at the recorded
time. Today's configuration must not silently reinterpret history.

Missing, stale, invalid or unsupported evidence is unknown, not zero, off or
success. Preserve valid zero/false. Reconnection, caches and held republishes do
not manufacture fresh observations or independent learning evidence. Corrections
cannot invent data for real acquisition gaps. Keep frozen forecasts and original
outcomes separate from corrected assessments; timing alone does not prove causal
savings, and overlapping energy totals/components must not be double-counted.
Chronological validation must not leak future evidence into training or forecasts.

Detailed evidence boundaries and approved exceptions:
[recording](docs/recording.md), [time](docs/time-evidence.md),
[temperatures](docs/temperature-sensors.md), [learning](docs/learning-and-control.md),
[floor GPIO feedback](docs/floor-preheat.md#evidence-and-ownership),
[Caravan qualification](docs/caravan-dehumidifier.md#automatic-power-and-caravan-location-check),
[positive vehicle identification](docs/charging/identification.md).

<a id="f5"></a>

## F5. Explicit control authority and restoration

Keep one authorized owner of equipment commands. Paused automation, read-only
replicas, copied state and restored checkpoints grant no actuation permission.
Pair promotion is explicit, never automatic after timeout. Bind permission to
current equipment/session identity and require the action's live evidence,
commissioning and readiness. Owner approval is not adapter capability; stale,
unknown or retired authority fails closed.

Preserve native protection, device refusals, required service, independent manual
instructions, identification limits and restoration duties. Source availability
and command readiness are distinct; commissioned local OCPP follows its
[cloud-outage contract](docs/charging/integrations/easee.md#easee-cloud-outages).
Temporary changes retain ownership, expiry and durable restoration across restart,
failure, model repair and correction. Reconcile against fresh actual state and
respect later manual changes. A model reset cannot erase physical obligations;
an acknowledgement alone cannot prove restoration.

Preserve device-local freshness and command fencing. Do not claim software can
restore equipment through a broken link. Economics and learned confidence cannot
relax hard comfort or equipment-protection limits. Ordinary development uses
controlled offline fixtures. A coding request alone does not authorize deployment,
household probing or live commands; honor applicable authorization already given.

Details: [control/restoration](docs/learning-and-control.md), [pairing](docs/pairing.md),
[Garage adapter](docs/garage-adapter.md), [charging execution](docs/charging/execution-and-recovery.md)
and [bounded identification](docs/charging/identification.md).

<a id="f6"></a>

## F6. Cost, comfort and service together

Reduce attributable energy cost while maintaining acceptable comfort and required
service. Evaluate preheat, reduction and recovery together at comparable comfort
and thermal end states, including auxiliary energy and delayed recovery. Cheaper
purchase timing, more OFF time or fewer auxiliary starts alone do not prove savings.
Keep normal operation a real option. Do not provoke unsafe cooling or resistance
use merely for training, or count reduced service during absence as occupied
savings. State uncertainty and distinguish assumptions, simulations and supported
outcomes.

Home uses one learned occupied reference and one fixed configured weighted indoor
average for comfort, without individual-room vetoes or day/night schedules. The
[temperature contract](docs/temperature-sensors.md#normal-temperature-reference)
owns initialization, refinement and the bounded control-only missing-room estimate.
The [Away policy](docs/learning-and-control.md#planning-and-recovery) leaves absolute
temperature protection to the native pump and restores occupied limits at return.
Neither estimates nor Away relax evidence, equipment, cost or restoration duties.
These owner-approved policies date from 2026-10-07.

Details: [learning and control](docs/learning-and-control.md),
[Garage manual heating](docs/garage.md), [firewood estimates](docs/fireplace.md).

<a id="f7"></a>

## F7. Responsive local operation

Raspberry Pi 5/Home Assistant and standalone Linux are first-class targets with
the same core behavior and data semantics. Learning and control remain practical
locally without a GPU, permanent cloud model or routine paid AI calls. Supported
external weather, market and device services remain legitimate; handle outages
conservatively.

Learning, reconstruction and historical reads must not block timely control,
MQTT ingestion or the UI. Bound memory, rolling caches and background work; avoid
unlimited routine history loads or full rebuilds on ordinary restart. Complexity
needs measured justification. Resource targets do not authorize discarding F2/F4
evidence. Details: [validation](docs/development-validation.md),
[recording](docs/recording.md), [startup](docs/startup.md).

<a id="f8"></a>

## F8. Private configuration and personal data

Keep credentials and household data outside Git and tool output, logs, diffs,
screenshots and commit messages, including precise coordinates, private
device/account identifiers and exports. Read private values only when needed;
inspect in memory and report paths, field names and counts rather than values.
Private directories use `0700`, files `0600`.

Private configuration belongs at `$XDG_CONFIG_HOME/st-mq/secrets.json`
(default `~/.config/st-mq/secrets.json`) or the explicit `STMQ_CONFIG` path.
Never stage it, copies or retired `options.json`. Use invented nonfunctional
fixtures. Repository encryption is retired: no keys in checkout/Git metadata or
history, encryption filters or key links. Historical encrypted data stays opaque
and unchanged; never decrypt it into the repository or expand the fixed audit
inventory to admit new private data or keys.

If plaintext enters history, stop committing/publishing that history and preserve
unrelated work. Coordinate repair with the owner; deleting a tip file does not
remove history. Rotate credentials exposed to a remote or another person.
[Secret handling](docs/secret-handling.md) owns incident and historical-audit scope.

<a id="f9"></a>

## F9. Converge toward production reliability

The owner approved this lasting policy on 2026-10-07. Prioritize correctness,
reliability and a smaller bug surface over architectural novelty. Preserve
established behavior and ownership. Reuse existing pairing, recovery, publication
and authority paths; keep one current implementation per responsibility and remove
redundant states/ownership when practical without broad rewrites.

A defect does not justify redesigning a subsystem. Architectural changes need a
concrete failure or measured limitation, why a focused fix is insufficient, and
validation of the affected behavior/boundaries. Fewer lines alone do not prove
lower risk. Preserve established behavior tests unless the owner deliberately
changes the behavior; cover demonstrated defects and relevant interruption or
uncertain outcomes when persistent state or authority changes.

From the actual v1.0.0 production baseline, each later production release must
provide and test a safe upgrade from the preceding production database and state.
Each release owns the conversion it needs; unchanged formats need none. Preserve
source until success, historical meaning, roles, identity and restoration duties.
Learning changes explicitly retain/rebuild supported evidence or identify a new
epoch. Older production backups need a documented tested path through necessary
intermediate releases, not a universal runtime reader or parallel schemas. This
excludes unsupported pre-v1.0.0 development databases and hypothetical migrations.
Never guess unknown format variants.

Use the [slave-first upgrade and normal handover](docs/pairing.md#software-upgrades)
when the release pair supports it; otherwise require coordinated stopped
activation. Each release tests its sequence and identifies incompatibility before
the master relinquishes control. A successful transfer is not control readiness;
never weaken incompatibility fences to complete an upgrade.

## Owner workflow

Every AI task with net repository changes must commit its completed intended work
before the final response unless the user explicitly says not to commit. Commits
are authorized by default; never create empty commits or include unrelated pending
work. Stage explicit paths and preserve the user's work. The lead coordinates Git
operations for delegated work; concurrent staging/commits need explicit ownership.
Report the commit hash and validation outcome. Committing does not authorize
pushing or deployment; push only when requested.

Complete appropriate validation and use the repository hooks; never bypass a
failure to satisfy the commit rule. Resolve it or report the blocker without
claiming completion. Integrate checks with an existing custom hooks setup instead
of replacing it. One successful secret check on the final index is sufficient;
whole-history audits are for checker changes, history repair or exposure evidence.
See [contributing](CONTRIBUTING.md) and [secret handling](docs/secret-handling.md).

Use issues for unfinished work, commit/PR descriptions for implementation and
validation, and `CHANGELOG.md` for changes users need to know about. Keep completed
task diaries out of the checkout. Follow [issue triage](CONTRIBUTING.md#issue-triage)
when creating or substantially revising issues. User-facing wording, interaction,
spacing and receipt policies live in [shared UI conventions](docs/ui-layout.md).
