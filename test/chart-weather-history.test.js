import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/storage/store.js';
import { historicalSolar } from '../src/app/chart-weather.js';
import { getChartData } from '../src/app/chart-data.js';
import { decodeFmiForecast } from '../src/acquisition/fmi.js';
import { decodeOpenMeteo } from '../src/acquisition/openmeteo.js';
import { historyDatasets } from '../chart/history-model.js';

const HOUR=3_600_000,at=Date.parse('2026-09-08T09:00:00Z');
function save(store,fetchedAt,value,{issuedAt=at,solar={}}={}) {
  return store.snapshot({kind:'weather',source:'fmi',fetchedAt,issuedAt,
    payload:{source:'fmi',fetchedAt,forecast:[{start:at,end:at+12*HOUR,source:'fmi',outdoorC:10,
      solarRadiationWm2:value,fetchedAt,issuedAt,issuedAtBasis:'provider-result-time',
      solar:{source:'fmi',fetchedAt,issuedAt,issuedAtBasis:'provider-result-time',...solar}}]}});
}
test('solar history uses forecast versions only after acquisition and does not rewrite the past',()=>{
  const store=new Store(':memory:');
  try {
    save(store,at,100);save(store,at+HOUR,200);save(store,at+3*HOUR,900);
    const rows=[...historicalSolar(store,{from:at-HOUR,to:at+4*HOUR},at+2*HOUR)];
    assert.deepEqual(rows.map(r=>[r.start,r.end,r.solarRadiationWm2]),[[at,at+HOUR,100],[at+HOUR,at+2*HOUR,200]]);
    assert.equal(store.observations({signal:'solar_radiation'}).length,0);
    const chart=getChartData({store,input:'providers',now:at+2*HOUR,startDate:'2026-09-08',left:'solar_radiation'});
    assert(chart.series.solar_radiation.some(p=>p.y===100));assert(chart.series.solar_radiation.some(p=>p.y===200));
    assert(!chart.series.solar_radiation.some(p=>p.y===900));
  }finally{store.close();}
});
test('forecast refetches preserve issuance freshness and mixed solar source metadata',()=>{
  const store=new Store(':memory:');
  try {
    save(store,at,100,{solar:{source:'openmeteo'}});
    save(store,at+5*HOUR,100,{solar:{source:'openmeteo',fetchedAt:at}});
    const rows=[...historicalSolar(store,{from:at,to:at+10*HOUR},at+10*HOUR)];
    assert(rows.length>0);assert.equal(Math.max(...rows.map(r=>r.end)),at+6*HOUR);
    assert(rows.every(r=>r.solar.source==='openmeteo'&&r.solar.fetchedAt===at));
  }finally{store.close();}
});
test('unchanged unknown-issuance solar does not become fresh again after seven hours',()=>{
  const store=new Store(':memory:');
  try {
    for(const fetchedAt of [at,at+7*HOUR])save(store,fetchedAt,100,{issuedAt:null,solar:{issuedAtBasis:'fetched-snapshot'}});
    const rows=[...historicalSolar(store,{from:at+7*HOUR,to:at+9*HOUR},at+9*HOUR)];
    assert.deepEqual(rows,[]);
  }finally{store.close();}
});

const decoderAt = Date.parse('2026-09-07T06:20:00Z');
const decoderOptions = { fetchedAt: decoderAt, coordinates: { latitude: 60.39, longitude: 25.66 } };
const openMeteoBody = JSON.parse(readFileSync(new URL('./fixtures/weather-openmeteo.json', import.meta.url)));
function fmiSolarFixture() {
  const xml = readFileSync(new URL('./fixtures/weather-fmi-forecast.xml', import.meta.url), 'utf8');
  const member = xml.slice(xml.indexOf('<wfs:member>'), xml.indexOf('</wfs:member>') + '</wfs:member>'.length);
  const temperature = member.replace('<gml:TimeInstant>', '<gml:TimeInstant gml:id="publication-time">');
  const radiation = member.replace('param=temperature', 'param=radiationglobal')
    .replace(/<om:resultTime>[\s\S]*?<\/om:resultTime>/, '<om:resultTime xlink:href="#publication-time"/>')
    .replace('<wml2:value>10.5', '<wml2:value>0').replace('<wml2:value>13', '<wml2:value>450')
    .replace('<wml2:value>14', '<wml2:value>NaN').replace('<wml2:value>15', '<wml2:value>600');
  return xml.replace(member, temperature + radiation);
}
function saveDecoded(store, payload) {
  return store.snapshot({ kind: 'weather', source: payload.source, fetchedAt: payload.fetchedAt,
    issuedAt: payload.issuedAt, payload });
}

for (const provider of ['fmi', 'openmeteo']) {
  test(`${provider} decoder snapshots distinguish archived and future forecast values without database writes`, () => {
    const store = new Store(':memory:');
    try {
      const payload = provider === 'fmi' ? decodeFmiForecast(fmiSolarFixture(), decoderOptions)
        : decodeOpenMeteo(openMeteoBody, decoderOptions);
      const now = decoderAt + 2 * HOUR, hour = Math.floor(decoderAt / HOUR) * HOUR;
      assert(payload.forecast.every(row => !Object.hasOwn(row.solar, 'fetchedAt')
        && !Object.hasOwn(row.solar, 'issuedAt') && !Object.hasOwn(row.solar, 'issuedAtBasis')),
      'Real decoder output stores shared acquisition metadata on the parent interval');
      saveDecoded(store, payload);
      const changes = store.db.prepare('SELECT total_changes() AS count').get().count;
      const rows = [...historicalSolar(store, { from: hour - HOUR, to: now + HOUR }, now)];
      const expected = provider === 'fmi'
        ? [[decoderAt, hour + HOUR, 0], [hour + 2 * HOUR, now, 450]]
        : [[decoderAt, hour + HOUR, 0], [hour + HOUR, hour + 2 * HOUR, 100], [hour + 2 * HOUR, now, 250]];
      assert.deepEqual(rows.map(row => [row.start, row.end, row.solarRadiationWm2]), expected);
      const chart = getChartData({ store, input: 'providers', now, startDate: '2026-09-07',
        left: 'solar_radiation', weather: payload });
      const history = chart.series.solar_radiation.filter(point => Number.isFinite(point.y));
      assert.deepEqual(history.map(point => [point.x, point.y]), expected.flatMap(([start, end, value]) =>
        [[start, value], [end - 1, value]]));
      if (provider === 'fmi') assert(chart.series.solar_radiation.some(point => point.y === null
        && point.x >= hour + HOUR && point.x < hour + 2 * HOUR), 'The missing FMI interval remains a chart gap');
      const future = chart.series.solar_forecast.filter(point => Number.isFinite(point.y));
      assert(future.length > 0);
      assert.equal(future[0].x, now);
      assert(future.every(point => point.x >= now));
      for (const point of [...history, ...future]) {
        assert.equal(point.source, provider);
        assert.equal(point.fetchedAt, decoderAt);
        assert.equal(point.issuedAt, payload.issuedAt);
        assert.equal(point.issuedAtBasis, payload.issuedAtBasis);
        assert.equal(point.intervalBasis, payload.forecast[0].solar.intervalBasis);
      }
      const datasets = historyDatasets(chart.series, CHART_VIEW_BY_KEY.weather).filter(dataset => dataset.yAxisID === 'left');
      assert.deepEqual(datasets.map(dataset => dataset.key), ['solar_radiation', 'solar_forecast']);
      assert.deepEqual(datasets.map(dataset => dataset.borderDash), [[8, 3, 2, 3], [8, 3, 2, 3]]);
      assert(datasets.every(dataset => dataset.stepped && !dataset.spanGaps));
      assert.equal(store.observations({ signal: 'solar_radiation' }).length, 0);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM provider_snapshot_fetches').get().count, 1);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM provider_snapshot_contents').get().count, 1);
      assert.equal(store.db.prepare('SELECT total_changes() AS count').get().count, changes,
        'Rendering archived solar does not insert observations, caches, or other database rows');
    } finally { store.close(); }
  });
}

test('mixed solar retains explicit unknown issuance instead of inheriting the FMI publication time', () => {
  const store = new Store(':memory:');
  try {
    save(store, at, 200, { issuedAt: at - 5 * HOUR,
      solar: { source: 'openmeteo', issuedAt: null, issuedAtBasis: 'fetched-snapshot' } });
    const now = at + 2 * HOUR;
    const rows = [...historicalSolar(store, { from: at, to: now }, now)];
    assert.deepEqual(rows.map(row => [row.start, row.end]), [[at, now]],
      'Fresh backup radiation survives expiry of the parent temperature publication');
    const chart = getChartData({ store, input: 'providers', now, startDate: '2026-09-08', left: 'solar_radiation' });
    const points = chart.series.solar_radiation.filter(point => Number.isFinite(point.y));
    assert(points.length > 0);
    assert(points.every(point => point.source === 'openmeteo' && point.issuedAt === null
      && point.issuedAtBasis === 'fetched-snapshot' && point.fetchedAt === at));
  } finally { store.close(); }
});

test('refetched decoder snapshots with parent-only unknown issuance expire from their original acquisition', () => {
  const store = new Store(':memory:');
  try {
    const original = decodeOpenMeteo(openMeteoBody, decoderOptions);
    for (const fetchedAt of [decoderAt, decoderAt + 5 * HOUR, decoderAt + 7 * HOUR]) {
      saveDecoded(store, { ...original, fetchedAt, forecast: original.forecast.map(row => ({ ...row, fetchedAt })) });
    }
    const now = decoderAt + 9 * HOUR;
    const rows = [...historicalSolar(store, { from: decoderAt + 5 * HOUR, to: now }, now)];
    assert(rows.length > 0);
    assert.equal(rows[0].start, decoderAt + 5 * HOUR);
    assert.equal(rows.at(-1).end, decoderAt + 6 * HOUR);
    assert.deepEqual([...historicalSolar(store, { from: decoderAt + 7 * HOUR, to: now }, now)], []);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM provider_snapshot_contents').get().count, 1);
  } finally { store.close(); }
});

test('solar history selects the valid hour from the version available then and carries a still-current hour', () => {
  const store = new Store(':memory:'), minute = 60_000;
  try {
    const snapshot = (fetchedAt, intervals) => saveDecoded(store, { source: 'fmi', fetchedAt, issuedAt: at,
      forecast: intervals.map(([start, value]) => ({ start, end: start + HOUR, outdoorC: 10,
        solarRadiationWm2: value, source: 'fmi', issuedAt: at, issuedAtBasis: 'provider-result-time', fetchedAt,
        solar: { intervalBasis: 'hourly-point-held-within-published-horizon' } })) });
    snapshot(at + 10 * minute, [[at, 100], [at + HOUR, 200], [at + 2 * HOUR, 300]]);
    snapshot(at + 30 * minute, [[at + HOUR, 900], [at + 2 * HOUR, 950]]);
    snapshot(at + 80 * minute, [[at + HOUR, 800], [at + 2 * HOUR, 850]]);
    snapshot(at + 2 * HOUR, [[at + 2 * HOUR, 999]]);
    const now = at + 100 * minute;
    const rows = [...historicalSolar(store, { from: at, to: at + 3 * HOUR }, now)];
    assert.deepEqual(rows.map(row => [row.start, row.end, row.solarRadiationWm2]), [
      [at + 10 * minute, at + 30 * minute, 100],
      [at + 30 * minute, at + HOUR, 100],
      [at + HOUR, at + 80 * minute, 900],
      [at + 80 * minute, now, 800],
    ]);
    assert(rows.every(row => row.fetchedAt <= row.start), 'No value appears before its forecast was acquired');
    assert.equal(rows[1].fetchedAt, at + 10 * minute,
      'Keeping the previous current-hour value preserves its original acquisition time');
    const chart = getChartData({ store, input: 'providers', now, startDate: '2026-09-08', left: 'solar_radiation' });
    const points = chart.series.solar_radiation.filter(point => Number.isFinite(point.y));
    assert.deepEqual([...new Set(points.map(point => point.y))], [100, 900, 800],
      'Superseded future values and the later download never appear as realized history');
    assert(points.every(point => point.x < now));
  } finally { store.close(); }
});
