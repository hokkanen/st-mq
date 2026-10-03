#!/usr/bin/env bash
# Networkless add-on packaging checks using synthetic files and disposable mounts.
set -euo pipefail

stmq_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stmq_image=${1:?Usage: bash scripts/test-addon-container.sh IMAGE [linux/amd64|linux/arm64]}
stmq_platform=${2:-${STMQ_DOCKER_PLATFORM:-linux/amd64}}
case "$stmq_platform" in
  linux/amd64|linux/arm64) ;;
  *) echo 'Expected linux/amd64 or linux/arm64' >&2; exit 2 ;;
esac
# Check the shipped image before adding any fixture mounts.
docker run --rm --platform "$stmq_platform" --network none "$stmq_image" node --input-type=module -e '
  import assert from "node:assert/strict";
  import { existsSync, readFileSync, readdirSync } from "node:fs";
  const manifest = JSON.parse(readFileSync("config.json"));
  const pkg = JSON.parse(readFileSync("package.json"));
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.private, true);
  assert.deepEqual(readdirSync("scripts").sort(), ["history.js", "pair-vip-addon", "pair-vip.js",
    "replica-receiver.js", "replica-ssh.js", "replica-verify.js", "test-live.js"].sort());
  assert.deepEqual(readdirSync("test"), ["live"]);
  assert.ok(existsSync("docs/floor-preheat.md"));
  assert.equal(existsSync("node_modules/vite"), false);
'
stmq_work=$(mktemp -d "${TMPDIR:-/tmp}/stmq-addon-container.XXXXXXXX")
stmq_container="stmq-addon-smoke-$(basename "$stmq_work")"
cleanup() {
  docker rm -f "$stmq_container" >/dev/null 2>&1 || true
  if [[ -d "$stmq_work" ]]; then
    # Container-owned SQLite files can be root-only. Remove only our own fixture.
    docker run --rm --network none --platform "$stmq_platform" \
      --mount "type=bind,source=$stmq_work,target=/fixture" "$stmq_image" \
      node --input-type=module -e 'import { rmSync } from "node:fs"; for (const part of ["data", "config", "share"]) rmSync(`/fixture/${part}`, { recursive: true, force: true });' >/dev/null 2>&1 || true
    rmdir "$stmq_work" 2>/dev/null || true
  fi
}
trap cleanup EXIT
mkdir -p "$stmq_work/data" "$stmq_work/config" "$stmq_work/share"
# A networkless fixture has no Supervisor to allocate an ingress port. Production
# discovers its assigned port from Supervisor; only this disposable test fixes it.
stmq_fixtures=(--mount "type=bind,source=$stmq_root/test/container,target=/st-mq/test/container,readonly"
  --mount "type=bind,source=$stmq_root/scripts/lib/provider-fixture.js,target=/st-mq/scripts/lib/provider-fixture.js,readonly")
stmq_mounts=(--platform "$stmq_platform" --network none --env STMQ_CONTAINER_FIXTURE=1 --env STMQ_INGRESS_PORT=8099
  "${stmq_fixtures[@]}"
  --mount "type=bind,source=$stmq_work/data,target=/data"
  --mount "type=bind,source=$stmq_work/config,target=/config"
  --mount "type=bind,source=$stmq_work/share,target=/share")

docker run --rm "${stmq_mounts[@]}" "$stmq_image" node test/container/smoke.js seed-addon
stmq_options_mount=(--mount "type=bind,source=$stmq_work/data/options.json,target=/data/options.json,readonly")
# Intentionally omit a command: validate the image's shipped CMD and environment.
docker run --detach --name "$stmq_container" "${stmq_mounts[@]}" "${stmq_options_mount[@]}" "$stmq_image" >/dev/null
if ! docker exec "$stmq_container" node test/container/smoke.js probe-addon; then
  docker logs "$stmq_container"; exit 1
fi
docker restart --time 10 "$stmq_container" >/dev/null
if ! docker exec "$stmq_container" node test/container/smoke.js probe-restart; then
  docker logs "$stmq_container"; exit 1
fi
docker stop --time 10 "$stmq_container" >/dev/null
[[ $(docker inspect --format '{{.State.ExitCode}}' "$stmq_container") == 0 ]] || {
  echo 'The add-on must stop cleanly before taking a cold backup.' >&2; exit 1;
}

# Cold backup is the add-on's Supervisor backup policy. The shipped offline CLI
# uses SQLite snapshots and never starts providers, MQTT or equipment control.
docker run --rm "${stmq_mounts[@]}" "$stmq_image" node scripts/history.js backup --output /share/st-mq/container-backup.sqlite
docker run --rm "${stmq_mounts[@]}" "$stmq_image" node scripts/history.js export --signal indoor_temperature --output /share/st-mq/container-export.csv
docker run --rm "${stmq_mounts[@]}" "$stmq_image" node scripts/history.js restore --input /share/st-mq/container-backup.sqlite --db /config/restored/st-mq.sqlite
docker rm "$stmq_container" >/dev/null
docker run --detach --name "$stmq_container" "${stmq_mounts[@]}" "${stmq_options_mount[@]}" \
  --env STMQ_DATABASE_DIR=/config/restored "$stmq_image" >/dev/null
if ! docker exec "$stmq_container" node test/container/smoke.js probe-restored; then
  docker logs "$stmq_container"; exit 1
fi
docker stop --time 10 "$stmq_container" >/dev/null
[[ $(docker inspect --format '{{.State.ExitCode}}' "$stmq_container") == 0 ]] || {
  echo 'The restored add-on must stop cleanly.' >&2; exit 1;
}
# A separate container sees the public add-on folder and share exactly as an SSH
# add-on can, with no private /data mount and read-only access to these files.
docker run --rm --platform "$stmq_platform" --network none --env STMQ_CONTAINER_FIXTURE=1 \
  "${stmq_fixtures[@]}" \
  --mount "type=bind,source=$stmq_work/config,target=/config,readonly" \
  --mount "type=bind,source=$stmq_work/share,target=/share,readonly" \
  "$stmq_image" node test/container/smoke.js inspect-shared

# In-process fixture separately checks the actual provider acquisition plumbing,
# including FMI, Elering fallback and simulated restart. It has no HTTP transport.
docker run --rm "${stmq_mounts[@]}" "${stmq_options_mount[@]}" "$stmq_image" node test/container/smoke.js
docker run --rm --platform "$stmq_platform" --network none --env STMQ_CONTAINER_FIXTURE=1 \
  "${stmq_fixtures[@]}" "$stmq_image" node test/container/replica.js
echo "Add-on container checks passed: $stmq_platform"
