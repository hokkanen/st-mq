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
predicted completion as a schedule. See [vehicle schedule limits](../planning.md#schedules-inside-the-vehicle).

Under **Data & settings → MQTT**, **BMW** has the subtitle **Vehicle · BMW CarData**.
The configured identity remains visible before the first message. Broker and
subscription health, live/retained reception and topics are shown separately from
the current charger association. Invalid reports need attention; repeat messages
do not renew measurement timestamps. BMW is not an electricity-consumption source.

**Data & settings → Connections & configuration → Charging → BMW** explains
the setup and shows each received field with its original source time. Publisher
health and current physical charger association are separate. The setup view
shows unavailable fields explicitly; it does not create a vehicle association or
send a charger command. **Guided BMW test** opens the common test guide, where the
physical charger and immediate/delayed vehicle-schedule program are chosen.

## Enabling the useful feeds

Use the descriptors in the table below when selecting vehicle data for the
CarData integration. Check that the integration has access to those descriptors
for the same vehicle, then enable their corresponding Home Assistant sensors.
Names shown in Home Assistant can differ from the technical descriptors. BMW's
[customer API documentation](https://bmw-cardata.bmwgroup.com/customer/public/api-documentation)
describes configured data containers and the applicable telematics catalogue;
availability is vehicle-dependent, so an absent sensor is not evidence of zero
charge or an unplugged vehicle.

The capabilities are independent:

- Measured battery percentage enables the automatic starting-charge input.
- Reported charge limit enables the automatic target and vehicle ceiling.
- Usable capacity is optional vehicle evidence; the configured capacity remains
  an explicit assumption when that reading is unavailable.
- Plug state, charging state and timestamped latitude/longitude provide the
  context and transitions needed for BMW identification. Battery percentage is
  not required to recognize the vehicle. Location alone does not identify which
  physical charger it is using.

Map the enabled sensors into the publisher builder below. The current builder
takes all three battery entity mappings; an unavailable battery sensor is omitted
from its MQTT report instead of being invented. Its optional identity arguments
must be supplied to publish the plug/charging/home evidence for identification.
The `device_tracker` is only an optional trigger; enable the separate coordinate
sensors even when a tracker already appears to locate the car at home.

Confirm the home-zone mapping before a physical test. The setup panel shows
neither the configured home point nor VIN, account, entity or source identifiers.
Original BMW measurement times remain visible even while the publisher continues
to report unchanged values. Vehicle charge windows are not forwarded by this
bridge; disable them for the immediate-charging program, or configure the
specific native timer requested by the delayed-start guide.

## Battery and identity facts

The builder is [`scripts/lib/bmw-cardata-automation.js`](../../../scripts/lib/bmw-cardata-automation.js).
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
identity facts clear current facts; they do not become false or turn an earlier
true into a current reading. Sparse battery fields retain the last accepted measurement and
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

The controller tolerates temporary GPS gaps, including coordinate updates that
arrive independently. When the current `atHome` fact is explicitly unknown, its
latest valid home observation supplies identification context indefinitely,
including across restart and unplug/replug. The current fact stays unknown;
the charger details show that distinction and the original home-observation time.
Repeated publications and restart do not renew the source timestamp. Live reports
whose source clocks lead receipt by at most one second wait under the shared
[time-evidence policy](../../time-evidence.md), preserving their original clocks
and arrival order. They cannot replace current telemetry, consume a target-change
watermark or identify a connection before admission. Excessive leads are rejected;
pending reports cannot cross an MQTT disconnect. This needs no
publisher change and does not claim to diagnose GPS reception.

Messages buffered before subscription confirmation use the same ordered,
per-message database admission as [TeslaMate](teslamate.md). The feed remains
unavailable until the complete received prefix commits. A failed packet cannot
be skipped to announce readiness; earlier committed values remain unavailable
context until the existing reconnect/subscription recovery succeeds. Original
measurement and receipt clocks are preserved.

An explicit valid away report or replacement of the configured vehicle feed
prevents the fallback. A BMW unplug event does not erase the remembered location.
A later live home-zone correction can supersede an away calculation while
keeping the original GPS clock. A charger reconnect alone does not mean the
vehicle left the property; its separate connection boundaries still fence all
charging evidence. Unknown plug or charging facts have no last-known fallback.
Matching vehicle and physical charger responses for the current connection remain mandatory. Missing
usable context leaves a new attempt waiting; once a test has begun, loss of
context cannot reset its time or energy limits. An already inconclusive attempt
still requires **Identify** or a new physical connection to start another test.
With a healthy feed and valid home context, a valid BMW unplugged report whose
source timestamp predates the physical connection does not block a new probe.
Tesla follows the same rule using its original receipt clock. A negative report
from the current connection, unknown clock, away report or unhealthy feed still
blocks readiness. This permission to gather evidence does not supply identity:
positive vehicle context and matching charging events remain required.

## Association with a charging point

Battery readings do not identify a charger. BMW needs positive home/plug context
and source-timestamped charging evidence matched to the physical connection.
The [identification contract](../identification.md#bmw-physical-correlation) owns
the exact start/stop correlation, causal pause proof, episode consumption and
joint Tesla/BMW rules. A negative Tesla result never identifies BMW.

An attempt waiting for usable evidence is pending. An exhausted unresolved active
attempt is **Identification inconclusive**; passive matching can still finish for
that same connection when delayed valid evidence arrives. Automatic retries,
new budgets after restart and invented source events are not permitted.
See [attempt completion and explicit retry](../identification.md#attempt-completion-and-explicit-retry).

## Conflicting charge targets

BMW can alternate its selected target with 100%. The controller activates the
filter after one live, ordered **100% → X** transition during the current
charger connection, where X is below 100%. This can happen at any point in the
session, with no time limit between the observations. Each observation must be
no more than fifteen minutes old when received and belong to this connection.
Retained messages, duplicates, old readings and repeated polling of the same
value cannot activate the filter. Until it activates, a change to 100% remains valid.

After confirmation, planning holds the latest reported target below 100% for that
connection, ignoring subsequent 100% reports. A new live lower-than-100% setting
replaces the held value immediately; it need not be lower than the previous
setting. Unverified reports cannot replace the held value. The card colors the
held planning target with the attention color. Its Target details show the
selected planning target and unmodified raw BMW report with their separate
original measurement times. Filtering changes neither battery percentage nor
the target configured in the car.

Edit **Target charge** in Session settings and use **Save for this session** to
plan for another target, including 100%. A saved target takes priority over the
filter and clears the held-target indicator; it does not change the car's own
charging limit. The hold evidence and saved session target survive a restart in
the same connection and clear on unplug or a new connection. A stale browser
cannot apply an edit to a different connection. Configured defaults are
unaffected. A newly installed filter starts collecting evidence from live
readings; it does not infer a past conflict from a lone saved target.

Development snapshots containing the retired BMW target `override` or `mode`
fields are rejected with fresh-database guidance, including an empty old
override. They are not converted or reset automatically.

## Installing or updating the publisher

Build the automation with privately discovered entity IDs and the verified home
reference. Validate the generated template through Home Assistant's template API,
save the automation, read it back, and verify live and retained MQTT publication.
Install the generated object as one Core automation using **Edit in YAML**;
see [installing the automations](../../homeassistant-mqtt.md#installing-the-automations).
The MQTT integration stays on HA's fixed broker and uses its standard
`homeassistant/status` birth/will topic. ST-MQ receives BMW through `mqtt.ha`
when configured, otherwise through primary. See
[broker routing](../../configuration.md#primary-mqtt-and-ha-hosted-integrations).
The ST-MQ app does not install this
publisher automatically.
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
