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
`v<version>` only as part of an authorized publication.
