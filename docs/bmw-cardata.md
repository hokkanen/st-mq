# BMW CarData vehicle feed

Home Assistant publishes BMW vehicle facts to `stmq/vehicles/bmw` as retained
JSON with QoS 1. This topic belongs to the vehicle, independently of the charging
point. The automation supplies telemetry and never operates a vehicle or charger.
TeslaMate keeps its native vehicle topics; neither source is named after Charger 1
or Charger 2.

This bridge does not currently export the vehicle's charging profile or charging
windows. BMW's [CarData catalogue](https://www.bmwgroup.com/content/dam/grpw/websites/bmwgroup_com/innovation/Innovation_Mobilitaet/CarData/3PP-CarData--Telematics_Data_Catalogue-en.pdf)
documents profile/window data, but availability depends on the vehicle and the
applicable catalogue. A selected-window flag alone gives no executable start/end
interval. ST-MQ must not infer unrestricted BMW charging from this feed or treat
predicted completion as a schedule. See [vehicle schedule limits](charging.md#schedules-inside-the-vehicle).

Under **Data & settings → MQTT**, **BMW** has the subtitle **Vehicle · BMW CarData**.
The configured identity remains visible before the first message. Broker and
subscription health, live/retained reception and topics are shown separately from
the current charger association. Invalid reports need attention; repeat messages
do not renew measurement timestamps. BMW is not an electricity-consumption source.

## Battery and identity facts

The builder is [`scripts/lib/bmw-cardata-automation.js`](../scripts/lib/bmw-cardata-automation.js).
Supply entities belonging to the same vehicle:

| Builder argument | CarData descriptor or Home Assistant entity |
| --- | --- |
| `socEntity` | `vehicle.powertrain.electric.battery.stateOfCharge.displayed` |
| `targetEntity` | `vehicle.powertrain.electric.battery.stateOfCharge.target` |
| `capacityEntity` | `vehicle.drivetrain.batteryManagement.maxEnergy` |
| `plugEntity` | `vehicle.body.chargingPort.status` |
| `chargingEntity` | `vehicle.drivetrain.electricEngine.charging.status` |
| `latitudeEntity` | `vehicle.cabin.infotainment.navigation.currentLocation.latitude` |
| `longitudeEntity` | `vehicle.cabin.infotainment.navigation.currentLocation.longitude` |
| `locationEntity` | Optional BMW `device_tracker` trigger; not a source clock |

Use measured SoC, not CarData's predicted SoC. ST-MQ already estimates progress
from recorded charging energy. Capacity comes from `maxEnergy`, not a range
estimate or charging-session counter. AC current and voltage descriptors describing
the last charging process are not treated as live charging power.

Battery fields retain their existing names: `soc`, `chargeLimitSoc` and
`usableCapacityKwh`. Identity adds `pluggedIn`, `charging` and `atHome`, each a
boolean or explicit `null` when unknown. Every identity fact has its own
`fields[name].measuredAt` and `fields[name].readingId`. Target and capacity also
retain independent clocks. The top-level provider is `bmw-cardata`.

The original BMW `timestamp` attribute supplies the clock, never automation time.
Identity can be published and accepted even when SoC is unavailable. Unknown
identity facts clear previous facts; they do not become false or silently preserve
an earlier true. Sparse battery fields retain the last accepted measurement and
its age. Malformed, future or older observations cannot manufacture fresh evidence.

## Home location

CarData's location tracker can restore coordinates without exposing their BMW
timestamps. Enable the underlying latitude/longitude sensors and use their
`timestamp` attributes. Both must be valid and their clocks at most 60 seconds
apart. `atHome` uses the older coordinate clock. A restored tracker or unavailable
coordinate sensor alone produces unknown location.

The builder accepts private `homeLatitude`, `homeLongitude` and
`homeRadiusMeters` arguments. With no explicit home point it uses Home Assistant's
`zone.home` configuration. Check that the chosen point actually describes the
charging property; weather coordinates and a default Home Assistant zone may be
different. A home-zone correction can revise the live `atHome` fact while keeping
the original GPS measurement time. Replayed retained values cannot reverse that
revision, and it does not create a plug or charging event. Only `atHome` and its
clock go to MQTT, never coordinates or private zone/device identifiers.

## Association with Charger 1

Charger 1 stays generic and uses editable manual battery values until BMW or Tesla
is positively associated with its current plug-in session. Receiving BMW battery
data does not establish that association. The Tesla diagnostic's negative result
means only that Tesla charges elsewhere.

The usual BMW match combines timestamped home context with a live plug event and a
charging start followed by a stop near the current Easee connection. Both charging
transitions must correspond to charging and stopping observed at Easee. Source
events and live MQTT delivery may precede the first connected Easee poll by up to
90 seconds, but must follow the last source-reported disconnect. Repeated polls
of that disconnected state preserve its source time; a missing source clock uses
the receipt time conservatively. This permits ordinary polling delay without
reusing evidence from an earlier connection. A BMW starting
to charge elsewhere at home is insufficient on its own. Without the
matching stop, Charger 1 continues to use manual battery values. Matching live
start evidence with valid home and plug context can show **BMW identification pending**
while awaiting stop confirmation, even if the plug report is unchanged, for at
most ten minutes from the observed charging start. Missing or
conflicting evidence then leaves it **Vehicle unidentified**.
Initial unrestricted charging can be observed for up to three minutes from the
connection when a BMW or Tesla at-home candidate is available. Both cloud and OCPP
use this same bounded window; manual priority and native restrictions are preserved.
Identification does not command an additional stop; it observes a pause or stop
that occurs as part of ordinary charging control.

BMW can also keep reporting `CONNECTED` without a new vehicle plug transition.
An alternative match uses home and plugged-in context no older than 24 hours,
plus a planned pause already controlled by ST-MQ. Live BMW charging-start
and stop events no older than fifteen minutes must each match Easee within
30 seconds. Both starts must precede
the pause boundary; both stops must follow it. The boundary is a durable request
witness saved after a guarded charging observation immediately before requesting
the normal economic pause. Missing request evidence cannot be replaced by a later
acknowledgement. The owned restriction must be confirmed for the same current
connection and expire in the future.

The charger boundary supplies one common pause proof to the BMW matcher. Cloud
control verifies its exact delayed schedule and scheduling-stop reason (54), with
the reason and physical stop clocks agreeing. OCPP verifies its current transaction,
owned zero-current profile, `SuspendedEVSE` status and fresh zero power. Its guarded
charging witness is distinct from the general install-intent time. A status change
observed while queued prevents dispatch from reusing the earlier charging witness.
Identity timing, pending
status, event consumption and conflict handling are shared between both modes.
Manual priority or conflicting Tesla evidence prevents this match. This path
adds no charger commands or identification probe, and its charging-start event
cannot be reused for another connection.

No BMW charging-power field or plug-event identifier is required. Cached/retained
true values, or unchanged true values republished with newer timestamps, cannot
create new plug events. Conflicting vehicle evidence keeps manual inputs active.

A fresh live unplug event from an already identified BMW also ends that charger
connection when the unplug/replug gap falls between Easee polls. This boundary is
saved separately from the raw Easee readings and survives restart. It resets the
old planning episode and clears only the exact old schedule still owned by ST-MQ;
manual restrictions retain priority. A fresh Easee connection event or subsequent
live BMW plug event allows a new observation window, and the new connection still
needs matching charging-start and stop evidence before vehicle readings apply.

A confirmed match is scoped to the charger connection, survives scheduled pauses
and restart, and clears on unplug. Startup preserves the saved match, session edits
and target choice while the charger adapter initializes. Until its session and
readback are available, the vehicle remains unidentified in the live view and
session edits are unavailable. The same connection restores the match without
reusing a plug event; a different connection or confirmed departure clears it.
Both plug and charging-start events are consumed on either successful match, so
changing evidence paths cannot identify the next car using an earlier episode. Available
automatic battery fields take precedence individually without
overwriting saved generic defaults. Missing fields remain editable. Tesla on
Easee appears in Charger 1, while Charger 2 indicates that association instead of
displaying a duplicate session.

## Conflicting charge targets

BMW can alternate its selected target with 100%. ST-MQ confirms a conflict only
when three live, ordered target changes form **X → 100% → X** within fifteen
minutes of source time during one charger connection. X must be below 100%.
A single change to 100% remains valid. Retained messages, duplicates, old readings
and repeated polling of the same value cannot establish a conflict.

After confirmation, planning holds the latest reported target below 100% for that
connection. A new lower-than-100% setting replaces the held value immediately;
it need not be lower than the previous setting. The card shows the selected
planning target and the unmodified raw BMW report, with their separate original
measurement times. Filtering changes neither battery percentage nor the target
configured in the car.

**Plan for 100% this connection** explicitly overrides the filter for planning;
set the desired full-charge limit in the car as well. **Use automatic target**
returns to the filtered BMW value. The conflict and explicit choice survive a
restart in the same connection and clear on unplug or a new connection. A stale
browser cannot apply a choice to a different connection. Saved visitor defaults
are unaffected. A newly installed filter starts collecting evidence from live
readings; it does not infer a past conflict from a lone saved target.

## Installing or updating the publisher

Build the automation with privately discovered entity IDs and the verified home
reference. Validate the generated template through Home Assistant's template API,
save the automation, read it back, and verify live and retained MQTT publication.
The automation uses standard [`mqtt.publish`](https://www.home-assistant.io/integrations/mqtt/#examples)
and [automation triggers](https://www.home-assistant.io/docs/automation/trigger/).
It reacts to entity changes, Home Assistant startup, MQTT birth and a five-minute
recovery interval. Periodic publication preserves all original field clocks.

The application source configuration is `charging.vehicles.bmw.mqttTopic`, with
`stmq/vehicles/bmw` as its default. When moving from the old
`stmq/garage/charger1/vehicle` topic, switch both publisher and subscriber, verify
the new route, then clear the retired retained message. Do not duplicate BMW
publications under charger-specific topics.

Private mappings, automation readbacks and deployment evidence belong outside Git
under `~/.config/st-mq/bmw-cardata/` (directory `0700`, files `0600`). Credentials
are read from the owner-provided token file, never placed in generated automation
payloads or repository files.
