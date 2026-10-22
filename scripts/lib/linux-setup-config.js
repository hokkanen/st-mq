import { constants, existsSync, lstatSync, openSync, closeSync, fstatSync, readFileSync,
  mkdirSync, writeFileSync, renameSync, fsyncSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../../src/app/config.js';
import { parseOptions, validateOptionFields, mergeOptions } from '../../src/app/configuration-source.js';
import { configurationSourceChanges } from '../../src/app/configuration-preview.js';
import { DeploymentSafetyError } from './paired-deployment.js';
import { canonical, validateConnection, validateEnvironment } from './linux-deployment.js';

const fail = message => { throw new DeploymentSafetyError(message); };
const schema = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8')).schema;
const hash = value => createHash('sha256').update(value).digest('hex');
export function setupDefaults({ home = homedir(), env = process.env, nodePath = process.execPath, user } = {}) {
  const directory = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'st-mq');
  return { directory, secrets: join(directory, 'secrets.json'), data: join(home, '.local/share/st-mq'),
    connectionPath: join(directory, 'linux-deploy.json'),
    connection: { runtime_dir: join(home, '.local/share/st-mq-runtime'), service_name: 'st-mq.service',
      service_scope: 'system', service_user: user, node_path: nodePath,
      environment_file: join(directory, 'linux-runtime.env'), status_url: 'http://127.0.0.1:1234' } };
}
export function cleanSetupEnvironment(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('STMQ_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
}
export function setupEnvironment({ secrets, data, database = data, pairing = join(data, 'pairing'), topology, port = 1234 }) {
  return { STMQ_CONFIG: secrets, STMQ_DATA_DIR: data, STMQ_DATABASE_DIR: database,
    ...(topology === 'pair' ? { STMQ_PAIR_DIR: pairing } : {}), STMQ_TOPOLOGY: topology, STMQ_PORT: String(port) };
}
export function environmentText(environment) {
  return Object.entries(environment).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /['\r\n\0]/.test(value)) fail('Installation paths cannot contain quotes or line breaks.');
    return `${key}='${value}'`;
  }).join('\n') + '\n';
}
export function minimalConfiguration(topology = 'standalone') {
  return topology === 'standalone' ? {} : { controller: { topology: 'pair', input: 'providers' }, mqtt: { address: 'mqtt://127.0.0.1' } };
}
export function parseSetupConfiguration(text) {
  if (Buffer.byteLength(text) > 1024 * 1024) fail('Configuration exceeds its size limit.');
  let options;
  try { options = parseOptions(text); validateOptionFields(options, schema); }
  catch (error) { fail(configurationIssue(error)); }
  return options;
}
export function validateSetupConfiguration(options, { environment, draft, connection, source }) {
  validateConnection(connection, source); validateEnvironment(environment, connection, source);
  try { validateOptionFields(options, schema); }
  catch (error) { fail(configurationIssue(error)); }
  // Build through the real current configuration boundary without starting a Store.
  writePrivate(draft, JSON.stringify(options, null, 2) + '\n');
  try { return loadConfig({ ...cleanSetupEnvironment(), ...environment, STMQ_CONFIG: draft }, source); }
  catch (error) { fail(configurationIssue(error)); }
}
export function reviewSetupChanges(before, after) {
  return configurationSourceChanges(before, after, schema).map(change => ({ path: change.path,
    before: change.before, after: change.after, redacted: change.redacted }));
}
export function patchSetupConfiguration(options, patch) { return mergeOptions(options, patch); }

export function requireExternalPath(path, boundaries) {
  if (!isAbsolute(path) || resolve(path) !== path) fail('Choose an absolute normalized installation path.');
  const actual = canonical(path);
  for (const boundary of boundaries) {
    const part = relative(canonical(boundary), actual);
    if (part === '' || part !== '..' && !part.startsWith('../') && !isAbsolute(part)) fail('Private configuration and state must remain outside source and runtime directories.');
  }
  return path;
}
export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) fail('Choose an owned private directory with mode 0700.');
}
export function snapshotPrivate(path, { optional = false } = {}) {
  if (optional && !lstatSync(path, { throwIfNoEntry: false })) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || Number(stat.mode & 0o077n) || stat.size > 1048576n) fail('Private inputs must be owned regular files, mode 0600, and no larger than 1 MiB.');
    const bytes = readFileSync(fd);
    if (bytes.length > 1048576) fail('Private input exceeds its size limit.');
    return { bytes, hash: hash(bytes), device: stat.dev.toString(), inode: stat.ino.toString() };
  } catch (error) {
    if (error instanceof DeploymentSafetyError) throw error;
    fail('The private file could not be read safely. Check its path, ownership and permissions.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function configurationIssue(error) {
  const text = typeof error?.message === 'string' ? error.message : '';
  const field = /^Invalid configuration (?:field|section): ([a-zA-Z0-9_.]+)\.?$/.exec(text)?.[1]?.replace(/\.$/, '');
  const known = path => { let rule = schema; for (const key of path.split('.')) { if (!rule || typeof rule !== 'object' || !Object.hasOwn(rule, key)) return false; rule = rule[key]; } return true; };
  if (field && known(field)) return `Invalid configuration field: ${field}. Edit the private draft and retry.`;
  const pair = /^Invalid pair setting: ([a-z_]+)$/.exec(text)?.[1];
  if (pair && known('pair.' + pair)) return `Check configuration field: pair.${pair}. Edit the private draft and retry.`;
  if (text.includes('Pair mode requires a shared private token')) return 'Check configuration field: pair.token (at least 32 characters).';
  if (text.includes('Paired controllers require live input')) return 'Check controller.input and mqtt.address: pair mode needs live input and a local broker.';
  return 'Configuration must be a current JSON object with supported fields and valid values. Edit the private draft and retry.';
}
export function unchangedPrivate(path, before) {
  const current = snapshotPrivate(path, { optional: true });
  if (Boolean(current) !== Boolean(before) || current && ['hash', 'device', 'inode'].some(key => current[key] !== before[key])) fail('A private input changed after review. Run setup again before applying.');
}
export function writePrivate(path, value) {
  privateDirectory(dirname(path));
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.uid !== process.getuid())) fail('Refusing to replace an unsafe private path.');
  const temporary = join(dirname(path), '.setup-' + randomUUID());
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function saveReviewedPrivate(path, value, before, backupDirectory) {
  unchangedPrivate(path, before);
  if (before && before.bytes.equals(Buffer.from(value))) return null;
  let backup = null;
  if (before) {
    privateDirectory(backupDirectory);
    backup = join(backupDirectory, 'previous-' + randomUUID() + '.json');
    writePrivate(backup, before.bytes);
  }
  unchangedPrivate(path, before);
  writePrivate(path, value);
  return backup;
}
