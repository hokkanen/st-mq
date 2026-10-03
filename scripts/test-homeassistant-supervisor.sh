#!/usr/bin/env bash
# Validate the shipped app against released Supervisor code, never a live host.
set -euo pipefail

stmq_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stmq_version=2026.09.3
stmq_revision=64ea3be4322537fd5dcfbf620c4dc25490c1f56d
stmq_work=$(mktemp -d "${TMPDIR:-/tmp}/stmq-supervisor-validation.XXXXXXXX")
trap 'rm -rf "$stmq_work"' EXIT
if [[ $# -gt 1 ]]; then
  echo 'Usage: bash scripts/test-homeassistant-supervisor.sh [PINNED_SUPERVISOR_CHECKOUT]' >&2
  exit 2
fi
stmq_source=${1:-$stmq_work/supervisor}
if [[ $# -eq 0 ]]; then
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$stmq_version" \
    https://github.com/home-assistant/supervisor.git "$stmq_source"
fi
stmq_source=$(cd "$stmq_source" && pwd)
if [[ $(git -C "$stmq_source" rev-parse HEAD) != "$stmq_revision" ]] \
  || [[ -n $(git -C "$stmq_source" status --porcelain --untracked-files=normal) ]]; then
  echo "Expected an unmodified Supervisor $stmq_version checkout at $stmq_revision" >&2
  exit 1
fi
stmq_image="stmq-supervisor-validator:$stmq_version"
node "$stmq_root/test/extended/supervisor/generate-options.js" > "$stmq_work/options.json"
docker build --file "$stmq_root/test/extended/supervisor/Dockerfile" \
  --tag "$stmq_image" "$stmq_source"
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/supervisor -e GIT_PYTHON_REFRESH=quiet \
  --mount "type=bind,source=$stmq_source,target=/supervisor,readonly" \
  --mount "type=bind,source=$stmq_root/config.json,target=/manifest.json,readonly" \
  --mount "type=bind,source=$stmq_root/translations,target=/translations,readonly" \
  --mount "type=bind,source=$stmq_root/repository.yaml,target=/repository.yaml,readonly" \
  --mount "type=bind,source=$stmq_work/options.json,target=/generated-options.json,readonly" \
  --mount "type=bind,source=$stmq_root/test/extended/supervisor/validate_options.py,target=/validate_options.py,readonly" \
  "$stmq_image" python /validate_options.py /manifest.json
