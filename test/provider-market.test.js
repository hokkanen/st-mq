import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeEntsoe, decodeElering, fetchMarket, fetchEntsoe, fetchElering, marketLocation } from '../src/acquisition/market.js';
import { priceIntervals } from '../src/domain/prices.js';
import { ProviderError } from '../src/acquisition/http.js';
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

test('Elering published market cadence preserves missing intervals and terminal duration without manual configuration', () => {
  const options = { country: 'fi', fetchedAt: at };
  const body = { success: true, data: { fi: [{ timestamp: at / 1000, price: -30 }, { timestamp: at / 1000 + 1800, price: 70 }] } };
  const result = decodeElering(body, options);
  assert.equal(result.intervals[0].end, at + 900_000);
  assert.equal(result.intervals[1].end, at + 2700_000);
  assert.equal(result.intervals[0].spotCtPerKwh, -3);
  assert.equal(result.issuedAt, null);
  assert.equal(result.intervals[1].resolution, 'PT15M');
  assert.match(result.intervals[1].durationEvidence, /nordpoolgroup/);
  assert.equal(result.intervals[1].vatIncluded, false);
  assert.throws(() => decodeElering(body, { ...options, country: 'se' }), /country/);
});

test('GET helper uses existing country/token, UTC bounds, injected HTTP and sanitizes errors', async () => {
  const connections = { geoloc: { country_code: 'fi' }, entsoe: { token: 'synthetic-secret' } };
  let calls = 0;
  const result = await fetchEntsoe({ connections, now: at, http: { text: async (url, opts) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('periodStart'), '202609052100');
    assert.equal(parsed.searchParams.get('periodEnd'), '202609072100');
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


const configured = { geoloc: { country_code: 'fi' }, entsoe: { token: 'synthetic-secret' } };
const dayStart = Date.parse('2026-09-05T21:00:00Z');
const dayEnd = Date.parse('2026-09-06T21:00:00Z');
function fullDayXml({ missing = [], start = dayStart, count = 96 } = {}) {
  const end = start + count * 900_000;
  const points = Array.from({ length: count }, (_, i) => missing.includes(i) ? ''
    : `<Point><position>${i + 1}</position><price.amount>${i - 30}</price.amount></Point>`).join('');
  return `<Publication_MarketDocument><mRID>synthetic-full-day</mRID><revisionNumber>1</revisionNumber><type>A44</type>
    <period.timeInterval><start>${new Date(start).toISOString()}</start><end>${new Date(end).toISOString()}</end></period.timeInterval>
    <TimeSeries><in_Domain.mRID>${options.domain}</in_Domain.mRID><out_Domain.mRID>${options.domain}</out_Domain.mRID>
    <currency_Unit.name>EUR</currency_Unit.name><price_Measure_Unit.name>MWH</price_Measure_Unit.name><curveType>A01</curveType>
    <Period><timeInterval><start>${new Date(start).toISOString()}</start><end>${new Date(end).toISOString()}</end></timeInterval>
    <resolution>PT15M</resolution>${points}</Period></TimeSeries></Publication_MarketDocument>`;
}
function eleringDay({ start = dayStart, count = 96 } = {}) {
  return { success: true, data: { fi: Array.from({ length: count }, (_, i) => ({ timestamp: start / 1000 + i * 900, price: i - 30 })) } };
}

test('Elering hourly-to-quarter-hour transition uses the market delivery boundary, not Finnish midnight or sparse spacing', () => {
  const start = Date.parse('2025-09-30T20:00:00Z');
  const entries = [0, 3600, 7200, 8100, 9900].map((seconds, i) => ({ timestamp: start / 1000 + seconds, price: i - 3 }));
  const result = decodeElering({ success: true, data: { fi: entries } }, { country: 'fi', fetchedAt: start });
  assert.deepEqual(result.intervals.map(p => p.end - p.start), [3_600_000, 3_600_000, 900_000, 900_000, 900_000]);
  assert.deepEqual(result.intervals.map(p => p.resolution), ['PT60M', 'PT60M', 'PT15M', 'PT15M', 'PT15M']);
  assert.equal(result.intervals[3].end, Date.parse('2025-09-30T22:30:00Z'));
  assert.equal(result.intervals.at(-1).end, Date.parse('2025-09-30T23:00:00Z'));
  assert.equal(result.intervals[0].spotCtPerKwh, -0.30000000000000004);
});

test('Elering rejects malformed values, countries, conflicts, misalignment and oversized histories', () => {
  const opts = { country: 'fi', fetchedAt: at }, row = { timestamp: at / 1000, price: -10 };
  for (const entries of [[{ ...row, timestamp: row.timestamp + 1 }], [{ ...row, timestamp: row.timestamp + .1 }],
    [{ ...row, price: null }], [{ ...row, price: '4' }], [row, { ...row, price: 4 }], [],
    Array.from({ length: 2049 }, () => row), [row, { ...row, timestamp: row.timestamp + 8 * 86400 }]]) {
    assert.throws(() => decodeElering({ success: true, data: { fi: entries } }, opts));
  }
  assert.equal(decodeElering({ success: true, data: { fi: [row, row] } }, opts).intervals.length, 1);
  assert.throws(() => decodeElering({ success: false, data: { fi: [row] } }, opts));
});

test('Elering retains all actual UTC intervals in short and long Finnish DST days', () => {
  for (const [start, end, count] of [
    ['2026-03-28T22:00:00Z', '2026-03-29T21:00:00Z', 92],
    ['2026-10-24T21:00:00Z', '2026-10-25T22:00:00Z', 100],
  ]) {
    const result = decodeElering(eleringDay({ start: Date.parse(start), count }), { country: 'fi', fetchedAt: Date.parse(start) });
    assert.equal(result.intervals.length, count);
    assert.equal(result.intervals[0].start, Date.parse(start));
    assert.equal(result.intervals.at(-1).end, Date.parse(end));
  }
});

test('a healthy ENTSO-E day needs one GET; unpublished tomorrow does not trigger fallback or invented prices', async () => {
  let calls = 0;
  const result = await fetchMarket({ connections: configured, now: at, http: {
    text: async () => { calls++; return fullDayXml(); }, json: async () => { throw new Error('Fallback must not run'); },
  } });
  assert.equal(calls, 1);
  assert.equal(result.source, 'entsoe');
  assert.equal(result.intervals.at(-1).end, dayEnd);
  assert.deepEqual(result.acquisition.attempts, [{ source: 'entsoe', status: 'ok', error: null }]);
  assert.equal(result.acquisition.fallbackUsed, false);
  assert.equal(result.coverage.completeToday, true);
});

test('missing current, internal gaps, truncated today and HTTP failures automatically select original Elering', async () => {
  for (const primary of [fullDayXml({ missing: [12] }), fullDayXml({ missing: [20] }), fullDayXml({ count: 48 }), new ProviderError('provider-http-error', 503)]) {
    let requests = 0;
    const result = await fetchMarket({ connections: configured, now: at, http: {
      text: async () => { requests++; if (primary instanceof Error) throw primary; return primary; },
      json: async (input, options) => {
        requests++; const url = new URL(input);
        assert.equal(url.origin, 'https://dashboard.elering.ee');
        assert.equal(url.pathname, '/api/nps/price');
        assert.equal(url.searchParams.get('start'), '2026-09-05T21:00:00.000Z');
        assert.equal(url.searchParams.get('end'), '2026-09-07T20:59:59.999Z');
        assert.equal(url.searchParams.has('securityToken'), false);
        assert.equal(options.method, 'GET');
        return eleringDay();
      },
    } });
    assert.equal(requests, 2);
    assert.equal(result.source, 'elering');
    assert.equal(result.acquisition.fallbackUsed, true);
    assert.equal(result.coverage.completeToday, true);
    assert.ok(result.intervals.every(row => row.source === 'elering' && row.vatIncluded === false));
  }
});

test('original Elering works without any API key or undocumented settings and explicit bidding zone takes precedence', async () => {
  const noKey = { geoloc: { country_code: 'FI' } };
  const result = await fetchMarket({ connections: noKey, now: at, http: { json: async () => eleringDay() } });
  assert.equal(result.source, 'elering');
  assert.equal(result.acquisition.attempts[0].status, 'not-configured');
  assert.equal(marketLocation({ entsoe: { domain: options.domain } }).country, 'fi');
  assert.equal(marketLocation({ geoloc: { country_code: 'ee' }, entsoe: { domain: options.domain } }).country, 'fi');
  await assert.rejects(fetchElering({ connections: { geoloc: { country_code: 'fi' }, entsoe: { domain: 'other-zone' } }, now: at, http: {
    json: async () => { throw new Error('Must not request the wrong country'); },
  } }), error => error.code === 'elering-not-configured');
});

test('a failed backup retains a usable partial primary with its real gaps and sanitized diagnostics', async () => {
  const result = await fetchMarket({ connections: configured, now: at, http: {
    text: async () => fullDayXml({ missing: [20] }), json: async () => { throw new Error('body synthetic-secret'); },
  } });
  assert.equal(result.source, 'entsoe');
  assert.equal(result.coverage.gaps, true);
  assert.equal(result.coverage.continuousUntil, dayStart + 20 * 900_000);
  assert.equal(result.acquisition.attempts[1].status, 'error');
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('future-only or stale Elering cannot masquerade as a live current price', async () => {
  for (const start of [at + 900_000, at - 2 * 86400_000]) {
    await assert.rejects(fetchElering({ connections: configured, now: at, http: {
      json: async () => eleringDay({ start, count: 4 }),
    } }), error => error.code === 'elering-current-price-missing');
  }
});

test('per-source backoff suppresses requests and rate-limit diagnostics retain only a safe status and delay', async () => {
  let keyedRequests = 0;
  const http = { text: async () => { keyedRequests++; throw Object.assign(new ProviderError('provider-http-error', 429), { retryAfterMs: 7200_000 }); },
    json: async () => eleringDay() };
  let result = await fetchMarket({ connections: configured, now: at, http });
  assert.deepEqual(result.acquisition.attempts[0], { source: 'entsoe', status: 'error', error: 'HTTP-429', retryAfterMs: 7200_000 });
  result = await fetchMarket({ connections: configured, now: at, http, skipSources: ['entsoe'] });
  assert.equal(keyedRequests, 1);
  assert.equal(result.acquisition.attempts[0].status, 'backoff');
  assert.equal(result.source, 'elering');
  await assert.rejects(fetchMarket({ connections: configured, now: at, http, skipSources: ['entsoe', 'elering'] }), error =>
    error.code === 'market-providers-unavailable' && error.acquisition.attempts.every(a => a.status === 'backoff'));
});

test('cancellation during the primary request never calls a fallback', async () => {
  const controller = new AbortController(); let fallback = 0;
  await assert.rejects(fetchMarket({ connections: configured, now: at, signal: controller.signal, http: {
    text: async () => { controller.abort(new Error('synthetic-secret')); throw new Error('synthetic-secret'); },
    json: async () => { fallback++; return eleringDay(); },
  } }), error => error.code === 'provider-request-aborted' && !error.message.includes('synthetic-secret'));
  assert.equal(fallback, 0);
});

test('total failure retains per-source retry diagnostics without provider messages or tokens', async () => {
  await assert.rejects(fetchMarket({ connections: configured, now: at, http: {
    text: async () => { throw Object.assign(new ProviderError('provider-http-error', 429), { retryAfterMs: 7200_000 }); },
    json: async () => { throw Object.assign(new ProviderError('provider-http-error', 503), { retryAfterMs: 1800_000 }); },
  } }), error => {
    assert.equal(error.code, 'market-providers-unavailable');
    assert.equal(error.status, 503);
    assert.equal(error.retryAfterMs, 1800_000);
    assert.deepEqual(error.acquisition.attempts.map(a => [a.source, a.error, a.retryAfterMs]),
      [['entsoe', 'HTTP-429', 7200_000], ['elering', 'HTTP-503', 1800_000]]);
    assert.equal(error.acquisition.selected, null);
    return true;
  });
});

test('public query bounds include the complete selected Finnish days across DST and clip unsolicited rows', async () => {
  for (const [now, start, end, count] of [
    ['2026-03-29T10:00:00Z', '2026-03-28T22:00:00.000Z', '2026-03-30T20:59:59.999Z', 188],
    ['2026-10-25T10:00:00Z', '2026-10-24T21:00:00.000Z', '2026-10-26T21:59:59.999Z', 196],
  ]) {
    const result = await fetchElering({ connections: configured, now: Date.parse(now), http: { json: async input => {
      const url = new URL(input);
      assert.equal(url.searchParams.get('start'), start);
      assert.equal(url.searchParams.get('end'), end);
      return eleringDay({ start: Date.parse(start) - 900_000, count: count + 2 });
    } } });
    assert.equal(result.intervals.length, count);
    assert.equal(result.intervals[0].start, Date.parse(start));
    assert.equal(result.intervals.at(-1).end, Date.parse(end) + 1);
  }
});
