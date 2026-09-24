# Automatic Easee OCPP setup and native control

This record supersedes the Easee local-access assumptions in the
[September owner review](OWNER-REVIEW-2026-09.md). Native OCPP transfers charging
authorization and scheduling to the connected server; cloud scheduling cannot
be assumed to remain effective. The correction follows the
[Easee maintainer's 22 September 2026 explanation](https://github.com/easee/connect/discussions/2)
and bounded owner-authorized live experiments. Household identifiers, credentials,
authorization tags and private endpoints are omitted from this record.

**Practical outage limit:** native OCPP does not provide seamless cloud-control
backup. Normal Ctrl+C/service stop requests `OcppOff`; failed cloud access leaves
handback unconfirmed. Paired handover preserves OCPP for the next controller.
After abrupt process or power loss, charging can remain approval-blocked until
ST-MQ restarts or Direct OCPP is disabled through Easee configuration. Expiry of
an installed pause does not restore cloud authorization for a new transaction.

## Current implementation

| Area | Behavior |
| --- | --- |
| Automatic setup | ST-MQ checks the current cloud connection, records durable ownership/intent, stores the desired version, verifies readback and applies it. It retries bounded failures and preserves foreign configurations. |
| Explicit adoption | The dashboard requires confirmation of replacing an inspected foreign connection. A revision check before the write rejects a changed configuration. Read-only or unauthorized instances cannot adopt it. |
| Owned disable | Disabling local OCPP and applying configuration stores/applies `OcppOff` only for the exact owned configuration, preserving its address, credentials and certificates. Pending cloud failure does not claim shutdown success. |
| Invalid setup state | Unsupported or malformed saved setup prevents the local listener from starting and fences both charging control backends before any setup mutation. It does not silently reset ownership. |
| Shutdown and handover | Normal shutdown attempts owned `OcppOff` before closing the charging runtime; cloud failure preserves the obligation and reports an error. Paired role transfer keeps native OCPP active. A crash cannot perform cloud handback after the process is gone. |
| Authorization | The default `rfid` mode requires permitted tags. Opt-in `plug-and-charge` uses a private virtual tag derived from installation credentials for remote startup; an empty physical tag list is allowed in that mode. |
| Exclusive control | Native activation releases ST-MQ's owned cloud instruction first. A foreign active cloud schedule is preserved and holds the transition. Cloud telemetry fallback does not reactivate cloud scheduling. |
| Native scheduling | Only absolute 0 A `TxProfile` restrictions for the confirmed current transaction are installed. Their expiry releases the restriction without another command. Effective composite readback checks the pause. Cleanup requires the exact owned profile ID and the current authorized connection; it remains possible when the old transaction is unconfirmed. Missing profile IDs are rejected. No positive-current profile is used. |
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
- A positive 6 A profile did not produce sufficiently clear behavior to support
  a positive-current control contract. The implementation therefore restricts
  native scheduling to expiring zero-current pauses and existing charger,
  vehicle and Equalizer limits.
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
