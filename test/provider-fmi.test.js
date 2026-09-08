import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFmiForecast, decodeFmiObservation, fetchFmiForecast, fetchFmiObservation,
  weatherCoordinates } from '../src/acquisition/fmi.js';
import { fetchWeather, fetchOutdoorTemperature } from '../src/acquisition/weather.js';

const forecastXml = readFileSync(new URL('./fixtures/weather-fmi-forecast.xml', import.meta.url), 'utf8');
const observationXml = readFileSync(new URL('./fixtures/weather-fmi-observations.xml', import.meta.url), 'utf8');
const at = Date.parse('2026-09-07T06:20:00Z'), HOUR = 3_600_000;
const coordinates = { latitude: 60.39, longitude: 25.66 };
const options = { fetchedAt: at, coordinates };
const connections = { geoloc: coordinates };
const member = xml => xml.slice(xml.indexOf('<wfs:member>'), xml.indexOf('</wfs:member>') + '</wfs:member>'.length);

test('FMI forecast retains publication/run/valid times independently and leaves hourly missing slots empty', () => {
  const result = decodeFmiForecast(forecastXml, options);
  assert.equal(result.source, 'fmi'); assert.equal(result.forecast.length, 3);
  assert.equal(result.issuedAt, Date.parse('2026-09-07T06:00:00Z'));
  assert.equal(result.analysisAt, Date.parse('2026-09-07T00:00:00Z'));
  assert.equal(result.fetchedAt, at); assert.equal(result.issuedAtBasis, 'provider-result-time');
  assert.deepEqual(result.forecast.map(row => [new Date(row.start).getUTCHours(), row.outdoorC]), [[6, 10.5], [8, 13], [9, 14]]);
  assert.equal(result.forecast[0].end, Date.parse('2026-09-07T07:00:00Z'));
  assert.equal(result.forecast.at(-1).end, Date.parse('2026-09-07T10:00:00Z')); // no extrapolation past last valid point
  assert.ok(result.forecast.every(row => row.end - row.start === HOUR && row.unit === 'degC'));
  assert.ok(result.forecast.every(row => row.solarRadiationWm2 === null));
  assert.equal(result.solarStatus, 'unavailable');
  assert.deepEqual(result.observations, []);
});

test('FMI rejects wrong parameter/model, stale publication, impossible values and unrelated locations', () => {
  const bad = [forecastXml.replace('param=temperature', 'param=dewpoint'), forecastXml.replace('harmonie_scandinavia_surface', 'unknown_model'),
    forecastXml.replace('<wml2:value>10.5', '<wml2:value>273.15'), forecastXml.replace('60.39 25.66', '20.39 25.66'),
    forecastXml.replace('/4326', '/3067'), forecastXml.replace('T07:00:00Z</wml2:time>', 'T07:30:00Z</wml2:time>')];
  for (const xml of bad) assert.throws(() => decodeFmiForecast(xml, options));
  assert.throws(() => decodeFmiForecast(forecastXml, { ...options, fetchedAt: at + 7 * HOUR }), /Stale/);
  assert.throws(() => decodeFmiForecast(forecastXml, { ...options, fetchedAt: at - HOUR }), /Stale/);
});

test('FMI XML parser rejects malformed XML, entity declarations, extra features and conflicting duplicates', () => {
  for (const xml of ['<broken>', '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///secrets">]>' + forecastXml,
    forecastXml.repeat(300), '<ows:ExceptionReport xmlns:ows="urn:example"><ows:Exception/></ows:ExceptionReport>',
    forecastXml.replace('</wfs:FeatureCollection>', member(forecastXml) + '</wfs:FeatureCollection>')])
    assert.throws(() => decodeFmiForecast(xml, options));
  const point = '<wml2:point><wml2:MeasurementTVP><wml2:time>2026-09-07T06:00:00Z</wml2:time><wml2:value>99</wml2:value></wml2:MeasurementTVP></wml2:point>';
  assert.throws(() => decodeFmiForecast(forecastXml.replace('</wml2:MeasurementTimeseries>', point.replace('99', '11') + '</wml2:MeasurementTimeseries>'), options), /Conflicting/);
});

test('FMI observed temperature uses nearest fresh station and preserves actual observation age', () => {
  const farther = member(observationXml).replace('60.40 25.66', '60.50 25.66').replace('999001', '999002').replace('>11<', '>13<');
  const xml = observationXml.replace('<wfs:member>', farther + '<wfs:member>');
  const [row] = decodeFmiObservation(xml, options);
  assert.equal(row.value, 11); assert.equal(row.sourceTime, Date.parse('2026-09-07T06:10:00Z'));
  assert.equal(row.receivedAt, at); assert.equal(row.source, 'fmi'); assert.equal(row.signal, 'outdoor_temperature');
  assert.equal(row.device, 'fmisid:999001'); assert.equal(row.raw.stationId, '999001');
  assert.equal(row.raw.distanceKm, 1.1); assert.equal(row.raw.spatialBasis, 'nearby-weather-station');
  assert.equal(row.raw.timestampBasis, 'observation-time'); assert.deepEqual(row.quality, []);
  const missingNearest = observationXml.replace('>11<', '>NaN<').replace('>10.5<', '>NaN<')
    .replace('<wfs:member>', farther + '<wfs:member>');
  assert.equal(decodeFmiObservation(missingNearest, options)[0].device, 'fmisid:999002');
});

test('FMI observations reject stale, future, distant, forecast and unidentified station data', () => {
  assert.throws(() => decodeFmiObservation(observationXml, { ...options, fetchedAt: at + 31 * 60_000 }), /No fresh/);
  for (const xml of [observationXml.replace('60.40 25.66', '62.40 25.66'), observationXml.replace('/stationcode/fmisid', '/stationcode/geoid'),
    observationXml.replace('param=t2m', 'param=temperature'), observationXml.replaceAll('T06:', 'T07:'), forecastXml])
    assert.throws(() => decodeFmiObservation(xml, options));
});

test('weather coordinate validation rejects missing/blank/boolean/range errors and accepts zero', () => {
  for (const latitude of [null, undefined, '', ' ', true, [], 91, NaN])
    assert.throws(() => weatherCoordinates({ geoloc: { latitude, longitude: 25 } }));
  assert.deepEqual(weatherCoordinates({ geoloc: { latitude: 0, longitude: '0' } }), { latitude: 0, longitude: 0 });
});

test('FMI fetches bounded hourly forecast and recent observations using the documented bbox argument', async () => {
  const requests = [];
  const http = { text: async (url, opts) => {
    const parsed = new URL(url); requests.push(parsed);
    assert.equal(parsed.origin, 'https://opendata.fmi.fi'); assert.equal(opts.method, 'GET');
    return parsed.searchParams.get('parameters') === 'Temperature,RadiationGlobal' ? forecastXml : observationXml;
  } };
  assert.equal((await fetchFmiForecast({ connections, now: at, http })).source, 'fmi');
  assert.equal((await fetchFmiObservation({ connections, now: at, http }))[0].source, 'fmi');
  assert.equal(requests[0].searchParams.get('starttime'), '2026-09-07T06:00:00.000Z');
  assert.equal(requests[0].searchParams.get('latlon'), '60.39,25.66');
  assert.equal(requests[0].searchParams.has('bbox'), false);
  assert.equal(requests[0].searchParams.get('endtime'), '2026-09-09T06:00:00.000Z');
  assert.equal(requests[0].searchParams.get('timestep'), '60');
  assert.equal(requests[0].searchParams.get('parameters'), 'Temperature,RadiationGlobal');
  assert.equal(requests[1].searchParams.get('starttime'), '2026-09-07T05:00:00.000Z');
  assert.equal(requests[1].searchParams.get('endtime'), '2026-09-07T06:20:00.000Z');
  assert.equal(requests[1].searchParams.has('latlon'), false, 'FMI silently ignores unsupported observation latlon');
  const [west, south, east, north, crs] = requests[1].searchParams.get('bbox').split(',');
  assert.equal(crs, 'EPSG:4326');
  assert.ok(+west < coordinates.longitude && +east > coordinates.longitude && +east - west < 2.1);
  assert.ok(+south < coordinates.latitude && +north > coordinates.latitude && +north - south < 1);
  assert.equal(requests[1].searchParams.get('timestep'), '10');
});

test('FMI bbox observations tolerate several returned stations but cap collection size', () => {
  const seven = observationXml.replace('</wfs:FeatureCollection>', member(observationXml).repeat(6) + '</wfs:FeatureCollection>');
  assert.equal(decodeFmiObservation(seven, options)[0].device, 'fmisid:999001');
  const excessive = observationXml.replace('</wfs:FeatureCollection>', member(observationXml).repeat(64) + '</wfs:FeatureCollection>');
  assert.throws(() => decodeFmiObservation(excessive, options), /feature collection/);
});

test('complete FMI primary never calls the keyless Open-Meteo backup', async () => {
  const http = { text: async url => new URL(url).searchParams.get('parameters') === 'Temperature,RadiationGlobal' ? solarFixture().replaceAll('<wml2:value>NaN', '<wml2:value>0') : observationXml,
    json: async () => assert.fail('Backup must remain idle when FMI succeeds') };
  for (const fetcher of [fetchWeather, fetchOutdoorTemperature]) {
    const result = await fetcher({ connections, now: at, http });
    assert.deepEqual(result.acquisition, { primary: 'fmi', selected: 'fmi', fallbackUsed: false,
      attempts: [{ source: 'fmi', status: 'ok', error: null }], ...(fetcher === fetchWeather ? { solarSource: 'fmi' } : {}) });
  }
});

function solarFixture() {
  const temperature = member(forecastXml).replace('<gml:TimeInstant>', '<gml:TimeInstant gml:id="publication-time">');
  const radiation = member(forecastXml).replace('param=temperature', 'param=radiationglobal')
    .replace(/<om:resultTime>[\s\S]*?<\/om:resultTime>/, '<om:resultTime xlink:href="#publication-time"/>')
    .replace('<wml2:value>10.5', '<wml2:value>0').replace('<wml2:value>13', '<wml2:value>450')
    .replace('<wml2:value>14', '<wml2:value>NaN').replace('<wml2:value>15', '<wml2:value>600');
  return forecastXml.replace(member(forecastXml), temperature + radiation);
}

test('FMI combines only temperature and global radiation, resolving shared publication references', () => {
  const result = decodeFmiForecast(solarFixture(), options);
  assert.deepEqual(result.forecast.map(row => row.solarRadiationWm2), [0, 450, null]);
  assert.equal(result.solarStatus, 'partial');
  assert.ok(result.forecast.every(row => row.solar.basis === 'forecast' && row.solar.unit === 'W/m²'));
  assert.deepEqual(result.forecast.at(-1).solar.quality, ['missing-solar-forecast']);
  assert.equal(result.forecast[1].solar.intervalBasis, 'hourly-point-held-within-published-horizon');
  assert.equal(result.observations.length, 0, 'Forecast radiation is never converted into an observation');
});

test('FMI rejects conflicting or invalid radiation metadata without inventing values', () => {
  const xml = solarFixture();
  for (const bad of [xml.replace('#publication-time', '#missing'),
    xml.replace('#publication-time', 'https://example.test/publication'),
    xml.replace('param=radiationglobal', 'param=windspeedms'),
    xml.replace('<wml2:value>450', '<wml2:value>-1'),
    xml.replace('<wml2:value>450', '<wml2:value>2001')]) assert.throws(() => decodeFmiForecast(bad, options));
});
