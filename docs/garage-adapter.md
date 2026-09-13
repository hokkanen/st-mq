# Garage adapter boundary

No Shelly Pill implementation or published client contract was available in the
provided repositories. `stmq-garage-fixture/v1` is therefore a **provisional host
simulation vocabulary**, not a claim about firmware support. It must not be
deployed as an imagined Pill protocol. The production MQTT integration receives
observations only; it has no garage command topic, publisher, arming flag or
configuration escape hatch. Setting the garage policy to enabled cannot change
this boundary.

Explicit MQTT topics can collect deliberately normalized provisional telemetry
for read-only inspection. An actual adapter publishing a different schema is
reported as unsupported. Completing real integration requires reviewing that
adapter's published contract, adding a separate supported driver and validating
installed commissioning evidence. None of the tests described here touched a
Pill, serial port, pump or live broker.

## Connection and evidence

Private configuration accepts only these adapter fields:

```json
{
  "garage": {
    "adapter": {
      "stateTopic": "invented/garage/state",
      "telemetryTopic": "invented/garage/telemetry",
      "maxAgeMs": 120000,
      "electricalSource": "none"
    }
  }
}
```

Both topics are optional, exact and distinct. Empty topics mean no subscription.
The electrical selection is `none`, `native-counter` or `native-power`; the two
energy paths cannot both contribute. Broker connection and credentials use the
existing private MQTT settings. The normal owner baseline is read from
`garage.baselineC` and compared with native evidence; the adapter never writes a
new thermostat target.

The fixture state example is
[`test/fixtures/garage-provisional-state.json`](../test/fixtures/garage-provisional-state.json).
Every state has a device, boot, adapter session, monotonic state sequence and
source observation timestamp. Device online, driver progressing and pump
communicating are independently timestamped health fields. The state carries
native power, optional setting readbacks, a fresh verified baseline profile,
capabilities, authoritative mode, owner session, one-use challenge, lease limits,
active episode, pending restoration and optional command result. State sequence
ordering does not make old field timestamps fresh. Repeated, future, retained,
stale and unreconciled state cannot authorize a pause.

Telemetry has the same envelope and an independent sequence. Each field explicitly
declares `supported`, `decodeVerified`, `value`, `unit` and `measuredAt` (UTC epoch
milliseconds). Supported fields are `indoorTemperature`/`outdoorTemperature`
(`degC`), `power` (`W`), `energy` (`kWh`), `compressorFrequency` (`Hz`), and
`compressorActive`/`defrost` (`boolean`). Zero and negative temperatures are valid;
missing support is unknown. Omitted fields retain their original clocks until
they expire. Native temperatures remain optional diagnostic context. They never
replace either external near-pipe sensor.

For monitoring before a source has UTC, `observedAgeMs` and field `ageMs` can
replace the corresponding timestamp. Such timestamps are reconstructed as
receipt minus age and labeled `receipt-minus-source-age`. Transport delay is
unresolved. Retained relative values remain unusable, relative state cannot
authorize control, and relative electrical timestamps cannot establish recorded
electricity timing. A zero/missing timestamp is never silently replaced by now.

Public status exposes normalized values, source clocks, qualities, separate
health, accepted limits, baseline versus native readbacks, phase, restoration,
command outcomes and a hashed source epoch. It excludes device/session/challenge
identities. Source epoch changes across adapter boot and source selection so the
learning journal can avoid fitting an interval across a transition.

## Host simulation and lease executor

Tests inject `createGarageSimulationTransport(send)` into `createGarageAdapter`.
The transport is recognized by a module-private object capability, not a JSON
flag. The production acquisition path never creates or accepts this transport.
These are tests of the host consumer; the injected receiver does not implement
CN105 decoding or prove that a real device enforces a lease.

The runtime calls `plannerTick({now, valid, plan, recoveryReady, demand})` with a
stable plan/episode ID and bounded `pauseFrom`/`pauseUntil`. Only that method can
start or renew. `safetyTick` can revoke permission and request release, but cannot
renew, and there is no networking renewal timer. Commands carry current device,
boot, adapter session, host ownership, episode, monotonic command sequence,
one-use challenge and a short deadline. A renewal uses the original episode and
can never enlarge its authorized endpoint. The accepted fixture lease limits
provide maximum lease, renewal interval, minimum ON lock and restoration delay.
No second configurable heartbeat timer is introduced.

An OFF attempt persists a compact restoration obligation before publication.
Requested, published, accepted, native-confirmed, uncertain, rejected, failed and
superseded results remain distinct. Native ON needs fresh causal readback after
the OFF obligation and any later restore request; an old ON cache cannot settle
it. Useful heat response is separate thermal evidence, never inferred from ON,
publication, compressor frequency or electrical watts.

Disconnect, invalid planning/protection, missing authority, watchdog/manual ON,
reboot and expired permission invalidate economic intent. Reconnect requires new
session evidence. Restart loads the old episode only as a restoration obligation
and uses a new host session; completed episode IDs cannot be restarted. Recovery
locks from the adapter and thermal readiness from the runtime both apply to a
new pause. An urgent release does not wait for an economic minimum OFF duration.

An inactive instance cannot send OFF, renew or restoration commands. Maintenance
and unknown native OFF outside a managed episode are surfaced without fighting
the owner. Monitoring does not invoke an undocumented handover command. Failed
storage blocks new OFF; an already owned restoration can still request ON while
preserving the previously persisted obligation. Repeated unchanged release
requests are idempotent, and retries require fresh native OFF evidence rather
than repeatedly treating broker delivery as recovery.

The runtime stores adapter obligations under `garage:adapter:<input>`. It owns
the independent five-second safety check and planner lifecycle. MQTT closure
accepts `restore:false` for an instance without control authority and never
queues old OFF work.

## Electrical accounting

Electrical scale and scope must be explicit. `accuracyVerified:false` preserves
the distinction between correctly decoded units and unverified absolute meter
accuracy. Only `meterScope:"garage-heat-pump-only"` contributes to dedicated
garage timing accounting. Frequency or charging activity never becomes watts.

A selected counter requires explicit positive kWh resolution and independent
update cadence no coarser than fifteen minutes. Repeated unchanged totals do not
create fictional zero-energy minutes. Consecutive qualified updates produce one
interval; interpolation across an outage, reset, unproven rollover, changed
quality, counter epoch, adapter boot or host restart is rejected. Timing remains
qualified as counter time allocation and absolute accuracy remains visible.

A selected power source uses trapezoidal integration between consecutive fresh
source measurements, with a two-minute maximum gap. Genuine zero power produces
zero energy. The integrated estimate is not an independent meter or an accuracy
check on the counter. Intervals are produced before chart decimation and keep
their full bounds, coverage, dedicated scope, measurement basis and source
qualification. An interval persistence failure can retry the same telemetry
frame without dropping or duplicating its energy.

## Evidence and future Pill work

`node --test test/garage-adapter*.test.js test/garage-runtime-adapter.test.js`
covers simulated lease races, stale and
retained input, health separation, boot/manual recovery, authority loss,
persistence failures, causal native confirmation, relative clocks, counter
resets/gaps/quantization, source selection and read-only MQTT wiring. Runtime
integration uses a saved explicit synthetic seed to exercise endogenous starts,
renewals, sensor expiry, persistence failure, authority/close behavior and
successive pause IDs within one frozen assessment with residual front debt. These tests
do not establish installed pipe safety, baseline preservation, native-meter
accuracy or realized savings.

The future Pill task should publish its actual schema, example client and pinned
firmware/driver version, authoritative ownership/handshake and replay rules,
accepted lease bounds, persistence/startup policy, independent health evidence
and field-specific support/units/cadence. Installed evidence must establish
selective native power control, preservation of the existing low-heat profile,
local expiry and offline startup restoration. The local return-to-ON is **Pill
software**: host/network loss can be covered by a healthy adapter, but a dead or
unpowered Pill or failed serial path cannot transmit ON. The host must retain
unresolved recovery when that path fails.

No firmware mechanisms, device discovery or deployment were implemented as part
of this garage consumer task. These notes are the intended handoff to the
separate Pill project.
