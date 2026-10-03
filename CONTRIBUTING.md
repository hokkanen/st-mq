# Contributing

Start with [AGENTS.md](AGENTS.md) for the project's foundations and working rules.
Current feature guides in [docs/](docs/) define the detailed behavior. Existing
code or a passing test does not override those contracts.

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

Ordinary development uses invented data and isolated services. Never point
fixtures at an installed controller, private broker or household equipment.
Keep credentials and household exports outside the checkout; see
[secret handling](docs/secret-handling.md). Prefix synthetic credential-like
values with `fixture-` so their intent is explicit to the secret checker.

## Changes and review

Use focused commits and pull requests. Describe the concrete problem, resulting
behavior and validation; preserve unrelated work. Update implementation,
configuration, current documentation and callers together when a contract changes.
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
