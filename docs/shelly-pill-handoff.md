# Notes for the separate Shelly Pill task

ST-MQ consumes the separate `shelly-cn105-mqtt` repository's `shelly-cn105/v1`
contract. See [garage adapter setup](garage-adapter.md) for the explicit production
driver, exact private MQTT topics and commissioning gates. The default synthetic
`stmq-garage-fixture/v1` driver cannot publish real commands.

- Production state includes all five installed commissioning results:
  `selectivePowerVerified`, `lowHeatVerified`, `expiryVerified`, and
  `restartVerified`, plus `releaseOrderingVerified`. Every result, the baseline and essential capabilities must
  be verified before ST-MQ claims an armed adapter or requests OFF. The adapter
  independently enforces its commissioned mode. Monitoring never claims it.
- The consumer needs native baseline-preserving availability/OFF/release,
  finite episode and lease endpoints, separate host/device sessions, replay-safe
  freshness challenges, sequencing and rejection/acceptance/native-confirmation
  evidence. Reboot or manual ON must invalidate previous OFF intent. A root host
  thermal episode can contain multiple separately identified native pauses.
- Provide actual accepted renewal, expiry, native minimum ON and worst-case
  useful-heating restoration-delay bounds. ST-MQ tracks independent front/rear
  thermal reserves and renews only from its one-minute planner tick. The consumer
  now requests no more than three minutes of permission from the older supporting
  temperature report, with a shorter deadline when reserve requires it. The
  protocol must accept earlier deadlines and expose accepted expiry. A request
  awaiting acknowledgement may already be active and counts as outstanding
  permission. Document real timing rather than treating these fixture tests as
  evidence of installed firmware behaviour.
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

ST-MQ also supports the Pill's external temperature control for persistent
room settings down to 5°C. The pump must already be ON in HEAT mode. ST-MQ explicitly
commands and confirms the native 17°C target, then feeds the independent Garage rear
temperature plus `17 − requested room setting`:
a 5°C setting adds 12°C. This uses neither Mitsubishi i-save nor an owner
assumption about mode persistence.

The driver must advertise the capability and enable its local feature flag.
Remote values are 8–39.5°C in 0.5°C steps, based on original usable reports less
than 90 seconds old. Each external enable or renewal requires ON, HEAT and 17°C
readbacks under the existing 30-second freshness requirement. A failed native
check stops host renewals and lets the existing lease expire, with no additional
host checks or native writes between renewals. This guard requires no Pill driver
changes or new lease limits; existing local cleanup behavior remains intact.
Lost, unaccepted numeric renewals can be retried after 10 seconds only when fresh
same-session state still acknowledges the exact previous, unexpired sample and
provides a new unused challenge that fences the earlier envelope. The retry uses
ordinary admission checks and original source timestamps; accepted writes are
never reclassified this way. This requires no firmware or wire-format change.
Missing or stale source evidence ends the feed; internal-sensor control uses
current native settings, HEAT at 17°C if unchanged. A saved target resumes after host restart
only with fresh independent source evidence and native setup. Serial clearing
of the override must finish before ordinary native settings or a managed pause
proceed. This host support does not establish physical frost protection or new
low-heat commissioning evidence. Economic pauses continue to require the
independently verified native baseline and installed restoration evidence.

The release-ordering commissioning result is an additional host requirement from
A04. It must cover delayed delivery and serial-in-flight OFF, renewed permissions,
manual ON, expiry, reboot, host restart and owner-session transfer. A release result
must fence every earlier possible OFF before native confirmation. Manual/watchdog
cancellation events include `ownerSession`, `episodeId`, `throughSequence` and
`at`; unrelated periodic ON reports never substitute for this fence. The separate
firmware and installation are not commissioned by the repository test suite.
