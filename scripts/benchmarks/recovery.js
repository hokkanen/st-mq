import assert from 'node:assert/strict';
import { recoveryWorkload } from '../../test/helpers/recovery-workload.js';

// Disposable current-schema history only. No household configuration, devices,
// credentials or remote services are read. HTTP polling uses a loopback server.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/benchmarks/recovery.js [--records=1000,10000,50000] [--windows=96] [--payload-bytes=128]');
  process.exit(0);
}
assert(args.every(value => /^--(?:records=\d+(?:,\d+)*|windows=\d+|payload-bytes=\d+)$/.test(value)), 'Unknown benchmark argument');
const sizes = (args.find(value => value.startsWith('--records='))?.slice(10) ?? '1000,10000,50000').split(',').map(Number);
const windows = Number(args.find(value => value.startsWith('--windows='))?.slice(10) ?? 96);
const payloadBytes = Number(args.find(value => value.startsWith('--payload-bytes='))?.slice(16) ?? 128);
assert(sizes.every(value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000));
assert(Number.isSafeInteger(windows) && windows > 0 && windows <= 10_000);
assert(Number.isSafeInteger(payloadBytes) && payloadBytes >= 0 && payloadBytes <= 65_536);
console.log(JSON.stringify({ node: process.version, host: `${process.platform}/${process.arch}`,
  note: 'Synthetic disk-backed recovery with concurrent local writes and loopback HTTP polling. Timings describe this host, not Raspberry Pi or household hardware.' }));
for (const records of sizes) {
  const cleanup = [], controller = new AbortController();
  const stop = () => controller.abort(new Error('Synthetic recovery benchmark cancelled'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await recoveryWorkload({ signal: controller.signal, after: callback => cleanup.push(callback) },
      { records, windows, payloadBytes, onStage: value => console.log(JSON.stringify({ records, payloadBytes, ...value })) });
    console.log(JSON.stringify({ records, windows, payloadBytes, sourceBytes: result.sourceBytes, databaseBytes: result.databaseBytes,
      liveWrites: result.liveWrites, verified: true }));
  } finally {
    controller.abort(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    for (const callback of cleanup.reverse()) await callback();
  }
}
