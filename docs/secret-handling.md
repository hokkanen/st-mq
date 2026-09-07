# Secret handling and H66 audit

The mandatory policy is in [AGENTS.md](../AGENTS.md). Private configuration,
credentials and personal data must never appear as plaintext in any Git commit.
`options.json` is allowed in Git only as git-crypt ciphertext. Private local notes,
exports and key backups should stay outside Git.

The repository's pre-commit hook checks the complete staged index. Its pre-push
hook checks every commit reachable from each ref being pushed. The CI `secrets`
job repeats the history check with a full checkout. Install the hooks in each
checkout with `git config --local core.hooksPath .githooks`; Git does not install
repository hooks automatically on clone. These checks need Node.js but no npm
dependencies or decryption key.

Run the checks explicitly as well:

```sh
node scripts/check-secrets.js --staged
node scripts/check-secrets.js --history H66
```

The checker inspects raw Git objects and the staged/historical attributes. It
requires encryption for every `options.json`, its `options.json.*` backups,
`workspace/consumption.csv`, and files assigned to git-crypt by those attributes.
It also checks common credential signatures and literal assignments, including
commit messages during history scans. It reports paths, hashes and categories,
never matched values. This does not identify every possible secret or private
datum. Review private-data handling even when the checker passes.

A ciphertext header is an accidental-plaintext guard, not proof of authenticated
encryption. When a key is available, authenticate/decrypt privately and do not
print the result. Git-crypt requires attributes before staging sensitive files
and leaves filenames and commit metadata unencrypted. See the
[upstream git-crypt documentation](https://github.com/AGWA/git-crypt#using-git-crypt).

## Audit and local history repair: 2026-09-07

Original H66 tip: `48b959528e0eb1b5f862f3957615a28af12af264`.
Repaired tip before this policy change: `d47d5420b3d58a0e32c8e10706bf180f2dfd49f0`.

- Examined all 180 reachable commits, including merged ancestry, deleted files
  and all 16 commits unique to H66 before repair: 516 unique file blobs.
- `data/options.json` existed in 100 commit snapshots, with eight distinct
  versions. All eight were already ciphertext, authenticated successfully using
  the existing key, and decrypted to valid JSON. Historical encryption attributes
  were correct. The other 80 commits had no `options.json`.
- Scanned the 508 other blobs and commit messages for credential patterns and
  exact credential values obtained privately from current and historical options,
  including encoded copies and exported git-crypt key material. No plaintext
  credential values were found. This is a scoped audit, not an exhaustive proof.
- Found private device identifiers in 15 older helper-script blobs, affecting 51
  commit snapshots; one also contained a private broker address. Replaced these
  historical literals with explicit placeholders/local host. Actual configured
  identifiers remain in encrypted options where those files existed.
- A deleted `workspace/consumption.csv` appeared in two of those commits. It
  contained timestamped readings without evidence of public or synthetic origin,
  so it was conservatively treated as private telemetry. Encrypted its complete
  contents using the existing git-crypt key and added attributes in both commits.
  Decryption was verified to reproduce the original bytes.
- Rebuilt H66 only: 179 commit IDs changed because their content or ancestry
  changed, with 51 trees directly changed. Twelve invalidated signature headers
  were removed; the rebuilt commits are not signed on the original signers'
  behalf. Commit messages, authors, dates and parent relationships were preserved.
  The project tree at the tip and all eight encrypted options blobs are identical
  to their pre-repair versions. Existing local options edits were preserved.
- Restricted local git-crypt key files to owner-only access, installed the hooks,
  and added this policy, ignore rules, encryption rules and CI validation.

This is a **local H66 repair**, not removal from every copy of the repository.
Other local branches, remote-tracking refs, version tags, the remote, and existing
reflogs still reference the old history. They were not rewritten or purged. A
private, value-free old-to-new commit map is kept locally at
`.git/security-audit/h66-repair.json`. Do not merge old unsanitized ancestry back
into H66. Coordinate any broader ref/remote cleanup separately. No push or
credential rotation was performed by this audit.
