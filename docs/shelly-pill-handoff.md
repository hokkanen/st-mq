# Notes for the separate Shelly Pill task

ST-MQ consumes the separate `shelly-cn105-mqtt` repository's `shelly-cn105/v1`
contract. See [garage adapter setup](garage-adapter.md) for the explicit production
driver, exact private MQTT topics and commissioning gates. The default synthetic
`stmq-garage-fixture/v1` driver cannot publish real commands.

- Production state includes installed `selectivePowerVerified`, `expiryVerified`
  and `restartVerified` evidence. Native baseline means fresh ordinary HEAT settings,
  including 17°C used for external-temperature control. Managed pause capabilities
  include native-setting preservation and software release ordering. One local
  `pauseEnabled` permission (default false) governs every managed pause. ST-MQ
  uses that capability for explicit timed OFF; automatic price control changes
  external room targets and requires external readiness instead. The Pill receives
  no manual/automatic `purpose` and stores no such policy.
  `mode: "ready"` and `authority.controlAllowed` expose qualified pause support;
  monitoring blocks new managed OFF. The independent `manualEnabled`
  permission governs ordinary persistent native settings, not a second bounded
  pause path. Software race tests do not manufacture installed test evidence.

- The consumer needs native baseline-preserving availability/OFF/release,
  finite episode and lease endpoints, separate host/device sessions, replay-safe
  freshness challenges, sequencing and rejection/acceptance/native-confirmation
  evidence. Reboot or manual ON must invalidate previous OFF intent. A root host
  manual timed-OFF operation has its own bounded restoration obligation.
- Provide actual accepted renewal, expiry, native minimum ON and worst-case
  useful-heating restoration-delay bounds. ST-MQ tracks independent front/rear
  thermal reserves and renews only from its one-minute planner tick. The consumer
  now requests no more than two minutes of permission from the older supporting
  temperature report, with a shorter deadline when reserve requires it. The
  protocol must accept earlier deadlines and expose accepted expiry. A request
  awaiting acknowledgement may already be active and counts as outstanding
  permission. Document real timing rather than treating these fixture tests as
  evidence of installed firmware behaviour. A transport-only probe outage can
  hold an accepted active pause within its original deadline and qualified reserve,
  but cannot authorize a start or renewal. No new grace period begins at outage.
- Publish driver progress separately from device MQTT presence and fresh pump
  communication. Local network-loss recovery depends on a healthy powered Pill
  and usable serial path. Preserve restoration obligations before any possible
  OFF write, restore without host/network/UTC, and document maintenance handover.
- Each native field needs real support, units, decoding/accuracy qualification,
  its own observation clock and boot identity. Re-publishing cached fields must
  not refresh them. Relative timestamps need explicit semantics; the current
  consumer does not use receipt-reconstructed clocks for recorded timing savings.
- Pump indoor/outdoor readings remain optional live context. The Pill's electronics
  temperature is a different source. Compressor frequency/activity is never watts.
- For energy, report coverage/scope, counter cadence, resolution and reset/rollover
  semantics. ST-MQ selects counter deltas **or** integrated power, never both.
  Coarse/uncertain totals cannot establish fine-grained electricity timing.
- ST-MQ's existing two garage probes, two EV histories and vehicle-door identities
  remain host inputs. Do not move optimization, thermal-reserve policy or EV scheduling
  into the Pill. Both vehicle doors are at the front; door2 is not a rear door.

Deploy the matching current application and adapter contracts together. Remove
retired `controller.mode` and `STMQ_MODE` from ST-MQ configuration and deployment
environment, and use the Pill's current `pauseEnabled` configuration instead of
the retired `armed` field. These inputs are rejected rather than translated.
Home and Garage default to Plan only and retain separate saved automation
permissions in ST-MQ. Plan only permits qualified explicit manual heating and
does not stop a separately saved room-target feed or an owed restoration.

ST-MQ also supports the Pill's external temperature control for persistent
room settings down to 5°C. Initial setup requires the pump ON in HEAT mode. ST-MQ explicitly
commands and confirms the native 17°C target, then feeds the independent Garage rear
temperature plus `17 − requested room setting`:
a 5°C setting adds 12°C. This uses neither Mitsubishi i-save nor an owner
assumption about mode persistence.

The driver must advertise the capability, enable its local feature flag, and
report `refreshMs: 10000` with `maxSourceAgeMs: 180000`. The old 90-second
advertisement is unsupported. Remote values are 8–39.5°C in 0.5°C steps. ST-MQ
requires original usable front and rear reports younger than 120 seconds and
requests expiry at most 120 seconds after the older report. The wire sample
retains the rear measurement's original timestamp; the driver must honor an
earlier absolute `requestedExpiryAt` within its 180-second ceiling. Both probes'
thermal reserve must cover this deadline and the driver's useful-heating delay;
the reserve can shorten permission further. These checks are independent of the
host's economic enablement and protection approval. Each external enable or
renewal also requires HEAT and 17°C readbacks under the existing 30-second
freshness requirement. Power must be ON; timed OFF and external input are
mutually exclusive. A failed native check stops renewals. Protection can request
earlier clearing without undoing an independent manual power/mode choice.
Automatic savings retain native ON and temporarily reduce the effective target,
without replacing the durable normal room choice. Same-source target changes
retain the original measurement timestamp and cannot extend its deadline.

Communication-only sensor outages can hold an existing acknowledged sample,
never admit or renew one, while its original deadline and both protection reserves
remain valid. This uses live in-memory evidence and does not fill historical gaps
or infer warmth. Invalid evidence and source changes do not qualify. Pill driver
1.2.5 retains an already admitted sample through MQTT/Wi-Fi loss until its original
shorter host deadline, with no new disconnect timer or renewal. An admitted serial
write can complete offline. Missing native settings allow continuation for up to
90 seconds since the last valid settings report; admission/renewal still require
settings no older than 30 seconds. Known incompatible settings and uncertain serial
writes continue to request immediate cleanup. After
reconnection, fresh non-retained same-boot/session/owner state must acknowledge
the exact sample before it is considered confirmed again. Reboot, ownership
change, completed cleanup or expiration cannot revive old permission. An
uncertain in-flight request may be resolved by its correlated ACK or by fresh
exact acknowledged state and a new unused challenge. The same reconciliation
handles a 45-second result timeout when only the Pill disconnects. Until a fresh
post-timeout report arrives, an acknowledged predecessor can remain unconfirmed
within its original expiry and protection reserve. Initial requests without
acknowledged coverage still require cleanup at timeout. Conflicting evidence,
expired coverage, explicit faults and pending clears cannot be revived by this
path. Reconnect never adds a new 120-second allowance.
Lost, unaccepted numeric renewals can be retried after 10 seconds only when fresh
same-session state still acknowledges the exact previous, unexpired sample and
provides a new unused challenge that fences the earlier envelope. The retry uses
ordinary admission checks and original source timestamps; accepted writes are
never reclassified this way. This requires no firmware or wire-format change.
Expired or invalid source evidence ends the feed; internal-sensor control uses
current native settings, HEAT at 17°C if unchanged. A saved target resumes after host restart
only with fresh independent source evidence and native setup. Serial clearing
of the override must finish before ordinary native settings or manual timed OFF
proceed. Timed OFF saves only the room intent, then clears external sensing before
admitting OFF. Normal/expiry restores native ON, and fresh measurements authorize
resuming the saved target. An internal-thermostat interval is possible during this
manual handover. Automatic target reductions do not clear external input or cycle
native power. Independent later native edits supersede saved intent. There is no
low-heat commissioning evidence. Manual timed OFF continues to require the
independently verified native baseline and installed restoration evidence. Both
managed OFF and external temperature now request expiry within 120 seconds of
the older supporting probe report, despite the driver's 180-second ceiling.
Both can tolerate transport-only probe loss for the remainder of existing
permission when reserve allows, and neither admits or renews from held evidence.
Invalid readings or protection failures still require prompt cleanup/restoration.

`capabilities.releaseOrdering` declares implemented software cancellation fencing;
there is no separate `releaseOrderingVerified` installation flag. Source and
compiled-driver tests cover delayed delivery and serial-in-flight OFF, renewed
permissions, manual ON, expiry, reboot, host restart and owner-session transfer.
A release result must fence every earlier possible OFF before native confirmation.
Manual/watchdog cancellation events include `ownerSession`, `episodeId`,
`throughSequence` and `at`; unrelated periodic ON reports never substitute for
this fence. Supervised installed qualification must additionally observe actual
UART recovery, subsequent native ON and device resource use. The separate
firmware and installation are not commissioned by the repository test suite.
