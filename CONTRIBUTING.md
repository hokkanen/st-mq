# Contributing

Start with [AGENTS.md](AGENTS.md) for the project's foundations and working rules.
Current feature guides in [docs/](docs/) define the detailed behavior. Existing
code or a passing test does not override those contracts.

## Repository layout

| Location | Responsibility |
| --- | --- |
| `src/` | Shared application, domain rules, acquisition, control, storage and paired operation; `src/main.js` is the runtime entrypoint. |
| `chart/` | Dashboard source and styles; Vite builds these into ignored `dist/`. |
| `docs/` | Current operating and engineering contracts; the [README guide table](README.md#guides) routes by topic. |
| `scripts/` | Setup, deployment, history tools and validation; shared helpers live in `scripts/lib/` and optional measurements in `scripts/benchmarks/`. |
| `test/` | Routine `*.test.js` files, synthetic fixtures and helpers; `extended/`, `browser/`, `container/` and `live/` have separate invocation and authority boundaries. |
| `integrations/` | Companion device/HA sources, templates and reviewed patches, with their upstream notices. |
| `assets/branding/`, `deploy/` | Maintained image source/export instructions and the public example address-helper policy. |
| `.github/workflows/`, `.githooks/` | Automated validation and publication secret guards. |
| Root packaging files | Home Assistant manifest, repository metadata, translations, images, Dockerfile and user installation/release documents. Their root locations are required by app discovery. |

Keep private installation configuration and runtime state outside the checkout.
Generated builds, dependencies, temporary test receipts and household exports are
not source files. Retain exact upstream fixture bytes and licenses when their
provenance is part of a test contract.

## Setup and checks

Use Node.js 22.19 or newer:

```sh
npm ci
npm run check
```

Configure repository hooks with `git config core.hooksPath .githooks` if no other
hooks path is configured. Integrate the secret checks with an existing custom
hooks setup instead of replacing it. See [development validation](docs/development-validation.md)
for extended tests, isolated browser fixtures, container checks and the pinned
Home Assistant Supervisor validator. Run the checks relevant to a change and
report any skips or limitations.

`npm run check:docs` checks local Markdown links, images and heading/HTML anchors
against versioned files. It is part of `npm run check` and CI; external URLs are
not fetched. Review wording, commands and behavior against their owning source
as well, since a valid link does not establish semantic accuracy.

The pre-commit hook runs `node scripts/check-secrets.js --staged` on the index.
Pre-push and CI audit reachable history automatically against the fixed private-blob
inventory. Do not bypass hooks or run routine decryption/history audits; see
[secret handling](docs/secret-handling.md) for the audit boundaries.

Ordinary development uses invented data and isolated services. Never point
fixtures at an installed controller, private broker or household equipment.
Keep credentials and household exports outside the checkout; see
[secret handling](docs/secret-handling.md). Prefix synthetic credential-like
values with `fixture-` so their intent is explicit to the secret checker.

## Changes and review

Keep Home Assistant's root manifest, documentation, images and translation layout
intact. The application package is private and is not published to npm.

Before 1.0.0, maintain one current development contract. Preserve the supported
0.7.5 CSV import and current restart/backup/restoration behavior; do not add old
runtime aliases, development migrations or silent resets.

Use GitHub issues for actionable unfinished work. Use commit/PR descriptions for
implementation detail and test evidence, and `CHANGELOG.md` for changes users
need to know about. Do not recreate completed-task diaries in the repository.
A release uses matching package, lockfile, app and container versions; development
prereleases advance as `0.9.5-dev.1`, `0.9.5-dev.2`, and so on. Tag releases as
`v<version>` only as part of an authorized publication. Publish the release commit
on `main`, and mark `-dev.N` GitHub releases as prereleases. Home Assistant follows
its configured repository branch and reads the app manifest version; a Git tag
alone does not publish an app update. Record validation results and remaining
installation limits with the release.

## Issue triage

New or substantially revised issues start with an understandable symptom or
missing assurance: who is affected, the trigger, what happens, why it matters,
and useful workarounds with their limits. Put justified impact/frequency ratings
and a dated current status before technical evidence and completion criteria.
An investigation describes the missing decision or assurance without inventing
an observed defect.

Use one label from each group; impact and frequency are independent:

| Label | Meaning |
| --- | --- |
| `impact: critical` | Supported safety, irrecoverable-data or privacy consequences |
| `impact: high` | Major required-service or control failure |
| `impact: moderate` | Material workflow delay or misleading information |
| `impact: low` | Minor, limited nuisance |
| `impact: unknown` | Practical impact not established |
| `frequency: systematic` | Consistently follows the stated trigger |
| `frequency: intermittent` | Repeated irregular occurrences |
| `frequency: single-observed` | One recorded occurrence; recurrence unestablished |
| `frequency: unknown` | Recurrence not established |

Distinguish observed harm, source-backed findings, suspected/conditional risks and
untested hardware or platform cases. State important unknown consequences and the
evidence scope: source inspection, synthetic tests or installed use. A rare
operation can have a systematic defect; one observation does not establish rarity.

Closed issues retain the original problem's impact/frequency and useful original
reports, comments and dated evidence. Keep the current summary accurate, mark
superseded history, and explain the closure's fixed/mitigated scope, remaining
limits and reopening criteria, including closure without a current reproducer.

## Existing clones after the 0.9.5-dev.1 publication

The release replaces the former `main` ancestry with the sanitized H66 history.
Keep local work, but do not merge or pull the former `main` history into the
published branch. Use a fresh clone, or fetch the published history and create
a separate worktree for review:

```sh
git fetch origin
git worktree add --detach ../st-mq-current origin/main
```

This leaves the existing checkout and its local changes in place. Start new
development branches from the published history. Review any local changes
before transferring them so private files or retired ancestry are not
reintroduced. See [the historical repair scope](docs/secret-handling.md#historical-repair-scope)
for the publication boundary and limits concerning other refs and clones.
