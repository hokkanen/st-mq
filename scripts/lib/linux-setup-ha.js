import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createSupervisorAPI, selectApp, validateConnection, readStoppedEvidence } from '../deploy-ha.js';
import { connectSSH, DeploymentTransportError } from './ha-deploy-transport.js';
import { readHARuntime } from './ha-deploy-runtime.js';
import { ownsApplicationListener } from './deployment-process.js';
import { DeploymentSafetyError } from './paired-deployment.js';
import { acquireRemoteDeploymentLock, remoteDeploymentLockPath } from './deployment-lock.js';
import { mergeOptions, parseOptions, validateOptionFields } from '../../src/app/configuration-source.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);

export class HASetupError extends DeploymentSafetyError {
  constructor(message, { changed = false, uncertain = false, backupPath = null } = {}) {
    super(message); this.changed = changed; this.uncertain = uncertain; this.backupPath = backupPath;
  }
}
export class HASetupUnavailableError extends HASetupError {}

// These are installation locations and proof owned by the destination host.
// Provider identities and electrical commissioning are configuration, not paths.
const localFields = ['controller.h66_verification_file', 'web.https_directory', 'recording.backup_directory',
  'pair.directory', 'pair.snapshot_directory', 'pair.listen_host', 'pair.vip_interface', 'pair.vip_helper', 'pair.vip_socket'];
const valueAt = (value, path) => path.split('.').reduce((current, key) => current?.[key], value);
function setAt(value, path, replacement) {
  const keys = path.split('.'), key = keys.pop(); let parent = value;
  for (const name of keys) parent = parent[name] ??= {};
  if (replacement === undefined) delete parent[key]; else parent[key] = clone(replacement);
}

/** Adapt a sparse, reviewed configuration without transporting local storage or
 * verification paths. The returned field names belong in the wizard review. */
export function prepareConfigurationForHost(source, { destination, existing = {}, mqtt, pair } = {}) {
  if (!['linux', 'ha'].includes(destination) || !object(source) || !object(existing)) throw new HASetupError('Invalid configuration adaptation request.');
  let options;
  try { options = parseOptions(JSON.stringify(source)); } catch { throw new HASetupError('The source configuration is not a valid current JSON object.'); }
  const localFieldsReset = [];
  for (const path of localFields) {
    if (valueAt(options, path) !== undefined) localFieldsReset.push(path);
    setAt(options, path, valueAt(existing, path));
  }
  if (Object.hasOwn(options, 'mirror')) localFieldsReset.push('mirror');
  delete options.mirror;
  if (Object.hasOwn(existing, 'mirror')) options.mirror = clone(existing.mirror);
  if (mqtt !== undefined) options.mqtt = mergeOptions(options.mqtt ?? {}, mqtt);
  if (pair !== undefined) options.pair = mergeOptions(options.pair ?? {}, pair);
  if (destination === 'ha') {
    options.mqtt ??= {}; options.mqtt.ha = { address: '', user: '', pw: '' };
    options.pair ??= {}; options.pair.vip_socket = '';
  }
  if (destination === 'linux') {
    const references = value => typeof value === 'string' ? value.startsWith('!secret ') : value !== null && typeof value === 'object' && Object.values(value).some(references);
    if (references(options)) throw new HASetupError('HA secret references cannot be used by Linux. Paste their actual values into the private draft before continuing.');
  }
  return { options, localFieldsReset };
}

// Code executes as root inside Supervisor. Reading raw saved overrides avoids
// materializing every public default in a Linux secrets.json export.
export function savedOptionsProgram(slug, { backupId, expectedOptions, expectedSchema } = {}) {
  if (!/^[a-z0-9_-]+$/.test(slug) || backupId !== undefined && !/^[a-f0-9-]{36}$/.test(backupId)
    || expectedOptions !== undefined && !object(expectedOptions) || expectedSchema !== undefined && !object(expectedSchema)) throw new HASetupError('Invalid HA settings snapshot request.');
  return `import json,os,stat
from pathlib import Path
from supervisor.const import FILE_HASSIO_APPS
try:
 path=Path(FILE_HASSIO_APPS)
 assert path.is_file() and not path.is_symlink() and path.stat().st_size<=67108864
 state=json.loads(path.read_text())
 ${expectedSchema ? `expected_schema=json.loads(bytes.fromhex('${Buffer.from(JSON.stringify(expectedSchema)).toString('hex')}').decode())
 assert state['system'][${JSON.stringify(slug)}]['schema']==expected_schema` : ''}
 user=state['user'][${JSON.stringify(slug)}]
 options=user['options']
 assert isinstance(options,dict)
 encoded=json.dumps(options,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
 assert len(encoded)<=1048576
 ${expectedOptions ? `expected=json.loads(bytes.fromhex('${Buffer.from(JSON.stringify(expectedOptions)).toString('hex')}').decode())
 assert encoded==json.dumps(expected,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()` : ''}
 ${backupId ? `directory=Path('/data/st-mq-setup-backups')/${JSON.stringify(backupId)}
 directory.parent.mkdir(mode=0o700,exist_ok=True)
 assert not directory.parent.is_symlink() and directory.parent.stat().st_uid==0 and stat.S_IMODE(directory.parent.stat().st_mode)==0o700
 directory.mkdir(mode=0o700)
 for name,value in [('supervisor-options.json',options),('supervisor-user.json',user)]:
  fd=os.open(directory/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
  with os.fdopen(fd,'w') as output:
   json.dump(value,output,ensure_ascii=False,allow_nan=False)
   output.flush();os.fsync(output.fileno())
 for parent in [directory,directory.parent]:
  fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 print(json.dumps({'ok':True,'backupPath':str(directory)}))` : `print(json.dumps({'ok':True,'options':options}))`}
except Exception:
 print(json.dumps({'ok':False}))
`;
}

async function savedOptions(ssh, slug, request = {}) {
  const result = await ssh.run('docker exec -i hassio_supervisor python3 -', { input: Buffer.from(savedOptionsProgram(slug, request)), timeoutMs: 30000 });
  if (result.exitCode !== 0) throw new HASetupError('HA saved settings could not be inspected or backed up. Private output is suppressed.');
  let value;
  try { value = JSON.parse(result.output); } catch { throw new HASetupError('HA returned an invalid private settings snapshot.'); }
  if (value?.ok !== true || (request.backupId ? value.backupPath !== '/data/st-mq-setup-backups/' + request.backupId : !object(value?.options)))
    throw new HASetupError('HA saved settings changed or could not be preserved. No settings replacement was submitted.');
  return request.backupId ? value.backupPath : parseOptions(JSON.stringify(value.options));
}

function installedApp(value, expected) {
  if (!object(value) || value.slug !== expected.slug || value.repository !== expected.repository || value.version !== expected.version || !object(value.options))
    throw new HASetupError('The installed HA app identity, version or settings changed during setup.');
  return value;
}

function validBrokerNetwork(value) {
  return object(value) && Object.entries(value).every(([key, port]) => /^[1-9][0-9]{0,4}\/(tcp|udp)$/.test(key)
    && Number(key.split('/')[0]) <= 65535 && (port === null || Number.isInteger(port) && port >= 1 && port <= 65535));
}

export function pairBrokerPort(app) {
  if (!validBrokerNetwork(app?.network) || !Object.hasOwn(app.network, '1883/tcp'))
    throw new HASetupError('HA broker network settings are unavailable or unsupported. Review its Network settings before pair setup.');
  if (Object.entries(app.network).some(([socket, port]) => socket.endsWith('/tcp') && port === 1883))
    throw new HASetupError('HA broker host port 1883 conflicts with the pair virtual-IP listener. Review Mosquitto Network settings and choose a separate fixed host port, normally 1885, before pair setup.');
  return app.network['1883/tcp'];
}

export async function connectSetupHA(connection, { connect = connectSSH, supervisor = createSupervisorAPI,
  readRuntime = readHARuntime, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), schema, expectedVersion, signal } = {}) {
  validateConnection(connection);
  let ssh, api, app, raw, mqtt, interfaces, initialRuntime;
  const abort = () => { void ssh?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new HASetupError('HA setup was cancelled before remote changes.');
    ssh = await connect(connection);
    api = supervisor(ssh);
    const apps = (await api('/addons')).addons;
    if (!Array.isArray(apps)) throw new HASetupError('HA did not return an installed app list.');
    const selected = selectApp(apps, connection.app_slug);
    app = await api(`/addons/${selected.slug}/info`);
    if (!object(app) || app.slug !== selected.slug || !object(app.options) || !['started', 'stopped', 'error'].includes(app.state)
      || typeof app.repository !== 'string' || typeof app.version !== 'string') throw new HASetupError('The installed HA app settings or state are invalid.');
    if (expectedVersion !== undefined && app.version !== expectedVersion) throw new HASetupError('The installed HA app and checkout versions differ. Install the matching app version before setup.');
    raw = await savedOptions(ssh, app.slug, { expectedSchema: schema });
    if (schema) {
      try { validateOptionFields(raw, schema); } catch { throw new HASetupError('HA saved options do not match this checkout. Correct the configuration before setup.'); }
    }
    const network = await api('/network/info');
    if (!Array.isArray(network.interfaces)) throw new HASetupError('HA network interface discovery returned invalid information.');
    interfaces = network.interfaces.filter(row => object(row) && typeof row.interface === 'string' && /^[a-zA-Z0-9_.-]{1,15}$/.test(row.interface)
      && row.enabled && row.connected).map(row => ({ name: row.interface, primary: row.primary === true,
        addresses: Array.isArray(row.ipv4?.address) ? row.ipv4.address.filter(address => typeof address === 'string') : [] }));
    const broker = apps.find(value => value.slug === 'core_mosquitto');
    mqtt = broker ? { installed: true, app: await api('/addons/core_mosquitto/info') } : { installed: false };
    if (mqtt.installed) mqtt.port = pairBrokerPort(mqtt.app);
    // MQTT service credentials need service permission in the SSH app. Reuse the
    // explicitly supplied st-mq broker credentials instead of broadening it.
    if (app.state === 'started' && raw.controller?.topology === 'pair') initialRuntime = await readRuntime(ssh, app);
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    await ssh?.close();
    if (signal?.aborted) throw new HASetupError('HA setup was cancelled before remote changes.');
    if (error instanceof DeploymentTransportError) throw new HASetupUnavailableError('HA SSH is unavailable. Linux setup can continue with manual HA configuration.');
    if (error instanceof DeploymentSafetyError) throw error;
    throw new HASetupError('HA setup discovery failed. Inspect the installed app, Supervisor permissions and private configuration.');
  }
  const original = clone(app); let expectedOptions = clone(raw), changed = false, uncertain = false, failed = false, lock = false, backupPath = null;
  const lockPath = remoteDeploymentLockPath(app.slug);
  const active = () => {
    if (signal?.aborted) throw new HASetupError(`HA setup was cancelled. Inspect the confirmed setup state before retrying.${lock ? ` Its lock location is ${JSON.stringify(lockPath)} on HA in the SSH app.` : ''}`, { changed, uncertain, backupPath });
    if (failed) throw new HASetupError(`The HA setup session has failed. Inspect HA before opening another session. Its lock location is ${JSON.stringify(lockPath)} on HA in the SSH app.`, { changed, uncertain, backupPath });
  };
  const mutation = async action => {
    active();
    changed = true;
    try { return await action(); }
    catch (error) {
      failed = true; uncertain = true;
      throw new HASetupError(`HA setup did not confirm a submitted operation. Inspect HA before retrying; no operation was replayed.${lock ? ` Its lock is retained at ${JSON.stringify(lockPath)} on HA in the SSH app.` : ''}`, { changed, uncertain, backupPath });
    }
  };
  const current = async () => {
    active();
    return installedApp(await api(`/addons/${app.slug}/info`), original);
  };
  const unchangedSettings = async () => {
    if (!isDeepStrictEqual(await savedOptions(ssh, app.slug, { expectedSchema: schema }), expectedOptions)) throw new HASetupError('HA saved settings changed after review. Review setup again before applying.');
    return current();
  };
  const unchangedRuntime = async value => {
    if (!initialRuntime || value.state !== 'started') return;
    const observed = await readRuntime(ssh, value, { expectedContainer: initialRuntime.container, expectedImage: initialRuntime.image });
    if (!observed?.pair || ['nodeId', 'pairId', 'role', 'canControl'].some(key => observed.pair[key] !== initialRuntime.pair[key])
      || observed.pair.busy !== false || observed.pair.phase !== null)
      throw new HASetupError('HA pair identity, authority or operation state changed after review. Review setup again before stopping it.');
  };
  const waitState = async state => {
    const deadline = clock() + 120000;
    do { const value = await current(); if (value.state === state || state === 'stopped' && value.state === 'error') return value; await sleep(1000); }
    while (clock() < deadline);
    throw new HASetupError('HA did not confirm the requested app state before the setup deadline.');
  };
  const acquire = async () => {
    if (lock) return;
    active();
    const changedBefore = changed;
    changed = true;
    try {
      await acquireRemoteDeploymentLock(ssh, app.slug);
      lock = true;
    } catch (error) {
      failed = true;
      uncertain = !(error instanceof DeploymentSafetyError);
      if (!uncertain) changed = changedBefore;
      throw new HASetupError(error instanceof DeploymentSafetyError ? error.message
        : `HA lock acquisition was not confirmed at ${JSON.stringify(lockPath)} in the SSH app. Inspect it before retrying; no operation was replayed.`,
      { changed, uncertain, backupPath });
    }
  };
  const prepareBroker = async brokerOptions => {
    if (!object(brokerOptions) || !object(mqtt.app?.options)) throw new HASetupError('The HA broker settings are unavailable or invalid.', { changed, backupPath });
    const brokerCurrent = await savedOptions(ssh, 'core_mosquitto');
    const brokerCandidate = mergeOptions(brokerCurrent, brokerOptions);
    if (Object.hasOwn(brokerOptions, 'logins')) {
      if (!Array.isArray(brokerOptions.logins) || brokerOptions.logins.some(row => !object(row) || typeof row.username !== 'string' || !row.username)
        || new Set(brokerOptions.logins.map(row => row.username)).size !== brokerOptions.logins.length || !Array.isArray(brokerCurrent.logins))
        throw new HASetupError('The reviewed HA broker account list is invalid.', { changed, backupPath });
      const replacements = new Map(brokerOptions.logins.map(row => [row.username, row]));
      brokerCandidate.logins = brokerCurrent.logins.map(row => replacements.has(row.username)
        ? { ...row, ...replacements.get(row.username) } : clone(row));
      for (const row of brokerOptions.logins) if (!brokerCurrent.logins.some(existing => existing.username === row.username)) brokerCandidate.logins.push(clone(row));
    }
    const checked = await api('/addons/core_mosquitto/options/validate', 'post', 30, brokerCandidate);
    if (checked.valid !== true) throw new HASetupError('Supervisor rejected the reviewed broker settings.', { changed, backupPath });
    return { current: brokerCurrent, candidate: brokerCandidate };
  };
  return {
    app: clone(app), options: clone(raw), mqtt: clone(mqtt), interfaces: clone(interfaces), initialRuntime: clone(initialRuntime ?? null),
    async backupAndApply({ options, installBroker = false, brokerOptions, brokerNetwork, startBroker = false } = {}) {
      active();
      if (typeof startBroker !== 'boolean' || startBroker && (!mqtt.installed || installBroker || brokerOptions !== undefined || brokerNetwork !== undefined))
        throw new HASetupError('Starting an existing HA broker is a separate reviewed action and does not change its configuration.');
      if (brokerNetwork !== undefined && (!installBroker || mqtt.installed || !validBrokerNetwork(brokerNetwork)))
        throw new HASetupError('Broker network provisioning is supported only for a newly installed HA broker. Existing network settings require separate review.');
      if (!object(options)) throw new HASetupError('HA configuration must be an object.');
      let candidate;
      try { candidate = parseOptions(JSON.stringify(options)); if (schema) validateOptionFields(candidate, schema); }
      catch { throw new HASetupError('The proposed HA settings do not match the current configuration contract.'); }
      const checked = await api(`/addons/${app.slug}/options/validate`, 'post', 30, candidate);
      if (checked.valid !== true) throw new HASetupError('Supervisor rejected the proposed HA settings. Correct the private configuration and review again.');
      await unchangedRuntime(await unchangedSettings());
      if (isDeepStrictEqual(candidate, expectedOptions) && !installBroker && brokerOptions === undefined && !startBroker) return { changed: false, restartRequired: false, backupPath: null };
      if (installBroker && mqtt.installed) throw new HASetupError('HA Mosquitto is already installed. Preserve and review its existing configuration.');
      if (!mqtt.installed && !installBroker && brokerOptions !== undefined) throw new HASetupError('HA Mosquitto must be installed before configuring it.');
      let reviewedBroker = mqtt.installed && brokerOptions !== undefined ? await prepareBroker(brokerOptions) : null;
      await acquire();
      backupPath = await mutation(() => savedOptions(ssh, app.slug, { backupId: randomUUID(), expectedOptions, expectedSchema: schema }));
      if (reviewedBroker) await mutation(() => savedOptions(ssh, 'core_mosquitto', { backupId: randomUUID(), expectedOptions: reviewedBroker.current }));
      app = await unchangedSettings();
      if (app.state === 'started') {
        await unchangedRuntime(app);
        await mutation(() => api(`/addons/${app.slug}/stop`, 'post', 120, {}));
        app = await mutation(() => waitState('stopped'));
      }
      if (!['stopped', 'error'].includes(app.state)) throw new HASetupError('HA must confirm the app is stopped before configuration changes.', { changed, backupPath });
      await mutation(() => readStoppedEvidence(ssh, app, { always: true }));
      await unchangedSettings();
      if (installBroker) {
        await mutation(() => api('/store/addons/core_mosquitto/install', 'post', 900, {}));
        mqtt = { installed: true, app: await api('/addons/core_mosquitto/info') };
        if (!validBrokerNetwork(mqtt.app.network)) throw new HASetupError('The newly installed HA broker returned invalid network settings.', { changed, backupPath });
      }
      if (brokerOptions !== undefined || installBroker) {
        if (!reviewedBroker) {
          reviewedBroker = await prepareBroker(brokerOptions ?? {});
          await mutation(() => savedOptions(ssh, 'core_mosquitto', { backupId: randomUUID(), expectedOptions: reviewedBroker.current }));
        }
        if (!isDeepStrictEqual(await savedOptions(ssh, 'core_mosquitto'), reviewedBroker.current)) throw new HASetupError('HA broker settings changed after review. Inspect HA before retrying.', { changed, backupPath });
        const network = installBroker ? { ...mqtt.app.network, ...(brokerNetwork ?? { '1883/tcp': 1885 }) } : null;
        if (network) pairBrokerPort({ network });
        await mutation(() => api('/addons/core_mosquitto/options', 'post', 30, { options: reviewedBroker.candidate, ...(network ? { network } : {}) }));
        if (network) {
          const observed = await api('/addons/core_mosquitto/info');
          if (!isDeepStrictEqual(observed.network, network)) throw new HASetupError('HA did not confirm the reviewed broker network mapping. Inspect HA before retrying.', { changed, backupPath });
          mqtt.app = observed; mqtt.port = pairBrokerPort(observed);
        }
      }
      if (installBroker || brokerOptions !== undefined || startBroker) {
        const state = (await api('/addons/core_mosquitto/info')).state;
        if (!startBroker || state !== 'started') {
          if (startBroker && state !== 'stopped') throw new HASetupError('HA broker state is not safe for the reviewed Start. Inspect HA before retrying.', { changed, backupPath });
          await mutation(() => api('/addons/core_mosquitto/' + (state === 'started' ? 'restart' : 'start'), 'post', 120, {}));
        }
        if ((await api('/addons/core_mosquitto/info')).state !== 'started') throw new HASetupError('HA did not confirm its MQTT broker is running. Inspect HA before retrying.', { changed, backupPath });
      }
      app = await unchangedSettings();
      if (!['stopped', 'error'].includes(app.state)) throw new HASetupError('HA app started outside setup during broker configuration. Inspect HA before retrying.', { changed, backupPath });
      await mutation(() => readStoppedEvidence(ssh, app, { always: true }));
      await unchangedSettings();
      await mutation(() => api(`/addons/${app.slug}/options`, 'post', 30, { options: candidate }));
      expectedOptions = clone(candidate);
      await mutation(unchangedSettings);
      return { changed: true, restartRequired: true, backupPath };
    },
    async start() {
      active();
      app = await unchangedSettings();
      if (app.state === 'started') return { changed: false };
      if (!['stopped', 'error'].includes(app.state)) throw new HASetupError('HA app state is not safe for setup Start.');
      await acquire();
      await mutation(() => readStoppedEvidence(ssh, app, { always: true }));
      await mutation(() => api(`/addons/${app.slug}/start`, 'post', 120, {}));
      app = await mutation(() => waitState('started'));
      return { changed: true };
    },
    async readRuntime(options = {}) { active(); return readRuntime(ssh, await current(), options); },
    async promote({ confirmed = false, expectedIdentity, mode = 'bootstrap' } = {}) {
      active();
      if (confirmed !== true || !object(expectedIdentity) || !/^[A-Za-z0-9_-]{1,80}$/.test(expectedIdentity.pairId ?? '')
        || typeof expectedIdentity.nodeId !== 'string' || !['bootstrap', 'protected-initial'].includes(mode)
        || mode === 'protected-initial' && raw.controller?.topology === 'pair') throw new HASetupError('Initial HA promotion requires explicit confirmation, an eligible setup mode and the observed pair identity.');
      const before = await readRuntime(ssh, await current());
      const p = before?.pair;
      if (p?.nodeId !== expectedIdentity.nodeId || p.pairId !== expectedIdentity.pairId || p.actions?.promote !== true || p.error !== null || p.canControl !== false
        || (mode === 'bootstrap' ? p.bootstrapPending !== true : p.role !== 'protected')
        || !['slave', 'protected'].includes(p.role) || p.busy !== false || p.phase !== null || p.vip?.owned !== false || p.peer?.role === 'master')
        throw new HASetupError('HA no longer qualifies for the explicitly reviewed initial promotion.');
      await acquire();
      const result = await mutation(() => ssh.run(`docker exec -i ${before.container} node --input-type=module`, {
        input: Buffer.from(promotionProgram({ expectedIdentity, requestId: randomUUID(), mode })), timeoutMs: 15000,
      }));
      let receipt; try { receipt = JSON.parse(result.output); } catch { /* Fixed diagnostic below. */ }
      if (result.exitCode !== 0 || receipt?.submitted !== true) { failed = true; uncertain = true; throw new HASetupError('HA initial promotion receipt is unconfirmed. Inspect pair status before retrying.', { changed, uncertain, backupPath }); }
      return { submitted: true };
    },
    async close() {
      try {
        if (lock && !failed && !signal?.aborted) {
          let result;
          try { result = await ssh.run(`rmdir ${lockPath}`, { timeoutMs: 15000 }); }
          catch { throw new HASetupError(`HA setup lock removal was not confirmed at ${JSON.stringify(lockPath)} in the SSH app. Inspect it before retrying.`, { changed, uncertain: true, backupPath }); }
          if (result.exitCode !== 0) throw new HASetupError(`HA setup completed, but its lock at ${JSON.stringify(lockPath)} in the SSH app could not be removed. Inspect it before retrying.`, { changed, backupPath });
          lock = false;
        }
      } finally { signal?.removeEventListener('abort', abort); await ssh.close(); }
    },
  };
}

export function promotionProgram({ expectedIdentity, requestId, mode = 'bootstrap' }, { pid = 1, directory = '/st-mq' } = {}) {
  return `import * as fs from 'node:fs';
import{loadConfig}from${JSON.stringify(directory + '/src/app/config.js')};
const ownsApplicationListener=${ownsApplicationListener.toString()};
try{
 const config=loadConfig(),origin='http://'+(config.host?.includes(':')?'[::1]':'127.0.0.1')+':'+config.port;
 if(!ownsApplicationListener({pid:${JSON.stringify(pid)},executable:process.execPath,directory:${JSON.stringify(directory)},entrypoint:${JSON.stringify(directory + '/src/main.js')},origin},fs))throw Error();
 const headers=config.token?{Authorization:'Bearer '+config.token}:{};
 const response=await fetch(origin+'/api/pair',{headers,redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error();const reader=response.body.getReader(),chunks=[];let bytes=0;
 while(true){const{done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1048576){await reader.cancel();throw Error();}chunks.push(Buffer.from(value));}
 const pair=JSON.parse(Buffer.concat(chunks).toString('utf8')),expected=${JSON.stringify(expectedIdentity)};
 if(pair.nodeId!==expected.nodeId||config.pair?.pairId!==expected.pairId||pair.actions?.promote!==true||pair.error!==null||${mode === 'bootstrap' ? 'pair.bootstrapPending!==true' : "pair.role!=='protected'"}||pair.canControl!==false||!['slave','protected'].includes(pair.role)||pair.busy!==false||pair.phase!==null||pair.vip?.owned!==false||pair.peer?.role==='master')throw Error();
 const result=await fetch(origin+'/api/pair/action',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({action:'promote',nodeId:expected.nodeId,requestId:${JSON.stringify(requestId)},confirmed:true}),redirect:'error',signal:AbortSignal.timeout(5000)});
 console.log(JSON.stringify({submitted:result.status===202}));
}catch{console.log(JSON.stringify({submitted:false}));}
`;
}
