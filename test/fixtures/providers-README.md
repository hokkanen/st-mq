Provider fixtures are authored offline examples, not fetched household data or historical forecasts. They contain no real API keys. Tests derive expected UTC instants and costs independently of parser internals.

The ENTSO-E example combines an A01 quarter-hour period with a missing point and a separate hourly period. Test variants exercise A03 variable blocks, explicitly missing prices, revisions and conflicting duplicates. The source contract was checked on 2026-09-06 against the official [REST API reference](https://documenter.getpostman.com/view/7009892/2s93JtP3F6), [curve specification v1.4](https://eepublicdownloads.entsoe.eu/clean-documents/EDI/Library/cim_based/Introduction_of_different_Timeseries_possibilities__curvetypes__with_ENTSO-E_electronic_document_v1.4.pdf) and [current curve-type guidance](https://transparencyplatform.zendesk.com/hc/en-us/articles/30262342482961-CurveType-A01-vs-CurveType-A03). A03 prices apply until the next supplied point or the same Period's end; explicit missing points interrupt this coverage. A01 omitted points remain gaps. Message creation time is recorded with its own basis; it is not receipt time.

Elering fallback now uses the original `/api/nps/price` endpoint automatically.
The [endpoint evidence](market-elering-evidence.md) records the official OpenAPI
schema, Nord Pool's delivery transition and bounded public live checks establishing
EUR/MWh excluding VAT and the terminal interval duration. Offline variants cover
hourly/quarter-hour transitions, missing rows, negative prices, daylight-saving
days, primary failure, cancellation and per-source retry delays. A missing row
never stretches the previous price to fill it. Unpublished tomorrow prices do not
trigger fallback when current-day coverage is complete.

FMI forecast/observation fixtures are authored XML examples with invented station
identifiers, names and measurements. They follow FMI's official
[forecast model manual](https://en.ilmatieteenlaitos.fi/open-data-manual-forecast-models)
and [WFS examples](https://en.ilmatieteenlaitos.fi/open-data-manual-wfs-examples-and-guidelines).
The forecast parser distinguishes model analysis, publication and valid times;
observations retain the station's timestamp and nearby-station spatial basis.
Tests reject stale, distant, malformed and wrong-parameter data, preserve missing
slots, and verify independent FMI → OpenWeather chains for forecast and outdoor
observation. Forecast points are never ingested as observed outdoor temperatures.

The OpenWeather fixture follows the official [five-day/three-hour forecast documentation](https://openweathermap.org/forecast5), checked 2026-09-06. Metric requests supply Celsius and `dt` is forecast-valid Unix time in UTC. The JSON response has no documented model issuance field. `issuedAt` remains null and `issuedAtBasis` is `fetched-snapshot`, with separate `fetchedAt`. Missing forecast slots remain gaps. This enables retaining the actual downloaded forecast snapshot without inventing historical forecasts or claiming to know the provider's issuance instant.


The [opt-in live suite](../../docs/live-testing.md) is separate from these fixtures.
It tests each configured primary and backup directly, with bounded serial requests,
rate-limit cooldowns and sanitized output. Passing deterministic tests establishes
parser/control behavior; only a successful current live check establishes access
with the installation's current API keys.
