// dataProcessor.js
import Papa from 'papaparse';

// The local electric grid voltage for all phases
const VOLTAGE = 230;
// Parcel-resolved URLs for CSV assets (use fetch to load at runtime)
const EASEE_CSV_URL = new URL('../share/st-mq/easee.csv', import.meta.url).toString();
const ST_CSV_URL = new URL('../share/st-mq/st-mq.csv', import.meta.url).toString();
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
  const tailRes = await fetch(url, { headers: { 'Range': `bytes=-${tailBytes}` }, cache: 'no-store' });
  const tailCt = (tailRes.headers.get('content-type') || '').toLowerCase();
  if (!tailRes.ok) throw new Error(`${url} tail fetch failed: ${tailRes.status} ${tailRes.statusText}`);
  if (tailCt.includes('text/html')) {
    const snippet = await tailRes.text().then(t => t.slice(0, 1024));
    throw new Error(`Expected CSV but received HTML for ${url} tail. Snippet:\n${snippet}`);
  }
  let tailText = await tailRes.text();
  // Discard partial row at the start of tail
  const firstNewline = tailText.indexOf('\n');
  if (firstNewline !== -1) {
    tailText = tailText.slice(firstNewline + 1);
  } else {
    tailText = '';
  }
  // Combine header and tail
  return header + '\n' + tailText;
}
async function fetchCsvForRange(url, start_time_unix) {
  try {
    const partial = await fetchPartialCsv(url);
    let min_time = Infinity;
    await new Promise((resolve, reject) => {
      Papa.parse(partial, {
        header: true,
        dynamicTyping: true,
        step: (results) => {
          const row = results.data;
          if (row['unix_time'] !== null && !isNaN(row['unix_time'])) {
            min_time = Math.min(min_time, row['unix_time']);
          }
        },
        complete: resolve,
        error: reject
      });
    });
    if (min_time <= start_time_unix) {
      return partial;
    } else {
      return await fetchCsv(url);
    }
  } catch (error) {
    throw error;
  }
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
export async function loadEaseeData(start_time_unix, end_time_unix) {
  const csv = await fetchCsvForRange(EASEE_CSV_URL, start_time_unix);
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
  await new Promise((resolve, reject) => {
    Papa.parse(csv, {
      header: true,
      dynamicTyping: true,
      step: (results) => {
        const row = results.data;
        if (row['unix_time'] >= start_time_unix && row['unix_time'] < end_time_unix) {
          if (!isNaN(row['ch_curr1'])) data.ch_curr1.push({ x: row['unix_time'], y: row['ch_curr1'] });
          if (!isNaN(row['ch_curr2'])) data.ch_curr2.push({ x: row['unix_time'], y: row['ch_curr2'] });
          if (!isNaN(row['ch_curr3'])) data.ch_curr3.push({ x: row['unix_time'], y: row['ch_curr3'] });
          if (!isNaN(row['ch_curr1']) && !isNaN(row['ch_curr2']) && !isNaN(row['ch_curr3'])) {
            data.ch_total.push({ x: row['unix_time'], y: VOLTAGE * (row['ch_curr1'] + row['ch_curr2'] + row['ch_curr3']) / 1000 });
          }
          if (!isNaN(row['eq_curr1'])) data.eq_curr1.push({ x: row['unix_time'], y: row['eq_curr1'] });
          if (!isNaN(row['eq_curr2'])) data.eq_curr2.push({ x: row['unix_time'], y: row['eq_curr2'] });
          if (!isNaN(row['eq_curr3'])) data.eq_curr3.push({ x: row['unix_time'], y: row['eq_curr3'] });
          if (!isNaN(row['eq_curr1']) && !isNaN(row['eq_curr2']) && !isNaN(row['eq_curr3'])) {
            data.eq_total.push({ x: row['unix_time'], y: VOLTAGE * (row['eq_curr1'] + row['eq_curr2'] + row['eq_curr3']) / 1000 });
          }
          if (row['unix_time'] !== null && !isNaN(row['unix_time'])) {
            min_time = Math.min(min_time, row['unix_time']);
            max_time = Math.max(max_time, row['unix_time']);
          }
        }
      },
      complete: (results) => {
        if (results.errors.length > 0) {
          reject(results.errors);
        } else {
          resolve();
        }
      },
      error: reject
    });
  });
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
  const csv = await fetchCsvForRange(ST_CSV_URL, start_time_unix);
  const data = {
    price: [],
    heat_on_raw: [],
    temp_in: [],
    temp_ga: [],
    temp_out: []
  };
  let min_time = Infinity;
  let max_time = -Infinity;
  await new Promise((resolve, reject) => {
    Papa.parse(csv, {
      header: true,
      dynamicTyping: true,
      step: (results) => {
        const row = results.data;
        if (row['unix_time'] >= start_time_unix && row['unix_time'] < end_time_unix) {
          if (!isNaN(row['price'])) data.price.push({ x: row['unix_time'], y: row['price'] });
          if (!isNaN(row['heat_on'])) data.heat_on_raw.push({ x: row['unix_time'], y: row['heat_on'] });
          if (!isNaN(row['temp_in'])) data.temp_in.push({ x: row['unix_time'], y: row['temp_in'] });
          if (!isNaN(row['temp_ga'])) data.temp_ga.push({ x: row['unix_time'], y: row['temp_ga'] });
          if (!isNaN(row['temp_out'])) data.temp_out.push({ x: row['unix_time'], y: row['temp_out'] });
          if (row['unix_time'] !== null && !isNaN(row['unix_time'])) {
            min_time = Math.min(min_time, row['unix_time']);
            max_time = Math.max(max_time, row['unix_time']);
          }
        }
      },
      complete: (results) => {
        if (results.errors.length > 0) {
          reject(results.errors);
        } else {
          resolve();
        }
      },
      error: reject
    });
  });
  let min_time_unix = null;
  let max_time_unix = null;
  if (min_time !== Infinity) {
    const lims = dateLims(new Date(min_time * 1000), new Date((max_time - 60) * 1000));
    min_time_unix = lims.bod;
    max_time_unix = lims.eod - 60;
  }
  return { data, min_time_unix, max_time_unix };
}