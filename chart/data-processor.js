import Papa from 'papaparse';

// The local electric grid voltage for all phases
const VOLTAGE = 230;
// Parcel-resolved URLs for CSV assets (use fetch to load at runtime)
const EASEE_CSV_URL = new URL('../share/st-mq/easee.csv', import.meta.url).toString();
const ST_CSV_URL = new URL('../share/st-mq/st-mq.csv', import.meta.url).toString();
const EASEE_PATH = './share/st-mq/easee.csv';
const ST_PATH = './share/st-mq/st-mq.csv';
const EASEE_CACHE_KEY = 'easee';
const ST_CACHE_KEY = 'st-mq';
// Small helper to fetch CSV text and detect HTML fallbacks
async function fetchCsv(url) {
  const res = await fetch(url, { cache: 'no-store' });
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) throw new Error(`${url} fetch failed: ${res.status} ${res.statusText}`);
  if (ct.includes('text/html')) {
    const snippet = await res.text().then(t => t.slice(0, 1024));
    throw new Error(`Expected CSV but received HTML for ${url}. Snippet:\n${snippet}`);
  }
  return await res.text();
}
// Helper to fetch partial CSV (header + last N bytes)
async function fetchPartialCsv(url, tailBytes = 50000) {
  // Get file size via HEAD
  const headRes = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!headRes.ok) throw new Error(`${url} HEAD fetch failed: ${headRes.status} ${headRes.statusText}`);
  const contentLength = headRes.headers.get('content-length');
  if (!contentLength) throw new Error('Content-Length header not available');
  const fileSize = parseInt(contentLength, 10);
  if (isNaN(fileSize)) throw new Error('Invalid Content-Length');
  const startByte = Math.max(0, fileSize - tailBytes);
  const tailRange = `bytes=${startByte}-${fileSize - 1}`;
  // Fetch prefix for header
  const prefixRes = await fetch(url, { headers: { 'Range': 'bytes=0-1023' }, cache: 'no-store' });
  const prefixCt = (prefixRes.headers.get('content-type') || '').toLowerCase();
  if (!prefixRes.ok) throw new Error(`${url} prefix fetch failed: ${prefixRes.status} ${prefixRes.statusText}`);
  if (prefixCt.includes('text/html')) {
    const snippet = await prefixRes.text().then(t => t.slice(0, 1024));
    throw new Error(`Expected CSV but received HTML for ${url} prefix. Snippet:\n${snippet}`);
  }
  const prefixText = await prefixRes.text();
  // Extract header row
  const newlineIdx = prefixText.indexOf('\n');
  if (newlineIdx === -1) throw new Error('No header found in CSV prefix');
  const header = prefixText.slice(0, newlineIdx).trim();
  // Fetch tail
  const tailRes = await fetch(url, { headers: { 'Range': tailRange }, cache: 'no-store' });
  const tailCt = (tailRes.headers.get('content-type') || '').toLowerCase();
  if (!tailRes.ok) throw new Error(`${url} tail fetch failed: ${tailRes.status} ${tailRes.statusText}`);
  if (tailCt.includes('text/html')) {
    const snippet = await tailRes.text().then(t => t.slice(0, 1024));
    throw new Error(`Expected CSV but received HTML for ${url} tail. Snippet:\n${snippet}`);
  }
  let tailText = await tailRes.text();
  // Handle tail: discard partial row at the start if present
  const firstNewlineIdx = tailText.indexOf('\n');
  if (firstNewlineIdx === -1) {
    tailText = '';
  } else {
    const firstLine = tailText.slice(0, firstNewlineIdx);
    const parsedFirst = Papa.parse(firstLine, { header: false, dynamicTyping: true }).data[0] || [];
    const headerFields = Papa.parse(header, { header: false, dynamicTyping: true }).data[0] || [];
    const expectedCols = headerFields.length;
    const isValidRow = parsedFirst.length === expectedCols && typeof parsedFirst[0] === 'number' && !isNaN(parsedFirst[0]);
    if (!isValidRow) {
      tailText = tailText.slice(firstNewlineIdx + 1);
    }
  }
  // Combine header and tail
  return header + '\n' + tailText;
}
// Cache management
const caches = new Map();
function getCache(key) {
  return caches.get(key);
}
function setCache(key, data) {
  caches.set(key, data);
}
// Binary search for lower bound (first index where key(row) >= target)
function binarySearch(arr, target, key) {
  let left = 0;
  let right = arr.length;
  while (left < right) {
    const mid = left + Math.floor((right - left) / 2);
    if (key(arr[mid]) < target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}
// Parse text to rows using step
async function parseToRows(text, url) {
  const rows = [];
  await new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: true,
      dynamicTyping: true,
      step: (results) => {
        const row = results.data;
        if (row.unix_time !== null && !isNaN(row.unix_time)) {
          rows.push(row);
        }
      },
      complete: (results) => {
        if (results.errors.length > 0) {
          reject(new Error(`Parse errors in ${url}: ${JSON.stringify(results.errors.slice(0, 5))}`)); // Limit to first 5 errors
        } else {
          resolve();
        }
      },
      error: reject
    });
  });
  // Ensure sorted by unix_time
  rows.sort((a, b) => a.unix_time - b.unix_time);
  return rows;
}
// Get rows for the range, using cache, partial, or full fetch
async function getRowsForRange(url, start_time_unix, cacheKey, tailBytes = 50000) {
  let cache = getCache(cacheKey);
  if (cache?.rows?.length > 0) {
    if (cache.isFull || cache.rows[0].unix_time <= start_time_unix) {
      const type = cache.isFull ? 'full' : 'partial';
      console.log(`Using ${type} cache for ${cacheKey}`);
      return cache.rows;
    } else if (!cache.isFull) {
      // Partial cache exists but insufficient, fetch full
      const fullText = await fetchCsv(url);
      const fullRows = await parseToRows(fullText, url);
      setCache(cacheKey, { rows: fullRows, isFull: true });
      console.log(`Fetched full data for ${cacheKey} and cached ${fullRows.length} rows for ${url}`);
      return fullRows;
    }
  }
  let rows;
  try {
    const partialText = await fetchPartialCsv(url, tailBytes);
    const kbSize = (partialText.length / 1024).toFixed(0);
    const partialRows = await parseToRows(partialText, url);
    if (partialRows.length > 0 && partialRows[0].unix_time <= start_time_unix) {
      console.log(`Fetched partial data (${kbSize}kb) for ${cacheKey} and cached ${partialRows.length} rows for ${url}`);
      setCache(cacheKey, { rows: partialRows, isFull: false });
      rows = partialRows;
    } else {
      const fullText = await fetchCsv(url);
      const fullRows = await parseToRows(fullText, url);
      setCache(cacheKey, { rows: fullRows, isFull: true });
      console.log(`Fetched full data for ${cacheKey} and cached ${fullRows.length} rows for ${url}`);
      rows = fullRows;
    }
  } catch (e) {
    console.warn(`Partial fetch failed for ${cacheKey}, falling back to full: ${e.message}`);
    const fullText = await fetchCsv(url);
    const fullRows = await parseToRows(fullText, url);
    setCache(cacheKey, { rows: fullRows, isFull: true });
    console.log(`Fetched full data for ${cacheKey} and cached ${fullRows.length} rows for ${url}`);
    rows = fullRows;
  }
  return rows;
}
// Get the beginning and end of the day
function dateLims(start_date, end_date) {
  let bod_date = new Date(start_date);
  bod_date.setHours(0, 0, 0, 0);
  let eod_date = new Date(end_date);
  eod_date.setHours(24, 1, 0, 0);
  const bod = Math.floor(bod_date.getTime() / 1000);
  const eod = Math.floor(eod_date.getTime() / 1000);
  return { bod, eod };
}
export async function prefetchFullData() {
  await getRowsForRange(EASEE_CSV_URL, 0, EASEE_CACHE_KEY);
  await getRowsForRange(ST_CSV_URL, 0, ST_CACHE_KEY);
}
export async function loadEaseeData(start_time_unix, end_time_unix) {
  let rows;
  try {
    rows = await getRowsForRange(EASEE_CSV_URL, start_time_unix, EASEE_CACHE_KEY);
    if (rows.length === 0) {
      return { error: { type: 'hasNoValidData', message: `Cannot find valid data in ${EASEE_PATH}` } };
    }
  } catch (e) {
    console.error('Error loading Easee data:', e);
    let type;
    let msg;
    if (e.message.includes('Expected CSV but received HTML') || e.message.match(/fetch failed:.*404/)) {
      type = 'isMissing';
      msg = `Cannot access ${EASEE_PATH}`;
    } else {
      type = 'hasNoValidData';
      msg = `Cannot find valid data in ${EASEE_PATH}`;
    }
    return { error: { type, message: msg } };
  }
  const startIdx = binarySearch(rows, start_time_unix, row => row.unix_time);
  let endIdx = startIdx;
  while (endIdx < rows.length && rows[endIdx].unix_time < end_time_unix) {
    endIdx++;
  }
  const periodRows = rows.slice(startIdx, endIdx);
  const data = {
    ch_curr1: [],
    ch_curr2: [],
    ch_curr3: [],
    ch_total: [],
    eq_curr1: [],
    eq_curr2: [],
    eq_curr3: [],
    eq_total: []
  };
  let min_time = Infinity;
  let max_time = -Infinity;
  for (const row of periodRows) {
    const ut = row.unix_time;
    if (!isNaN(row.ch_curr1)) data.ch_curr1.push({ x: ut, y: row.ch_curr1 });
    if (!isNaN(row.ch_curr2)) data.ch_curr2.push({ x: ut, y: row.ch_curr2 });
    if (!isNaN(row.ch_curr3)) data.ch_curr3.push({ x: ut, y: row.ch_curr3 });
    if (!isNaN(row.ch_curr1) && !isNaN(row.ch_curr2) && !isNaN(row.ch_curr3)) {
      data.ch_total.push({ x: ut, y: VOLTAGE * (row.ch_curr1 + row.ch_curr2 + row.ch_curr3) / 1000 });
    }
    if (!isNaN(row.eq_curr1)) data.eq_curr1.push({ x: ut, y: row.eq_curr1 });
    if (!isNaN(row.eq_curr2)) data.eq_curr2.push({ x: ut, y: row.eq_curr2 });
    if (!isNaN(row.eq_curr3)) data.eq_curr3.push({ x: ut, y: row.eq_curr3 });
    if (!isNaN(row.eq_curr1) && !isNaN(row.eq_curr2) && !isNaN(row.eq_curr3)) {
      data.eq_total.push({ x: ut, y: VOLTAGE * (row.eq_curr1 + row.eq_curr2 + row.eq_curr3) / 1000 });
    }
    min_time = Math.min(min_time, ut);
    max_time = Math.max(max_time, ut);
  }
  let min_time_unix = null;
  let max_time_unix = null;
  if (min_time !== Infinity) {
    const lims = dateLims(new Date(min_time * 1000), new Date((max_time - 60) * 1000));
    min_time_unix = lims.bod;
    max_time_unix = lims.eod - 60;
  }
  return { data, min_time_unix, max_time_unix };
}
export async function loadStData(start_time_unix, end_time_unix) {
  let rows;
  try {
    rows = await getRowsForRange(ST_CSV_URL, start_time_unix, ST_CACHE_KEY);
    if (rows.length === 0) {
      return { error: { type: 'hasNoValidData', message: `Cannot find valid data in ${ST_PATH}` } };
    }
  } catch (e) {
    console.error('Error loading ST data:', e);
    let type;
    let msg;
    if (e.message.includes('Expected CSV but received HTML') || e.message.match(/fetch failed:.*404/)) {
      type = 'isMissing';
      msg = `Cannot access ${ST_PATH}`;
    } else {
      type = 'hasNoValidData';
      msg = `Cannot find valid data in ${ST_PATH}`;
    }
    return { error: { type, message: msg } };
  }
  const startIdx = binarySearch(rows, start_time_unix, row => row.unix_time);
  let endIdx = startIdx;
  while (endIdx < rows.length && rows[endIdx].unix_time < end_time_unix) {
    endIdx++;
  }
  const periodRows = rows.slice(startIdx, endIdx);
  const data = {
    price: [],
    heat_on_raw: [],
    temp_in: [],
    temp_ga: [],
    temp_out: []
  };
  let min_time = Infinity;
  let max_time = -Infinity;
  for (const row of periodRows) {
    const ut = row.unix_time;
    if (!isNaN(row.price)) data.price.push({ x: ut, y: row.price });
    if (!isNaN(row.heat_on)) data.heat_on_raw.push({ x: ut, y: row.heat_on });
    if (!isNaN(row.temp_in)) data.temp_in.push({ x: ut, y: row.temp_in });
    if (!isNaN(row.temp_ga)) data.temp_ga.push({ x: ut, y: row.temp_ga });
    if (!isNaN(row.temp_out)) data.temp_out.push({ x: ut, y: row.temp_out });
    min_time = Math.min(min_time, ut);
    max_time = Math.max(max_time, ut);
  }
  let min_time_unix = null;
  let max_time_unix = null;
  if (min_time !== Infinity) {
    const lims = dateLims(new Date(min_time * 1000), new Date((max_time - 60) * 1000));
    min_time_unix = lims.bod;
    max_time_unix = lims.eod - 60;
  }
  return { data, min_time_unix, max_time_unix };
}