#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/storage/store.js';
import { reconstructGarageHistory } from '../src/garage/history.js';
import { replayGarageJournal } from '../src/garage/learning.js';
import { garageModelSummary } from '../src/garage/model.js';

export function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!['db', 'input', 'from', 'to', 'max-samples'].includes(key) || !args[i + 1] || Object.hasOwn(options, key))
      throw new Error('Usage: node scripts/garage-replay.js --db FILE --input historical|mqtt|providers|offline|simulated [--from ISO --to ISO --max-samples COUNT]');
    options[key] = args[i + 1];
  }
  if (!options.db || !['historical', 'mqtt', 'providers', 'offline', 'simulated'].includes(options.input))
    throw new Error('Explicit --db and --input historical|mqtt|providers|offline|simulated are required');
  const timestamp = value => {
    if (value === undefined) return undefined;
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Replay range requires an ISO timestamp with UTC offset');
    return Date.parse(value);
  };
  const from = timestamp(options.from), to = timestamp(options.to);
  const store = new Store(resolve(options.db), { readOnly: true });
  try {
    const result = options.input === 'historical' ? reconstructGarageHistory(store, {
      ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}),
      ...(options['max-samples'] ? { maxSamples: Number(options['max-samples']) } : {}) }) : replayGarageJournal(store, options.input);
    // No paths, raw rows, household device IDs or checkpoint tapes in output.
    const report = options.input === 'historical' ? { scope: result.scope, status: result.status,
      algorithm: result.algorithm, samples: result.samples, bounded: result.bounded,
      checksum: result.checksum, summary: result.summary, limitations: result.limitations }
      : { scope: `garage:${options.input}`, status: result ? 'reconstructed' : 'unavailable',
        algorithm: result?.algorithmVersion ?? null, cursor: result?.cursor ?? null,
        checksum: result?.digest ?? null, summary: result ? garageModelSummary(result.model) : null };
    console.log(JSON.stringify(report, null, 2)); return report;
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch { console.error('Garage read-only reconstruction failed. Check arguments, readable database and matching schema/version.'); process.exitCode = 1; }
}
