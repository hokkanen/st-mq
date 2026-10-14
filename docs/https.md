# Secure web access

Open **Data & settings → Web access**, immediately above **Configuration**.
Home Assistant ingress and local HTTP recovery work before HTTPS is configured.
Setting up HTTPS never restarts heating, charging or recording. The optional
listener and certificate helper report their own failures.

## Independent entrances

| Entrance | Default | Authentication |
| --- | --- | --- |
| Local recovery | `http://127.0.0.1:1234` | Admin/family passwords; standalone Linux permits tokenless initial bootstrap only on loopback. HA bootstrap uses ingress. |
| Home Assistant ingress | Supervisor-assigned port | Existing HA authentication and ingress-proxy validation. |
| Optional HTTPS | `https://<certificate-hostname>:8443` | Ordinary ST-MQ admin/family passwords; TLS grants no control authority. |
| Optional LAN HTTP backup | `http://<LAN-address>:1236` | Ordinary passwords, with an unencrypted-access warning. Disabled by default. |

HTTPS uses Node's native TLS implementation and the existing application handler.
It does not install Caddy, a reverse proxy, a second web application or another
updater. TLS library maintenance follows normal Node/application/image updates.
Certificate replacement does not require an application restart.

Only the browser entrance changes. MQTT, OCPP, paired control, actuator permissions,
learning and database formats keep their existing contracts. A certificate or
helper failure cannot authorize a command or change a controller role. Native
TLS shares the application process; this is lifecycle isolation, not an independent
CPU or memory sandbox.

Each listener admits at most 128 TCP connections. TLS handshakes have a 5-second
deadline and HTTP headers a 10-second deadline. Ordinary JSON request bodies have
a 15-second deadline; authenticated recovery uploads retain their existing
one-hour owner budget. Disabling or expiring HTTPS also destroys connections that
have not completed a handshake. These limits bound transport work; development-host
load measurements do not qualify physical Raspberry Pi behavior.

## Set up when ready

1. Configure an admin password of at least 24 characters in
   `controller.web_token`. An optional distinct family password must meet the
   same network-access requirement. Ingress still uses Home Assistant login.
2. Choose **Set up HTTPS**. Fresh installations do not download or start Tailscale
   until this administrator action. There are no Tailscale binaries in Git or
   bundled in the Home Assistant image.
3. Authorize the dedicated ST-MQ certificate node through the displayed Tailscale
   link. Enable MagicDNS and HTTPS certificates in the tailnet account. Arrange
   an appropriate unattended node-key-expiry policy. Existing system-wide or HA
   Tailscale installations remain separate.
4. Use the exact certificate hostname shown by setup. Map that hostname to this
   server's reserved LAN IPv4 address, or to the existing shared VIP for a pair.
5. Open the full HTTPS URL and log in normally. A changed origin has separate
   browser storage; credentials are not copied automatically between origins.

Tailscale handles the public DNS challenge for certificate issuance. There is no
public inbound port forwarding, purchased domain, client-installed CA, Serve or
Funnel requirement. The dedicated helper uses userspace networking and does not
take over host DNS, routes, SSH or general-purpose Tailscale access.

Certificate names appear in public Certificate Transparency records. Choose a
non-sensitive node name before issuance. The pinned canonical hostname cannot
silently follow an account-side rename.

## Before router DNS is available

Development, setup, authorization and certificate issuance can finish with an
ISP-controlled router. The UI separates local TLS readiness from LAN DNS readiness.
It does not leave a working ingress/recovery page automatically.

On a test computer, an explicit hosts-file entry can map the exact hostname to
the server's LAN address. For a command-line TLS check, use the real hostname and
`curl --resolve <hostname>:8443:<LAN-address> https://<hostname>:8443/`; do not use
`-k` or disable browser certificate validation. Raw-IP HTTPS and unrelated aliases
do not match the certificate.

For ordinary household access, configure the LAN resolver to return the intended
address and check both A and AAAA answers. An upstream IPv6 answer can compete
with the local IPv4 mapping. Configure `web.lan_resolver` with the resolver's IPv4
address for an explicit server-side check; an empty value means not checked.
Client VPN settings and browser encrypted DNS can bypass that resolver. A server
check cannot establish every client's DNS or trust-store behavior.

## Configuration and HTTP backup

The `web` section owns network wiring, with these public defaults:

```json
{
  "web": {
    "https_host": "0.0.0.0",
    "https_port": 8443,
    "https_directory": "",
    "lan_http_enabled": false,
    "lan_http_host": "0.0.0.0",
    "lan_http_port": 1236,
    "lan_resolver": ""
  }
}
```

Private overrides stay sparse. To enable the backup, set only
`{"web":{"lan_http_enabled":true}}` in the installation configuration and use
the normal controlled restart for network-binding changes. Both configured
passwords must satisfy network-access validation. This listener runs independently
of Tailscale and certificate renewal, so an intentionally enabled backup survives
their failure. HTTPS never enables it automatically.

HTTP exposes credentials and household data to interception or modification.
The UI keeps that warning visible while LAN HTTP is enabled. A wildcard IPv4 bind
does not establish LAN-only reachability: maintain router/host firewall boundaries
and do not forward its port from the Internet. Neither optional listener opens
wildcard IPv6, ports 80/443 or an automatic redirect entrance. HSTS is not enabled.

`STMQ_HOST` now selects only a loopback recovery address; network values are
rejected with guidance to use the explicit backup settings. `STMQ_PORT` retains
its default `1234` for recovery. Retired network binding through `STMQ_HOST` is
not translated into new permission. Ingress retains its assigned port.

HTTPS enablement, enrolled identity, selected hostname, certificate generations
and helper update policy are durable installation state under the managed HTTPS
directory, not controller defaults or learning/database state. The optional
`web.https_directory` selects an absolute external private destination without
changing controller storage. Empty defaults to `<dataDir>/https` on Home Assistant;
standalone uses `$XDG_STATE_HOME/st-mq/https-<installation-hash>` (otherwise
`~/.local/state/st-mq/https-<installation-hash>`). Root-run standalone defaults to
`/var/lib/st-mq-https-<installation-hash>` when no XDG override is set. The hash
namespaces the existing data-directory path. Setup creates storage only when
requested and rejects paths physically inside a Git checkout before downloading.
Disabling HTTPS
retains reusable identity and certificates. Node management is available to an
authenticated standby administrator without granting household-control authority.

## Certificates and helper updates

Setup installs a tested pinned official Tailscale release. Its architecture-specific
digest is an anchor for a known artifact; the independent Tailscale distribution
signature is still required. There is no checksum-only fallback, custom download
URL or user-supplied signing root. Accepted updates use official stable metadata
and signed artifacts, preflight the supported interface, then replace immutable
runtime generations. CLI and daemon always update together.

The initial anchor is **Tailscale 1.104.1**. Its official signed artifacts were
verified for AMD64 and ARM64, and the helper preflight passed in a native AMD64
container and an emulated ARM64 container. The anchor hashes and public signing
roots are reviewed application source in `src/https/official-roots.js`; they are
not installation secrets. Native Raspberry Pi and Supervisor validation remain
separate from these container checks.

After explicit setup, choose automatic compatible stable updates or notify/manual
installation. Update status distinguishes the tested anchor, installed/running
version, latest observed candidate, and failed/stale checks. The updater manages
only this private helper; it does not update host Tailscale, Node, dependencies,
Home Assistant, ST-MQ or router firmware.

Certificates are validated for the full hostname, matching key, validity and normal
public trust before activation. Renewal and activation are serialized; a failed
replacement retains the previous valid certificate. A stored valid certificate
can serve HTTPS without the helper or Internet connection. Expiration withholds
only HTTPS and closes its connections; ingress, recovery and an explicitly enabled
HTTP backup remain independent.

Tailscale identity is stateful. A saved directory or same-major version does not
prove that an old daemon can safely run after a failed update. Changed-state
failures preserve recovery evidence and require recovery forward or explicit
administrator repair; the updater does not blindly restore old identity keys.

All managed files stay outside Git. Private state uses mode `0700` directories
and `0600` files; verified immutable executables use `0555`. On root-operated installations, a separate private helper
directory beside the data directory permits an unprivileged helper without
weakening permissions on controller data. The helper receives a sanitized
environment, no inherited application credentials, no effective/permitted/ambient
capabilities, and no privilege escalation. An unavailable privilege facility
blocks only the helper and reports the failed preflight.
The root adapter also refuses a sibling identity path inside a repository and
requires its parent to permit unprivileged traversal. Select an external
`web.https_directory` if a custom location prevents that traversal; it does not
change private ancestor permissions or move existing controller state.

An interrupted lock acquisition can report `https_lock_recovery_required`.
Stop the application and confirm that its previous helper and any restored copy
are stopped before repairing this state. Preserve the managed directory first;
remove only the stale `https/manager.claim` directory and its `owner.json`, then
restart. Never remove a live manager's lock or delete identity/certificates to
clear a lock warning. An ordinary dead manager lock is reclaimed automatically;
an ambiguous interrupted claim requires this explicit repair.

## Paired nodes and backups

Choose a certificate owner explicitly during paired setup. This is separate from
master/standby control ownership. Only the owner runs the dedicated Tailscale
identity; the other node installs validated certificate generations through the
existing authenticated-encrypted pair channel. Keys are not database content and
never enter ordinary database replication or export. Each node serves its own
native HTTPS listener and stored certificate through the shared hostname/VIP.

An offline peer is reported as incomplete delivery. Controller takeover never
depends on helper or TLS readiness. Loss of the renewal owner leaves the other
node usable only until its stored certificate expires. Disabling local HTTPS on
an owner with a known enabled recipient retains the renewal responsibility.

A standalone HTTPS state cannot silently become paired certificate ownership
after a topology change. Preserve the existing private directory, explicitly
select a fresh `web.https_directory`, then choose the paired owner during setup.
This creates separate identity state; use its shown hostname and update DNS
deliberately. Existing keys and certificates are never migrated automatically.

Home Assistant's cold application backup includes default private runtime state,
identity and certificates beneath `/data`; ordinary database backups do not.
Custom storage outside the application's backed-up directories needs its own
protected cold backup. Standalone backups must include the managed HTTPS directory
and, when root-operated, its private helper sibling. Keep identity backups protected
and offline. Never start two restored copies of the same identity. A changed
machine or managed-directory binding blocks automatic helper startup while the stored valid certificate
remains usable. Explicit identity restoration requires confirming that the prior
owner is fenced; otherwise authorize a distinct identity and update the hostname
and DNS. Restoring control state follows the existing pairing/authority rules.

For Linux recovery, use `ssh -N -L 1234:127.0.0.1:1234 user@server`, keep the
connection active and open `http://127.0.0.1:1234` on that client. If its local port
is occupied, choose another local forwarding port. For Home Assistant, ingress is
the standard recovery path; another SSH add-on does not automatically share the
ST-MQ container's namespace.

## Validation boundaries

Tests use synthetic credentials, separate state, ephemeral ports and isolated
certificate fixtures. Public vendor downloads may be verified separately; tests
do not enroll a production node, request a household certificate, change router
DNS or contact household equipment. Fake roots are explicit fixture injection,
never a production configuration option.

Docker checks establish image behavior, not Supervisor/AppArmor policy or physical
Raspberry Pi performance. Real Supervisor execution from persistent storage,
backup/restore and native supported-hardware qualification remain release gates
when those environments are unavailable. Signature acceptance and passing tests
do not establish freedom from vulnerabilities or every future vendor change.

Official references: [Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates),
[Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking),
[Node TLS](https://nodejs.org/docs/latest-v22.x/api/tls.html),
[Home Assistant ingress](https://developers.home-assistant.io/docs/apps/presentation/).
