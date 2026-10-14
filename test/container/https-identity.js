// Networkless packaging fixture. The runner hides /sys and the Alpine image has
// no /etc/machine-id. Only Supervisor's transport is substituted; the shipped
// identity reader and saved-marker admission run normally in a disposable /tmp.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installationBinding, helperLocations } from '../../src/https/helper.js';

assert.equal(process.env.STMQ_ADDON, '1');
const directory = await mkdtemp('/tmp/stmq-addon-https-identity-');
const originalFetch = globalThis.fetch;
const machineId = '1234567890abcdef1234567890abcdef';
let reportedId = machineId; let calls = 0; let socketDirectory;
process.env.SUPERVISOR_TOKEN = 'synthetic-addon-supervisor-identity';
globalThis.fetch = async (url, options) => {
  calls++;
  assert.equal(url, 'http://supervisor/info');
  assert.equal(options.headers.Authorization, `Bearer ${process.env.SUPERVISOR_TOKEN}`);
  assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
  return new Response(JSON.stringify({ result: 'ok', data: { machine_id: reportedId } }));
};
try {
  await assert.rejects(installationBinding(), { code: 'helper_installation_binding_unavailable' });
  assert.equal(calls, 0, 'Standalone lookup cannot use Supervisor');
  const managerDirectory = resolve(directory, 'https'); await mkdir(managerDirectory, { mode: 0o700 });
  const dataDir = resolve(directory, 'controller');
  const locations = await helperLocations(dataDir, managerDirectory, { addon: true }); socketDirectory = locations.socketDirectory;
  const marker = resolve(locations.identity, 'stmq-owner.json'); const saved = await readFile(marker, 'utf8');
  assert.equal(saved.includes(machineId), false); assert.equal(saved.includes(process.env.SUPERVISOR_TOKEN), false);
  await helperLocations(dataDir, managerDirectory, { addon: true }); assert.equal(await readFile(marker, 'utf8'), saved);
  reportedId = null;
  await assert.rejects(helperLocations(dataDir, managerDirectory, { addon: true }), { code: 'helper_installation_binding_unavailable' });
  assert.equal(await readFile(marker, 'utf8'), saved);
  reportedId = 'abcdef1234567890abcdef1234567890';
  await assert.rejects(helperLocations(dataDir, managerDirectory, { addon: true }), { code: 'identity_restore_required' });
  assert.equal(await readFile(marker, 'utf8'), saved);
  console.log(`Add-on HTTPS identity fixture passed: ${process.arch}, no host identity files, authenticated Supervisor fallback, restart and preservation.`);
} finally {
  globalThis.fetch = originalFetch;
  if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
}
