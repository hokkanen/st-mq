# Notes for the separate Shelly Pill task

The separate Pill task has not been implemented or deployed here. No serial
packets, firmware, supervisor, device configuration or live pump tests were added.
These are integration findings to carry into its own repository later.

- ST-MQ's consumer currently uses the deliberately synthetic
  `stmq-garage-fixture/v1` contract in `src/garage/contract.js` and
  `test/fixtures/garage-provisional-state.json`. This is a requirements/test
  vocabulary, **not** a protocol to adopt blindly. Its actual published replacement
  must be reviewed against implementation, schema, client and installed evidence.
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
Current ST-MQ production wiring is read-only until the real driver and required
commissioning evidence exist. No ST-MQ setting bypasses that gate.
