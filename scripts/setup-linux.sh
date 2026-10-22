#!/usr/bin/env bash
set -euo pipefail
# Installation always evaluates the reviewed file, never inherited runtime overrides.
unset NODE_OPTIONS NODE_PATH
while IFS= read -r setup_environment_key; do unset "$setup_environment_key"; done < <(compgen -A variable STMQ_ || true)

# Bootstrap only. Application credentials and installation choices belong to the wizard.
setup_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
setup_source=$(dirname -- "$setup_dir")
if [[ ${1-} == --help || ${1-} == -h ]]; then
  printf '%s\n' 'Usage: bash scripts/setup-linux.sh [--connection /private/path/linux-deploy.json] [--dry-run]' 'Interactive standalone or paired Linux installation.' 'Private configuration is copied or edited as a secrets.json file; individual credentials are never prompted.'
  exit 0
fi
if (( EUID == 0 )); then
  printf '%s\n' 'Run setup as the ordinary application account; sudo will request privileges when needed.' >&2
  exit 1
fi
if [[ ! -r /etc/os-release || ! -d /run/systemd/system ]]; then
  printf '%s\n' 'Setup requires systemd-based Ubuntu 22.04 or newer.' >&2
  exit 1
fi
setup_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
setup_version=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')
if [[ $setup_id != ubuntu || ! $setup_version =~ ^([0-9]+)\.([0-9]+)$ ]] || (( BASH_REMATCH[1] < 22 || (BASH_REMATCH[1] == 22 && BASH_REMATCH[2] < 4) )); then
  printf '%s\n' 'Setup supports Ubuntu 22.04 or newer.' >&2
  exit 1
fi
case $(uname -m) in
  x86_64) setup_arch=x64; setup_hash=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 ;;
  aarch64|arm64) setup_arch=arm64; setup_hash=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e ;;
  *) printf '%s\n' 'Setup supports amd64 and arm64.' >&2; exit 1 ;;
esac
setup_node_version=24.22.1
setup_node_root=/opt/st-mq/node-v${setup_node_version}-linux-${setup_arch}
setup_trusted_node() {
  local candidate path owner mode
  candidate=$(readlink -f -- "$1") || return 1
  [[ -f $candidate && -x $candidate ]] || return 1
  path=$candidate
  while :; do
    owner=$(stat -c %u -- "$path") || return 1
    mode=$(stat -c %a -- "$path") || return 1
    [[ $owner == 0 ]] && (( (8#$mode & 8#022) == 0 )) || return 1
    [[ $path == / ]] && break
    path=$(dirname -- "$path")
  done
  [[ -f $(dirname -- "$candidate")/npm ]] || return 1
  "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' >/dev/null 2>&1 || return 1
  setup_node=$candidate
}
setup_node=
for setup_candidate in "$(command -v node || true)" /usr/bin/node /usr/local/bin/node "$setup_node_root/bin/node"; do
  if [[ -n $setup_candidate ]] && setup_trusted_node "$setup_candidate"; then break; fi
done
if [[ -z $setup_node ]]; then
  if [[ ${1-} == --dry-run ]]; then
    printf '%s\n' 'A trusted Node runtime is required before the wizard can run. Normal setup installs the pinned official runtime.' >&2
    exit 1
  fi
  printf '%s\n' 'Setup needs a trusted Node runtime. It will install download tools if missing and a verified official Node runtime under /opt/st-mq.'
  command -v sudo >/dev/null || { printf '%s\n' 'Install sudo and retry as the application account.' >&2; exit 1; }
  timeout --foreground --kill-after=5s 120 sudo -v
  setup_packages=()
  for setup_package in ca-certificates curl xz-utils; do
    if [[ $(dpkg-query -W -f='${db:Status-Status}' "$setup_package" 2>/dev/null || true) != installed ]]; then setup_packages+=("$setup_package"); fi
  done
  if (( ${#setup_packages[@]} )); then
    timeout --foreground --kill-after=5s 600 sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update
    timeout --foreground --kill-after=5s 120 sudo -v
    timeout --foreground --kill-after=5s 900 sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${setup_packages[@]}"
  fi
  setup_temporary=$(mktemp -d)
  trap 'rm -rf -- "$setup_temporary"' EXIT
  setup_archive=node-v${setup_node_version}-linux-${setup_arch}.tar.xz
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 \
    "https://nodejs.org/dist/v${setup_node_version}/${setup_archive}" -o "$setup_temporary/node.tar.xz"
  printf '%s  %s\n' "$setup_hash" "$setup_temporary/node.tar.xz" | sha256sum --check --status
  timeout --foreground --kill-after=5s 120 sudo -v
  # Stage in a root-owned directory; never execute a runtime from user-writable storage as root.
  timeout --foreground --kill-after=5s 300 sudo -n bash -s -- "$setup_temporary/node.tar.xz" "$setup_node_root" "$setup_hash" <<'ROOT'
set -euo pipefail
archive=$1 destination=$2 expected=$3
[[ $destination == /opt/st-mq/node-v24.22.1-linux-x64 || $destination == /opt/st-mq/node-v24.22.1-linux-arm64 ]] || exit 1
for component in /opt /opt/st-mq; do
  [[ ! -L $component ]] || exit 1
  if [[ -e $component ]]; then
    [[ $(stat -c %u "$component") == 0 ]] && (( (8#$(stat -c %a "$component") & 8#022) == 0 )) || exit 1
  else install -d -o root -g root -m 0755 "$component"; fi
done
[[ ! -e $destination && ! -L $destination ]] || { printf '%s\n' 'Pinned runtime destination already exists; inspect it before retrying.' >&2; exit 1; }
staging=$(mktemp -d /opt/st-mq/.node-install-XXXXXXXX)
trap 'rm -rf -- "$staging"' EXIT
install -o root -g root -m 0600 "$archive" "$staging/node.tar.xz"
printf '%s  %s\n' "$expected" "$staging/node.tar.xz" | sha256sum --check --status
mkdir "$staging/runtime"
tar -xJf "$staging/node.tar.xz" --strip-components=1 --no-same-owner -C "$staging/runtime"
chmod -R go-w "$staging/runtime"
mv "$staging/runtime" "$destination"
ROOT
  rm -rf -- "$setup_temporary"
  trap - EXIT
  setup_trusted_node "$setup_node_root/bin/node" || { printf '%s\n' 'Installed Node verification failed.' >&2; exit 1; }
fi
export PATH="$(dirname -- "$setup_node"):$PATH"
if ! "$setup_node" -e 'import(process.argv[1]).catch(()=>process.exit(1))' "$setup_source/src/app/config.js" >/dev/null 2>&1; then
  printf '%s\n' 'Preparing local setup and build dependencies. Diagnostic output is kept private.'
  "$setup_node" "$setup_source/scripts/lib/linux-setup-bootstrap.js" "$setup_source"
  if ! "$setup_node" -e 'import(process.argv[1]).catch(()=>process.exit(1))' "$setup_source/src/app/config.js" >/dev/null 2>&1; then
    printf '%s\n' 'Setup modules could not load after dependency installation. Check the source checkout before retrying.' >&2
    exit 1
  fi
fi
exec "$setup_node" "$setup_source/scripts/setup-linux.js" "$@"
