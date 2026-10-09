# Finnish electricity-price predictions

`electricity.forecast_enabled` enables the free Energy Price Forecast EU feed.
It defaults to `true`. To disable it, set it to `false` in the existing
configuration source and apply the reviewed configuration, or restart. It requires
the Finnish market, including
any explicit ENTSO-E bidding zone. The setting owns acquisition, display and
forecast availability for normal and extra-day charging plans; it does not grant
charger control permission or change configured ready-by times.

The integration is for each user's own private, non-commercial installation.
Each active master fetches directly from the provider, without credentials.
ST-MQ does not operate a shared redistribution service. Commercial deployments,
customer projects and redistribution require separate provider permission.
The provider's [free access conditions](https://energypriceforecast.eu/en/private-pro/)
and [commercial access page](https://energypriceforecast.eu/en/api-for-business/)
describe that boundary. Availability and predicted savings are not guaranteed.

## Acquisition and evidence

The [current OpenAPI](https://energypriceforecast.eu/openapi/integration-api.json)
and a public native Finnish response were checked on 2026-10-08. ST-MQ uses the
documented `/api/v1/home-assistant/prices` endpoint on the fixed HTTPS host
`api.energypriceforecast.eu`, with `country=fi`, `hours=48`,
`mode=forecast_only`, `resolution=native` and `price_mode=base`. The public
endpoint is keyless. Its free request limit depends on the endpoint; ST-MQ does
not assume the paid plan's allowance applies to anonymous access.

Native predictions are hourly EUR/kWh excluding VAT. They become c/kWh excluding
VAT at the acquisition boundary. Genuine zero and negative prices remain valid.
Currency, country, offset-bearing instants, native duration, source and requested
price mode are validated. Duplicate or overlapping intervals, impossible time
ranges and malformed values reject the complete response. Gaps stay gaps.
An unknown or changed external format fails closed; there are no old-format
decoders, database migrations or price backfills.

The requested horizon is 48 hours, or a shorter provider entitlement, measured
from the request rather than the last official price. The inspected service
begins at the next whole UTC hour. ST-MQ retains the complete final supplied
hour, admitting its end up to that next whole hour plus the permitted horizon.
It never extends a supplied interval or invents the missing current half hour.
UTC native intervals preserve both occurrences of a repeated Finnish autumn hour.

The service keeps one bounded snapshot in RAM. It fetches on live master startup
and every 30 minutes, even when both chargers are unplugged and Automatic is off.
Chart reads and charging-dialog openings never trigger provider requests.
Requests are single-flight, use the existing bounded HTTP transport and can be
canceled when acquisition stops. A failure retains the original clocks of the
previous snapshot. Retries start after 30 minutes, increase to at most six hours,
and honor a bounded `Retry-After` of up to 24 hours. Diagnostics retain only
approved error codes, never response bodies or arbitrary provider messages.

`fetchedAt` records receipt; provider `generated_at` is the response-generation
time, not a claim of a new model issue. Where supplied,
`source.firestore.updated_at` is retained separately as `modelUpdatedAt`; absent
model time stays unknown. Availability expires 90 minutes after receipt or
response generation, and at six hours of model age when that clock is supplied.
These are conservative local admission limits, not provider accuracy guarantees.
Expired predictions disappear from the forward chart and charging outlook;
an outage does not invalidate an already authorized session deadline.

## Price and storage boundaries

Only the forward price chart and charging price outlook receive this feed.
Published prices always replace predictions on overlap. The existing household
price calculation supplies dated retailer margin, electricity tax, VAT and
Finnish time-of-use transfer charges. An hourly forecast may be repeated in
quarter-hour planner slots, retaining the same native interval and source;
the four quarters are not independent model predictions.

Normal charging and both alternatives in **One extra day** use this same
charging outlook. No deadline extension is needed to schedule with a fresh
forecast. Both plans keep estimated all-in cash cost separate from a conservative
uncertainty allowance of **2 c/kWh** on predicted slots, including negative-price
intervals. The allowance is a decision penalty, not an invoiced charge or measured
forecast error. Published slots have no uncertainty allowance. A comparison
changes only the selected charger's deadline; it does not unlock a new price
source. Its risk-adjusted benefit accounts for the uncertainty allowance in each
plan, so unchanged forecast exposure cancels out.

Predictions never enter canonical market snapshots, price history, recorded
energy/cost accounting, Home heating, hot water, Garage control or learning
journals. Ordinary polling does not write forecast rows or a forecast-health
journal. User-approved session deadline state has a separate durable lifetime;
it does not require persisting hourly provider values.

The master exposes safe feed metadata through `providers.electricityForecast`
and the current bounded RAM snapshot through the separate forecast API. The
replica has no acquisition service or transient peer forecast channel; it
reports the feed as unavailable on the read-only instance instead of deriving
current predictions from copied history. No prices are added to replication.
Promotion starts the ordinary master acquisition pathway and requests fresh
provider data. Restart likewise discards the transient cache.

## Chart and charger controls

The existing spot and all-in price lines continue into predicted intervals
with their usual colors and more widely spaced dots (`[1,8]`, compared with
published `[1,3]`). Existing price toggles control both portions. The chart adds
no date controls, presets or views: choose future dates with the existing date
selection. Predictions appear after the last published interval, even with no
vehicle connected. Gaps remain blank. Tooltips identify Forecast, the provider,
native hourly resolution and original download/model clocks. An optional feed
failure cannot delay loading recorded history.

**Electricity prices** separates **Prices** from **Price forecast**, with each
section's explanation below its heading. The **48-hour price forecast** has its
own availability and plain-text provider attribution. Forecast metadata shows
**Fetched** with the original acquisition time and age, plus **Model updated**
when supplied. Weather forecasts use the same clock presentation, retaining
separate issue times and backup solar provenance. A status refresh never renews
these clocks. A forecast outage does not change published-price availability.

Each eligible connected charger shares its existing footer with a compact
**One extra day** comparison button. Its two-line label shows the available
estimated saving immediately, including zero or an estimated extra cost, without
repeating the deadline. If current evidence cannot support a comparison, it shows
the limitation. A previous successful comparison for the same session and request
remains visible with its original calculation time during a failed refresh or
forecast outage; age alone does not erase it. Without such a retained comparison,
the estimate is unavailable. Green emphasis appears only when the joint comparison
supports a positive household saving after the uncertainty premium; other results stay
neutral. Opening the dialog changes no charging permission or selected plan.
The ordinary total-session estimate combines accrued published-price cost with
the current plan's estimated remaining all-in cost; it can include forecast
prices without changing the recorded bill. The comparison
shows remaining cost, estimated completion and modeled charging duration for
the current and next-day deadline. Charging duration includes only modeled
energy delivery, excluding pauses and waits for available capacity. The dialog
also explains both chargers' combined estimated impact and the separate
uncertainty allowance. Both alternatives use published and forecast prices on
the same basis. Their displayed costs include applicable transfer charges, tax,
margin and VAT; the uncertainty allowance guides selection and is not added to
the cash cost or saving. Already delivered energy is common to both choices.
Unavailable comparison data never becomes a zero cost or promised saving.
With an active allowance, the alternatives and planning allowances refer to the
earlier and approved deadlines. The uncertainty-adjusted result includes the
difference between allowances; the cash saving remains separate.

**Charging plan** within **Schedule & readings**, and **How charging works** in
**Help & setup**, explain that forecast periods
are estimates, that published prices replace them and that the schedule can
change when prices or capacity change. A forecast outage retains usable
published prices and the binding ready-by time; it cannot invent a future rate.

Prices need not reach the later ready-by time when both plans can deliver the
same required energy within the available priced horizon. The comparison labels
incomplete coverage and explains that later prices may change the saving.

**Allow one more day** is the separate affirmative action. It permits charging
at any economical time before the later deadline; it does not request a 24-hour
delay. The effective Ready by shows a red **+1 day** cue while the previous
deadline is still ahead. At that checkpoint the cue disappears and the approved
later deadline becomes the ordinary binding deadline. Only then can another
day be authorized through a new comparison and explicit action. Grants cannot
stack or renew automatically. **Cancel flexibility** before the checkpoint
restores the earlier deadline with best-effort charging if it is no longer
achievable. An explicit Ready by edit replaces the grant.

The shared dialog uses native keyboard/focus behavior, initially focuses Close
and returns focus to its opener. Admin and family-password users have the full
workflow: view and refresh, allow one more day and cancel an active allowance.
The same equipment, physical-session, request and control checks apply. Read-only
views can inspect available results but cannot approve or cancel an allowance.
The temporary cue clears on a local checkpoint timer and tab visibility change;
a new approval still requires current server session/revision validation.
The [charging planning contract](charging/planning.md) owns the durable
checkpoint, calendar-day, authority and outage behavior.
