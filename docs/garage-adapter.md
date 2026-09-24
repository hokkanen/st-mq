# Garage adapter boundary

ST-MQ supports the separate `shelly-cn105-mqtt` adapter's `shelly-cn105/v1`
contract. The driver runs on stock Shelly Pill firmware and reports native CN105
observations. Select it explicitly with `garage.adapter.driver: "shelly-cn105"`.
The default `fixture` driver remains an isolated, read-only consumer of the
`stmq-garage-fixture/v1` host simulation vocabulary.

Automatic pause control requires fresh device evidence: armed mode, matching native
profile, essential capabilities and installed selective-power, local-expiry and
restart-restoration and release-ordering results. Low-heat and baseline verification remain required.
Permanent external temperature control is a separate ordinary control feature;
it does not replace commissioning evidence or authorize economic pauses.

## Connection and evidence

Private configuration selects exact topics and a driver:

```json
{
  "garage": {
    "adapter": {
      "driver": "shelly-cn105",
      "stateTopic": "invented/garage/state",
      "telemetryTopic": "invented/garage/telemetry",
      "commandTopic": "invented/garage/command",
      "maxAgeMs": 120000,
      "electricalSource": "none"
    }
  }
}
```

All topics are exact and distinct. Empty observation topics mean no subscription.
Omit `commandTopic` for a telemetry-only connection. A command topic requires the
production driver and a state topic; it does not arm the device. The default
`driver: "fixture"` rejects command topics.
The electrical selection is `none`, `native-counter` or `native-power`; the two
energy paths cannot both contribute. Broker connection and credentials use the
existing private MQTT settings. The normal owner baseline is read from
`garage.baselineC` and compared with native evidence; automatic price control
never writes a new thermostat target. Explicit ordinary setting changes use the
separate manual interface below.

The fixture-only example is
[`test/fixtures/garage-provisional-state.json`](../test/fixtures/garage-provisional-state.json).
Both schemas use a device, boot, adapter session, monotonic state sequence and
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
`compressorActive`/`defrost` (`boolean`). Optional diagnostic fields include
`actualFan` (`stage`), `preheat`/`standby` (`boolean`), `faultRaw` (hexadecimal,
null unit) and `energyCounterRaw` (`count`). The raw counter never becomes kWh.
Zero and negative temperatures are valid;
missing support is unknown. Omitted fields retain their original clocks until
they expire. Native temperatures remain optional diagnostic context. They never
replace either external near-pipe sensor. Public production status omits fields
that are unsupported, null or explicitly unknown/invalid. Observed values retain
their last source clock and become stale when communication stops; missing
measurements do not create permanent unavailable reading rows.

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
flag. The production acquisition path never creates or accepts this transport. Its
separate `createShellyCn105Transport` sends `claim`, `start`, `renew`,
`release`, explicit `manual` settings and external temperature commands to the configured exact command topic with QoS 0, retain false and
reconnect queuing disabled. Receipt and native confirmation come from device
state, independently of MQTT publication success.

A fresh, fully commissioned and unowned armed adapter receives a `claim` using
its current one-use challenge and a new host session. ST-MQ waits for ownership
readback and a new challenge before OFF. It never automatically takes authority
from a foreign owner, leases while disconnected, or claims in monitoring mode.
A restarted host waits for the device's owner expiry/reconciliation; an old OFF
lease is only an unresolved restoration obligation. The device enforces these
same rules independently.
These are tests of the host consumer; the injected receiver does not implement
CN105 decoding or prove that a real device enforces a lease.

The runtime calls `plannerTick({now, valid, plan, recoveryReady, demand})` with a
stable plan/episode ID, finite `pauseFrom`/`pauseUntil`, and an independently
bounded short permission deadline. There is no fixed maximum for the total
continuous episode: ST-MQ chooses its endpoint from temperatures, pipe reserve,
uncertainty, economics and available forecast coverage. The Pill retains only
the compact active episode and current permission, so a longer pause does not
accumulate device-side samples or commands. Only that method can
start or renew. `safetyTick` can revoke permission and request release, but cannot
renew, and there is no networking renewal timer. Commands carry current device,
boot, adapter session, host ownership, episode, monotonic command sequence,
one-use challenge and a short deadline. A renewal uses the original episode and
can never enlarge its authorized endpoint. The accepted fixture lease limits
provide maximum lease, renewal interval, minimum ON lock and restoration delay.
The host additionally caps permission at three minutes from the older supporting
rear/front temperature report, with earlier expiry when the thermal reserve
requires it. A stale report cannot gain a later deadline from repeated planning.
Revalidation runs each minute; no network-owned renewal loop is introduced.
The published adapter renewal interval must support that cadence. A device that
requires more than one minute between renewals cannot authorize a pause under
this policy; the host does not silently override its advertised limits. The
synthetic fixture advertises a one-minute renewal interval and three-minute cap.

The projected heat reserve must cover permission expiry plus the qualified delay
until heating becomes useful near the references. Existing accepted permission
and a pending request that might have been accepted both count. A shorter local
host deadline is not proof that the device shortened its lease. The runtime no
longer unconditionally reserves the advertised maximum lease plus another fixed
delay; it uses the outstanding or proposed permission and the restoration bound.
Temperature expiry at two minutes and maximum permission at three minutes are
overlapping deadlines measured from evidence, not sequential grace periods.

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

## Ordinary Mitsubishi controls

`POST /api/garage/native` accepts exactly `{ "setting": "fan", "value": "auto" }`.
The available settings are native power (`on`/`off`), mode (`heat`, `cool`, `auto`,
`dry`, `fan`), native target temperature (16–31 °C with the advertised 1 or 0.5 °C step),
fan (`auto`, `quiet`, numbers 1–4), vertical vane (`auto`, numbers 1–5, `swing`)
and horizontal vane (`far-left`, `left`, `center`, `right`, `far-right`, `split`,
`swing`). A setting is enabled only when the driver advertises its capability and
provides a fresh exact readback. Optional `capabilities.manualOptions` restricts
individual enum settings to the connected model's supported typed choices. A
missing entry keeps the generic choices; a malformed, duplicate, empty or
out-of-contract array disables that setting. Both the UI and command admission
use this restricted set. An unknown horizontal vane is unavailable.
**Room setting** extends the target selector down to 5°C when the driver's
external temperature capability and local feature flag are enabled. This is an
ST-MQ room target; ST-MQ selects a native Mitsubishi thermostat target of 17°C. The special
Mitsubishi i-save mode is not used or inferred.

`garage.nativeControls` reports overall availability, reason, busy/pending flags,
per-setting typed choices/ranges and readbacks, and the separate last native
result. Ordinary controls require primary ownership, the live production route,
fresh state and device/driver/pump health, `authority.manualControlAllowed`, an
unused current challenge, and no foreign owner or pending command. They are
available independently of economic enablement, active/shadow mode and automatic
commissioning proof. Device maintenance and commissioning modes block them.

Each request publishes one `action:"manual"` command with a single-key `settings`
object and current device/boot/session/host identities, increasing sequence and
a short deadline. The device atomically takes manual ownership when unowned;
there is no automatic lease claim beforehand. An existing economic pause must
finish restoration before a setting can change. Pending manual work blocks new
automatic pauses, and manual changes disqualify overlapping savings assessments.

Publication, acceptance and native confirmation remain separate. Confirmation
requires the matching command result and a later fresh readback of that exact
setting, value and adapter session. A missing result becomes uncertain after
45 seconds; disconnect or restart never replays the request. The compact native
request/result is persisted separately from economic lease obligations. Ordinary
power OFF is the owner's selection and creates no automatic restoration lease.

## Permanent external room temperature

A room setting below 16°C uses only the independent Garage rear sensor,
`garage_temperature`. The pump must already be ON in HEAT mode; ST-MQ explicitly
commands and confirms the native 17°C target before feeding `rear temperature + (17 − room setting)`.
For a 5°C setting the offset is +12°C. The requested room target, original source
reading, offset, remote value and actual native readback remain distinct status
values. Both driver capability and the Pill's local feature flag are required.

Before each external-temperature enable or renewal, ST-MQ requires fresh native
ON, HEAT and 17°C readbacks using the existing 30-second freshness requirement.
The 17°C target distinguishes this control baseline from the installed pump's
ambiguous 10°C i-save / 16°C readback. If the check fails, ST-MQ stops renewing;
it does not rewrite native settings or add checks between renewals, and the
existing external-temperature lease expires. The Pill driver is unchanged,
including its existing local cleanup behavior. Ordinary targets of 16°C and above
still use native control.

The remote temperature protocol accepts 8–39.5°C in 0.5°C steps. Host renewals
use the original source timestamp and require a usable independent report less
than 90 seconds old. Retained, future or stale evidence cannot authorize the
feed, and repeated timestamps do not extend source freshness. Loss of fresh
evidence ends the feed. Internal-sensor control uses the pump's current native
settings; when unchanged from setup, that is HEAT at 17°C. This relies on the
driver enforcing its local expiry and on a working Pill and serial path. The
90-second source lifetime is unchanged; no additional lease timer is introduced.

The room target is durable intent. Restart does not replay a cached remote
temperature: the host must obtain fresh source evidence and reestablish native
setup before resuming. Native changes and managed pauses wait for serial clearing
of the external override; MQTT publication alone does not prove it cleared.
External control does not establish physical frost protection, low-heat
commissioning or a new economic-pause baseline. Installed qualification remains
the responsibility of the separate adapter and installation work.

Before low-temperature use, enable the Pill's external-temperature feature and
put the pump ON in HEAT mode. Selecting the low room setting in ST-MQ clears
external input, explicitly commands 17°C and waits for confirmation before
feeding the sensor offset. The setup and renewal checks address the known
i-save readback ambiguity; the command and serial acknowledgement still require
thermal qualification on the installed pump and do not prove regulation at the
requested room temperature.

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

## Evidence and installed commissioning

`node --test test/garage-adapter*.test.js test/garage-pill.test.js test/garage-runtime-adapter.test.js`
covers simulated lease races, stale and
retained input, health separation, boot/manual recovery, authority loss,
persistence failures, causal native confirmation, relative clocks, counter
resets/gaps/quantization, source selection and read-only MQTT wiring. Runtime
integration uses a saved explicit synthetic seed to exercise endogenous starts,
renewals, sensor expiry, persistence failure, authority/close behavior and
rejection of another pause until the original event and its recovery are resolved. These tests
do not establish installed pipe safety, baseline preservation, native-meter
accuracy or realized savings.

The separate adapter repository owns firmware/API qualification, CN105 decoding,
on-device persistence, deployment and installed evidence. ST-MQ's tests cover
its contract consumer, commissioning gates, MQTT handshake and bounded commands;
they do not establish the real pump's low-heat preservation or expiry/restart
recovery. Inspect that repository's commissioning report for actual device tests.

The local return-to-ON is **Pill software**: host/network loss can be covered by a
healthy adapter, but a dead or unpowered Pill or failed serial path cannot transmit
ON. The host retains unresolved recovery when that path fails. Native ON remains
separate from evidence of useful heat near the two external reference probes.

## Restoration evidence and explicit Normal heating

A fresh ON observation establishes current power, but does not prove that a
previous OFF command was cancelled. ST-MQ retains its maximum possible OFF expiry
through disconnect and host restart until fresh native ON, no active lease and no
pending device restoration are accompanied by one of:

- A correlated release `native-confirmed` result from the same boot/session, after
  all possibly effective OFF commands in that episode.
- Native ON measured after the maximum outstanding permission expiry.
- A new device boot that invalidates commands addressed to the old boot.
- A `manual-on` or `watchdog-recovery` event carrying matching `ownerSession`,
  `episodeId`, `throughSequence` covering all host commands, and `at` no later than
  the confirming native measurement.

Production automatic OFF additionally requires commissioning
`releaseOrderingVerified: true`. This asserts that release/cancellation fences
queued and serial-in-flight OFF writes before reporting completion; late stale
commands must be rejected. Firmware bench qualification is required before setting
this result. Host fixtures prove host behavior, not actual serial ordering.

Explicit **Normal heating** uses ordinary native power ON when the pump is
unmanaged OFF, requiring its advertised manual capability and fresh readback.
An external room-temperature override clears before ON. Missing capability rejects
the request before saving a false success. Background release remains scoped to
an existing managed pause and respects owner-selected native OFF.
