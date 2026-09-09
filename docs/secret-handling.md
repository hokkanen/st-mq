# Private configuration and historical secret handling

Current private configuration stays outside Git in
`~/.config/st-mq/secrets.json` (or `$XDG_CONFIG_HOME/st-mq/secrets.json` / the
explicit `STMQ_CONFIG` path). HASSIO imports `/config/secrets.json` into Supervisor
settings, then removes the uploaded file after successful application. Runtime
Easee tokens remain in the private data directory; they are not configuration.

Private configuration files and backups use mode `0600` in directories with
mode `0700`. Ignore rules prevent accidental staging and Docker packaging; the
pre-commit hook also rejects private filenames even when force-added. Source
examples must contain invented, nonfunctional values only.

The current checkout needs no git-crypt tooling or key. Historical ciphertext
and its original committed attributes remain unchanged. Keep the recovery key
outside Git in secure storage. This migration does not erase old ciphertext or
rewrite any historical refs. Local git-crypt filter configuration can remain
for reading historical revisions; it is unused by the current tree.

The pre-commit hook scans the complete index once. Pre-push and CI scan reachable
history, including archived encryption requirements and commit messages. These
checks need Node.js, no npm dependencies or decryption key. Ordinary changes do
not require manual attribute, git-crypt or repeated full-history checks. See
[AGENTS.md](../AGENTS.md) for the working policy. Pattern checks are not exhaustive;
results report paths, object IDs and categories without matched values.

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
