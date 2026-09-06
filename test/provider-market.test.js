import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeEntsoe, decodeElering, fetchMarket } from '../src/acquisition/market.js';
import { priceIntervals } from '../src/domain/prices.js';
const xml = readFileSync(new URL('./fixtures/market-entsoe.xml', import.meta.url), 'utf8');
const at = Date.parse('2026-09-06T00:00:00Z');
const options = { fetchedAt: at, domain: '10YFI-1--------U' };

test('ENTSOE uses actual period positions, negative prices, declared hourly/quarter-hour units and gaps', () => {
  const result = decodeEntsoe(xml, options);
  assert.equal(result.intervals.length, 4);
  assert.equal(result.intervals[0].spotCtPerKwh, -5);
  assert.equal(result.intervals[1].spotCtPerKwh, 0);
  assert.equal(result.intervals[2].start, at + 45 * 60_000);
  assert.equal(result.intervals[1].end, at + 30 * 60_000);
  assert.equal(result.intervals[3].end - result.intervals[3].start, 3_600_000);
  assert.equal(result.intervals[3].spotCtPerKwh, 50);
  assert.equal(result.intervals[0].vatIncluded, false);
  assert.equal(result.issuedAt, at - 12 * 3_600_000);
});

test('A03 blocks extend only within their own period, explicit empty price interrupts the block', () => {
  const changed = xml.replace('A01</curveType>', 'A03</curveType>');
  const result = decodeEntsoe(changed, options);
  assert.equal(result.intervals[1].end, at + 45 * 60_000);
  const missing = changed.replace('<price.amount>0</price.amount>', '<price.amount/>');
  const intervals = decodeEntsoe(missing, options).intervals;
  assert.equal(intervals.length, 3);
  assert.equal(intervals[0].end, at + 15 * 60_000);
  assert.equal(intervals[1].start, at + 45 * 60_000);
});

test('ENTSOE rejects unsupported currency, units, resolution, position, malformed payload and wrong zone', () => {
  for (const changed of [xml.replace('>EUR<', '>SEK<'), xml.replace('>MWH<', '>MAW<'),
    xml.replace('PT15M', 'PT30M'), xml.replace('<position>4', '<position>5'),
    xml.replace('>500<', '>NaN<'), xml.replace('</Publication_MarketDocument>', ''),
    '<!DOCTYPE x [<!ENTITY x "value">]>' + xml, 'x'.repeat(1_000_001)]) {
    assert.throws(() => decodeEntsoe(changed, options));
  }
  assert.throws(() => decodeEntsoe(xml, { ...options, domain: 'wrong' }), /zone/);
  assert.throws(() => decodeEntsoe('<Acknowledgement_MarketDocument/>', options));
});

test('market DST delivery days retain 92 or 100 actual quarter-hour intervals', () => {
  for (const [start, end, count] of [
    ['2026-03-28T22:00:00Z', '2026-03-29T21:00:00Z', 92],
    ['2026-10-24T21:00:00Z', '2026-10-25T22:00:00Z', 100],
  ]) {
    const points = Array.from({ length: count }, (_, i) => `<Point><position>${i + 1}</position><price.amount>${i}</price.amount></Point>`).join('');
    const doc = `<Publication_MarketDocument><mRID>synthetic-dst</mRID><revisionNumber>1</revisionNumber><type>A44</type>
      <period.timeInterval><start>${start}</start><end>${end}</end></period.timeInterval>
      <TimeSeries><currency_Unit.name>EUR</currency_Unit.name><price_Measure_Unit.name>MWH</price_Measure_Unit.name><curveType>A01</curveType>
      <Period><timeInterval><start>${start}</start><end>${end}</end></timeInterval><resolution>PT15M</resolution>${points}</Period></TimeSeries></Publication_MarketDocument>`;
    const result = decodeEntsoe(doc, { fetchedAt: Date.parse(start) });
    assert.equal(result.intervals.length, count);
    assert.equal(result.intervals[0].start, Date.parse(start));
    assert.equal(result.intervals.at(-1).end, Date.parse(end));
    assert.equal(result.issuedAt, null);
  }
});

test('document revisions replace whole older versions, conflicts are never resolved by array order', () => {
  const revised = xml.replace('<revisionNumber>1', '<revisionNumber>2').replace('>500<', '>600<');
  assert.equal(decodeEntsoe([revised, xml], options).intervals.at(-1).spotCtPerKwh, 60);
  assert.equal(decodeEntsoe([xml, xml], options).intervals.length, 4);
  assert.throws(() => decodeEntsoe([xml, xml.replace('>500<', '>600<')], options), /revision/);
  assert.throws(() => decodeEntsoe([xml, xml.replace('synthetic-market-document', 'other').replace('>500<', '>600<')], options), /Conflicting/);
});

test('Elering fixed documented cadence preserves missing intervals and requires terminal duration evidence', () => {
  const options = { country: 'fi', fetchedAt: at, intervalMinutes: 15, durationEvidence: 'Synthetic endpoint contract fixture', unit: 'EUR/MWh', vatIncluded: false };
  const body = { success: true, data: { fi: [{ timestamp: at / 1000, price: -30 }, { timestamp: at / 1000 + 1800, price: 70 }] } };
  const result = decodeElering(body, options);
  assert.equal(result.intervals[0].end, at + 900_000);
  assert.equal(result.intervals[1].end, at + 2700_000);
  assert.equal(result.intervals[0].spotCtPerKwh, -3);
  assert.equal(result.issuedAt, null);
  assert.throws(() => decodeElering(body, { ...options, durationEvidence: '' }), /verified/);
  assert.throws(() => decodeElering(body, { ...options, vatIncluded: true }), /verified/);
});

test('GET helper uses existing country/token, UTC bounds, injected HTTP and sanitizes errors', async () => {
  const connections = { geoloc: { country_code: 'fi' }, entsoe: { token: 'synthetic-secret' } };
  let calls = 0;
  const result = await fetchMarket({ connections, now: at, http: { text: async (url, opts) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('periodStart'), '202609060000');
    assert.equal(parsed.searchParams.get('periodEnd'), '202609080000');
    assert.equal(parsed.searchParams.get('in_Domain'), options.domain);
    assert.equal(parsed.searchParams.get('contract_MarketAgreement.type'), 'A01');
    assert.equal(opts.method, 'GET');
    return xml;
  } } });
  assert.equal(calls, 1);
  assert.equal(result.source, 'entsoe');
  await assert.rejects(fetchMarket({ connections, now: at, http: { text: async () => { throw new Error('URL with synthetic-secret'); } } }), err => !err.message.includes('synthetic-secret'));
});

test('all-in interval splitting rejects extreme calendar spans before allocation', () => {
  assert.throws(() => priceIntervals([{ start: at, end: at + 1000 * 365 * 86_400_000, unit: 'c/kWh', vatIncluded: false, spotCtPerKwh: 1 }], {
    periods: [{ from: at, marginCtPerKwh: 0, taxCtPerKwh: 0, vatRate: 0 }],
  }), /calendar day/);
});
