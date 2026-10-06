# Repository foundations and working rules

This is the entry point for the owner's foundational design decisions and AI
working rules. Read it before changing code, tests, configuration or documentation.
Apply the relevant linked contracts as part of the task, including delegated work.

## Authority and scope

Within repository documentation, this file governs the foundations; linked feature
contracts define their detailed behavior. Historical handoffs, audit results, task records,
examples, existing code and tests do not silently amend these decisions. If they
conflict, flag the discrepancy and align affected work with the current contract.
An implementation or passing test is not proof that a foundation is satisfied.

The foundations protect behavior and ownership, not every implementation choice.
Algorithm identifiers, schema versions, thresholds, file layouts and UI conventions
may evolve within them. Ordinary compliant work needs no new approval. The owner
can explicitly amend a foundation using the conflict procedure below; a routine
feature request is not by itself an informed waiver of an earlier decision.

| ID | Foundation | Scope |
| --- | --- | --- |
| [F1](#f1) | One current development contract | Temporary pre-v1.0.0 policy; only v0.7.5 CSV import is a historical exception. |
| [F2](#f2) | Reconstructible learning and reversible corrections | Durable model contract within the supported journal/algorithm. |
| [F3](#f3) | Explicit configuration and state ownership | Configuration defaults, scoped overrides, device state and durable intent have distinct owners. |
| [F4](#f4) | Honest evidence and historical meaning | Preserve provenance, unknown states and the distinction between observation and inference. |
| [F5](#f5) | Explicit control authority and restoration | Device identity, fresh evidence and physical obligations govern actuation. |
| [F6](#f6) | Cost, comfort and service together | Assess complete consequences; do not substitute a convenient proxy for savings. |
| [F7](#f7) | Responsive local operation | Raspberry Pi 5/Home Assistant and standalone Linux remain first-class targets. |
| [F8](#f8) | Private data stays private | Keep installation secrets and household data outside Git and diagnostic output. |

<a id="conflicting-requests"></a>

## Handling requests that conflict with a foundation

Before making a potentially conflicting change, including one explicitly requested
by the owner:

1. Name the affected foundation ID, link the relevant rule and explain the concrete
   conflict and consequences in plain language. Do this before the conflicting
   edit or operation, not only in the final report.
2. Offer a compliant alternative when one is practical. If the conflict or intended
   exception remains unresolved, ask one focused question and **wait for explicit
   owner approval** of the exception or amendment. Silence is not approval.
3. Pause only the conflicting part. Continue independent authorized investigation,
   design and implementation that does not assume the answer. Do not bypass the
   decision by first weakening documentation, tests or validation.
4. An instruction that already explicitly acknowledges the affected rule and
   authorizes that specific departure is sufficient approval. State its scope and
   proceed; do not ask again. A general instruction to work autonomously, make it
   work, or use best judgment is not approval to disregard a foundation.
5. For an approved lasting change, update this file and affected contracts,
   implementation and validation together. Record the reason and scope in the
   task's issue or pull-request description (or commit body for direct work).
   A one-task exception does not silently become a new general rule; record its
   limits without exposing private information.

Ask about a material ambiguity in a foundation when the existing contracts and
session do not resolve it. Do not create approval gates for routine implementation
choices. Report unresolved contradictions and validation limits honestly.

<a id="f1"></a>

## F1. One current development contract before v1.0.0

This temporary policy governs every change before the first actual production
release, **v1.0.0**. It does not weaken the durable correctness and safety rules.

### One historical exception

Retain **read-only import of version 0.7.5 `easee.csv` and `st-mq.csv`**. Preserve
source bytes/files, timestamp and unit meanings, missing/invalid-value quality,
row/file provenance, duplicate/idempotency handling and supported interruption
recovery. Normalize accepted rows at this import boundary into the **one current
internal schema and model-input contract**. This exception does not authorize a
0.7.5 runtime, native database reader, old configuration/API, old model engine,
CSV-based live recording or a second historical chart application. Neither
filename spelling variants nor unverified CSV dialects become additional support
promises. Tests use synthetic files with the supported headers; real owner files
remain outside the repository and must never be silently rewritten.

### Actively remove internal backwards compatibility

Development databases and checkpoints are disposable. Do not add or retain
schema-upgrade ladders, development-data backfills/repair passes, old-path
migration, old payload decoders, old algorithm interpreters, settings translators,
renamed-field aliases, mixed-ST-MQ-version bridges, legacy runtime entrypoints or
historical development-data presentation solely to support earlier ST-MQ designs.
Update current callers, schemas, configuration examples, UI and tests together.
Tests that require retaining an obsolete design are not constraints to preserve;
replace them with current-contract and unsupported-input rejection tests.

A fresh database is initialized directly with the final current schema, not by
walking historical migrations. An existing incompatible or malformed database
must be rejected **before mutation**, with actionable fresh-start guidance. Do
not automatically delete, truncate, recreate, migrate or overwrite it. A
nonempty unversioned database is not a blank database. The owner's intentional
reset of a known disposable development database is an operational action, not a
new compatibility/reset-on-startup subsystem. Re-import permitted CSV sources
into the fresh schema rather than importing an old development database.

Use one current persisted/configuration/API contract. Unknown or retired fields
and payload versions must fail closed at their relevant boundary, not silently
be translated, ignored or granted authority. Genuinely missing optional current
fields and genuinely absent new state may use documented current defaults; that
is different from recognizing an old shape. No old charger slot, device
association, ownership or permission may authorize a newly configured actuator.

### Preserve current correctness and safety

Do not confuse backwards compatibility with current functionality. Preserve
same-schema backup/restore, current-version restart and deterministic journal
reconstruction, transactional publication, current-format correction/recovery,
replica fencing, current supported external protocols and hardware behavior,
secret handling, provenance, quality/unknown states and fail-closed validation.
An earlier event in a current-version session is not an earlier software format.
The actively written `legacyOutstanding` restoration obligation and the current
standalone SSH replication feature are not removable merely because comments
call them legacy. Remove obsolete representation support, not current physical
safety or restoration duties. Use controlled offline fixtures for implementation;
do not operate, probe or erase a household installation as part of these audits.

Semantic changes may change the current schema/algorithm identifier and require
a deliberate clean development start. They do not require maintaining old
interpreters, migrating old checkpoints, seeding from old fitted coefficients or
archiving every prior development interpretation. Current source corrections
within the supported contract still need provenance and atomic current replay.

### Agent/review gate

Before and after each relevant change, inspect producers, consumers, state,
configuration, UI, tests and documentation for obsolete compatibility paths.
Delete them as part of the affected implementation instead of adding wrappers.
Document removal, retained current capabilities and tests in the issue,
pull request or commit body.
Do not resolve a failing legacy-preservation test by restoring prohibited code.
Do not overstate unrun tests or treat current guard tests as proof of completeness.

This rule ends only with an explicitly approved production support policy at the
first actual v1.0.0 release. A package-version edit, future-dated release plan or
agent assumption does not authorize pre-release migrations. Production support
requirements will be decided explicitly; do not build speculative machinery now.

<a id="f2"></a>

## F2. Reconstructible learning and reversible corrections

- Apply [the reconstruction contract](docs/reconstruction-and-versioning.md) to
  Home within the current supported journal/algorithm. Garage has no learned heat
  model or economic controller. F1 governs
  incompatible development formats; reconstruction does not require old interpreters.
- Given the intact committed learning journal, saved seed and configuration,
  selected source-correction revisions and matching algorithm/software, replay
  must reproduce the complete model checkpoint at the same journal boundary:
  coefficients, estimated thermal state, comfort references and learning evidence.
  Live learning and rebuilding use the same ordered update function. Checkpoints
  are replaceable caches, never the only source of learning history.
- Preserve enough committed inputs, source context and configuration history to
  reconstruct corrected learning from the supported seed. A telemetry CSV alone
  is insufficient. Do not silently remove required replay history or replace it
  with fitted coefficients; a retention change that narrows the guarantee needs
  an explicit scope decision under the conflict procedure.
- Manual additions, sensor changes and their corrections are compact immutable
  source events. Removing a firewood entry excludes its heat throughout the
  selected corrected history. Reverting a sensor-change entry removes that
  boundary's learning effect, including its settling exclusion, using preserved
  measurements. Other active corrections and actual reporting gaps still apply.
  Keep original events and observations so earlier revisions remain interpretable.
- Change the learning algorithm identifier when numerical interpretation, training
  selection, corrections, seeds or fitting rules change, and validate replay.
  SQLite schema versioning remains separate. Before v1.0.0, an
  incompatible format/algorithm requires a deliberate fresh start, not an old
  interpreter, checkpoint translator, old fitted seed or development-history archive.
- Correction rebuilds keep control available, survive restart, reject stale work
  and atomically publish a complete, caught-up checkpoint with matching source
  revisions and journal head. Failure retains the previous model and reports the
  problem; publication must never expose partial replacement state.
- Original observed behavior and frozen forecasts remain distinct from corrected
  assessments. This contract does not reproduce every historical control choice,
  recover missing physical outcomes or prove receipt of attempted commands. It is
  conditional on intact retained inputs and corresponding software. Do not add
  per-minute snapshots or comprehensive decision-input archives without agreement.

<a id="f3"></a>

## F3. Explicit configuration and state ownership

Classify a new setting or control by its owner and lifetime before choosing where
it is stored. Persistence alone does not make a value a configuration default or
permission to act. See [the configuration guide](docs/configuration.md).

### Configuration ownership and dashboard controls

- Home automatic heating permission is a durable dashboard control choice bound
  to its current equipment identity, defaulting to Pause. Garage has manual
  Normal/Away selections and independent device-local frost protection. Charging
  Automatic scheduling and Caravan Automatic power retain independent ownership. There is no global operating
  mode. The environment
  (live, simulation or history viewer) describes data/connection scope, not an
  automatic actuation permission. Explicit manual heating overrides are separately
  authorized actions with restoration duties regardless of automation. Home
  Automatic / Pause is one choice: Pause has no end unless a resume time is set.
  Normal and Reduced choices remain during Pause; Preheat always has a fixed
  lease deadline and restores ROOM at that deadline. Scheduled expiry resumes
  Automatic for the same equipment identity.
- Configured controller defaults belong exclusively to configuration. Dashboard
  edits must never rewrite those defaults or create persistent database
  preferences that replace them. Reloading or restarting must derive defaults
  from the current configuration, not from an earlier dashboard preference.
- Temporary controller overrides require an explicit physical session or expiry
  (Home Normal/Reduced may instead use the current explicit Pause). Display
  that scope beside the action, restore configured behavior when it ends, and
  persist only the remaining valid scope across restart. Validate session and
  device identity before accepting an edit; a new connection inherits no old
  override. Live device observations retain separate provenance and authority.
- Charging configuration owns only the shared and vehicle-specific defaults for
  ready-by time, starting charge, target charge and usable battery capacity.
  Session edits of those four values do not replace configuration defaults.
  Automatic charging and shared charger priority are persistent dashboard
  control choices, not configuration fields. Bind them to current equipment
  identity; preserve them across restart and unplugging for that equipment.
  Charge now is a session action independent of the Automatic charging switch.
  It still respects live control authority, device readiness and native limits.
  Integration setup, commissioning and electrical limits remain configured.
- Charging current adjusts to property loading and shared charger priority by
  default, independently of Automatic scheduling and including Charge now.
  Charger 1 retains native Equalizer current control. Shelly applies the shared
  planner's allocation policy to admitted live household headroom, using priority,
  remaining energy and ready-by requirements;
  Balanced is not necessarily an equal split. Charger 1's momentary draw,
  Equalizer allowance and response delay must not redistribute that entitlement,
  directly or through replanning. Charger 1's measured current is used to remove
  its contribution from property consumption, not to reserve its entitlement.
  Shelly reduces for property protection only when household demand plus Shelly
  alone exceeds the configured effective phase limit. If reducing Charger 1
  could remove the excess, Shelly leaves that correction to Equalizer regardless
  of the amount or duration of the excess; no response watchdog takes over.
  Allocation changes and native/vehicle restrictions remain independent.
  With Charger 2 priority, a conservative forecast allocation or secondary
  deadline reservation must not lower Shelly's live household headroom.
  Current adjustment requires supported capabilities, explicitly configured
  electrical limits and valid property and charger source evidence. Equalizer
  supplies property current; its reported allowance, native budget and an
  agreement comparison are not prerequisites for Shelly's calculation.
  Healthy synchronized reporting or current native status readback can confirm
  unchanged measurements without renewing their original last-change clocks.
  Reading an application cache or retained MQTT message cannot establish that
  health. Use each source's latest valid current measurement whenever that
  source is healthy in its current connection, independently of other sources'
  timestamps. Neither OCPP nor cloud readings need to follow a property update;
  changed charger values also need no later property confirmation. There is no
  measurement-pairing hold or retained prior ceiling for timestamp ordering.
  Separately arriving changes can temporarily overestimate or underestimate
  household demand and headroom. The owner explicitly accepted that uncertainty
  on 2026-10-06 to keep current allocation responsive; independently received
  reports remain non-atomic and retain their original clocks. Invalid or
  contradictory measurements and actual feed loss still select fallback.
  Record both charger allowances even without plugged-in vehicles: Charger 1
  keeps its healthy native Equalizer allowance; Charger 2 reports available
  capacity while preserving connected-peer commitments without inventing an
  unplugged vehicle's request or deadline. Connection, applied current, session
  restrictions and command permission remain separate. Observing unplugged
  capacity sends no device command and cannot backfill unobserved history.
  Command readiness, native readback and physical identification retain
  their separate freshness requirements. Unavailable or invalid source evidence
  uses the configured fallback, still respecting known tighter limits and never
  inventing headroom. The per-phase effective budget is `mainFuseA - marginA`;
  a negative configured margin intentionally increases it for owner calibration,
  without changing the declared physical fuse rating or native protection.
  An explicit configuration opt-out remains supported. This lasting amendment,
  approved on 2026-10-05, removes the independent Equalizer cross-check and the
  unchanged-value expiry to avoid competing balancing loops and false fallback.
- Shelly's adjustable current setting follows the physical session's instruction
  precedence. With `limiterEnabled:true`, a setting carried into a new confirmed
  connection is readback, not a permanent restriction on load balancing. A
  genuinely observed external current choice made during that connection remains
  a ceiling until unplugging or explicit **Use automatic** supersedes it;
  same-session restart and transport reconnection preserve that choice. Confirmed
  controller writes cannot become external choices. The Automatic scheduling
  switch does not enable or disable current adjustment, and changing it or using
  Charge now does not clear a later external current choice. Current adjustment
  still requires its own capability, evidence and command confirmation; it grants
  no Start permission and cannot relax configured electrical, native hardware or
  vehicle limits. `limiterEnabled:false` preserves the native setting except for
  separately scoped identification and restoration. This owner-approved lasting
  amendment on 2026-10-05 separates an adjustable session choice from an equipment
  limit so a carried-over setting cannot permanently cap a new connection.
- When future charging current is unknown, economic scheduling assumes the
  maximum the charger can deliver within its configured/verified ceiling and
  forecast property headroom on every phase after household and peer load. Use
  that assumption to estimate delivery, duration and completion and select cheap
  periods. Do not invent hidden vehicle timers or lower current settings, reserve
  permanent worst-case peer demand, or release both chargers merely because one
  charger's current or control readiness is unavailable. Keep that charger in
  the joint forecast; label assumed delivery and revise it when usable evidence
  arrives. Known applicable native, vehicle and electrical restrictions remain
  authoritative. Battery-request defaults retain their configured ownership.
  A modeled deadline shortfall or missing shared price/capacity evidence is
  distinct from an unknown charging-current restriction. This is an optimistic
  planning assumption, never evidence of current draw, command readiness,
  accepted scheduling or guaranteed completion. See
  [the charging planning contract](docs/charging/planning.md#maximum-available-current-assumption).
- Both charger cards use one shared component with capability-driven differences.
  With Automatic enabled, each new confirmed physical connection takes automatic
  control, superseding earlier charging instructions and native charger schedules,
  including recurring schedules. Genuinely absent saved session state follows the
  same policy after fresh connection evidence; unreadable or invalid state does
  not grant permission. Later external instructions take priority for that
  connection and survive restart/reconnect. The explicit **Use automatic** action
  also supersedes earlier instructions, enables Automatic and returns to price
  scheduling; it need not start charging immediately. Ordinary polling within an
  established connection, the Automatic preference switch and Charge now never
  independently acquire takeover authority. Bind takeover to current equipment,
  connection and observed native instructions; newer external changes retain
  priority. Confirm native changes and preserve uncertain outcomes across failure.
  Unsupported native schedule operations remain visibly blocked; this policy does
  not authorize guessed device commands or unrelated site settings. Do not restore
  superseded instructions after unplugging or restart, infer who caused an observed
  stop, change unrelated device schedules or bypass electrical protection, charger
  authorization, faults or vehicle restrictions.
- The owner-approved [Shelly system permission exception](docs/charging/execution-and-recovery.md#shelly-system-permission-changes)
  classifies fresh, supported `sys` permission changes as device transitions at
  any time, including repeated cycles, independently of plug time, charging
  current or identification. This explicit amendment was approved on 2026-10-04;
  it is not proof of who caused an instruction. A device Stop remains physically
  stopped and blocks replacement Start until fresh permission returns. System
  Enable does not create authority or clear an unrelated native instruction.
  Interrupted application pauses must not furnish continuous stop evidence.
  Identification keeps its original attempt, deadlines and energy allowance;
  native protection and other instructions retain priority. An indistinguishable
  native action reported as `sys` is the accepted residual ambiguity.
- Explicit configuration import/application and clearly labeled native-device
  setup/commands are separate from controller-default edits. Keep their actual
  effect visible. Historical records, restoration obligations, commissioning and
  pairing state are not configuration defaults; preserve their appropriate
  persistence and safety duties.
- Caravan dehumidifier Automatic power and its OFF/ON thresholds are durable
  dashboard control choices bound to the appliance and Caravan temperature-sensor
  connection. Configuration owns the wiring, not replacement threshold defaults.
  Disabling automatic power does not disable the independent recording evidence
  gate or grant authority to stale device/sensor observations.
- Ordinary heat-pump parameter edits are persistent device commands. Read the
  actual settings from the pump; do not impose an application expiry or mirror
  readable native settings into controller configuration. Successful edits
  establish the baseline for later automatic control. Home Heat control actions
  Normal and Reduction last through the current Pause, including a pause without
  an end time. In Automatic they are reassessed on the next controller update.
  Preheat and explicit timed tests retain fixed deadlines and restoration duties
  separately from parameter edits. Manual phases use the same immediate equipment
  actions as automatic phases; equipment capability and protection checks remain.
- Garage Normal/Away is durable device-bound application intent without expiry.
  Configuration owns the predefined Away target; the explicit normal target and
  mode selection survive restart. ST-MQ sends the resulting real target and
  external-control enable to the heat-pump controller. It persists these,
  regulates from native BTHome temperature components and does not need mode
  labels. Ordinary power/mode/fan/vane edits are one-shot device commands without
  automatic replay or restoration. Temperature maintenance preserves OFF and never enforces HEAT;
  non-HEAT suspends/clears the offset and fresh HEAT recovery resumes the target.
  In HEAT, sensor timeout clears the offset and selects native 16°C preserving
  power. Successful external regulation first confirms native 17°C and sends
  measured temperature + 17°C - effective target. Freshness is received sensor
  evidence, never repeatedly reading a cache or a stored target.
- Garage frost protection runs independently in the probe sender and heat-pump
  controller. The sender retains conservative front/rear pipe-reserve state and
  settings;
  the heat-pump controller applies a minimum target and explicit HEAT/ON rescue.
  Protection cannot overwrite the saved user target. The installation approval,
  protection margin, pipe geometry and heat-transfer assumptions belong exclusively
  to `garage.protection` in configuration. ST-MQ applies those loaded values to the
  sender over MQTT; the dashboard only compares configured values with actual
  readback and cannot edit them. Configuration or a command acknowledgement is
  not proof that the sender applied it. Unavailable or stale protection remains
  unknown. There is one pump-command
  owner. The BLU H&T development setup supplies temperature but no pipe protection.
  Warn when manual target/mode changes raise temperature; approximately 24 hours
  is moisture-avoidance guidance, not a guarantee that stored objects are warm.
- Keep the configured H66 assumptions `compressor_integral_a1`,
  `aux_integral_a2`, `compressor_hysteresis_c`, `aux_hysteresis_c` and `a2_basis`:
  the integration cannot read these from the pump. Treat them as declared model
  assumptions, not observed settings or commands. Controller strategies,
  comfort/protection limits and integration setup remain configuration-owned.

### Configuration design

- Keep `config.json.options` as the shared defaults and the existing private or
  Supervisor source as sparse installation overrides. Add another configuration
  layer or format only when a concrete requirement justifies it.
- Keep credentials and private identifiers in private configuration. Non-secret
  installation choices may also go there; common MQTT topics and equipment
  definitions belong in public defaults. Do not copy defaults into private files
  or examples just because a feature adds settings.
- Put new settings in their owning section beside related settings, and keep
  `options` and `schema` in the same section and field order. Use the section map
  in [docs/configuration.md](docs/configuration.md); update it for new sections.
  Change field paths when the current design needs it, updating all current callers, examples and tests together. Reject retired paths; do not add aliases or migrations for development configurations.
- Public Garage enablement and sender protection approval default to false.
  Test explicit private opt-in independently; approval is installation intent,
  not evidence of adapter readiness or fresh local protection.
- Feature tests must explicitly configure the synthetic integrations relevant
  to their scenario instead of inheriting unrelated public device subscriptions.
  Keep separate coverage for intended public defaults and sparse override merging.

<a id="f4"></a>

## F4. Honest evidence and historical meaning

- Keep observations, engineering assumptions, estimates, forecasts, requests,
  acknowledgements and confirmed device readback distinguishable. Preserve source
  identity, units, source/receipt clocks, quality and the meaning effective at the
  recorded time. Today's configuration must not silently reinterpret history.
- Missing, stale, invalid or unsupported evidence is unknown, not zero, off or a
  successful result. Preserve valid zero/false values. Reconnection, held values
  and cached republishes do not manufacture fresh observations or independent
  learning evidence. Corrections cannot invent data for actual acquisition gaps.
- Charging may resolve both vehicle assignments jointly when fresh Tesla
  actual-current evidence, corroborating power and confirmed measured 6 A draw
  provide a unique comparison, and BMW's own valid start/stop episode matches
  the other unchanged physical connection. That same BMW episode may fit the Tesla
  connection's transitions; the unique Tesla comparison resolves this ambiguity.
  BMW still requires its own positive evidence. A negative Tesla result or the
  remaining charger alone cannot identify BMW, and a different contradictory BMW
  episode keeps the assignment unresolved. Preserve source, session, retry and
  consumption checks; polling, restart or a new connection cannot reuse the
  shared episode to contradict the resolved assignment. A confirmed comparison
  may retain its original clocks for a delayed BMW report within the same two
  physical connections, identification attempts and feed associations; it is
  historical identity evidence, not fresh current or control permission. This
  narrow lasting amendment was explicitly approved by the owner on 2026-10-04. See
  [vehicle assignment](docs/charging/identification.md#vehicle-assignment).
- Keep original frozen forecasts and outcomes separate from later corrected model
  assessments. Estimated or timing-only benefits are not measured causal savings;
  overlapping energy totals and components must not be double-counted.
- Require independent validation appropriate to the claim. Tests should encode
  expected behavior rather than reproduce implementation formulas; chronological
  learning validation must not leak future evidence into training or forecasts.

Details: [recording and provenance](docs/recording.md),
[temperature evidence](docs/temperature-sensors.md),
[learning and control](docs/learning-and-control.md).

<a id="f5"></a>

## F5. Explicit control authority and restoration

- Keep one authorized owner of equipment commands. Paused automation,
  read-only replicas, copied database state and restored checkpoints do not grant
  actuation permission. Pair promotion is explicit, never automatic after timeout.
- Bind control choices and permission to the current equipment/session identity
  where applicable. Require the live evidence, commissioning and readiness for
  the action; owner approval alone is not evidence of adapter capability. Reject
  stale, unknown or retired authority rather than translating it into permission.
- Ordinary application stop, restart and paired handover preserve the charger's
  OCPP configuration and current instructions. Only explicit native-control
  deactivation or connection reconfiguration owns return to cloud control.
- Preserve native equipment protection and required service. Temporary changes
  retain their ownership, expiry and durable restoration obligations across
  restart, failure, model repair and correction. Reconcile with fresh actual state
  and respect independent manual device changes. Model resets do not erase physical
  obligations; a command acknowledgement alone does not prove restoration.
- The [Shelly system permission exception](docs/charging/execution-and-recovery.md#shelly-system-permission-changes)
  preserves a device permission hold as a restriction across restart. Fresh native
  evidence must resolve it; restored state grants no new Start or observation.
  A device hold is not an owned identification pause or evidence of physical
  charging. Existing restoration duties and original identification limits remain.
- Preserve device-local freshness and command fencing. Garage permanent targets
  and one-shot device edits have no leases; source timeout and local frost rescue
  remain independent. Do not claim a software retry can restore equipment through a broken link. Economic preferences
  and learned confidence cannot relax hard comfort/equipment protection limits.
- Use controlled offline fixtures for ordinary development. A coding request alone
  does not authorize deployment, household probing or live equipment commands;
  honor explicit, applicable authorization already given in the session.

Details: [control and restoration](docs/learning-and-control.md),
[pairing](docs/pairing.md), [Garage adapter](docs/garage-adapter.md),
[charging](docs/charging.md).

<a id="f6"></a>

## F6. Cost, comfort and service together

Reduce actual attributable energy cost while maintaining acceptable comfort and
required service. Evaluate preheat, reduction and recovery together at comparable
comfort and thermal end states. Account for auxiliary energy and delayed recovery;
cheaper purchase timing, more OFF time or fewer auxiliary starts alone do not prove
savings. Keep normal operation a real option. Do not provoke unsafe cooling or
resistance use merely to obtain training labels, or treat reduced service during
absence as ordinary occupied-operation savings. State uncertainty and distinguish
engineering assumptions, simulated benefit and supported outcome evidence.

Details: [learning and control](docs/learning-and-control.md),
[Garage manual heating](docs/garage.md), [firewood estimates](docs/fireplace.md).

<a id="f7"></a>

## F7. Responsive local operation

Raspberry Pi 5 Home Assistant add-on and standalone Linux are first-class targets
with the same core behavior and data semantics. Keep learning and control practical
locally without a GPU, a permanently running cloud model or routine paid AI calls.
External weather, market and supported device services remain legitimate inputs;
the application must handle their outages conservatively.

Learning, reconstruction and historical queries must not block timely control,
MQTT ingestion or the UI. Keep memory, rolling caches and background work bounded;
do not load unlimited history for routine requests or rebuild all history on every
ordinary restart. Choose maintainable complexity supported by measured behavior.
Resource/storage targets do not authorize discarding required F2/F4 evidence.

Details: [development validation](docs/development-validation.md),
[recording](docs/recording.md), [startup](docs/startup.md).

<a id="f8"></a>

## F8. Private configuration and personal data

- Keep credentials and private personal data out of Git and out of tool output,
  logs, diffs, screenshots and commit messages. This includes precise household
  coordinates, private device/account identifiers and household exports.
- Private configuration lives outside the checkout in
  `$XDG_CONFIG_HOME/st-mq/secrets.json` (default `~/.config/st-mq/secrets.json`),
  or the explicit `STMQ_CONFIG` path. Never stage `secrets.json`, its copies or
  the retired `options.json`. Use invented, nonfunctional examples in tests/docs.
- Private directories use mode `0700`; private files use `0600`. Do not read
  private values unless needed for the task. Inspect them in memory and report
  only paths, field names and counts.
- Repository encryption is retired. Keep encryption keys out of the checkout,
  Git metadata and Git history; do not install encryption filters or key links.
  Private configuration stays external. Existing historical encrypted data stays
  opaque and unchanged; never decrypt it into the repository. Its exact paths and
  blob IDs are inventoried in `scripts/historical-private-blobs.json` solely for
  history auditing, not runtime support. Do not extend that inventory to admit
  new private data or keys.

### If plaintext ever enters history

Stop committing/pushing the affected history. Deleting a file from the newest
revision does not remove earlier plaintext. Preserve unrelated work and recovery
information, identify affected refs without printing values, and coordinate any
shared-history repair with the owner. If credentials reached a remote or another
person, revoke/rotate them with the provider. Do not rewrite unrelated refs or
claim an exposure is removed from other clones/caches without evidence.

See [docs/secret-handling.md](docs/secret-handling.md) for historical audit scope.

## Working and review rules

For each relevant task, identify the foundations it touches and inspect the affected
producers, consumers, state, configuration, UI, tests and documentation. Keep them
consistent. Use current contracts and unsupported-input rejection tests; do not
restore forbidden compatibility to satisfy an obsolete test. Apply focused checks
that establish the changed behavior; documentation-only work calls for consistency,
link and diff checks, not a new runtime test suite. Use the existing
[validation guide](docs/development-validation.md) for code and deployment changes.
Report what ran and what remains unverified; never claim exhaustive compliance
from a narrow guard test. Record the change, retained capabilities, relevant
removals and validation in the issue, pull request or commit body. Track unfinished
work in issues and user-facing release changes in `CHANGELOG.md`; do not keep a
completed-task diary in the checkout.

### Required commits for AI tasks

- Every AI task that changes repository files must commit its completed changes
  before the final response, however small the task. This includes code, tests,
  documentation, configuration, formatting, and repository instructions.
- Commits are authorized by default; do not wait for another request or ask for
  confirmation. Follow an explicit user instruction not to commit when given.
- **Never create empty commits.** If a task makes no net repository changes,
  report that no commit was needed. Do not manufacture changes just to commit.
- Commit only the task's intended changes. Preserve unrelated pending work
  unless the user explicitly asks to include it.
- Complete appropriate validation and the secret checks below before
  committing. Never bypass a failed check to satisfy this rule; resolve it or
  clearly report the blocker without claiming the task is complete.
- The lead agent coordinates commits for delegated work. Subagents must not
  stage or commit concurrently unless explicitly assigned ownership of Git work.
- Report the resulting commit hash and validation outcome. Creating a commit
  does not authorize pushing it; push only when the user requests it.

### Routine commit validation

1. Use the repository hooks (`core.hooksPath=.githooks`). If another hooks path
   is configured, integrate the checks instead of silently replacing it.
2. Review intended changed paths, run appropriate tests/build checks, and stage
   explicit paths. Never use an unchecked `git add .` or bypass hooks.
3. The pre-commit hook runs `node scripts/check-secrets.js --staged`, checking the
   index for private filenames and credential patterns. One successful check on
   the final index is sufficient; routine tasks need no decryption or
   whole-history audit commands.
4. Pre-push and CI audit reachable history automatically against the fixed
   private-blob inventory. Run a history audit manually when changing the
   checker, repairing history or investigating an exposure, not after every task.

Pattern checks cannot recognize every private value. Review confidential-data
handling when the task touches configuration, accounts or household observations.
Do not broaden a routine code task into a repeated security audit without evidence.

## UI conventions

- Do not use the project name **ST-MQ** in user-facing labels, descriptions,
  popovers, status messages or errors. Use natural wording such as “the controller”
  or “this application”. Keep actual file paths and protocol identifiers accurate.
- Use device roles such as “protection sender”, “heat-pump controller” and
  “Bluetooth gateway” throughout the UI and current documentation. Name specific
  hardware and firmware as tested examples or in device-specific instructions,
  not as universal requirements. Describe compatibility through the capabilities
  needed, and distinguish tested installations from unverified candidates.
- Show Mitsubishi fields that have real reported data, including valid zero/false
  values. Omit never-observed or unsupported placeholders. Keep previously observed
  fields visible during temporary data loss, with an explicit unavailable state
  and source/quality details. Keep readings in their own fold and compressor state
  in the summary; never interpret missing compressor activity as idle.

- Action receipts and similar success/failure/confirmation messages remain for
  24 hours after the action, or until replaced by a newer action on that control.
  Fresh device evidence updates pending text immediately; later stale readings
  must not undo a confirmed receipt. Distinguish a past receipt from current
  control ownership. Live faults and unresolved restoration remain visible for
  their actual duration, independently of receipt expiry.
