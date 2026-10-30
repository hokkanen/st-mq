# Shared local MQTT broker

This optional HAOS app replaces the stock Mosquitto app when its authentication
chain cannot admit a native device username without depending on HA Core.
It runs the pinned stock broker image directly with one Dynamic Security owner.
It adds no Meross-specific broker, protocol translator or authentication service.

Copy this directory to the HAOS local apps directory, reload the app store and
build it through Supervisor. Provision private broker configuration, accounts,
TLS certificates and retained/session data before starting. The wrapper refuses
missing configuration rather than creating an anonymous or reset broker.

Private files belong under `/share/stmq-shared-mqtt/runtime` with directory mode
0700 and credentials mode 0600. `mosquitto.conf` loads the image's native Dynamic
Security plugin and the provisioned `dynamic-security.json`, uses that directory
for persistence, and defines MQTT/TLS listeners. Preserve the old broker database
using a settled saved copy from the same broker version. Never move a live database
without including its final save.

The default management ports preserve ST-MQ's paired frontend arrangement:
HA host 1885 reaches broker 1883 and HA host 8885 reaches broker 8883. Devices use
the ST-MQ VIP. Internal clients formerly using `core-mosquitto` must explicitly
use the new app hostname, `local-stmq-mqtt`. Preserve usernames, passwords,
MQTT client identities, topics, subscriptions, entity IDs and automations.
Provision each existing account before cutover, including HA's own MQTT account;
HA-managed authentication is deliberately replaced by local broker authentication.

The stock app must be stopped before this app starts on its management ports.
Keep the stock app, its data and all previous client configurations for rollback.
Rolling back after the replacement has accepted traffic requires preserving the
new history/session data too; do not silently replace it with an older copy.

An image change requires testing native username authentication, existing accounts,
ACLs, retained/session file loading, MQTT reconnect and the paired VIP handover.
Use the version's own `mosquitto_ctrl` tooling for password representations;
Mosquitto 2.0 and 2.1 represent these differently. Do not copy an encoded hash into
a plaintext password field. See [MSG200 integration](../../docs/meross-msg200.md).
