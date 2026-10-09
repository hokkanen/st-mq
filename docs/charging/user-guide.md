# Using charging

[Charging overview](../charging.md) · [Policies](policies.md) · [Setup](#device-information-and-setup)

The two charger cards use the same controls and layout. The activity line tells
you what the charger is observed to be doing; the controls tell you what has been
requested. A connected vehicle can be waiting even when charging is allowed.

Use the chevron beside **Charger 1** or **Charger 2** to expand readings and
settings. Below the energy figures, the compact footer keeps the current status
and allowance visible, including while an action is pending, saved or failed.
**Session report → Open ↗** opens the report window independently of the card.

## Daily controls

| Control | Effect and scope |
| --- | --- |
| **Automatic charging** | Saves the scheduling preference for this equipment, including across restart and unplugging. A later native instruction can retain priority while this switch remains on. |
| **Charge now** | Requests charging for this connection, including with Automatic off, while native restrictions and device readiness remain binding. Turning Charge now off returns to Automatic and enables it if needed. ON is a request, not proof of draw. |
| **Save for this session** | Applies current charge, target, usable capacity and ready-by edits to this physical connection. It does not rewrite configured defaults. |
| **Use automatic** | Appears when a supported handover from another charger instruction is available. It enables Automatic, ends Charge now and returns to the price plan after confirmed takeover. |
| **Identify** | Requests another bounded identification attempt for the current connection. An existing confirmed assignment remains visible during the check. |
| **Shared priority** | Chooses Balanced, Charger 1 or Charger 2 for both chargers. Both cards edit the same saved choice. |
| **One extra day** | Compares the current deadline with one later calendar day. Allowing the day changes only this connection's deadline; canceling an active allowance restores the earlier deadline. |

Automatic starts off and shared priority starts Balanced on a fresh installation.
Neither switch alone is a physical Stop control. Use the supported native control
when an explicit physical stop is required and check the observed response.
[Ownership and takeover](execution-and-recovery.md) explains which instructions
can be superseded and which remain binding.

Charger 2's load balancing remains active when Automatic scheduling is off,
unless it was explicitly disabled in configuration. An old current setting does
not permanently cap a new connection. A current choice made on the charger
during the connection remains a ceiling until unplugging or **Use automatic**;
restart preserves it. Hardware, electrical and vehicle limits still apply.

**Use automatic** appears in Charging controls only when a supported takeover is
available. It is disabled while its request runs and hides when no longer needed;
its pending or failed outcome remains visible. **Identify** is at the end of
Charging controls below Session settings, disabled without control authority or
while an attempt is already pending/in progress. Admin and family users can use
it when permitted. Messages and explanations wrap without deliberate clipping;
compact labels omit terminal periods and action receipts use complete sentences.

## Session settings and battery progress

When disconnected or connection state is unknown, the compact card shows
configured battery/ready-by **defaults**, without borrowing earlier session edits
or progress. Session actions require a confirmed current connection. The shared
initial defaults are 20% starting charge, 80% target, 06:00 ready-by and 74 kWh;
identified BMW and Tesla capacity assumptions start at 74 and 57 kWh respectively.
Change permanent defaults through [reviewed configuration](../configuration.md#charging-defaults-and-dashboard-overrides).

**Current charge** follows applicable vehicle evidence and estimated progress from
measured charging energy. A manual edit establishes a new reference for this
connection. A newer applicable vehicle reading can supersede that reference;
a pinned capacity takes precedence over reported capacity. The requested target
remains separate from the car's actual ceiling: requesting 95% does not bypass an
80% limit set in the vehicle. Original readings remain available beside edits.
The last reported charge shows its value and source above a separate **Measured**
or **Received** timestamp. Receipt time is not measurement time. Open the reading's
information for the full date and any unavailable measurement time; compact dates
include the year when it differs from the dashboard's current local year.

Type ready-by as **HH:mm**, or use **Choose time → Set** and then **Save for this
session**. The deadline becomes one concrete occurrence for this connection;
midnight, identification, replanning and restart do not roll it forward.
A deliberate ready-by edit may change it. Drafts survive ordinary status refreshes,
and a stale browser cannot edit a replacement connection.

**One extra day ↗** compares a later deadline for that charger alone. The main
saving is its estimated remaining charging cost reduction. If sharing capacity
changes the other charger's estimated cost, the comparison explains that effect
and the total; the other charger's ready-by time stays unchanged. Opening the
window does not grant extra time. **Allow one more day** approves the later
deadline for this connection, then the button says **One day allowed** and keeps
its estimated saving visible. The red label and **+1 day** ready-by marker end at
the earlier deadline; the approved later deadline remains binding.

Both alternatives use the same published and fresh forecast prices, including
transfer charges, electricity tax, margin and VAT. Normal scheduling can already
use cheaper forecast periods before its deadline. Another day saves money only
when the additional time changes the plan. The planner adds a **2 c/kWh
uncertainty allowance** to forecast prices when choosing periods in either
plan; this allowance is separate from the displayed cash cost and saving.
Published prices replace forecasts as they become available. The window explains
the assumptions and each plan's forecast exposure without implying guaranteed
savings.

The comparison shows when it was calculated. It updates when a replacement
changes the displayed result; ordinary polling does not renew its timestamp.
Use **Refresh comparison** to request a new assessment. The previous successful
estimate remains visible during recalculation or a failed refresh, with its age
and any refresh limitation. Card estimates also update when a replacement is
ready; ordinary voltage/current updates do not erase them.
A changed connection or charging request still requires reviewing its comparison
before making another choice. Estimates describe a plan, not guaranteed savings.

Admin and family-password users can open and refresh the comparison, allow the
day and use **Cancel flexibility** before the earlier deadline. Canceling
restores the earlier deadline with best-effort charging if it can no longer be
met. These actions require the same current connection and control eligibility
for both roles. A read-only instance cannot change the allowance. An approved
day survives forecast loss; another day always requires a new explicit action.

**Added energy** and connection cost cover the physical connection. A new battery
reading can change estimated charge without resetting its measured grid energy.
Missing energy is not credited. [Progress and cost](evidence-and-reporting.md#charge-progress-and-cost)
describes losses, measurement gaps and timing comparisons.

## Schedule and readings

**Schedule & readings** belongs to the current charging session. Both cards use
common sections for the plan, control/identification state and current readings.
Supported hardware differences add relevant information: Easee's reported
Equalizer allowance is distinct from Shelly's load-balancing status and confirmed
native current setting. Missing values remain unknown; forecasts and requests
must not be displayed as observed charging.

| What you see | Meaning |
| --- | --- |
| Proposed charging periods | The current economic plan; they may still be awaiting native acceptance. |
| Forecast prices in the plan | Estimated all-in prices selected with the same uncertainty allowance used by One extra day. They can change and are replaced by published prices. |
| Charging is allowed | The applicable instruction permits charging. A car timer, target or other restriction can still prevent draw. |
| Paused between periods | The controller has confirmed the applicable pause. A pending instruction is shown separately. |
| Identification pending | The attempt is waiting for the evidence or readiness it needs. Ordinary scheduling can use configured/session inputs. |
| Identification inconclusive | The active attempt ended unresolved. Passive evidence can still complete the match within this connection. |
| Load balancing: Fallback | Current uses its configured fallback cap subject to known tighter limits. It is not proof of healthy household headroom. |
| Load balancing: Unknown | Current headroom or the controller decision is unavailable. A retained charger setting does not establish available capacity. Healthy feeds use their latest values without waiting for matching timestamps. |

Normal automatic scheduling combines published prices with fresh forecast prices
when the optional feed is enabled. It selects economical periods before the
binding ready-by time using the same all-in tariff and 2 c/kWh forecast uncertainty
allowance as the extra-day comparison. The allowance affects selection, not the
displayed bill estimate. Forecasts can change; expired or unavailable predictions
are excluded while available published prices remain usable. A proposed plan is
still separate from native acceptance and observed charging.

**How charging works** explains these price assumptions and the session behavior
for that backend. Easee cloud
and OCPP pauses can expire on the charger; a Shelly pause needs a running
application and working MQTT to resume. OCPP expiry does not authorize a new
transaction or restore cloud control. See [outages and recovery](execution-and-recovery.md#missing-feeds-and-controller-outages).

## Device information and setup

Follow **Charging setup & documentation** from either card, or open
**Data & settings → Connections & configuration → Charging**. This is the home
for installation information rather than duplicating it in daily session folds.

The hardware cards identify the charger role, integration, model and available
firmware evidence. A **reported firmware** version comes from native discovery or
an OCPP boot report, with its source and original receipt time. It is not a tested
compatibility claim; unavailable metadata stays unavailable and reconnects need
new evidence. Serial numbers, authentication secrets and private device identifiers
are not part of these display cards.

Expand charger setup for connection and capability prerequisites, native OCPP
setup/adoption where applicable, and installation-specific current readiness.
Firmware 344 or later is the documented Easee native OCPP prerequisite, not a
blanket claim that every later firmware has been tested. The Shelly profile is
admitted through its discovered capabilities. Its [qualification record](integrations/shelly.md#hardware-verification-still-required)
describes a bounded setup observation on firmware 1.7.1; that observation does
not qualify every current-control or outage behavior, or the currently installed
firmware.

Separate BMW and Tesla feed sections explain source setup and show their accepted
fields and clocks. A healthy vehicle feed is separate from vehicle identification
and charger control readiness. Opening a guide sends no commands. Use the linked
[Easee](integrations/easee.md), [Shelly](integrations/shelly.md),
[BMW](integrations/bmw.md) and [TeslaMate](integrations/teslamate.md) instructions
for installation detail.

## Reports and assessment

Each ordinary connection has a **Session report** on its charger card. It keeps
findings, plans, control changes and original evidence together. Saving protects
that historical report from automatic expiry; it does not create a backup or
authorize charging. [Report details](evidence-and-reporting.md#session-reports).

**Guided assessments** in Charging setup compare ordinary operation with recorded
assumptions. Their entered battery values and timers never alter the production
plan or identify a vehicle. The user operates any vehicle timer. Stopping an
assessment stops observation while ordinary charging continues.
[Assessment guide](guided-assessments.md).

For deliberately selected manual hardware cases, the repository also contains
bounded command-line observers and an offline limiter auditor. These development
tools and their evidence limits are documented in [testing](testing.md).
