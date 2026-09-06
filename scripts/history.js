#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/storage/store.js';
import { importCsv, exportCsv, seedHandoffObservations } from '../src/storage/history.js';

const usage = `Offline history administration (does not start device providers).
  node scripts/history.js import [--db data/st-mq.sqlite] [--file FILE --kind stmq|easee]
  node scripts/history.js summary [--db DB]
  node scripts/history.js export --output NEW.csv [--signal SIGNAL] [--from ISO --to ISO] [--db DB]
  node scripts/history.js backup --output NEW.sqlite [--db DB]
  node scripts/history.js restore --input BACKUP.sqlite --db NEW.sqlite
  node scripts/history.js tail [--follow] [--after ID] [--limit 100] [--db DB]
  node scripts/history.js counter --signal SIGNAL --value NUMBER --date YYYY-MM-DD [--note TEXT] [--db DB]
  node scripts/history.js annotate --kind KIND --from ISO --to ISO --note TEXT [--boundary-confidence approximate] [--db DB]
Import defaults to the two CODEX CSVs and preserves dated handoff counters/absence annotations.
ISO timestamps require Z or an explicit UTC offset. Query end times are exclusive.
Backups, restores and CSV exports require a new destination. Restore while the application is stopped.`;

function argumentsFor(argv) {
  const [command = 'help', ...rest] = argv; const options = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error(`Unexpected argument: ${rest[i]}`);
    const key = rest[i].slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option --${key}`);
    if (key === 'follow') options[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = rest[++i];
    }
  }
  return { command, options };
}
function required(options, key) { if (!options[key]) throw new Error(`--${key} is required`); return options[key]; }
function timestamp(value) {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`Timestamp requires an ISO date, time and UTC offset: ${value}`);
  return Date.parse(value);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = argumentsFor(argv);
  if (command === 'help' || command === '--help') { console.log(usage); return; }
  const accepted = {
    import: ['file', 'kind'], summary: [], export: ['output', 'signal', 'from', 'to'],
    backup: ['output'], restore: ['input'], tail: ['follow', 'after', 'limit'],
    counter: ['signal', 'value', 'date', 'note', 'device', 'provenance'],
    annotate: ['kind', 'from', 'to', 'note', 'boundary-confidence', 'provenance'],
  };
  if (!Object.hasOwn(accepted, command)) throw new Error(`Unknown command: ${command}\n${usage}`);
  for (const key of Object.keys(options)) if (key !== 'db' && !accepted[command].includes(key)) throw new Error(`Unknown option --${key} for ${command}`);
  const path = options.db ?? process.env.STMQ_DATABASE ?? resolve(process.env.STMQ_DATA_DIR ?? 'var', 'st-mq.sqlite');
  if (command === 'restore') {
    required(options, 'db');
    console.log(JSON.stringify({ restored: await Store.restore(required(options, 'input'), path) }, null, 2)); return;
  }
  const store = new Store(path); let following = false;
  try {
    let result;
    switch (command) {
      case 'import': {
        if (Boolean(options.file) !== Boolean(options.kind)) throw new Error('--file and --kind must be supplied together');
        seedHandoffObservations(store);
        const inputs = options.file ? [[options.file, options.kind]] : [['CODEX/st-mq-corrected.csv', 'stmq'], ['CODEX/easee.csv', 'easee']];
        result = [];
        for (const [file, kind] of inputs) result.push(await importCsv(store, file, { kind }));
        break;
      }
      case 'summary': result = store.summary(); break;
      case 'export': result = await exportCsv(store, required(options, 'output'), { signal: options.signal, from: timestamp(options.from), to: timestamp(options.to) }); break;
      case 'backup': result = { backup: await store.backup(required(options, 'output')) }; break;
      case 'counter': {
        result = { id: store.counter({ signal: required(options, 'signal'), value: Number(required(options, 'value')),
          observedDate: required(options, 'date'), note: options.note ?? '', device: options.device, provenance: options.provenance }) };
        store.event('history.manual_counter', result); break;
      }
      case 'annotate': {
        result = { id: store.annotation({ kind: required(options, 'kind'), startAt: timestamp(required(options, 'from')),
          endAt: timestamp(required(options, 'to')), note: required(options, 'note'),
          boundaryConfidence: options['boundary-confidence'] ?? 'approximate', provenance: options.provenance }) };
        store.event('history.annotation', result); break;
      }
      case 'tail': {
        let after = options.after === undefined ? 0 : Number(options.after);
        const limit = options.limit === undefined ? 100 : Number(options.limit);
        const print = () => {
          const rows = store.events({ after, limit });
          for (const row of rows) { console.log(JSON.stringify(row)); after = row.id; }
        };
        print();
        if (options.follow) {
          following = true;
          const timer = setInterval(print, 1000);
          const stop = () => { clearInterval(timer); store.close(); process.exitCode = 0; };
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
        }
        return;
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { if (!following) store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
