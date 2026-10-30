#!/bin/sh
set -eu
# Installation owns these private files; absence must never create an open broker.
root=/share/stmq-shared-mqtt/runtime
test -s "$root/mosquitto.conf"
test -s "$root/dynamic-security.json"
chmod 0700 "$root"
chmod 0600 "$root/dynamic-security.json"
exec mosquitto -c "$root/mosquitto.conf"
