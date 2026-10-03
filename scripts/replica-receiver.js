#!/usr/bin/env node
import { runReceiver } from '../src/replication/receiver.js';
import { databaseErrorDetails } from '../src/storage/database-errors.js';

if (process.argv.length !== 3 || !process.argv[2].startsWith('/')) {
  process.stderr.write('Usage: node scripts/replica-receiver.js /absolute/private/replica-directory\n');
  process.exitCode = 2;
} else {
  try { await runReceiver({ directory: process.argv[2] }); }
  catch (error) {
    const allowed = new Set(['receiver_busy', 'directory_not_empty', 'unsafe_directory', 'invalid_protocol',
      'verification_failed', 'integrity_failed', 'snapshot_busy', 'transfer_interrupted', 'invalid_publication',
      'database_schema_mismatch', 'database_schema_invalid']);
    process.stdout.write(`${JSON.stringify({ type: 'error', code: allowed.has(error.code) ? error.code : 'receiver_failed',
      ...databaseErrorDetails(error) })}\n`);
    process.exitCode = 1;
  }
}
