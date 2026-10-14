import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, lstat, chown, chmod, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpsError, privateDirectory, atomicJson, readJson, outsideCheckout } from './storage.js';

const UID = 65534; const GID = 65534;
export const RESTRICTION_FLAGS = Object.freeze(['--accept-dns=false', '--accept-routes=false', '--shields-up=true', '--exit-node=',
  '--exit-node-allow-lan-access=false', '--advertise-routes=', '--advertise-exit-node=false', '--advertise-tags=', '--advertise-connector=false',
  '--ssh=false', '--webclient=false', '--auto-update=false', '--update-check=true']);

export function restrictedEnvironment(directory) {
  return { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C', GOMAXPROCS: '1', GOMEMLIMIT: '128MiB' };
}

export function effectiveRestrictions(prefs, serve) {
  return prefs?.CorpDNS === false && prefs.RouteAll === false && prefs.ShieldsUp === true && prefs.RunSSH === false && prefs.RunWebClient === false &&
    !prefs.ExitNodeID && (!prefs.ExitNodeIP || prefs.ExitNodeIP === '0.0.0.0' || prefs.ExitNodeIP === '::') && prefs.ExitNodeAllowLANAccess === false &&
    (prefs.AdvertiseRoutes === null || Array.isArray(prefs.AdvertiseRoutes) && prefs.AdvertiseRoutes.length === 0) && (prefs.AdvertiseTags === null || Array.isArray(prefs.AdvertiseTags) && prefs.AdvertiseTags.length === 0) &&
    prefs.AppConnector?.Advertise === false && prefs.AutoUpdate?.Apply === false && prefs.AutoUpdate?.Check === true &&
    prefs.RemoteConfig === false && (serve === null || typeof serve === 'object' && !Array.isArray(serve) && Object.keys(serve).length === 0);
}

export function localApi(socket, path, { timeout = 5000 } = {}) {
  if (!['/localapi/v0/status', '/localapi/v0/prefs', '/localapi/v0/serve-config'].includes(path)) throw httpsError('helper_api_path_invalid');
  return new Promise((resolveResponse, reject) => {
    const req = request({ socketPath: socket, path, headers: { Host: 'local-tailscaled.sock' }, timeout }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(httpsError('helper_api_unavailable')); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 512 * 1024) req.destroy(httpsError('helper_api_response_too_large')); else chunks.push(chunk); });
      response.once('end', () => { try { resolveResponse(JSON.parse(Buffer.concat(chunks))); } catch { reject(httpsError('helper_api_schema_invalid')); } });
      response.once('error', () => reject(httpsError('helper_api_unavailable')));
    });
    req.once('timeout', () => req.destroy(httpsError('helper_api_timeout')));
    req.once('error', error => reject(error?.code?.startsWith('helper_') ? error : httpsError(error.code === 'ECONNREFUSED' ? 'helper_api_socket_refused' : error.code === 'ENOENT' ? 'helper_api_socket_absent' : 'helper_api_unavailable'))); req.end();
  });
}

async function safeOwnedDirectory(directory, uid, gid) {
  await mkdir(directory, { mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== uid && info.uid !== process.getuid())) throw httpsError('helper_directory_unsafe');
  if (process.getuid() === 0) await chown(directory, uid, gid);
  await chmod(directory, 0o700);
}

async function verifyPrivilege(pid, { uid, gid, requireClearGroups }) {
  let status;
  try { status = await readFile(`/proc/${pid}/status`, 'utf8'); } catch { throw httpsError('helper_privilege_check_failed'); }
  const get = field => new RegExp(`^${field}:[ \\t]*(.*)$`, 'm').exec(status)?.[1]?.trim();
  const ids = field => get(field)?.split(/\s+/).map(Number);
  if (!ids('Uid')?.every(value => value === uid) || !ids('Gid')?.every(value => value === gid) || uid === 0 ||
      !['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].every(field => /^0+$/.test(get(field) ?? '')) || get('NoNewPrivs') !== '1' ||
      requireClearGroups && get('Groups')?.trim()) throw httpsError('helper_privilege_check_failed');
}

export async function installationBinding({ addon = false, signal, environment = process.env,
  readIdentity = readFile, fetchImpl = (...args) => fetch(...args) } = {}) {
  for (const path of ['/sys/class/dmi/id/product_uuid', '/sys/firmware/devicetree/base/serial-number', '/etc/machine-id']) {
    const value = await readIdentity(path).catch(() => null);
    if (value && value.length > 4 && value.length < 256 && value.toString().replace(/\0/g, '').trim())
      return createHash('sha256').update(path).update('\0').update(value).digest('hex');
  }
  // Supervisor exposes the underlying host's machine-id without opening host
  // files or granting hardware/API administration privileges to the add-on.
  // This application-side request never passes its token to the helper.
  if (addon && typeof environment.SUPERVISOR_TOKEN === 'string' && environment.SUPERVISOR_TOKEN) {
    try {
      const response = await fetchImpl('http://supervisor/info', { method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${environment.SUPERVISOR_TOKEN}`, Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 64 * 1024) throw Error();
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const machineId = result?.data?.machine_id;
      if (result?.result !== 'ok' || typeof machineId !== 'string' || !/^[a-f0-9]{32}$/i.test(machineId) || /^0+$/.test(machineId)) throw Error();
      return createHash('sha256').update('home-assistant:supervisor:machine_id').update('\0').update(machineId.toLowerCase()).digest('hex');
    } catch { /* Preserve identity; transport/response details can contain secrets. */ }
  }
  throw httpsError('helper_installation_binding_unavailable');
}

export async function helperLocations(dataDir, managerDirectory, { restoreFenced = false, addon = false, signal,
  getInstallationBinding = installationBinding } = {}) {
  if (process.platform !== 'linux' || !process.getuid) throw httpsError('helper_platform_unsupported');
  const root = process.getuid() === 0;
  await outsideCheckout(managerDirectory);
  // Never open up private household-data ancestors. On root-run HA, the helper
  // owns its separate persistent sibling; the application alone owns certs and
  // accepted executables. Parent traversal is checked by an actual launch.
  const sibling = resolve(managerDirectory) === resolve(dataDir, 'https') ? dataDir : managerDirectory;
  const identity = root ? resolve(dirname(sibling), `.${basename(sibling)}-https-helper`) : resolve(managerDirectory, 'identity');
  await outsideCheckout(identity);
  const marker = resolve(identity, 'stmq-owner.json');
  const binding = await getInstallationBinding({ addon, signal });
  try { await safeOwnedDirectory(identity, root ? UID : process.getuid(), root ? GID : process.getgid()); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(identity);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== (root ? UID : process.getuid()) || (info.mode & 0o077)) throw httpsError('helper_directory_unsafe');
  const saved = await readJson(marker);
  if (saved !== null && (typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(key => !['version', 'dataDirectoryHash', 'managerDirectoryHash', 'installationBinding', 'fencedRestoreConfirmedAt'].includes(key)) ||
      saved.version !== 1 || !['dataDirectoryHash', 'managerDirectoryHash', 'installationBinding'].every(field => /^[a-f0-9]{64}$/.test(saved[field] ?? '')) ||
      saved.fencedRestoreConfirmedAt !== undefined && (!Number.isFinite(saved.fencedRestoreConfirmedAt) || saved.fencedRestoreConfirmedAt <= 0))) throw httpsError('helper_identity_marker_invalid');
  const bindingRecord = { version: 1, dataDirectoryHash: createHash('sha256').update(dataDir).digest('hex'), managerDirectoryHash: createHash('sha256').update(managerDirectory).digest('hex'), installationBinding: binding };
  if (saved && (saved.dataDirectoryHash !== bindingRecord.dataDirectoryHash || saved.managerDirectoryHash !== bindingRecord.managerDirectoryHash || saved.installationBinding !== binding)) {
    if (!restoreFenced) throw httpsError('identity_restore_required');
    await atomicJson(marker, { ...bindingRecord, fencedRestoreConfirmedAt: Date.now() });
    if (root) await chown(marker, UID, GID);
  }
  if (!saved) {
    if ((await readdir(identity)).length) throw httpsError('helper_unowned_identity_present');
    await atomicJson(marker, bindingRecord);
    if (root) await chown(marker, UID, GID);
  }
  const socketDirectory = resolve('/tmp', `stmq-h-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`);
  try { await safeOwnedDirectory(socketDirectory, root ? UID : process.getuid(), root ? GID : process.getgid()); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const socketInfo = await lstat(socketDirectory);
  if (!socketInfo.isDirectory() || socketInfo.isSymbolicLink() || socketInfo.uid !== (root ? UID : process.getuid()) || socketInfo.mode & 0o077) throw httpsError('helper_socket_directory_unsafe');
  return { identity, socketDirectory, socket: resolve(socketDirectory, 's'), uid: root ? UID : process.getuid(), gid: root ? GID : process.getgid(), root };
}

export async function launchRestricted(file, args, { locations, foreground = false, timeout = 20000, cwd = locations.identity, onProcess, includeStderr = false } = {}) {
  const binary = await open(file, 'r');
  const root = locations.root;
  let launcher;
  for (const path of ['/usr/bin/setpriv', '/bin/setpriv']) { if ((await lstat(path).catch(() => null))?.isFile() || (await lstat(path).catch(() => null))?.isSymbolicLink()) { launcher = path; break; } }
  if (!launcher) { await binary.close(); throw httpsError('helper_launcher_unavailable'); }
  let child;
  try {
    child = spawn(launcher, ['--no-new-privs', process.execPath, fileURLToPath(new URL('./privilege-launcher.js', import.meta.url)),
      String(locations.uid), String(locations.gid), root ? 'root' : 'user', ...args], {
      cwd, env: restrictedEnvironment(cwd), stdio: ['ignore', 'pipe', 'pipe', binary.fd, 'pipe'], detached: true,
    });
  } finally { await binary.close(); }
  let bytes = 0; const chunks = []; let overflow = false;
  for (const output of [child.stdout, child.stderr]) output.on('data', chunk => {
    if (foreground) return;
    bytes += chunk.length;
    if (bytes > 256 * 1024) { overflow = true; killGroup(child, 'SIGKILL'); } else if (output === child.stdout || includeStderr) chunks.push(chunk);
  });
  const completion = new Promise((resolveProcess, reject) => {
    child.once('error', () => reject(httpsError('helper_launcher_unavailable')));
    child.once('close', code => code === 0 && !overflow ? resolveProcess(Buffer.concat(chunks).toString('utf8')) : reject(httpsError(overflow ? 'helper_output_limit_exceeded' : 'helper_command_failed')));
  });
  // Observe every foreground completion even if it fails before supervision.
  completion.catch(() => {});
  child.once('exit', (code, signal) => {
    if (code !== 0 || signal) {
      // A wrapper failure must not leave a daemon retaining the identity. This
      // process group was created exclusively by this owned spawn.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already reaped */ }
    }
  });
  const record = { child, completion, ownedPid: null };
  onProcess?.(record);
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), timeout); timer.unref();
  try {
    const proof = await new Promise((ready, reject) => {
      let text = '';
      child.stdio[4].on('data', chunk => {
        text += chunk;
        if (text.length > 1024) { killGroup(child, 'SIGKILL'); reject(httpsError('helper_privilege_check_failed')); return; }
        if (text.includes('\n')) {
          try { const decoded = JSON.parse(text.trim()); if (!decoded.privilegeVerified || !Number.isSafeInteger(decoded.pid) || decoded.pid < 1) throw Error(); ready(decoded); }
          catch { reject(httpsError('helper_privilege_check_failed')); }
        }
      });
      completion.finally(() => reject(httpsError('helper_privilege_check_failed'))).catch(() => {});
    });
    if (foreground) await verifyPrivilege(proof.pid, { uid: locations.uid, gid: locations.gid, requireClearGroups: root });
    record.ownedPid = proof.pid;
    if (foreground) return record;
    return await completion;
  } catch (error) { killGroup(child, 'SIGKILL'); await completion.catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
}

function killGroup(child, signal) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
  }
}

export async function stopOwned(processRecord) {
  if (!processRecord?.child || processRecord.child.exitCode !== null || processRecord.child.signalCode !== null) return;
  const child = processRecord.child; killGroup(child, 'SIGTERM');
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 5000); timer.unref();
  try { await processRecord.completion.catch(() => {}); } finally { clearTimeout(timer); }
}

export class CertificateHelper {
  constructor({ directory, locations, onExit, processRecordPath }) { this.directory = directory; this.locations = locations; this.onExit = onExit; this.process = null; this.expectedStop = false; this.commands = new Set(); this.processRecordPath = processRecordPath; this.processToken = null; }
  cli(args, options) {
    return launchRestricted(resolve(this.directory, 'tailscale'), [`--socket=${this.locations.socket}`, ...args], { locations: this.locations, ...options,
      onProcess: record => { this.commands.add(record); record.completion.finally(() => this.commands.delete(record)).catch(() => {}); } });
  }
  async start() {
    if (this.process && this.process.child.exitCode === null) return;
    if (this.processRecordPath) {
      const saved = await readJson(this.processRecordPath);
      if (saved !== null) {
        if (typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(key => !['version', 'pid', 'start', 'token'].includes(key)) ||
            saved.version !== 1 || !Number.isSafeInteger(saved.pid) || saved.pid < 1 || !/^\d{1,20}$/.test(saved.start ?? '') || typeof saved.token !== 'string' || !saved.token.length || saved.token.length > 80) throw httpsError('helper_process_record_invalid');
        const start = await processStart(saved.pid);
        if (start === saved.start) throw httpsError('helper_already_running');
        await rm(this.processRecordPath);
      }
    }
    const existing = await lstat(this.locations.socket).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      if (!existing.isSocket() || existing.uid !== this.locations.uid) throw httpsError('helper_socket_unsafe');
      // An orphan launcher may still be draining its owned daemon after an
      // application crash. Never unlink a responding helper's LocalAPI socket
      // and start a second daemon against that identity.
      try { await localApi(this.locations.socket, '/localapi/v0/status'); throw httpsError('helper_already_running'); }
      catch (error) { if (!['helper_api_socket_refused', 'helper_api_socket_absent'].includes(error.code)) throw error; }
    }
    await rm(this.locations.socket, { force: true });
    this.expectedStop = false;
    this.process = await launchRestricted(resolve(this.directory, 'tailscaled'), ['--tun=userspace-networking', '--state=./tailscaled.state', '--statedir=.',
      `--socket=${this.locations.socket}`, '--port=0', '--no-logs-no-support'], { locations: this.locations, foreground: true });
    if (this.processRecordPath) {
      this.processToken = randomUUID();
      const start = await processStart(this.process.ownedPid);
      if (!/^\d{1,20}$/.test(start ?? '')) { await this.stop(); throw httpsError('helper_userspace_start_failed'); }
      await atomicJson(this.processRecordPath, { version: 1, pid: this.process.ownedPid, start, token: this.processToken });
    }
    this.process.completion.finally(() => { if (!this.expectedStop) this.onExit?.(); }).catch(() => {});
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (this.process.child.exitCode !== null || this.process.child.signalCode !== null) throw httpsError('helper_userspace_start_failed');
      try {
        await verifyPrivilege(this.process.ownedPid, { uid: this.locations.uid, gid: this.locations.gid, requireClearGroups: this.locations.root });
        await localApi(this.locations.socket, '/localapi/v0/status'); return;
      } catch (error) { if (error.code === 'helper_privilege_check_failed') { await this.stop(); throw error; } }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    await this.stop(); throw httpsError('helper_userspace_start_timeout');
  }
  async restrictions() {
    await this.cli(['set', ...RESTRICTION_FLAGS.filter(flag => !flag.startsWith('--advertise-tags=')), '--remote-config=false', '--relay-server-port=', '--relay-server-static-endpoints=']);
    let serve = await localApi(this.locations.socket, '/localapi/v0/serve-config');
    if (serve && Object.keys(serve).length) { await this.cli(['serve', 'reset']); serve = await localApi(this.locations.socket, '/localapi/v0/serve-config'); }
    const prefs = await localApi(this.locations.socket, '/localapi/v0/prefs');
    if (!effectiveRestrictions(prefs, serve)) { await this.stop(); throw httpsError('helper_restrictions_not_confirmed'); }
  }
  async authorize(machineName) {
    try { await this.cli(['up', '--timeout=12s', `--hostname=${machineName}`, ...RESTRICTION_FLAGS], { timeout: 15000 }); }
    catch { /* Pending browser authorization is determined from structured status. */ }
    return this.status();
  }
  status() { return localApi(this.locations.socket, '/localapi/v0/status'); }
  async certificate(hostname, minValidity) {
    const name = `cert-${randomUUID()}`;
    const certName = `${name}.pem`; const keyName = `${name}.key`;
    try {
      await this.cli(['cert', `--cert-file=${certName}`, `--key-file=${keyName}`, `--min-validity=${minValidity}`, hostname], { timeout: 90000 });
      const certPath = resolve(this.locations.identity, certName); const keyPath = resolve(this.locations.identity, keyName);
      const [certInfo, keyInfo] = await Promise.all([lstat(certPath), lstat(keyPath)]);
      if (!certInfo.isFile() || !keyInfo.isFile() || certInfo.isSymbolicLink() || keyInfo.isSymbolicLink() || certInfo.size > 64 * 1024 || keyInfo.size > 16 * 1024) throw httpsError('certificate_size_invalid');
      return { cert: await readFile(certPath, 'utf8'), key: await readFile(keyPath, 'utf8') };
    } finally {
      await rm(resolve(this.locations.identity, certName), { force: true }); await rm(resolve(this.locations.identity, keyName), { force: true });
    }
  }
  async stop() {
    this.expectedStop = true; await Promise.all([...this.commands, this.process].filter(Boolean).map(stopOwned)); this.process = null;
    if (this.processRecordPath && this.processToken) {
      const saved = await readJson(this.processRecordPath).catch(() => null);
      if (saved?.token === this.processToken) await rm(this.processRecordPath, { force: true });
    }
  }
}

async function processStart(pid) {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  return text ? text.slice(text.lastIndexOf(')') + 2).split(' ')[19] : null;
}

export async function preflightRuntime(directory, version, locations) {
  const preflightDirectory = resolve(locations.socketDirectory, `test-${randomUUID()}`);
  await safeOwnedDirectory(preflightDirectory, locations.uid, locations.gid);
  const testLocations = { ...locations, identity: preflightDirectory, socket: resolve(preflightDirectory, 's') };
  const helper = new CertificateHelper({ directory, locations: testLocations });
  try {
    const cli = await launchRestricted(resolve(directory, 'tailscale'), [`--socket=${testLocations.socket}`, 'version', '--json'], { locations: testLocations });
    let decoded;
    try { decoded = JSON.parse(cli); } catch { throw httpsError('helper_version_response_invalid'); }
    if (!decoded?.short || decoded.short !== version) throw httpsError('helper_version_mismatch');
    await helper.start(); await helper.restrictions();
    const status = await helper.status();
    if (!['NeedsLogin', 'Stopped'].includes(status.BackendState) || status.Self?.ID || !(status.Version === version || status.Version?.startsWith(`${version}-`))) throw httpsError('helper_preflight_identity_invalid');
    // Candidate capability inspection never authorizes/registers a node and
    // never uses a copied production identity or asks for a certificate.
    const help = await helper.cli(['cert', '--help'], { includeStderr: true });
    if (!help.includes('--min-validity') || !help.includes('--cert-file') || !help.includes('--key-file')) throw httpsError('helper_certificate_capability_missing');
    return { testedVersion: version, restrictionsVerified: true, certificateCapabilityVerified: true };
  } finally { await helper.stop(); await rm(preflightDirectory, { recursive: true, force: true }); }
}
