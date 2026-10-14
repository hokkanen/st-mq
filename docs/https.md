# Secure web access

Open **Data & settings → Connections & configuration → Web access**,
immediately above **Configuration**.
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

## Guided setup

Web access shows this computer’s current status and the next action to take.
An authorization link appears beside the actions only when the helper provides a
current, validated Tailscale sign-in URL. Detailed setup instructions, household
DNS and recovery checks, and certificate renewal/helper updates have separate
closed disclosures. Opening or refreshing the panel preserves those disclosures
and keyboard focus.

HTTPS being requested, a stored certificate, a listening HTTPS port and household
DNS verification are separate observations. Client access and the unattended
node-key-expiry policy remain manual checks; neither is marked complete by a
server-side check or a valid certificate.

The panel keeps recent actions for 24 hours using their original operation clocks.
An earlier failed request can remain visible after HTTPS recovers; it is labeled
as a past action and does not change current readiness or block a fresh sign-in
link. A lost request reply and a later observed operation result remain separate
evidence. Current unresolved problems remain visible independently of receipt
expiry.

1. Configure an admin password of at least 24 characters in
   `controller.web_token`. An optional distinct family password must meet the
   same network-access requirement. Ingress still uses Home Assistant login.
   If paired, choose the certificate owner explicitly; it is independent of the
   master/standby role. Both nodes need suitable network passwords.
2. Choose **Set up HTTPS**. Fresh installations do not download or start Tailscale
   until this administrator action. There are no Tailscale binaries in Git or
   bundled in the Home Assistant image. Authorize the dedicated certificate node
   through the displayed enrollment link and complete any account-side device
   approval or Tailnet Lock requirement. A recipient node directs setup to its
   paired certificate owner. Existing system-wide or HA Tailscale installations
   remain separate.
3. Use the setup guide links to [Tailscale DNS settings](https://console.tailscale.com/admin/dns)
   and enable MagicDNS and HTTPS certificates. In [Machines](https://console.tailscale.com/admin/machines),
   review or disable expiry for this dedicated node so unattended certificate
   renewal can continue. A valid certificate does not verify that policy.
4. Choose **Recheck** or **Retry setup** to finish certificate issuance and start this
   computer's HTTPS listener. The panel shows the exact URL and reports local
   readiness independently of household DNS. Keep using ingress or recovery
   until the chosen HTTPS URL works; the panel never navigates automatically.
5. When the router or LAN resolver is available, reserve this server's LAN IPv4
   address in DHCP and add a local DNS A-record override for the exact certificate
   hostname. A pair uses its existing shared VIP rather than either individual
   computer's address. This is a local hostname mapping, not public port forwarding.
6. Set `web.lan_resolver` to the LAN resolver's IPv4 address in Configuration and
   apply it through the existing configuration-save and controlled-restart
   workflow. Choose **Recheck**, review the displayed A and AAAA answers, then
   open the full HTTPS URL on each intended browser device and
   log in normally. A changed origin has separate browser storage; credentials
   are not copied automatically between origins.

If setup reports **Authorization link unavailable**, it did not receive a usable
sign-in URL. Choose **Retry setup** to request one; a retry preserves the installed
helper runtime and saved identity. A failed authorization command is reported as
a setup failure, separately from waiting for browser sign-in, account approval or
a connection. The panel never invents an enrollment link or hides the failure
behind an approval prompt.

A pending sign-in URL belongs to the helper's current daemon session. After an
application or helper-runtime restart, previously requested setup or retained
peer renewal resumes that request once if the new restricted helper needs login
and has no usable current URL. The saved identity, runtime and certificate remain
in place; an earlier URL is never restored from a cache. Fresh or disabled
installations do not acquire setup permission. An authenticated helper, an
existing current sign-in URL or pending account approval does not start another
login request. The panel shows setup progress while requesting a new URL; a
failure retains explicit Retry guidance, and ordinary polling does not repeat the
interactive request. Signing in and approving the node remain administrator
actions in Tailscale.

The external steps are Tailscale account authorization and settings, a stable LAN
address and local DNS mapping, and a browser check on each intended device. The
application handles its helper installation, certificate issuance, listener and
renewal. Router access is not required to complete the first four steps.

Tailscale handles the public DNS challenge for certificate issuance. There is no
public inbound port forwarding, purchased domain, client-installed CA, Serve or
Funnel requirement. The dedicated helper uses userspace networking and does not
take over host DNS, routes, SSH or general-purpose Tailscale access.

Certificate names appear in public Certificate Transparency records. Choose a
non-sensitive node name before issuance. The pinned canonical hostname cannot
silently follow an account-side rename.

## Before router DNS is available

Development, setup, authorization and certificate issuance can finish with an
ISP-controlled router. The UI separates local TLS readiness from LAN DNS readiness
and can report **HTTPS ready · DNS not verified**. An unconfigured
server check is not evidence that the household's DNS is missing or broken.
It does not leave a working ingress/recovery page automatically.

On a test computer, an explicit hosts-file entry can map the exact hostname to
the server's LAN address: `<LAN-address> <exact-certificate-hostname>`. Use
`/etc/hosts` on Linux/macOS or `C:\Windows\System32\drivers\etc\hosts` on Windows,
with administrator access. Remove the temporary entry after household DNS works.
The panel fills the address from the configured pair VIP or an explicit HTTPS
IPv4 binding when known; otherwise it labels the address as a placeholder for
the server's reserved LAN address. A wildcard listener is not a discoverable LAN
address. For a command-line TLS check, use the real hostname and
`curl --resolve <hostname>:8443:<LAN-address> https://<hostname>:8443/`; do not use
`-k` or disable browser certificate validation. Raw-IP HTTPS and unrelated aliases
do not match the certificate.

For ordinary household access, configure the LAN resolver to return the intended
address and check both A and AAAA answers. An upstream IPv6 answer can compete
with the local IPv4 mapping. Configure `web.lan_resolver` with the resolver's IPv4
address for an explicit server-side check; apply changes through the normal
configuration-save and controlled-restart workflow before choosing **Recheck**.
An empty value means not checked.
Client VPN settings and browser encrypted DNS can bypass that resolver. A server
check cannot establish every client's DNS or trust-store behavior.

## Installation identity unavailable

This failure is independent of router DNS or certificate issuance. Setup needs
machine identity evidence before it can use a saved Tailscale identity or install
its helper. Linux reads a supported local machine identity file. When those files
are unavailable inside a Home Assistant add-on, it uses the host `machine_id`
from authenticated Supervisor `GET /info`. The raw identity and Supervisor token
are not exposed in status or helper process environment.

For Home Assistant, check Supervisor health and the add-on's Supervisor API
access, then choose **Retry setup**. For standalone Linux, restore read access to a
supported identity source (`/etc/machine-id`, `/sys/class/dmi/id/product_uuid` or
`/sys/firmware/devicetree/base/serial-number`), then choose **Retry setup**. Preserve the managed
directory; deleting it is not a repair. A changed machine binding still requires
the existing explicit fenced-owner identity restoration described below.

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

After explicit setup, choose automatic compatible stable updates or manual
installation in **Certificate renewal & helper updates**. Update status distinguishes the tested anchor, installed/running
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

A genuinely missing manager state file starts with HTTPS disabled. An explicit
malformed state file, including a JSON null or other scalar, is rejected before
storage admission; it is preserved and cannot authorize helper installation or
replace saved installation evidence with fresh defaults.
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
