import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, userInfo, networkInterfaces } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DeploymentSafetyError, validateStandby } from './paired-deployment.js';
import { runCommand } from './deployment-command.js';
import { main as runtimeOperation, checkoutRoot, parseEnvironment, validateConnection, validateInstalledRuntime, readPair, readLocalStatus, validateStandalone, servicePath } from './linux-deployment.js';
import { inspectPlatform, authenticateSudo, startSudoLease, provisionLinux } from './linux-setup-platform.js';
import { connectSetupHA, HASetupUnavailableError, prepareConfigurationForHost } from './linux-setup-ha.js';
import { createSetupTerminal } from './linux-setup-terminal.js';
import { setupDefaults, setupEnvironment, environmentText, minimalConfiguration, parseSetupConfiguration,
  validateSetupConfiguration, reviewSetupChanges, patchSetupConfiguration, requireExternalPath, privateDirectory,
  snapshotPrivate, unchangedPrivate, writePrivate, saveReviewedPrivate } from './linux-setup-config.js';
import { validateVip } from '../../src/pairing/vip.js';
import { requireLocalBroker } from '../../src/pairing/config.js';
import { acquireDeploymentLock, releaseDeploymentLock } from './deployment-lock.js';
import { BrokerProbeError, brokerOrigin, canProvisionBroker, linuxHAMqttRoute, newBrokerCredentials, probeMQTTBroker, verifySetupBrokers } from './linux-setup-broker.js';

const fail = message => { throw new DeploymentSafetyError(message); };
const json = value => JSON.stringify(value, null, 2) + '\n';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const help = `Usage: bash scripts/setup-linux.sh [--connection /private/path/linux-deploy.json] [--dry-run]
Install and configure this checkout on Ubuntu with systemd.
Choose standalone or paired operation and supply secrets.json as a whole file:
reuse, hidden paste, copy, editor or a minimal starter. No individual credential questions.
Review changes before installation. Setup installs prerequisites and helpers, starts
the service and enables boot startup from this checkout’s clean committed HEAD.
--dry-run reviews without applying changes.
See docs/linux-deployment.md. Run as an ordinary sudo-capable user, not root.`;

export function setupArguments(args) {
  let connectionPath, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run' && !dryRun) dryRun = true;
    else if (args[i] === '--connection' && !connectionPath && args[i + 1] && !args[i + 1].startsWith('--')) connectionPath = resolve(args[++i]);
    else fail('Invalid setup arguments; use --help.');
  }
  return { connectionPath, dryRun };
}
export function pairSettings(options, remote, { peerUrl, networkInterface, vipAddress, prefixLength }) {
  const local = options.pair ?? {}, peer = remote?.pair ?? {};
  if (local.pair_id && peer.pair_id && local.pair_id !== peer.pair_id
    || local.token && peer.token && local.token !== peer.token) fail('Pair identities or credentials differ. Resolve them in the private configuration before setup.');
  const pair = { ...local, pair_id: local.pair_id || peer.pair_id || 'st-mq-' + randomUUID().slice(0, 8),
    token: local.token || peer.token || randomBytes(32).toString('hex'), peer_url: peerUrl,
    listen_host: local.listen_host || '0.0.0.0', vip_interface: networkInterface,
    vip_address: vipAddress, vip_prefix: prefixLength, vip_socket: '/run/st-mq-vip/socket' };
  validateVip({ interface: networkInterface, address: vipAddress, prefixLength });
  let url; try { url = new URL(peerUrl); } catch { fail('Enter the peer’s fixed HTTP origin including its peer port.'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === vipAddress)
    fail('Use the peer’s fixed HTTP origin, without credentials or a path; the virtual IP is not a peer address.');
  return pair;
}

export async function main(args = [], dependencies = {}) {
  const { source = checkoutRoot, home = homedir(), env = process.env, run = runCommand,
    inspect = inspectPlatform, authenticate = authenticateSudo, provision = provisionLinux,
    install = runtimeOperation, connectHA = connectSetupHA, clock = Date.now, sleep = delay, signal,
    operator = userInfo(), uid = process.getuid?.(), log = console.log } = dependencies;
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { log(help); return { state: 'help' }; }
  const { connectionPath: selectedPath, dryRun } = setupArguments(args);
  if (uid === 0) fail('Run setup as the intended ordinary application account, not root.');
  const io = dependencies.io ?? createSetupTerminal({ signal });
  let ha, workspace, complete = false, operationLock, lockRuntime, haConnection, haConnectionBefore, haConnectionPath, lease, phase = 'configuration review';
  try {
    const platform = await inspect({ run, nodePath: process.execPath, signal });
    const defaults = setupDefaults({ home, env, user: operator.username });
    const connectionPath = selectedPath ?? defaults.connectionPath;
    requireExternalPath(connectionPath, [source]);
    const connectionBefore = snapshotPrivate(connectionPath, { optional: true });
    let connection = connectionBefore ? validateConnection(parseSetupConfigurationConnection(connectionBefore.bytes), source) : defaults.connection;
    const originalConnection = structuredClone(connection);
    const environmentBefore = snapshotPrivate(connection.environment_file, { optional: true });
    const previousEnvironment = environmentBefore ? parseEnvironment(environmentBefore.bytes.toString('utf8')) : {};
    io.log('Application installation');
    const topology = await io.choose('Operation', ['standalone', 'pair'], previousEnvironment.STMQ_TOPOLOGY || 'standalone');
    connection.runtime_dir = await io.ask('Runtime directory', connection.runtime_dir);
    if (existsSync(join(originalConnection.runtime_dir, 'deployment.json')) && connection.runtime_dir !== originalConnection.runtime_dir)
      fail('This managed installation has a fixed runtime location. Setup does not relocate an installed runtime.');
    const data = await io.ask('Data directory', previousEnvironment.STMQ_DATA_DIR || defaults.data);
    if (previousEnvironment.STMQ_DATA_DIR && existsSync(previousEnvironment.STMQ_DATA_DIR) && data !== previousEnvironment.STMQ_DATA_DIR)
      fail('This installation already has a data directory. Setup does not relocate existing history or pairing state.');
    const secrets = await io.ask('Private configuration file', previousEnvironment.STMQ_CONFIG || defaults.secrets);
    const port = Number(await io.ask('Local web port', String(new URL(connection.status_url).port || 1234)));
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Choose a web port between 1 and 65535.');
    connection.status_url = 'http://127.0.0.1:' + port;
    requireExternalPath(secrets, [source, connection.runtime_dir]); requireExternalPath(data, [source, connection.runtime_dir]);
    validateConnection(connection, source);
    const originalSecrets = snapshotPrivate(secrets, { optional: true });
    let previousOptions = {};
    if (originalSecrets) {
      try { previousOptions = parseSetupConfiguration(originalSecrets.bytes.toString('utf8')); }
      catch { io.log('The existing private file requires correction. Its original bytes will be backed up before replacement.'); }
    }
    const directory = dirname(connectionPath);
    privateDirectory(directory);
    workspace = join(directory, '.setup-' + randomUUID()); privateDirectory(workspace);
    const draft = join(workspace, 'configuration.json');

    if (topology === 'pair' && await io.confirm('Configure HA through SSH if available?', Boolean(existsSync(join(directory, 'ha-deploy.json'))))) {
      haConnectionPath = join(directory, 'ha-deploy.json');
      haConnectionBefore = snapshotPrivate(haConnectionPath, { optional: true });
      haConnection = haConnectionBefore ? parseSetupConfigurationConnection(haConnectionBefore.bytes) : { ssh_host: await io.ask('HA SSH destination or alias') };
      const manifest = JSON.parse(readFileSync(join(source, 'config.json'), 'utf8'));
      try { ha = await connectHA(haConnection, { expectedVersion: manifest.version, schema: manifest.schema, signal }); }
      catch (error) {
        if (!(error instanceof HASetupUnavailableError)) throw error;
        io.log('HA SSH is unavailable. Linux setup will finish locally and save the HA settings for manual application.');
      }
    }
    const sources = [...(originalSecrets ? ['Use existing file'] : []), 'Paste JSON', 'Copy a file', 'Minimal starter', ...(ha ? ['Copy HA settings'] : [])];
    const selection = await io.choose('Configuration source', sources, sources[0]);
    let text;
    if (selection === 'Use existing file') text = originalSecrets.bytes.toString('utf8');
    else if (selection === 'Paste JSON') text = await io.paste();
    else if (selection === 'Copy a file') {
      const path = await io.ask('Source configuration path'); requireExternalPath(path, [source, connection.runtime_dir]);
      text = snapshotPrivate(path).bytes.toString('utf8');
    } else if (selection === 'Copy HA settings') {
      const adapted = prepareConfigurationForHost(ha.options, { destination: 'linux', existing: previousOptions });
      text = json(adapted.options);
      if (adapted.localFieldsReset.length) io.log('Machine-local fields require local values: ' + adapted.localFieldsReset.join(', '));
    } else text = json(minimalConfiguration(topology));
    writePrivate(draft, text);
    let options;
    while (true) {
      try { options = parseSetupConfiguration(readFileSync(draft, 'utf8')); break; }
      catch (error) { io.log(error.message); await editDraft(io, draft); }
    }
    if (selection === 'Minimal starter' && await io.confirm('Open the minimal starter in an editor?', topology === 'pair')) {
      await io.edit(draft); options = parseSetupConfiguration(readFileSync(draft, 'utf8'));
    }
    let broker = null, haInterface, localOrigin, pair, installHABroker = false, haBroker = null, startHABroker = false;
    const pairing = previousEnvironment.STMQ_PAIR_DIR || join(data, 'pairing');
    const savedStatePath = join(pairing, 'state.json');
    const stateBefore = existsSync(savedStatePath) ? snapshotPrivate(savedStatePath) : null;
    const savedState = stateBefore ? parseSetupConfigurationConnection(stateBefore.bytes) : null;
    if (topology === 'standalone' && savedState) fail('This state belongs to a pair. Decommission pairing explicitly before choosing standalone operation. Setup does not replace saved authority.');
    if (topology === 'pair' || ['mqtt', 'providers'].includes(previousEnvironment.STMQ_INPUT ?? options.controller?.input)) {
      if (options.mqtt?.address) brokerOrigin(options.mqtt.address); // Reject embedded credentials before displaying a default.
      const selectedBrokerOrigin = await io.ask(topology === 'pair' ? 'Linux local MQTT origin' : 'Primary MQTT origin',
        options.mqtt?.address && !options.mqtt.address.includes('core-mosquitto') ? options.mqtt.address : 'mqtt://127.0.0.1');
      options = patchSetupConfiguration(options, { mqtt: { address: selectedBrokerOrigin } });
      if (canProvisionBroker(selectedBrokerOrigin, platform.broker)) {
        let unavailable;
        try { await (dependencies.probeBroker ?? probeMQTTBroker)(options.mqtt, { signal }); }
        catch (error) { if (!(error instanceof BrokerProbeError) || error.code === 'cancelled') throw error; unavailable = error; }
        // A responding unmanaged listener is not an unused installation target,
        // even if Mosquitto is absent from the package database.
        if (unavailable && (platform.broker?.managed || unavailable.endpointState === 'refused')
          && await io.confirm('Install or configure the private local Mosquitto broker?', true)) {
          broker = newBrokerCredentials(options.mqtt);
          options = patchSetupConfiguration(options, { mqtt: { address: 'mqtt://127.0.0.1', user: broker.user, pw: broker.password } });
        }
      }
    }
    if (topology === 'pair') {
      if (ha && !ha.mqtt?.installed) {
        installHABroker = await io.confirm('Install HA Mosquitto with the reviewed broker credentials?', true);
        if (installHABroker) haBroker = newBrokerCredentials(options.mqtt);
        if (!installHABroker) io.log('HA broker installation is pending; pairing cannot be verified until its local broker is ready.');
      }
      if (ha?.mqtt?.installed && ha.mqtt.app?.state === 'stopped')
        startHABroker = await io.confirm('Start the existing stopped HA MQTT broker?', true);
      const interfaces = Object.entries(networkInterfaces()).filter(([, addresses]) => addresses?.some(a => !a.internal && a.family === 'IPv4')).map(([name]) => name);
      const networkInterface = await io.ask('Linux LAN interface', options.pair?.vip_interface || interfaces[0] || 'eth0');
      const vipAddress = await io.ask('Shared virtual IPv4 address', options.pair?.vip_address || ha?.options.pair?.vip_address || '');
      const prefixLength = Number(await io.ask('Virtual IP prefix length', String(options.pair?.vip_prefix || ha?.options.pair?.vip_prefix || 24)));
      const peerUrl = await io.ask('Peer fixed HTTP origin', options.pair?.peer_url || '');
      pair = pairSettings(options, ha?.options, { peerUrl, networkInterface, vipAddress, prefixLength });
      if (savedState && (savedState.pairId !== pair.pair_id || previousOptions.pair?.token && previousOptions.pair.token !== pair.token))
        fail('Pair configuration differs from the saved installation. Setup does not reset pairing or rotate its credentials.');
      const localAddress = networkInterfaces()[networkInterface]?.find(a => a.family === 'IPv4' && !a.internal)?.address;
      localOrigin = await io.ask('Linux fixed HTTP peer origin', localAddress ? `http://${localAddress}:${pair.port || 1244}` : '');
      const localUrl = new URL(localOrigin);
      if (localUrl.protocol !== 'http:' || localUrl.username || localUrl.password || localUrl.pathname !== '/' || localUrl.hash || localUrl.search || localUrl.hostname === vipAddress)
        fail('Choose Linux’s fixed HTTP peer origin without credentials, virtual IP or path.');
      if (ha) haInterface = await io.ask('HA LAN interface', ha.options.pair?.vip_interface || ha.interfaces?.find(i => i.primary)?.name || ha.interfaces?.[0]?.name || 'eth0');
      options = patchSetupConfiguration(options, { controller: { topology: 'pair', input: options.controller?.input && options.controller.input !== 'simulated' ? options.controller.input : 'providers' }, pair });
    } else options = patchSetupConfiguration(options, { controller: { topology: 'standalone' } });
    if (selection === 'Copy HA settings' && topology === 'pair') {
      try {
        const route = linuxHAMqttRoute({ sourceOptions: ha.options, existingRoute: previousOptions.mqtt?.ha,
          peerUrl: options.pair.peer_url, brokerPort: installHABroker ? 1885 : ha.mqtt?.port, newCredentials: haBroker });
        options = patchSetupConfiguration(options, { mqtt: { ha: route } });
        io.log('HA-hosted MQTT integrations retain a separate reviewed route through HA’s fixed broker endpoint.');
      } catch (error) {
        if (!(error instanceof DeploymentSafetyError)) throw error;
        writePrivate(draft, json(options)); io.log(error.message); await editDraft(io, draft);
        options = parseSetupConfiguration(readFileSync(draft, 'utf8'));
        if (!options.mqtt?.ha?.address) fail('Complete mqtt.ha in the private draft before installing imported HA configuration.');
      }
    }
    const environment = { ...previousEnvironment, ...setupEnvironment({ secrets, data, database: previousEnvironment.STMQ_DATABASE_DIR || data, pairing, topology, port }) };
    let config;
    while (true) {
      try { config = validateSetupConfiguration(options, { environment, draft, connection, source }); break; }
      catch (error) {
        io.log(error.message); await editDraft(io, draft);
        options = parseSetupConfiguration(readFileSync(draft, 'utf8'));
      }
    }
    if (config.topology !== topology) fail('The edited configuration changed the reviewed operation. Run setup again.');
    if (broker) {
      if (!canProvisionBroker(config.connections.mqtt?.address, platform.broker)) fail('The edited MQTT origin is outside the reviewed local broker installation. Review setup again.');
      broker = newBrokerCredentials(config.connections.mqtt);
      options = patchSetupConfiguration(options, { mqtt: { address: 'mqtt://127.0.0.1', user: broker.user, pw: broker.password } });
      config = validateSetupConfiguration(options, { environment, draft, connection, source });
    }
    if (topology === 'pair') {
      pair = options.pair;
      if (savedState && (savedState.pairId !== config.pair.pairId || previousOptions.pair?.token !== config.pair.token)) fail('The edited configuration changed the saved pair identity or credentials.');
      await (dependencies.validateBrokerLocation ?? requireLocalBroker)(config.connections.mqtt, { vipAddress: config.pair.vip.address });
    }
    let startsReviewedHARoute = false;
    if (startHABroker && config.connections.mqtt.ha?.address) {
      const route = new URL(config.connections.mqtt.ha.address), peer = new URL(config.pair.peerUrl);
      startsReviewedHARoute = route.protocol === 'mqtt:' && route.hostname === peer.hostname && Number(route.port || 1883) === ha.mqtt.port;
    }
    await verifySetupBrokers(config, { probe: dependencies.probeBroker ?? probeMQTTBroker, signal, skipPrimary: Boolean(broker), skipHA: installHABroker || startsReviewedHARoute });
    let haOptions, firstMaster = 'none';
    if (ha) {
      haOptions = patchSetupConfiguration(ha.options, { controller: { topology: 'pair', input: ha.options.controller?.input && ha.options.controller.input !== 'simulated' ? ha.options.controller.input : 'providers' },
        ...(installHABroker ? { mqtt: { address: 'mqtt://core-mosquitto', user: haBroker.user, pw: haBroker.password } } : {}),
        pair: { pair_id: config.pair.pairId, token: config.pair.token, peer_url: localOrigin, listen_host: ha.options.pair?.listen_host || '0.0.0.0',
          vip_interface: haInterface, vip_address: config.pair.vip.address, vip_prefix: config.pair.vip.prefixLength, vip_socket: '' } });
      if (!savedState && (!ha.initialRuntime || ha.initialRuntime.pair?.bootstrapPending === true)) firstMaster = await io.choose('First master for this new pair', ['HA', 'Linux', 'Select later'], 'HA');
    }
    const checkedRun = (...args) => { lease?.assertValid(); return run(...args); };
    const service = (...a) => connection.service_scope === 'user'
      ? checkedRun('systemctl', ['--user', ...a], { signal, timeout: 120000, acceptedExitCodes: a[0] === 'show' ? [0, 1] : [0] })
      : checkedRun('sudo', ['-n', 'systemctl', ...a], { signal, timeout: 120000, acceptedExitCodes: a[0] === 'show' ? [0, 1] : [0] });
    const needsPrivilege = true; // System units, helpers or user-service lingering require reviewed root operations.
    io.log(`Operation: ${topology}; input: ${config.input}.`);
    io.log(`Service: ${connection.service_scope}/${connection.service_name}; enable at boot and start.`);
    if (existsSync(join(connection.runtime_dir, 'deployment.json'))) io.log('The existing Linux service will stop normally, be rebuilt and restarted. Control is interrupted while it is stopped.');
    io.log(`Runtime: ${connection.runtime_dir}\nData: ${data}\nConfiguration: ${secrets}`);
    if (platform.packages.length) io.log('Required packages: ' + platform.packages.join(', '));
    if (broker) io.log('Install local broker with privately generated or file-supplied credentials.');
    if (installHABroker) io.log('Install HA Mosquitto with the reviewed account; publish internal MQTT 1883 on fixed HA host port 1885, leaving 1883 for the virtual IP.');
    if (startHABroker) io.log('Start the existing stopped HA MQTT broker; preserve its accounts and network settings.');
    if (topology === 'pair') io.log('Install the restricted virtual-IP helper; preserve saved pairing state.');
    for (const change of reviewSetupChanges(previousOptions, options)) io.log('Configuration field: ' + change.path + (change.redacted ? ' [private]' : `: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`));
    if (haOptions) for (const change of reviewSetupChanges(ha.options, haOptions)) io.log('HA field: ' + change.path + (change.redacted ? ' [private]' : ''));
    if (haOptions && !isDeepStrictEqual(haOptions, ha.options)) io.log('HA settings will be privately backed up and the app stopped for configuration, then restarted.');
    if (firstMaster !== 'none' && firstMaster !== 'Select later') io.log(`Explicit initial master selection: ${firstMaster}. Confirm that no other controller owns control.`);
    const tokenPath = config.token ? connection.token_file ?? join(directory, 'linux-status-token') : null;
    const tokenBefore = tokenPath ? snapshotPrivate(tokenPath, { optional: true }) : null;
    if (dryRun) { complete = true; io.log('Dry run complete. No installation or permanent configuration changes applied.'); return { state: 'preview', topology }; }
    if (!await io.confirm('Apply this configuration, install and start?', false)) { complete = true; return { state: 'cancelled' }; }
    phase = 'source and private-input checks';
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: source, signal });
    if (!/^[a-f0-9]{40}$/.test(head) || await run('git', ['status', '--porcelain'], { cwd: source, signal })) fail('Commit the intended source and leave the checkout clean before installing.');
    unchangedPrivate(secrets, originalSecrets); unchangedPrivate(connectionPath, connectionBefore); unchangedPrivate(connection.environment_file, environmentBefore);
    if (tokenPath) unchangedPrivate(tokenPath, tokenBefore);
    verifySavedIdentity(savedStatePath, stateBefore);
    // Existing runtime reconfiguration is deliberately limited to a stopped
    // current installation. This preserves its physical stop/restoration duties.
    const installed = existsSync(join(connection.runtime_dir, 'deployment.json'));
    operationLock = acquireDeploymentLock(connection.runtime_dir); lockRuntime = connection.runtime_dir;
    if (needsPrivilege) {
      phase = 'sudo authentication';
      const action = () => authenticate({ signal });
      await (io.external ? io.external(action) : action());
      lease = (dependencies.lease ?? startSudoLease)({ run, signal });
    }
    lease?.assertValid();
    phase = 'service ownership and normal stop';
    if (installed) {
      await (dependencies.validateInstallation ?? validateInstalledRuntime)(originalConnection, { source, run: checkedRun, signal, unitPath: dependencies.unitPath ?? servicePath });
      await service('stop', connection.service_name);
      const current = await service('show', connection.service_name, '--property=ActiveState,MainPID');
      if (!current.includes('ActiveState=inactive') || !current.includes('MainPID=0')) fail('The current service did not confirm a normal stop. No settings were applied.');
    } else {
      const current = await service('show', connection.service_name, '--property=LoadState,ActiveState,MainPID');
      if (!current.includes('LoadState=not-found') || !current.includes('MainPID=0')) fail('The proposed service name is already in use. No settings were applied.');
    }
    unchangedPrivate(secrets, originalSecrets); unchangedPrivate(connectionPath, connectionBefore); unchangedPrivate(connection.environment_file, environmentBefore);
    if (tokenPath) unchangedPrivate(tokenPath, tokenBefore);
    verifySavedIdentity(savedStatePath, stateBefore);
    if (await run('git', ['rev-parse', 'HEAD'], { cwd: source, signal }) !== head || await run('git', ['status', '--porcelain'], { cwd: source, signal })) fail('The source changed after review. No installation was applied.');
    lease?.assertValid();
    phase = 'Linux prerequisites and helper installation';
    if (platform.packages.length || topology === 'pair' || broker) await provision({ source, nodePath: connection.node_path,
      user: operator.username, group: platform.group, vip: topology === 'pair' ? { interface: config.pair.vip.interface, address: config.pair.vip.address, prefixLength: config.pair.vip.prefixLength } : null, broker, run: checkedRun, signal, log: message => io.log(message) });
    const backups = join(directory, 'setup-backups', new Date(clock()).toISOString().replaceAll(':', '-'));
    phase = 'private configuration save';
    saveReviewedPrivate(secrets, json(options), originalSecrets, backups);
    saveReviewedPrivate(connection.environment_file, environmentText(environment), environmentBefore, backups);
    if (config.token) {
      connection.token_file = tokenPath;
      saveReviewedPrivate(connection.token_file, config.token + '\n', tokenBefore, backups);
    } else delete connection.token_file;
    saveReviewedPrivate(connectionPath, json(connection), connectionBefore, backups);
    if (haConnection) saveReviewedPrivate(haConnectionPath, json(haConnection), haConnectionBefore, backups);
    let haResult;
    phase = 'HA configuration';
    if (haOptions) haResult = await ha.backupAndApply({ options: haOptions, installBroker: installHABroker, startBroker: startHABroker,
      ...(installHABroker ? { brokerOptions: { logins: [{ username: haBroker.user, password: haBroker.password }] }, brokerNetwork: { '1883/tcp': 1885 } } : {}) });
    await verifySetupBrokers(config, { probe: dependencies.probeBroker ?? probeMQTTBroker, signal });
    if (await run('git', ['rev-parse', 'HEAD'], { cwd: source, signal }) !== head || await run('git', ['status', '--porcelain'], { cwd: source, signal })) fail('The source changed during provisioning. Review the installation before continuing.');
    lease?.assertValid();
    phase = 'runtime build and installation';
    await install(installed ? 'deploy' : 'setup', ['--connection', connectionPath, ...(installed ? ['--stopped'] : ['--apply'])], { source, run: checkedRun, signal, operationLock, ...(dependencies.unitPath ? { unitPath: dependencies.unitPath } : {}), log: message => io.log(message) });
    phase = 'service startup';
    await service('enable', connection.service_name);
    lease?.assertValid();
    if (connection.service_scope === 'user') await checkedRun('sudo', ['-n', 'loginctl', 'enable-linger', operator.username], { signal, timeout: 30000 });
    await service('start', connection.service_name);
    const observed = await waitForSetupRuntime({ connection, topology, run, service, signal, sleep, clock,
      read: dependencies.readRuntime ?? (topology === 'pair' ? readPair : readLocalStatus) });
    if (ha) await ha.start();
    phase = 'pair commissioning and readiness';
    let state = topology === 'standalone' ? 'ready' : 'peer-pending';
    if (topology === 'pair' && firstMaster === 'HA') {
      const target = await waitForHARuntime(ha, { clock, sleep, signal });
      if (!(target.pair.role === 'master' && target.pair.canControl === true))
        await ha.promote({ confirmed: true, expectedIdentity: target.pair, mode: target.pair.bootstrapPending === true ? 'bootstrap' : 'protected-initial' });
    } else if (topology === 'pair' && firstMaster === 'Linux') {
      if (!(observed.role === 'master' && observed.canControl === true))
        await localPromotion(connection, observed, { signal, protectedInitial: !savedState && previousEnvironment.STMQ_TOPOLOGY !== 'pair', read: dependencies.readRuntime ?? readPair, fetchImpl: dependencies.fetchImpl,
          verify: () => waitForSetupRuntime({ connection, topology, run, service, signal, sleep, clock, read: dependencies.readRuntime ?? readPair }) });
    }
    if (topology === 'pair') {
      if (!ha) {
        const manual = patchSetupConfiguration({}, { controller: { topology: 'pair', input: config.input },
          pair: { pair_id: config.pair.pairId, token: config.pair.token, peer_url: localOrigin, listen_host: '0.0.0.0',
            vip_address: config.pair.vip.address, vip_prefix: config.pair.vip.prefixLength, vip_socket: '' } });
        const path = join(directory, 'ha-pair-settings.json'); writePrivate(path, json(manual));
        io.log(`Linux installed. HA configuration pending. Merge the private settings from ${path} into HA and supply HA’s LAN interface and local MQTT settings.`);
      } else {
        const deadline = clock() + (connection.sync_timeout_seconds || 900) * 1000;
        while (true) {
          const p = await (dependencies.readRuntime ?? readPair)(connection, { signal });
          const remote = await ha.readRuntime({ allowWaiting: true });
          try {
            validateSetupPair(p, remote?.pair, { now: clock(), remoteNow: remote?.observedAt });
            state = 'ready'; break;
          } catch { /* Both nodes must supply fresh matching ready evidence. */ }
          if (firstMaster === 'Select later' || p.role === 'protected' || clock() >= deadline) break;
          await sleep(1000);
        }
        io.log(state === 'ready' ? 'Paired installation verified: master/slave roles and synchronization ready.' : 'Linux and HA installed. Pair commissioning remains pending; inspect Paired computers.');
      }
    } else io.log(`Standalone installation verified. Input: ${config.input}${config.input === 'simulated' ? ' (simulation; equipment has not been commissioned)' : ''}.`);
    complete = true;
    releaseDeploymentLock(operationLock, lockRuntime); operationLock = null;
    return { state, topology, connectionPath, haResult };
  } catch (error) {
    const detail = error instanceof DeploymentSafetyError ? error.message : 'Setup failed; private error details suppressed.';
    if (workspace) io.log('Private draft retained at ' + workspace);
    throw new DeploymentSafetyError(`Setup failed during ${phase}: ${detail} No automatic rollback, role reset or uncertain-operation retry was attempted. Inspect that stage before rerunning setup.`);
  } finally {
    try { await ha?.close(); }
    finally {
      await lease?.close();
      if (complete && workspace) rmSync(workspace, { recursive: true, force: true });
      if (!dependencies.io) io.close();
    }
  }
}

export function validateSetupPair(local, remote, { now = Date.now(), remoteNow = now } = {}) {
  const slave = local?.role === 'slave' ? local : remote;
  const master = local?.role === 'master' ? local : remote;
  validateStandby(slave, null, slave === local ? now : remoteNow, true);
  const masterNow = master === local ? now : remoteNow;
  if (!master || master.role !== 'master' || master.canControl !== true || master.busy !== false || master.phase != null || master.error != null
    || master.vip?.owned !== true || master.peer?.reachable !== true || master.peer.role !== 'slave'
    || !Number.isFinite(masterNow) || !Number.isFinite(master.peer.lastSeenAt) || master.peer.lastSeenAt > masterNow + 5000 || masterNow - master.peer.lastSeenAt > 15000
    || master.pairId !== slave.pairId || master.nodeId !== slave.peer.nodeId || slave.nodeId !== master.peer.nodeId)
    fail('Fresh matching master and synchronized slave evidence is required.');
}

function verifySavedIdentity(path, before) {
  if (!before) { unchangedPrivate(path, null); return; }
  const original = parseSetupConfigurationConnection(before.bytes), current = parseSetupConfigurationConnection(snapshotPrivate(path).bytes);
  if (['nodeId', 'pairId', 'role'].some(key => current[key] !== original[key]) || current.transition || current.reset || current.release)
    fail('Saved pair authority changed during review. Setup did not replace it.');
}

async function waitForHARuntime(ha, { clock, sleep, signal }) {
  const deadline = clock() + 120000;
  while (true) {
    if (signal?.aborted) fail('Setup cancelled while HA starts.');
    const snapshot = await ha.readRuntime({ allowWaiting: true });
    if (snapshot) return snapshot;
    if (clock() >= deadline) fail('HA application startup timed out. Inspect HA before retrying.');
    await sleep(1000);
  }
}

function parseSetupConfigurationConnection(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('Invalid private installation metadata; values suppressed.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid private installation metadata.');
  return value;
}
async function editDraft(io, draft) {
  io.log('Private configuration draft: ' + draft);
  const action = await io.choose('Correct the complete configuration', ['Open editor', 'Paste replacement', 'Wait for external editor', 'Cancel']);
  if (action === 'Open editor') await io.edit(draft);
  else if (action === 'Paste replacement') writePrivate(draft, await io.paste());
  else if (action === 'Wait for external editor') await io.ask('Press Enter after saving the private draft');
  else fail('Setup cancelled before applying configuration.');
}
export async function waitForSetupRuntime({ connection, topology, run, service, read, signal, sleep = delay, clock = Date.now }) {
  const deadline = clock() + 120000;
  while (true) {
    if (signal?.aborted) fail('Setup cancelled after service start.');
    const state = await service('show', connection.service_name, '--property=ActiveState,SubState,MainPID');
    if (state.includes('ActiveState=failed')) fail('The service failed to start; inspect its private logs.');
    const pid = /^MainPID=([1-9][0-9]*)$/m.exec(state)?.[1];
    if (pid && state.includes('ActiveState=active')) {
      try {
        await run(connection.node_path, [fileURLToPath(new URL('./linux-deployment-process.js', import.meta.url)), pid, connection.node_path, join(connection.runtime_dir, 'current'), connection.status_url], { signal, timeout: 10000 });
        const status = await read(connection, { signal });
        if (topology === 'standalone') return validateStandalone(status);
        if (!status || !['slave', 'master', 'protected'].includes(status.role)) fail('Unexpected pair status after startup.');
        if (status.role !== 'master' && status.canControl !== false) fail('Unknown pair authority after startup.');
        return status;
      } catch (error) { if (signal?.aborted || error instanceof DeploymentSafetyError && !(error.message.includes('unavailable') || error.message.includes('Command failed'))) throw error; }
    }
    if (clock() >= deadline) fail('Application startup timed out. The service was left for inspection.');
    await sleep(1000);
  }
}
export async function localPromotion(connection, identity, { signal, protectedInitial = false, read = readPair, fetchImpl = fetch, verify } = {}) {
  if (typeof verify !== 'function') fail('Initial promotion requires a fresh service and listener ownership check.');
  await verify();
  const current = await read(connection, { signal });
  const eligible = current.bootstrapPending === true && current.role === 'slave'
    || protectedInitial && current.role === 'protected';
  if (current.nodeId !== identity.nodeId || current.pairId !== identity.pairId || !eligible || current.actions?.promote !== true
    || current.canControl !== false || current.busy !== false || current.phase !== null || current.error !== null
    || current.vip?.owned !== false || current.peer?.role === 'master') fail('Initial promotion preconditions changed.');
  const token = connection.token_file ? readFileSync(connection.token_file, 'utf8').trim() : '';
  const response = await fetchImpl(connection.status_url + '/api/pair/action', { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ action: 'promote', confirmed: true, requestId: randomUUID() }), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10000)]) });
  if (response.status !== 202) fail('Initial promotion was not acknowledged. Inspect Paired computers before retrying.');
}
