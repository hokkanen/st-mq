import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { instantMs, normalizePriceIntervals } from '../domain/prices.js';

export const MARKET_SOURCES = Object.freeze({
  entsoe: 'https://documenter.getpostman.com/view/7009892/2s93JtP3F6',
  curves: 'https://eepublicdownloads.entsoe.eu/clean-documents/EDI/Library/cim_based/Introduction_of_different_Timeseries_possibilities__curvetypes__with_ENTSO-E_electronic_document_v1.4.pdf',
  elering: 'https://dashboard.elering.ee/v3/api-docs', inspectedAt: '2026-09-06',
});
const MAX_ROWS = 2048, MAX_SPAN = 7 * 86_400_000;
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const numeric = value => typeof value === 'number' ? value : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : NaN;
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, processEntities: false });
function span(start, end) {
  const a = instantMs(start), b = instantMs(end);
  if (b <= a || b - a > MAX_SPAN) throw new Error('Market interval must be positive and at most seven days');
  return [a, b];
}

/** XML strings may contain successive revisions of the same document; highest revision wins. */
export function decodeEntsoe(input, { fetchedAt, domain } = {}) {
  fetchedAt = instantMs(fetchedAt);
  const documents = new Map();
  const texts = array(input);
  if (texts.length > 16) throw new Error('Too many market documents');
  for (const xml of texts) {
    if (typeof xml !== 'string' || Buffer.byteLength(xml) > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid or oversized market XML');
    if (XMLValidator.validate(xml) !== true) throw new Error('Invalid market XML');
    const parsed = parser.parse(xml);
    if (parsed.Acknowledgement_MarketDocument) throw new Error('ENTSO-E returned an acknowledgement without prices');
    const doc = parsed.Publication_MarketDocument;
    if (!doc || doc.type !== 'A44' || typeof doc.mRID !== 'string') throw new Error('Expected an ENTSO-E A44 price document');
    const revision = numeric(doc.revisionNumber);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid market document revision');
    const previous = documents.get(doc.mRID);
    if (previous?.revision === revision && JSON.stringify(previous.doc) !== JSON.stringify(doc)) throw new Error('Conflicting market document revision');
    if (!previous || revision > previous.revision) documents.set(doc.mRID, { doc, revision });
  }
  const candidates = [];
  for (const { doc, revision } of documents.values()) {
    const [docStart, docEnd] = span(doc['period.timeInterval']?.start, doc['period.timeInterval']?.end);
    const issuedAt = doc.createdDateTime == null ? null : instantMs(doc.createdDateTime);
    // The server may create its response shortly after the caller records request time.
    if (issuedAt > fetchedAt + 60_000) throw new Error('Market document creation is in the future');
    for (const ts of array(doc.TimeSeries)) {
      if (ts['contract_MarketAgreement.type'] != null && ts['contract_MarketAgreement.type'] !== 'A01') throw new Error('Expected day-ahead market prices');
      if (ts['currency_Unit.name'] !== 'EUR' || ts['price_Measure_Unit.name']?.toUpperCase() !== 'MWH') throw new Error('Unsupported market currency or price unit');
      if (domain && (ts['in_Domain.mRID'] !== domain || ts['out_Domain.mRID'] !== domain)) throw new Error('Unexpected market bidding zone');
      const curve = ts.curveType ?? 'A01';
      if (!['A01', 'A03'].includes(curve)) throw new Error('Unsupported market curve type');
      for (const period of array(ts.Period)) {
        const [start, end] = span(period.timeInterval?.start, period.timeInterval?.end);
        if (start < docStart || end > docEnd) throw new Error('Market period exceeds document bounds');
        const duration = { PT15M: 900_000, PT60M: 3_600_000 }[period.resolution];
        const count = (end - start) / duration;
        if (!duration || !Number.isInteger(count) || count > MAX_ROWS) throw new Error('Unsupported market resolution or duration');
        const points = new Map();
        if (array(period.Point).length > MAX_ROWS) throw new Error('Too many market points');
        for (const point of array(period.Point)) {
          const position = numeric(point.position), value = numeric(point['price.amount']);
          if (!Number.isSafeInteger(position) || position < 1 || position > count) throw new Error('Market point position is outside period');
          // Empty A03 points explicitly interrupt a block; absence must never become zero.
          const price = Number.isFinite(value) ? value : null;
          if (point['price.amount'] != null && point['price.amount'] !== '' && price === null) throw new Error('Invalid market price');
          if (points.has(position) && points.get(position) !== price) throw new Error('Conflicting duplicate market point');
          points.set(position, price);
        }
        const sorted = [...points].sort((a, b) => a[0] - b[0]);
        for (let i = 0; i < sorted.length; i++) {
          const [position, value] = sorted[i];
          if (value === null) continue;
          const blockEnd = curve === 'A03' ? sorted[i + 1]?.[0] ?? count + 1 : position + 1;
          candidates.push({ start: start + (position - 1) * duration, end: start + (blockEnd - 1) * duration,
            value, issuedAt, issuedAtBasis: issuedAt == null ? 'not-supplied' : 'document-created',
            fetchedAt, documentId: doc.mRID, revision, resolution: period.resolution, curve });
          if (candidates.length > MAX_ROWS) throw new Error('Too many market intervals');
        }
      }
    }
  }
  const unique = new Map();
  for (const row of candidates) {
    const key = `${row.start}:${row.end}`;
    const previous = unique.get(key);
    if (previous && previous.value !== row.value) throw new Error('Conflicting overlapping market publications');
    if (!previous || (row.issuedAt ?? 0) > (previous.issuedAt ?? 0)) unique.set(key, row);
  }
  const rows = [...unique.values()].sort((a, b) => a.start - b.start);
  const intervals = normalizePriceIntervals(rows, { unit: 'EUR/MWh', vatIncluded: false, source: 'entsoe' })
    .map((p, i) => ({ ...p, ...Object.fromEntries(Object.entries(rows[i]).filter(([k]) => !['start', 'end', 'value'].includes(k))) }));
  if (!intervals.length) throw new Error('No usable market intervals');
  return { source: 'entsoe', issuedAt: Math.max(...intervals.map(p => p.issuedAt ?? -Infinity)) === -Infinity ? null : Math.max(...intervals.map(p => p.issuedAt ?? -Infinity)),
    fetchedAt, intervals, provenance: MARKET_SOURCES.entsoe };
}

/** Elering JSON has no interval end or units; require explicit verified endpoint semantics. */
export function decodeElering(body, { country, fetchedAt, intervalMinutes, durationEvidence, unit, vatIncluded } = {}) {
  fetchedAt = instantMs(fetchedAt);
  if (![15, 60].includes(intervalMinutes) || typeof durationEvidence !== 'string' || !durationEvidence.trim() || unit !== 'EUR/MWh' || vatIncluded !== false) {
    throw new Error('Elering requires verified intervalMinutes, durationEvidence, EUR/MWh and ex-VAT configuration');
  }
  const entries = body?.data?.[country];
  if (body?.success !== true || !Array.isArray(entries) || !entries.length || entries.length > MAX_ROWS) throw new Error('Invalid Elering price response');
  const unique = new Map();
  for (const row of entries) {
    if (!Number.isSafeInteger(row.timestamp) || !Number.isFinite(row.price)) throw new Error('Invalid Elering timestamp or price');
    const start = instantMs(row.timestamp * 1000);
    if (start % (intervalMinutes * 60_000) !== 0) throw new Error('Elering timestamp disagrees with configured resolution');
    if (unique.has(start) && unique.get(start).value !== row.price) throw new Error('Conflicting Elering duplicate');
    unique.set(start, { start, end: start + intervalMinutes * 60_000, value: row.price });
  }
  const rows = [...unique.values()].sort((a, b) => a.start - b.start);
  span(rows[0].start, rows.at(-1).end);
  return { source: 'elering', issuedAt: null, fetchedAt,
    intervals: normalizePriceIntervals(rows, { unit, vatIncluded, source: 'elering' })
      .map(row => ({ ...row, fetchedAt, issuedAt: null, issuedAtBasis: 'not-supplied', resolution: `PT${intervalMinutes}M`, durationEvidence })),
    provenance: MARKET_SOURCES.elering };
}

export async function fetchMarket({ connections, now, http, signal } = {}) {
  const fetchedAt = instantMs(now), start = Math.floor(fetchedAt / 3_600_000) * 3_600_000, end = start + 48 * 3_600_000;
  const country = connections?.geoloc?.country_code?.toLowerCase();
  const zones = { fi: '10YFI-1--------U', ee: '10Y1001A1001A39I', lt: '10YLT-1001A0008Q', lv: '10YLV-1001A00074' };
  const domain = connections?.entsoe?.domain ?? zones[country];
  if (connections?.entsoe?.token && domain) {
    const url = new URL('https://web-api.tp.entsoe.eu/api');
    const format = at => new Date(at).toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '');
    url.search = new URLSearchParams({ securityToken: connections.entsoe.token, documentType: 'A44', 'contract_MarketAgreement.type': 'A01',
      in_Domain: domain, out_Domain: domain, periodStart: format(start), periodEnd: format(end) });
    try { return decodeEntsoe(await http.text(url.toString(), { method: 'GET', signal }), { fetchedAt, domain }); }
    catch { if (!connections?.elering) throw new Error('ENTSO-E market acquisition failed'); }
  }
  if (!['fi', 'ee', 'lt', 'lv'].includes(country)) throw new Error('A supported market country or explicit bidding zone is required');
  if (!connections?.elering) throw new Error('Market provider credentials or verified Elering configuration are required');
  const url = new URL('https://dashboard.elering.ee/api/nps/price');
  url.search = new URLSearchParams({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  try { return decodeElering(await http.json(url.toString(), { method: 'GET', signal }), { ...connections.elering, country, fetchedAt }); }
  catch { throw new Error('Elering market acquisition failed; verify provider configuration and availability'); }
}
