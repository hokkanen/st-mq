# Mosquitto configuration for MSG200

The paired installation uses two local Mosquitto brokers and one device endpoint
at `VIP:8883`. ST-MQ's TCP frontend forwards TLS unchanged to the master's
broker. Existing broker users, subscriptions and retained stores remain local.

## Prerequisites and backups

Both ST-MQ nodes need working primary MQTT connections and commissioned pairing.
Keep the virtual IP outside the DHCP pool. Record each node's fixed management
address, published broker ports and existing listener configuration.

Before changing a broker, back up its configuration, authentication files,
certificates and retained-message database. Preserve the current MSG200 binding
and ST-MQ equipment configuration. Perform planned changes with both doors
stationary. Existing password-file or plugin authorization must be reviewed before
adding another authentication plugin.

The Linux preparation tool below targets Mosquitto 2.0 Dynamic Security, as
provided by Ubuntu. It does not generate Mosquitto 2.1 password records. The HA
broker uses the official add-on's normal authentication path.

## Private device identity

Create a private directory outside the checkout with mode `0700`, and a
`device.json` file with mode `0600`. Its fields are:

```json
{
  "uuid": "0123456789abcdef0123001122334455",
  "key": "abcdef0123456789abcdef0123456789",
  "user_id": 17
}
```

These are invented values. Use the paired device's actual UUID, local key and
user ID; preserve them when changing its broker. The UUID's final twelve hex
digits identify the device MAC. The firmware username is the lowercase,
colon-separated MAC. Its password is `user_id`, an underscore, and the lowercase
MD5 digest of the concatenated MAC and local key. This format is documented in
the [Meross protocol reference](https://github.com/albertogeniola/MerossIot/blob/0.4.X.X/docs/meross-protocol.rst).

The username contains colons and cannot be stored with `mosquitto_passwd`.
Application users continue to use their existing credentials.

## Linux authentication

Stop Mosquitto before copying or replacing its Dynamic Security state. The plugin
owns that file while running and may write it during shutdown.

With the device identity in a private file and the existing password file at the
example path below, prepare a new output directory:

```sh
sudo python3 scripts/prepare-meross-mosquitto.py \
  --device-file /path/to/private/device.json \
  --password-file /etc/mosquitto/passwd \
  --output-dir /path/to/private/prepared
```

If Dynamic Security is already installed, also supply
`--dynamic-security /path/to/current/dynamic-security.json`. The tool preserves
existing client records and roles. It refuses a conflicting native account or
role and a default-allow configuration, which require a separate authorization
review. No running service or installed broker file is changed by preparation.

The output contains:

- `device-login.json`: the firmware username and password, for provisioning the
  equivalent HA account and authenticating the device.
- `dynamic-security.json`: a restricted device role and password-file account
  records. New password-file records defer authentication to the existing password
  file and receive ordinary application topic permissions. Existing Dynamic
  Security clients retain their configured authorization.

Install the generated state as
`/etc/mosquitto/stmq-meross/dynamic-security.json`, owned by `mosquitto`, mode
`0600`, in a directory owned by `mosquitto`, mode `0700`. Keep the existing
`password_file` setting. Install the listener/plugin configuration from
[the Linux example](../integrations/homeassistant/meross-mosquitto-linux.conf.example)
as a private file under `/etc/mosquitto/conf.d/`. Check the installed plugin path
for the machine architecture; `dpkg -L mosquitto` lists packaged files.

The native role permits the device to publish only its appliance reports and
application replies, and to subscribe only to its own command topic. Verify a
normal application subscription as well as device authentication; successful
login alone does not prove that existing users retain topic access.

## TLS certificate and listeners

Both brokers present the same device-compatible server certificate and key.
Preserve a working certificate during migration. For a new certificate, provision
an RSA server certificate whose subject alternative name includes the virtual IP
or broker hostname. Verify compatibility with the installed firmware before
changing the device binding. Certificate validation behavior varies by firmware;
it is not a substitute for MQTT authentication or topic access control.

For example, a new self-signed RSA certificate for an example virtual IP can be
created in a private directory with:

```sh
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /path/to/private/server.key -out /path/to/private/server.crt \
  -subj "/CN=192.0.2.30" -addext "subjectAltName=IP:192.0.2.30"
```

Use the actual endpoint and maintain a renewal date. A certificate generated this
way still needs firmware compatibility verification; an existing working
installation can instead restore its known certificate and CA from backup.

Keep private keys outside the checkout and install them with mode `0600`. The
Linux example expects `server.crt` and `server.key` in
`/etc/mosquitto/stmq-meross/`. Its TLS upstream listens only on `127.0.0.1:8885`.
Existing fixed-address TLS listeners and their certificates are preserved.

A wildcard listener on port 8883 conflicts with the virtual-IP frontend. Bind an
existing listener to its fixed management address or loopback instead. The normal
primary listener likewise leaves `VIP:1883` available to the paired frontend.

## Official HA Mosquitto add-on

The official Mosquitto add-on retains its standard update path. Configure its
certificate and key through the normal `certfile` and `keyfile` options, with
`require_certificate: false`. These files are installed under HA's `/ssl` folder.
Keep existing logins and other options. Custom broker images or authentication
plugins are not required for this setup.

Provision the firmware username and password from `device-login.json` as a
separate Home Assistant user with local-only access and the read-only user group.
Do not add the colon-containing username to the add-on's password-file `logins`
list. HA account management owns this user's credential.

The add-on authenticates through Supervisor. A successful initial authentication
warms Supervisor's persisted credential cache. When HA Core is unavailable,
Supervisor can authenticate an unchanged credential from that cache. A new or
changed credential must be authenticated while Core is available first. Loss of
Supervisor or its persisted data is a separate host failure.

Publish the add-on's TLS listener on a management port distinct from the virtual
IP listener. A representative port layout is:

| Listener | Broker/container port | Fixed host port |
| --- | --- | --- |
| HA application MQTT | 1883 | 1885 |
| HA TLS management | 8883 | 8885 |
| Linux TLS upstream | 8885 on loopback | 8885 on loopback |
| Paired device MQTT | Frontend | VIP:1883 |
| Paired device TLS | Frontend | VIP:8883 |

The ST-MQ primary MQTT connection uses its node's local broker, not the virtual
IP. Set `pair.mqtt_tls_port` to `8883` on HA and `8885` on Linux for this layout.
Zero disables the TLS frontend. See [pair settings](pairing.md#configuration).

## Broker verification

Create a private `broker-check.json` for each TLS upstream:

```json
{
  "address": "mqtts://192.0.2.20:8885",
  "uuid": "0123456789abcdef0123001122334455",
  "login_file": "/path/to/private/prepared/device-login.json",
  "server_certificate": "/path/to/private/server.crt",
  "ca_certificate": "/path/to/private/ca.crt"
}
```

For a self-signed server certificate, `ca_certificate` can be omitted. With the
repository's Node dependencies installed, run:

```sh
node scripts/verify-meross-broker.js /path/to/private/broker-check.json
```

The check makes a fresh TLS connection, pins the supplied server certificate,
authenticates the firmware account and subscribes to its command topic. It sends
no publish or door command. On Linux, add `--restricted` to require rejection of
an unrelated subscription. HA's normal account authorization model can allow
that subscription. A successful HA connection also warms Supervisor's credential
cache before the Core-off test.

Use only the configuration fields shown above. The login file must contain only
`username` and `password`, with the MAC username belonging to the configured UUID.
Application credentials cannot qualify the firmware account.

## Device binding

`scripts/bind-meross-msg200.py` inspects an already paired MSG200 or changes only
its broker configuration. It cannot send door movement commands. First inspect
its identity and current binding:

```sh
python3 scripts/bind-meross-msg200.py \
  --device-file /path/to/private/device.json \
  --device-host 192.0.2.40 --broker-host 192.0.2.30
```

The addresses are examples. After authentication and TLS have been verified on
both brokers, bind the device to the shared virtual IP:

```sh
python3 scripts/bind-meross-msg200.py \
  --device-file /path/to/private/device.json \
  --device-host 192.0.2.40 --broker-host 192.0.2.30 \
  --backup-dir /path/to/private/original-binding --bind
```

The tool checks the device UUID and user ID before writing, preserves the local
key, saves the original response privately and refuses an existing attempt file.
Both primary and secondary server entries use the shared virtual IP on port 8883.
A SETACK acknowledges configuration only. Repeat inspection without `--bind` and
check broker connection logs and fresh ST-MQ contacts after reconnection. An
unconfirmed response requires inspection before any deliberate retry.

## Validation and maintenance

Validate each broker before handover: device authentication, a native command-topic
subscription, rejection of an unrelated device subscription, normal application
subscriptions and TLS certificate loading. With HA Core stopped, verify a fresh
device connection after restarting the official broker; then restore Core.

Commission [the native equipment entries](meross-msg200.md#equipment-configuration)
and test attended movement, broker restart, application restart and explicit
handover in both directions. The final role and authority checks are separate
from contact-state readback.

Certificate renewal is performed on both broker upstreams using the paired
slave-first procedure. Credential changes are applied to both brokers before
changing the device. Existing broker stores are not replicated; a reconnect
requires fresh device reports. Restore original files and binding from the
private backups if validation fails, preserving any newer unrelated changes.
