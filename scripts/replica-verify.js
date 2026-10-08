#!/usr/bin/env node
import { verifyReplicaPublication } from '../src/replication/publication.js';

if (process.argv.length !== 4 || process.argv[2] !== '--directory') {
  process.stderr.write('Usage: node scripts/replica-verify.js --directory /private/replica-directory\n');
  process.exitCode = 2;
} else {
  try {
    const publication = await verifyReplicaPublication(process.argv[3]);
    const { generation, digest, bytes, sourceAt, digestAlgorithm, checkpoint, fullVerification } = publication;
    process.stdout.write(`${JSON.stringify({ ok: true, verification: 'full', generation, checkpoint,
      digestAlgorithm, digest, bytes, sourceAt, verifiedAt: fullVerification.verifiedAt,
      fullDigest: fullVerification.digest, fullDigestAlgorithm: fullVerification.algorithm })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'snapshot_verification_failed' })}\n`);
    process.exitCode = 1;
  }
}
