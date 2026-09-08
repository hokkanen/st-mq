# Repository instructions

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

## Mandatory protection of secrets and personal data

These rules apply to every agent and contributor, every branch, and every commit,
including temporary commits, stashes, rebases, cherry-picks, and merges.

- **Never put plaintext secrets or private personal data in Git.** This includes
  API keys, access/refresh tokens, passwords, private keys, connection credentials,
  private device/account identifiers, and household observations or exports.
- **Every `options.json` must be stored as git-crypt ciphertext in the index and
  in every commit that contains it.** A decrypted local working copy is normal
  in an unlocked checkout; it is not evidence that the Git blob is encrypted.
  Renamed copies, backups, logs, fixtures, screenshots, and documentation must not
  become plaintext escape routes. Use invented, nonfunctional example values.
- Keep private files outside the repository or ignored whenever possible. If a
  private file must be versioned, assign `filter=git-crypt diff=git-crypt -text`
  in a committed `.gitattributes` rule **before staging the file**. Keep Git
  control files such as `.gitattributes` readable. `.gitignore` does not protect
  files already tracked, and attributes alone do not prove encryption occurred.
- Never commit a raw git-crypt key or any private decryption key, even inside an
  encrypted file. Keep key backups outside the repository with owner-only access
  and secure storage. Unlock with the existing key; do not reinitialize git-crypt
  or replace keys to bypass a missing-key error. Preserve `filter.git-crypt.required=true`.
- Never print secrets or decrypted configuration in tool output, diffs, logs,
  commit messages, issue/PR text, or audit reports. Inspect sensitive values only
  in memory and report paths, object IDs, categories, and counts. Git-crypt does
  not encrypt filenames or commit metadata. Ordinary author attribution may be
  public; never add private personal information to it.

## Required commit and push practice

1. Install the repository hooks in each checkout:
   `git config --local core.hooksPath .githooks`. If another hooks directory is
   configured, integrate these checks into it instead of silently replacing it.
   Node.js must be available. Do not bypass hooks with `--no-verify` or disable
   the encryption filter/checker to make a commit succeed.
2. Check encryption configuration before staging private changes:
   `git check-attr filter diff -- data/options.json` and `git-crypt status -e`.
   Both attributes must select `git-crypt`; the clean filter must be configured
   and required. Stage only intentional paths, never an unchecked `git add .`.
3. After staging, run `node scripts/check-secrets.js --staged`. This checks the
   raw index, including unchanged tracked sensitive files, rather than trusting
   a decrypted working copy or textconv output. Fix failures before committing.
4. After committing and before pushing, run
   `node scripts/check-secrets.js --history HEAD` (or `--history H66`). Every
   reachable commit must pass, including intermediate commits and merge parents.
   The pre-push hook and CI run this check too. CI must fetch complete history.
5. Review changed paths and confidential-data handling as well as automated
   results. Pattern checks cannot recognize every possible credential or piece
   of personal data. A ciphertext signature check is a guard against accidental
   plaintext, not cryptographic authentication; validate decryption privately
   when the repository key is available.

## If plaintext ever enters history

Stop committing/pushing the affected history. Encrypting only the newest version,
adding `.gitignore`, deleting a file, or running `git-crypt status --fix` does not
remove older plaintext commits. Repair every affected reachable commit using the
existing encryption key, preserving the intended configuration, and rerun the
complete history audit. Preserve unrelated working changes without creating a
plaintext stash, patch, backup branch, or exported archive.

If credentials reached a remote or another person, revoke/rotate them with the
provider; history rewriting cannot make a disclosed credential secret again.
Coordinate any rewrite of shared refs and replacement of remote history. Account
for old branches/tags, reflogs, clones, caches, and backups before claiming that
the exposure has been removed. Do not erase recovery data or rewrite unrelated
refs without authorization. Never include exposed values in the incident note.

See [docs/secret-handling.md](docs/secret-handling.md) for audit scope and results.
