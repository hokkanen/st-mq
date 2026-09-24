# A06 equipment and A10 publication ownership remediation

This is the equipment/transport portion of the package. Paired-runtime authority
transitions and other A10 findings are covered in the [pairing ledger](A08-A10-A11.md). Implementation and
tests used current-format synthetic equipment, temporary SQLite and loopback
servers; no appliance, private broker or household configuration was used.

## Findings

| Finding | Disposition |
| --- | --- |
| A06-001, lost restoration wake-up | `src/app/equipment-tests.js` rearms when its one-shot callback finds a wall-clock deadline still in the future. The actual callback test applies successive backward adjustments and proves restoration without a manual `tick()`. Existing duration, pending-operation, authority, retry and current restart coverage remains. The current persisted wall-clock policy is retained; this is not a hardware maximum lifetime. |
| A06-002, delayed old poll clears restoration | Native requests retain their sequence and request-start boundary. A device write establishes an ordering fence, and a later accepted status/notification advances the observed boundary. An earlier poll cannot supersede the newer command/readback. The combined real capture/test-manager regression holds a pre-command OFF result, confirms ON, releases the old reply, then requires a new OFF command plus its correlated readback before clearing the saved obligation. |
| A06-003, switch command replay | Both generic and native Gen1/Gen2 switch write call sites opt into `noReplay`. In addition, the shared transport now fences every publication through MQTT.js's asynchronous outgoing-store and final stream-write boundaries. Timeout/disconnect cancels pending publication state and store entries. Fresh intent or explicit current restoration is required after a lost connection. Publication success remains separate from native readback. |
| A06-004, read-only query actuates another route | `equipment-config.js` checks all enabled ordinary switch, cover and dehumidifier command owners against state/mapping/query/availability/heartbeat topics. Read-only queries cannot write another reading/availability route. Native prefixes reserve their RPC and Gen1 command endpoints too. Collisions reject during configuration before capture construction. Deliberate shared availability and disabled cross-device entries remain supported. |
| A06-005, weak generic confirmation | Main readings carry ingestion revisions. A waiter requires a new accepted main report after dispatch, current subscriptions and all declared availability, heartbeat and required readings. An auxiliary-only update cannot confirm a cached main value. Equal-source-time contradictions are rejected; identical cached reports preserve their revision/source age. Invalid reports still terminate availability. New receipt-based packets in the same millisecond can qualify by revision. Restoration may still be attempted from unknown state. |
| A06-006, missing source/wrong component | Modern native replies require request destination/ID, discovered device source and selected component ID. Whole-status component keys and embedded IDs must agree; malformed identity/component evidence cannot mutate a good value or confirm a command. Existing synthetic replies were corrected to include actual protocol fields and identity exchange. Gen1 scalar external protocol remains supported. |
| A06-007, cross-meter increments | `equipmentMeterIdentity` hashes broker/account route, native identity where available, generation, component and counter path/topic/unit/scale/offset. Native accumulators wait for identity before coupling a baseline. A changed current identity discards only the previous counter baseline; committed history and valid current daily totals remain, with partial coverage. Current hourly pending energy is preserved. Caravan checkpoint version 3 and hourly checkpoint version 1 reject incompatible/malformed shapes; no old checkpoint conversion. Same-meter restart, changed broker/native ID/component/calibration, counter resets and transaction retry are covered. |
| A06-008, partial updates erase fields | Native partial updates check field/path presence inside the component. Omitted fields preserve their value and original clock; nested path omission works the same way. Explicit null/errors and full-snapshot omissions invalidate fields. Field expiry remains independent. Tests preserve both mapped power and a nested energy field across an output-only patch, then check invalidation/expiry. |
| A10-001, queued writes survive authority loss | `src/control/mqtt-publication-gate.js` binds each MQTT publication to authority and a connection generation. It checks at public entry, `_sendPacket`, and `_writePacket`, including the actual stream write after synchronous `packetsend` listeners. It rejects publication while MQTT.js processes reconnect queues, removes cancelled QoS 1 state and rejects late store callbacks. `startMqtt().revoke()` is synchronous; the lead runtime invokes it before awaited shutdown on authority loss. The short-lived DHWR transport uses the same gate. Same-owner graceful restoration remains authorized before revocation. Already-delivered packets cannot be retracted. |

Equipment delivery now commits atomically across SQLite, Engine held observations,
per-device readings/availability, RPC request identity, meter baselines and the
bounded duplicate cache. A failed commit restores them all, allowing the identical
MQTT retransmission to retry. Readback/check completion and follow-up requests run
after commit, so a transaction failure cannot acknowledge a physical command.
Four fault-injection regressions cover held temperature clocks, generic and native
command confirmation, and a native meter delta whose inner operation succeeded
before the enclosing transaction failed.

The publication fence uses internal boundaries of the installed, pinned MQTT.js
client because a public `publish()` check or `queueQoSZero:false` alone cannot
govern asynchronous QoS 1 storage/replay. The installed-client tests deliberately
exercise these boundaries and must accompany an MQTT.js dependency update.

## B12-012 current contract

The lead removed old public/private configuration aliases, the obsolete
`shelly-config.js` normalizer, duplicated Engine/server status fields and chart
inventory merging. This work removes the corresponding standalone acquisition
branches: `startMqtt` consumes only `connections.equipment`, exposes
`acquisition.equipment`, and attaches `engine.equipment`. Standalone
`temperatureTopics` and role-based Shelly capture are gone. The native parser
consumes current normalized equipment fields instead of inferring old roles.

Tests now use `equipmentConfiguration` for native, generic and room routes.
Previous native fixtures perform identity discovery and carry component IDs.
The old legacy-topic reconnect matrix was replaced by the one current signed
equipment route. The modern route still preserves original measurement and
receipt times, subscription admission, restart recovery and source ownership.
Only the two permitted v0.7.5 CSV imports retain historical compatibility.

## Retained design and external evidence

Host-managed temporary tests retain their persisted original output/route and
uncertain restoration. Loss of controller, broker, device, power or clock
stability can extend physical output duration. No new promise of device-local
failsafe timing is made.

Cover and dehumidifier controls retain separate publication and observed-state
stages. Full dehumidifier snapshots deliberately replace missing settings;
native partial component notifications deliberately do not. Caravan running
state means reported power/fan state, not measured moisture removal. Autonomous
humidity/price optimization remains unimplemented and is not presented as a
completed feature.

Appliance OFF and supply-plug OFF remain separate owner actions. Actual bridge
vocabulary, supported settings, physical readback timing, relay wiring and safe
appliance shutdown still require owner commissioning. The source changes do not
operate or certify absent equipment. The paired system's external fencing and
split-brain assumptions remain the lead A10 scope.

## Validation and paths

Changed implementation paths: `src/app/equipment-tests.js`,
`src/acquisition/{equipment,equipment-config,mqtt,mqtt-admission,mqtt-reception,shelly,shelly-energy}.js`,
`src/control/{mqtt,mqtt-publication-gate}.js`. Shared MQTT changes preserve A01's
vehicle/physical-EVSE acquisition and A04's Garage permission transport.

New focused tests are `test/audit-equipment.test.js` and
`test/mqtt-publication-gate.test.js`. Existing equipment, native Shelly, Garage
door/native MQTT, availability/reconnect and source-cache fixtures were updated
to the current contract. Supporting documentation is in
`docs/{mqtt-equipment,shelly-mqtt,recording,smartthings-temperature-rule}.md`.

Node **24.21.0**, installed dependencies, real SQLite:

```sh
node --test test/acquisition-source-contract.test.js test/audit-equipment.test.js \
  test/provider-coordinator.test.js test/equipment*.test.js \
  test/shelly*.test.js test/caravan*.test.js test/mqtt-*.test.js \
  test/garage-adapter-mqtt.test.js test/garage-event-doors.test.js \
  test/app-observation-quality.test.js test/app-outdoor-priority.test.js
```

This final expanded selection passed **354/354 tests** after durable reception
rollback and current provider-cache cleanup. The publication gate's four installed-
MQTT.js tests use a real client/parser and synthetic duplex broker streams, with
held PUBACKs and deliberately delayed outgoing-store callbacks. They verify
generic, Gen1 and Gen2 topics; unsent and sent/unacknowledged cancellation;
disconnect/reconnect; timeout; authority rejection before publication; revocation
inside `packetsend` before byte output; and successful fresh same-owner intent.
The four publication-gate tests also pass independently on minimum Node
**22.19.0** and Node **24.21.0**. Their timeout case advances the test clock across
the actual gate deadline, checking retention immediately before expiry and
store cancellation before the delayed callback resumes. This avoids depending
on a live socket to keep the production unreferenced deadline timer running;
the synthetic duplex stream has no such operating-system handle.
An isolated Mosquitto receive/DUP integration also passed under A05. These are
software transport proofs, not installed broker/device commissioning results.
The lead records final repository-wide build/browser/pairing validation.
