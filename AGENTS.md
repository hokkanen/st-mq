# Repository instructions

## Pre-v1.0.0 compatibility guard

This is the owner's governing policy for every task in this package and every
ST-MQ change before the first production release, **v1.0.0**.

## One historical exception

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

## Actively remove internal backwards compatibility

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

## Preserve current correctness and safety

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

## Agent/review gate

Before and after each relevant change, inspect producers, consumers, state,
configuration, UI, tests and documentation for obsolete compatibility paths.
Delete them as part of the affected implementation instead of adding wrappers.
Document removal, retained current capabilities and tests in the issue tracker.
Do not resolve a failing legacy-preservation test by restoring prohibited code.
Do not overstate unrun tests or treat current guard tests as proof of completeness.

This rule ends only with an explicitly approved production support policy at the
first actual v1.0.0 release. A package-version edit, future-dated release plan or
agent assumption does not authorize pre-release migrations. Production support
requirements will be decided explicitly; do not build speculative machinery now.

## Model reconstruction and versioning contract

- Apply [docs/reconstruction-and-versioning.md](docs/reconstruction-and-versioning.md)
  to the current supported journal/algorithm contract. The pre-v1.0.0 guard above
  takes precedence over any wording that would retain obsolete development formats.
- Preserve deterministic model replay from the committed journal, saved seed and
  configuration, selected manual-event revision and matching algorithm. Use the
  same ordered update function for live learning and rebuilding.
- Keep manual loads and corrections as compact source events; never silently
  rewrite telemetry or reinterpret an old learning algorithm as a new one.
- Version changes to learning semantics explicitly. Before v1.0.0, start fresh
  when a format/algorithm becomes incompatible; do not retain an old interpreter,
  checkpoint translator or obsolete development-history archive. Preserve current
  journal provenance and documented current seeds/epochs for supported replay.
- Background correction rebuilds must keep control available, reject stale results
  and atomically publish a complete, caught-up checkpoint. Keep original observed
  behavior and frozen forecasts distinct from corrected model assessments.
- This contract does not require exact replay of every historical control choice
  or guarantee heat-pump receipt of attempted commands. Do not expand storage into
  per-minute model snapshots or full decision-input archives without agreement.

## Required commits for AI tasks

- Every AI task that changes repository files must commit its completed changes
  before the final response, however small the task. This includes code, tests,
  documentation, configuration, formatting, and repository instructions.
- Commits are authorized by default; do not wait for another request or ask for
  confirmation. Follow an explicit user instruction not to commit when given.
- **Never create empty commits.** If a task makes no net repository changes,
  report that no commit was needed. Do not manufacture changes just to commit.
- Commit only the task's intended changes. Preserve unrelated pending work
  unless the user explicitly asks to include it.
- Complete appropriate validation and all secret/encryption checks below before
  committing. Never bypass a failed check to satisfy this rule; resolve it or
  clearly report the blocker without claiming the task is complete.
- The lead agent coordinates commits for delegated work. Subagents must not
  stage or commit concurrently unless explicitly assigned ownership of Git work.
- Report the resulting commit hash and validation outcome. Creating a commit
  does not authorize pushing it; push only when the user requests it.

## Private configuration and personal data

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
- Current development no longer needs git-crypt. Historical encrypted blobs and
  decryption keys must remain recoverable; do not rewrite history or remove keys
  as part of ordinary work. Never commit a decryption key. Retained local
  git-crypt filters are for old revisions only; do not disable their required flag.

## Routine commit validation

1. Use the repository hooks (`core.hooksPath=.githooks`). If another hooks path
   is configured, integrate the checks instead of silently replacing it.
2. Review intended changed paths, run appropriate tests/build checks, and stage
   explicit paths. Never use an unchecked `git add .` or bypass hooks.
3. The pre-commit hook runs `node scripts/check-secrets.js --staged`, checking the
   index for private filenames and credential patterns. One successful check on
   the final index is sufficient; routine tasks need no git-crypt status,
   attribute, decryption or whole-history audit commands.
4. Pre-push and CI audit reachable history automatically, including historical
   ciphertext requirements. Run a history audit manually when changing the
   checker, repairing history or investigating an exposure, not after every task.

Pattern checks cannot recognize every private value. Review confidential-data
handling when the task touches configuration, accounts or household observations.
Do not broaden a routine code task into a repeated security audit without evidence.

## If plaintext ever enters history

Stop committing/pushing the affected history. Deleting a file from the newest
revision does not remove earlier plaintext. Preserve unrelated work and recovery
information, identify affected refs without printing values, and coordinate any
shared-history repair with the owner. If credentials reached a remote or another
person, revoke/rotate them with the provider. Do not rewrite unrelated refs or
claim an exposure is removed from other clones/caches without evidence.

See [docs/secret-handling.md](docs/secret-handling.md) for historical audit scope.

## Configuration design

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
- Public Garage enablement and protection approval default to false. Test the
  explicit private opt-in independently; owner approval is installation state,
  not evidence of adapter readiness.
- Feature tests must explicitly configure the synthetic integrations relevant
  to their scenario instead of inheriting unrelated public device subscriptions.
  Keep separate coverage for intended public defaults and sparse override merging.

## UI wording

- Do not use the project name **ST-MQ** in user-facing labels, descriptions,
  popovers, status messages or errors. Use natural wording such as “the controller”
  or “this application”. Keep actual file paths and protocol identifiers accurate.
- Show Mitsubishi fields that have real reported data, including valid zero/false
  values. Omit never-observed or unsupported placeholders. Keep previously observed
  fields visible during temporary data loss, with an explicit unavailable state
  and source/quality details. Keep readings in their own fold and compressor state
  in the summary; never interpret missing compressor activity as idle.
