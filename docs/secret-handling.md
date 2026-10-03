# Private configuration and secret handling

Private configuration stays outside Git in `~/.config/st-mq/secrets.json`
(or `$XDG_CONFIG_HOME/st-mq/secrets.json` / the explicit `STMQ_CONFIG` path).
HASSIO imports `/config/secrets.json` into Supervisor settings, then removes
the uploaded file after successful application. Runtime Easee tokens remain
in the private data directory; they are not configuration.

Private configuration files and backups use mode `0600` in directories with
mode `0700`. Ignore rules prevent accidental staging and Docker packaging; the
pre-commit hook also rejects private filenames even when force-added. Source
examples must contain invented, nonfunctional values only.

Repository encryption has been removed. Do not keep encryption keys in the
checkout, Git metadata or Git history, and do not configure encryption filters
or worktree key links. The application, hooks and CI need no encryption tooling.

The pre-commit hook scans the complete index. Pre-push and CI scan reachable
history and commit messages. These checks read raw Git objects with Node.js;
they never decrypt data or invoke filters. They reject private-key signatures,
credential patterns, private configuration filenames and newly staged data in
the retired encrypted format, regardless of its filename. Recognition of retired
data and key signatures is only a rejection check, not encryption support.

Existing historical private data remains opaque and unchanged. The fixed
`scripts/historical-private-blobs.json` inventory identifies its 15 existing
blobs by exact Git object ID and historical path (`data/options.json` and
`workspace/consumption.csv`). Only history scans permit these exact pairs;
changed bytes, renamed copies and current-index copies are rejected. Historical
attributes and local filter settings do not authorize anything. The inventory
contains no private data or key material and must not be expanded to admit new
private data. Ordinary work must keep these historical blobs unchanged.

Pattern checks are not exhaustive. Results report paths, object IDs and
categories without matched values. Run a history audit when changing the
checker or investigating an exposure; ordinary commits need one staged check.
See [AGENTS.md](../AGENTS.md) for the working policy.

## Historical repair scope

The 2026-09-07 repair sanitized H66's earlier history while preserving existing
encrypted private blobs. Other branches, tags, remote-tracking refs and reflogs
were not rewritten. The private old-to-new commit map remains at
`.git/security-audit/h66-repair.json`. Do not merge unsanitized ancestry back into
H66; deleting a secret from the tip does not remove earlier copies.

For the 2026-10-03 publication of `v0.9.5-dev.1`, the owner approved replacing
`main` with H66's sanitized history using an exact `--force-with-lease` guard.
The sanitized equivalent of the former main tip has the same files and is
already an ancestor of H66. This integrates the development work without
merging the exposed household CSV ancestry back into the release. Existing
tags, other branches, clones and caches are outside this repair's scope; this
publication does not establish that the earlier exposure has been removed
from them. Existing clones must not merge their old main history into the
published branch; see [contributor guidance](../CONTRIBUTING.md).

The 2026-09-27 removal deletes the local repository key, its worktree links and
encryption filter configuration. A scan of all locally stored Git objects found
no key copies, so no history rewrite is needed. This does not remove keys from
separate recovery backups outside the checkout or audit a remote repository.
