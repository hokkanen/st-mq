# Direct Shelly MQTT

See [MQTT equipment](mqtt-equipment.md) for the explicit `shelly:<topic prefix>` /
`mqtt:<state topic>` configuration, device setup instructions, Home and Garage
monitoring, connection checks, timed switch tests and hourly energy recording.

Device connections and topics now have public defaults in `config.json`; broker
credentials remain in the private configuration. ST-MQ does not automatically
recognise or switch between the two connection formats.

Heating verification uses the configured tariff relay's output. For Gen2 and
later, a matching post-command `Switch.GetStatus` RPC response verifies
`Switch.Set`; the `was_on` command response does not. Live status keeps the
dashboard current, and stale/offline readings or a mismatching output need
attention. The API actions are `normal` and `reduction`; no legacy button topic
is used. See [Shelly Switch documentation](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/).

RPC replies must match the discovered device source, request destination/ID and
selected component ID. A whole-device snapshot's component key and embedded ID
must agree. A late poll that began before a newer command/readback cannot replace
that evidence. Poll observations retain their request-start boundary separately
from receipt time; receipt alone cannot establish a later physical restoration.
Reconnect clears request/identity correlation and requires a new identity check.

Incremental notifications update only fields they actually contain. An omitted
field retains its original timestamp and expires independently; explicit null,
component errors and fields missing from a full snapshot invalidate that field.

A malformed or future notification `ts` cannot establish a new measurement or
refresh device availability. Rejecting that clock preserves previously accepted
readings with their original timestamps and expiry; even a small source-clock
lead does not mean both probes failed. Explicit invalid values and component
errors still invalidate the affected readings, recorded as availability
transitions without a trusted source time. A notification with no `ts` retains
the native protocol's receipt-time behavior; an explicitly null clock does not.

H66 register 0233 configures the reduction offset for EVU external control. It
does not report whether that input is active; equality with the ROOM setting or
measured room temperature cannot verify tariff operation. See the
[Husdata C60 register profile](https://online.husdata.se/h-docs/C60.pdf).
