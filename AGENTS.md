# Repository instructions

## Development data and eventual production migration

- The first production version will start with a fresh SQLite database. Current
  development databases are disposable and need no compatibility migration or
  data-preservation work. Documentation should describe production behavior,
  without explaining superseded development implementations.
- Version 0.7.5 continues running on another machine until the actual migration.
  Leave that installation and its source data intact.
- When historical Easee or st-mq CSV files are explicitly imported, preserve
  their formats, timestamp/unit interpretation, duplicate handling and provenance.
- Update this section when production migration begins. The secret-handling rules
  below apply to development data and CSV imports throughout.

## Model reconstruction and versioning contract

- Respect [docs/reconstruction-and-versioning.md](docs/reconstruction-and-versioning.md)
  unless the owner explicitly agrees to change that contract.
- Preserve deterministic model replay from the committed journal, saved seed and
  configuration, selected manual-event revision and matching algorithm. Use the
  same ordered update function for live learning and rebuilding.
- Keep manual loads and corrections as compact source events; never silently
  rewrite telemetry or reinterpret an old learning algorithm as a new one.
- Version changes to learning semantics explicitly. Preserve an honest archival
  boundary and a documented seed/epoch; old runtime code need not run in parallel.
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
  Preserve existing field paths unless a behavior change needs a migration.
- Public Garage enablement and protection approval default to false. Test the
  explicit private opt-in independently; owner approval is installation state,
  not evidence of adapter readiness.
- Feature tests must explicitly configure the synthetic integrations relevant
  to their scenario instead of inheriting unrelated public device subscriptions.
  Keep separate coverage for intended public defaults and sparse override merging.
