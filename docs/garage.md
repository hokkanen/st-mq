# Learned garage heating

Garage heating has its own coupled thermal learner, two independent heat-reserve
histories, whole-outlook planner, frozen episode accounting and compact equipment
and learning disclosures. Home heating, its indoor average, EV charging priorities
and household electrical accounting retain their existing behavior.

**The installed Pill contract is still missing.** This version implements and
tests the ST-MQ consumer using `stmq-garage-fixture/v1`, an explicitly provisional
host simulation contract. Production MQTT can inspect this fixture vocabulary but
has no garage command publisher. No configuration flag enables physical garage
OFF commands. The separate Pill project must supply a published, reviewed driver
contract and installed commissioning evidence before a real driver can be added.

## Owner configuration

Permanent settings use the existing private configuration and **Apply
configuration** workflow, on both standalone and Home Assistant add-on installs.
The `garage` object in `config.json` documents defaults and the add-on schema.
Its three everyday preferences are:

- `protection`: owner approval and a thermal-reserve policy, independently applied
  at rear and front to protect pipes and stored liquids. A water-filled copper pipe
  is the reference; defaults are unapproved engineering assumptions.
- `aggressiveness`: 0–100. Zero ends owned economic pauses and keeps learning;
  higher values reduce the stable cost assigned to depth and duration of cooling.
- `baselineC`: the existing Mitsubishi setting, initially 10°C. It supplies
  baseline context and readback checks; ST-MQ never raises the thermostat.

`enabled`, `frontRequired`, adapter connections and timing bounds are commissioning
and engineering settings. Both real protection locations must be fresh before any
simulated automatic pause; commissioning front never permits substitution when
it disappears. Global monitoring/shadow mode and loss of controller authority
also prohibit automatic garage commands. A confirmed real baseline, compatible
schema, local expiry, persisted restoration and offline startup recovery are
essential future commissioning dependencies; native indoor/outdoor temperatures
and electricity are optional capabilities.

The existing `garage_temperature` is **rear**. `garage_temperature_2` is **front**;
old rear history retains its original meaning. Use the existing equipment reading
mapping for two probes on a Shelly, or distinct MQTT temperature connections. The
legacy exact-topic options `mqtt.garage_temperature_topic` and
`mqtt.garage_temperature_2_topic` also work. Repeated equal-valued genuine reports
are fresh; repeated timestamps, retained packets, missing reports and native pump
temperatures cannot refresh protection evidence.

**Freezing protection** shows the 1°C estimated-temperature margin, reference
pipe dimensions (21 mm outside diameter and assumed 1 mm wall), nominal heat
transfer (20 W/m²·K), and fixed safety factor (2). The calculated reserve follows
recent local cooling and warming, with no fixed cold allowance, hard air cutoff,
warm-up timer or constant repayment rate. Rear and front cannot borrow reserve
from each other. See [protection parameters and assumptions](garage-protection-defaults.md).

## Everyday controls

The **Garage** card's upper summary shows the rear temperature, doors and heating
request, and opens **Heating configuration** with heating controls and
**Pause savings**. The two charger cards follow the summary. **Sensors & More
equipment** contains both protection probes, the pump's own temperatures, doors
and Caravan. A selected mode has an inline check; requested state remains
distinct from confirmed native power.

**Pause savings** suspends economic scheduling until a Finnish local deadline
and restores Normal heating when started or reset. **Normal heating** and
**Heating off** are manual selections: without Pause, control takes over on its
next update, bounded by a one-minute expiry. During Pause, the selection stays
until the deadline or **Resume now**. Normal restores the existing native
baseline through the adapter's owned release route; it does not overwrite a
device switched off independently of ST-MQ. Restart keeps the price-control
deadline but restores an owned OFF request instead of resuming it.

Manual OFF uses the same native lease, authority, recovery and freeze-protection
checks as automatic control. It does not require an economic saving prediction;
both protection temperatures and thermal reserve are still required. Protection
or loss of fresh control evidence can restore heating before the chosen deadline.
These controls require active mode and a supported adapter; the current
provisional contract supports host simulation only, as described above.

While Pause holds an OFF selection, an amber warning stays visible even with the
fold closed. Changing heating during Pause also opens a confirmation describing
the duration and freezing risk. Home uses the same warning style for held heating
or native parameter changes. Circulation retains its separate configured timer.

The authenticated routes are `POST /api/garage/temporary` with `pauseUntilLocal`
or offset-aware `pauseUntil` (null resumes), and `POST /api/garage/heating` with
`mode: "normal"` or `mode: "off"`. Both return the full dashboard status.

## Control, recovery and evidence

The rear/core state describes effective building memory; the coupled front
difference describes local cooling. Neither represents measured pipe temperature,
stored kWh or universal insulation coefficients. Native demand and electrical
response are learned separately from temperature response. Two existing EV
electrical/activity sources are reused without changing charging schedules.
Optional native temperatures stay live-only until they earn modeling use; Home's
outdoor-source priority is unchanged. Unknown future EV warmth receives no credit
in protection. Solar is excluded pending demonstrated predictive improvement.

The planner compares preparation, native OFF and recovery over up to 48 hours.
Preparation means making native heating available. Flat-price timing benefit is
zero, uncertainty discourages tiny opportunities, and terminal heat debt is priced
conservatively without assuming unavailable future electricity is cheap. Whole
thermal episodes may contain several independently identified adapter pauses.
Each pause has its own endpoint; renewals cannot extend it. The host retains one
frozen model/reference and unpaid recovery debt across those pauses and refits.

Before the first possible OFF request, both host accounting and adapter recovery
obligations are persisted. Only a fresh planner tick may renew, at a one-minute
cadence and no later than three minutes from its supporting temperature evidence.
An earlier thermal deadline shortens the requested permission. A five-second
safety check and acquisition failures can request restoration and stop permission;
they cannot renew it. Restart reconciles ON and never revives saved OFF intent.
Shutdown/configuration reload requests restoration through the original route;
unresolved restoration blocks replacing that route. An inactive/replica instance
does not fight the active controller with either OFF or ON commands.

**End garage pause** requests release of an owned pause. It does not overwrite an
unmanaged manual OFF. Publication, acceptance, native ON and useful temperature
response remain separate evidence. A stopped driver, broken serial link or
unpowered Pill cannot send ON; the future fallback is local Pill software, not a
hardware-independent guarantee.

Episode model estimates include elapsed preparation-equivalent native operation,
shutdown and recovery under identical weather/EV assumptions. An episode is
frozen immediately before its first OFF; preceding continuously available
preparation is identical to reference and contributes zero difference. Short
recorded dedicated electrical intervals are preferred when complete; otherwise
actual electrical response is explicitly modeled. Price-boundary segments are
weighted separately. Missing intervals invalidate completion savings rather than
becoming zeros. Reporting timeouts and source corrections never forgive physical
debt. Completion requires both local temperatures, slow estimated state and local
thermal reserve to recover; a positive freeze-protection reserve alone is not
complete building recovery. Incomplete evidence can finish only without a savings claim.

## Recording, replay and UI

Garage learning uses a separate `garage:<input>` stream in the existing immutable
learning journal. The first entry saves its seed; every entry saves normalized
used inputs, settings checksum and algorithm version
`committed-garage-v3-event-doors`. Fresh temperature source reports provide
evidence; UI polling does not. Confirmed door state is event-driven and has no
fixed age expiry. Source/bridge outages and invalid state make it unknown until
a live snapshot and availability evidence restore it. The original source time
remains distinct from confirmation; a recovered closed state cannot erase an
opening or outage between learning samples. Configured open or unknown doors
exclude affected learning evidence but do not automatically revoke heating pauses.
The same ordered entry function drives live learning, rebuilding and
coefficient charts. Cache digests detect accidental corruption. File-backed
reconstruction runs in a worker, catches up the current journal and checks the
selected correction revision and epoch before atomic publication.

Sensor additions/replacements and reversals retain original source events.
Corrected replay projects measurement eligibility without editing telemetry or
frozen forecasts. Garage thermal-reserve/recovery state remains separate from that
rebuild. Imported rear-only history and simulation retain separate input scopes;
absent front, OFF and native electrical evidence remain unknown.

**Heating savings** defaults to Home and adds **Garage / Total**. Model estimates
and timing comparisons remain different methods. Total sums only compatible
system contributions within one method. Missing components produce a named
partial total; provisional evidence and negative values remain visible. Home's
existing timing source is based on recorded operation and nominal power, so adding
Garage does not turn the combined result into meter-grade evidence. Garage timing
uses qualified dedicated short electricity intervals and the same recorded daily
energy distributed uniformly across the Finnish 23/24/25-hour calendar day.

Garage equipment/settings/learning disclosures are closed by default. Separate
Garage model input and coefficient axes show original normalized inputs and
versioned corrected model history. Native equipment temperatures are live context,
not duplicated protection readings or automatically recorded database channels.

See [model and protection semantics](garage-model.md), [adapter contract and
simulation evidence](garage-adapter.md), [reporting and chart rules](garage-reporting.md)
and [notes for the future Pill task](shelly-pill-handoff.md).

Software validation uses deterministic virtual-time model, adapter, electrical,
runtime/replay and UI scenarios, plus Home/add-on/standalone/role regressions.
No live pump test, native-meter accuracy check, realized-savings measurement or
physical pipe-protection validation is claimed by these software tests.
