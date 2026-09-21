# Notes for the separate Shelly Pill task

ST-MQ consumes the separate `shelly-cn105-mqtt` repository's `shelly-cn105/v1`
contract. See [garage adapter setup](garage-adapter.md) for the explicit production
driver, exact private MQTT topics and commissioning gates. The default synthetic
`stmq-garage-fixture/v1` driver cannot publish real commands.

- Production state includes all four installed commissioning results:
  `selectivePowerVerified`, `lowHeatVerified`, `expiryVerified`, and
  `restartVerified`. Every result, the baseline and essential capabilities must
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

The installed Mitsubishi baseline is special low-heat/i-save context, not proof
that writing an ordinary numeric 10°C target recreates the same native mode.
The initial installation is read-only until the required installed
commissioning evidence exists. No ST-MQ setting bypasses that gate.
