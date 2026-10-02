# Automatic Easee OCPP setup and native control

This record supersedes the Easee local-access assumptions in the
[September owner review](OWNER-REVIEW-2026-09.md). Native OCPP transfers charging
authorization and scheduling to the connected server; cloud scheduling cannot
be assumed to remain effective. The correction follows the
[Easee maintainer's 22 September 2026 explanation](https://github.com/easee/connect/discussions/2)
and bounded owner-authorized live experiments. Household identifiers, credentials,
authorization tags and private endpoints are omitted from this record.

**Practical outage limit:** native OCPP does not provide seamless cloud-control
backup. Normal Ctrl+C/service stop, restart and paired handover preserve OCPP
configuration and existing control obligations. An offline controller can leave
new charging approval-blocked until ST-MQ restarts or Direct OCPP is explicitly
disabled through Easee configuration. Expiry of an installed pause does not
restore cloud authorization for a new transaction. Earlier live experiments
below describe the former shutdown behavior; they are historical observations.

## Current implementation

| Area | Behavior |
| --- | --- |
| Automatic setup | ST-MQ checks the current cloud connection, records durable ownership/intent, stores the desired version, verifies readback and applies it. It retries bounded failures and preserves foreign configurations. |
| Explicit adoption | The dashboard requires confirmation of replacing an inspected foreign connection. A revision check before the write rejects a changed configuration. Read-only or unauthorized instances cannot adopt it. |
| Owned disable | Disabling local OCPP and applying configuration stores/applies `OcppOff` only for the exact owned configuration, preserving its address, credentials and certificates. Pending cloud failure does not claim shutdown success. |
| Invalid setup state | Unsupported or malformed saved setup prevents the local listener from starting and fences both charging control backends before any setup mutation. It does not silently reset ownership. |
| Shutdown and handover | Ordinary shutdown, restart and paired role transfer preserve native configuration and outstanding profile obligations. Only an explicit integration change requests owned `OcppOff`; unconfirmed restoration remains pending. |
| Authorization | The default `rfid` mode requires permitted tags. Opt-in `plug-and-charge` uses a private virtual tag derived from installation credentials for remote startup; an empty physical tag list is allowed in that mode. |
| Exclusive control | Initial native activation checks for an active cloud schedule before suspending the cloud controller, preserving its restriction and pending automatic takeover. Once the schedule clears or expires, setup drains old control and rechecks before applying native configuration. Cloud telemetry fallback does not reactivate cloud scheduling. |
| Native scheduling | Absolute `TxProfile` restrictions bind to the confirmed current transaction. Economic pauses use 0 A and expire at the planned release. Extra identification charging releases the owned pause under normal native current limits; controller energy/time guards reinstate the economic pause. No positive-current profile or autonomous probe cutoff is installed. Effective composite readback verifies zero-current restrictions. Cleanup requires the exact owned profile ID and current authorized connection; it remains possible when the old transaction is unconfirmed. Missing profile IDs are rejected. |
| Paired address | The charger uses the pairing VIP and local port. Peer readiness verifies compatible endpoint, identity, credentials, authorization mode and tags, plus listener admission. Disabled local OCPP still requires these checks while restoration is owed. Final transaction/setup state travels with the verified database snapshot. |
| Public status | Setup progress, activation/control-handover waiting and fresh local measurements are separate. Working cloud reading availability stays accurate. No endpoint, password or private tag is displayed. |
| Current state | The native transaction ledger is strict version 4. Unsupported development ledgers are rejected before mutation; no migration, old decoder or automatic erasure is added. |
| Missing native stop | Fresh, explicitly timestamped connector status can retire the active slot only when newer than its latest transaction-specific evidence. The retained row records separate `endedByStatus` evidence without inventing `StopTransaction`, a stop timestamp, `meterStop` or energy. A later real stop can complete the old row without ending a newer transaction. |
| Off/on recovery | An owned `OcppOff` request records durable intent before apply. Only a later authenticated connection can use its bounded recovery permission; a distinct authorized start supersedes the old active row with separate `endedByNewStart` evidence. The request alone does not end the transaction. |

Standalone generated credentials live in a private file; paired credentials are
derived from the shared pairing token. Generated passwords have 20 characters,
and explicit passwords must have 16–20. Secrets are not copied into the learning
history. Compact setup ownership, command intent and transaction identity serve
different purposes from recorded electricity; no duplicate energy series or
chart-summary storage was added.

Version 4 retains each transaction's latest native evidence time. Only a fresh
`Available` or `Finishing` report from the current authenticated
connector can establish no ongoing transaction. Future timestamps wait until
current, and newer buffered transaction readings fence older status. Neither a
cloud apply acknowledgement nor socket closure clears the active transaction.
`Preparing` cannot retire a transaction: the live firmware emitted it one second
after an accepted `StartTransaction`.

The `modeDisableIntent` marker records request time and connection identity before
owned Off apply, without claiming physical completion. Fresh explicit `Preparing`
on a later authenticated connection, newer than that request and without current
transaction-bearing meter evidence, permits one plug-and-charge recovery attempt.
The attempt is persisted before transmission; retries and process restarts do not
replenish it. A boot on the same socket or paired handover does not grant recovery.
The old active row remains until a distinct authorized start is newer than both
its latest transaction evidence and the disable request. Supersession preserves
the missing stop and meter data; a delayed real stop still updates only that row.
`SuspendedEVSE` does not retire or automatically restart an existing transaction.

## Live evidence and its limits

The authorized experiment established these specific observations on the tested
charger and vehicle:

- A private virtual-tag `RemoteStartTransaction` was accepted, followed by a
  native `StartTransaction` and physical charging without an RFID tap.
- The actual ST-MQ receiver observed `Preparing` shortly after an accepted start,
  requiring the transaction logic to preserve that active transaction. Its
  native `Inlet` samples also established a needed measurement-parser correction;
  synthetic regressions now cover that charger-connector location.
- A 0 A profile for the current transaction paused charging.
- `GetCompositeSchedule` reported the zero-current interval and a later release
  envelope. A returned 255 value was an observed composite result, not a 255 A
  setpoint sent by ST-MQ or a claim about available installation current.
- With the test server suspended before profile expiry, physical charging was
  observed about two seconds after expiry without a resume command. This checks
  autonomous release of an already-installed pause on that test installation.
- In a separate user-assisted test with the server suspended for about four
  minutes, the user unplugged/replugged and pressed Start in the Easee app. The
  app waited for approval and no charging followed while OCPP still owned
  authorization. After the server resumed, a remote-start request was accepted
  again. This demonstrates that pause expiry and fresh-session authorization
  are separate; app/cloud operation is not an automatic fallback during outage.
- While the server was connected, the owner pressed Easee app Pause and Resume,
  with corresponding `Charging`/`SuspendedEVSE` status changes. The offline Start
  result does not establish that all app controls are blocked while connected.
  A suspended existing session is not automatically restarted from that status.
- The original positive 6 A experiment did not validate positive-current control.
  An October 6 A trial confirmed the requested schedule but measured no draw
  during its bounded window. A later 6.1 A request started after vehicle context
  arrived; effective composite readback still showed 6 A and fresh physical
  measurements showed no draw. Positive-current limiting was dropped from this change;
  identification uses ordinary charging current and the established zero-current
  pause/release path. No physical minimum-current behavior is claimed.
- The subsequent normal-current application check obtained three-phase draw
  around 11 kW, observed a return to zero, and identified BMW from corresponding
  vehicle reports. Final readback confirmed the scheduled native pause, with no
  pending command or positive-current profile. The charging choice changed
  during this run, so this checks start/stop and identification; it is not a
  physical validation of an exact 0.15 kWh cutoff.
- An earlier OCPP mode-disable/re-enable cycle left charging telemetry without a
  transaction identifier until a physical unplug/replug. The controller retained
  its transaction-confirmation fence. Preserving the native session during the
  final application handover avoided another mode cycle; general orphaned
  transaction recovery remains a separate operational issue.
- After applying `OcppOff`, a follow-up about one minute later reported no active
  cloud schedule and external authorization disabled. This is delayed control
  readback, not evidence of immediate physical handback or a new charging start.

These observations do not establish every firmware, vehicle or phase arrangement,
all manual-control interactions, or paired-hardware takeover. The owner declined
an Equalizer load test. The app reported Equalizer available; continued local
balancing is an installation assumption, not a verified load-test result. An outage can
still miss a future pause; installed-pause expiry does not make future economic
scheduling autonomous.

The live commissioning API also established details that the simplified guide
did not make clear: Basic-auth passwords are limited to 20 characters, the store
request can return HTTP 201, and GET includes the appended charge-point identity
in its URL while POST takes the base URL. The canonical GET response uses
`version`, `connectivityMode`, `websocketConnectionArgs` and `basicAuth`.
The [official GET reference](https://developer.easee.com/reference/getuserchargerconnectiondetailsendpoint)
has an inconsistent schema reference, but its response example agrees with the
operator API's `ConnectionDetailsDto`. ST-MQ validates the current response and
exact identity instead of accepting request-shaped aliases or arbitrary wrappers.

## Validation

The focused UI suites and isolated browser check cover setup/reading separation,
pending control handover, confirmation cancellation, revision changes while the
dialog is open, busy-state handling, read-only refusal and the 320-pixel layout.
Backend suites cover setup ownership/retries, cloud response validation, native
authentication, transaction replay, bounded Off/on recovery and missing-stop
recovery without fabricated meter data, expiring profile construction/readback,
authority changes, invalid setup fencing, exact-ID cleanup with an unconfirmed
transaction, graceful cloud restoration and paired readiness with outstanding
restoration. All automated fixtures use invented
identities and isolated services.

Reproduction commands:

```sh
node --test test/provider-status.test.js test/ocpp-setup-ui.test.js
node --test test/easee-ocpp.test.js test/easee-ocpp-setup.test.js test/easee-ocpp-api.test.js test/easee-ocpp-disable.test.js test/easee-ocpp-lifecycle.test.js test/charging-ocpp.test.js test/pair-ocpp.test.js
npm run build -- --configLoader native
node scripts/browser-ocpp-setup-smoke.js ws://127.0.0.1:39125/session
```

The browser command requires a separately started isolated Firefox BiDi listener.
Integrated validation passed: 2,892 tests in the full unit suite, a final
150-test focused run covering the last listener and pairing guards, all nine
extended tests, the production build and the focused browser check. The UI
suite also passed and its 320-pixel view was inspected. These automated results
do not establish paired-hardware takeover or general firmware compatibility.

The actual ST-MQ application was then run against the authorized charger with
isolated charger acquisition and the final transaction format. It completed
automatic setup, retained its accepted transaction through later `Preparing`
status, and received live local charging power around 3.5 kW. Normal application
shutdown stored/applied owned `OcppOff` and preserved the unresolved transaction
with a durable mode-change intent instead of fabricating a stop.
Restarting that same application database while the car remained connected then
produced one accepted remote-start request and a newly accepted transaction.
The new transaction superseded the marked unresolved record, retained its missing
stop/energy fields, and supplied confirmed local telemetry. Native composite
readback showed no scheduled pause. This verifies the bounded mode-change
recovery path on the tested installation, independently of paired-hardware
takeover or whether the vehicle chooses to draw power after each mode change.
