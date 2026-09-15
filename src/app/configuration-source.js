import { constants, existsSync, openSync, closeSync, fstatSync, readFileSync, mkdirSync, renameSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { garageSettings } from '../garage/settings.js';

const bundledDefaults = fileURLToPath(new URL('../../config.json', import.meta.url));
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_CONFIGURATION_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Normalize the retired protection policy at the configuration boundary,
// before merging defaults supplies the new version. Never rewrite the source
// file or carry its approval into a different physical model.
function currentGarageOptions(options) {
  if (!object(options?.garage?.protection)) return options;
  const protection = options.garage.protection;
  const legacy = ['garage-exposure-v1', 'garage-exposure-v2'].includes(protection.version)
    || protection.version == null && ['floorC', 'hardMinimumC', 'budgetDegreeMinutes',
      'recoveryAboveC', 'recoveryDegreeMinutesPerMinute', 'recoveryDwellMinutes'].some(key => Object.hasOwn(protection, key));
  if (!legacy) return options;
  return { ...options, garage: { ...options.garage, protection: garageSettings({ protection }).protection } };
}

export function mergeOptions(defaults, overrides) {
  if (!object(defaults) || !object(overrides)) throw new Error('Configuration must be a JSON object.');
  const merged = structuredClone(defaults);
  for (const [key, value] of Object.entries(overrides)) {
    if (forbiddenKeys.has(key)) throw new Error('Configuration contains an unsupported field.');
    merged[key] = object(value) ? mergeOptions(object(merged[key]) ? merged[key] : {}, value) : structuredClone(value);
  }
  return merged;
}

// Report field names only: JSON parser diagnostics can include a credential.
export function parseOptions(text, { allowWrapper = false } = {}) {
  let options;
  try { options = JSON.parse(text); }
  catch { throw new Error('Configuration must contain valid JSON.'); }
  if (allowWrapper && object(options?.options)) options = options.options;
  if (!object(options)) throw new Error('Configuration must be a JSON object.');
  return mergeOptions({}, options);
}

export function validateOptionFields(options, schema, path = '') {
  if (!object(options) || !object(schema)) throw new Error(`Invalid configuration section${path ? `: ${path}` : ''}.`);
  if (path === '') options = currentGarageOptions(options);
  for (const [key, value] of Object.entries(options)) {
    const field = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(schema, key) || forbiddenKeys.has(key)) throw new Error(`Unknown configuration field: ${field}.`);
    const rule = schema[key];
    if (object(rule)) validateOptionFields(value, rule, field);
    else if (Array.isArray(rule)) {
      if (!Array.isArray(value)) throw new Error(`Configuration field must be an array: ${field}.`);
      for (const item of value) {
        if (object(rule[0])) validateOptionFields(item, rule[0], field);
        else validateScalar(item, rule[0], field);
      }
    } else validateScalar(value, rule, field);
  }
}

function validateScalar(value, rule, field) {
  const specification = String(rule), optional = specification.endsWith('?');
  const type = optional ? specification.slice(0, -1) : specification;
  if (value === null && optional) return;
  let valid = false;
  if (['str', 'password', 'url', 'email'].includes(type)) valid = typeof value === 'string';
  else if (type === 'bool') valid = typeof value === 'boolean';
  else if (type.startsWith('list(')) valid = typeof value === 'string' && type.slice(5, -1).split('|').includes(value);
  else if (/^(int|float)(\(|$)/.test(type)) {
    valid = Number.isFinite(value) && (!type.startsWith('int') || Number.isInteger(value));
    const range = type.match(/\(([^,]*),([^)]*)\)/);
    if (range) valid &&= (!range[1] || value >= Number(range[1])) && (!range[2] || value <= Number(range[2]));
  }
  if (!valid) throw new Error(`Invalid configuration field: ${field}.`);
}

export function configurationPaths(env, cwd) {
  const addon = env.STMQ_ADDON === '1';
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : resolve(env.HOME || homedir(), '.config');
  return {
    defaultsPath: existsSync(resolve(cwd, 'config.json')) ? resolve(cwd, 'config.json') : bundledDefaults,
    privatePath: resolve(cwd, env.STMQ_CONFIG ?? (addon ? '/data/options.json' : resolve(xdg, 'st-mq/secrets.json'))),
    importPath: addon ? '/config/secrets.json' : null,
    receiptPath: addon ? resolve(env.STMQ_DATA_DIR ?? '/data/st-mq', 'configuration-import.json') : null,
  };
}

function manifest(path) {
  const value = parseOptions(readFileSync(path, 'utf8'));
  if (!object(value.options) || !object(value.schema)) throw new Error('Public config.json must contain options and schema objects.');
  return value;
}

function privateOptions(path, required) {
  if (!existsSync(path)) {
    if (required) throw new Error('STMQ_CONFIG must name an existing configuration file.');
    return {};
  }
  return currentGarageOptions(parseOptions(readFileSync(path, 'utf8'), { allowWrapper: true }));
}

export function readConfigurationOptions(env, cwd, paths = configurationPaths(env, cwd)) {
  const defaults = manifest(paths.defaultsPath);
  const overrides = privateOptions(paths.privatePath, Boolean(env.STMQ_CONFIG));
  if (env.STMQ_ADDON !== '1') {
    validateOptionFields(defaults.options, defaults.schema);
    validateOptionFields(overrides, defaults.schema);
  }
  return { options: mergeOptions(defaults.options, overrides), defaults, paths };
}

function snapshot(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CONFIGURATION_BYTES) throw new Error('invalid-file');
    const bytes = readFileSync(descriptor);
    if (bytes.length > MAX_CONFIGURATION_BYTES) throw new Error('invalid-file');
    return { options: currentGarageOptions(parseOptions(bytes.toString('utf8'))), digest: createHash('sha256').update(bytes).digest('hex'),
      device: stat.dev, inode: stat.ino, size: stat.size, modified: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.message.startsWith('Configuration')) throw error;
    throw new Error('The import must be a readable regular secrets.json file, at most 1 MiB.');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function sameFile(left, right) {
  return left && right && ['digest', 'device', 'inode', 'size', 'modified'].every(key => left[key] === right[key]);
}

function readReceipt(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (/^[a-f0-9]{64}$/.test(value.digest) && ['saving', 'saved', 'applied'].includes(value.state)
      && ['device', 'inode', 'size', 'modified'].every(key => Number.isFinite(value[key]))) return value;
    throw new Error('invalid-receipt');
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('The private configuration import receipt could not be read.'); }
  return null;
}

function receiptFor(file, state, extra = {}) {
  const { digest, device, inode, size, modified } = file;
  return { digest, device, inode, size, modified, state, ...extra };
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch {
    try { unlinkSync(temporary); } catch { /* No credentials are stored here. */ }
    throw new Error('The private configuration import receipt could not be saved.');
  }
}

function withoutRetiredEaseeTokens(options) {
  const result = mergeOptions({}, options);
  if (object(result.easee)) { delete result.easee.access_token; delete result.easee.refresh_token; }
  return result;
}

function optionsDigest(options) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(options))).digest('hex');
}

function visitValues(options, visit, path = '') {
  for (const [key, value] of Object.entries(options)) {
    const field = path ? `${path}.${key}` : key;
    if (object(value) || Array.isArray(value)) visitValues(value, visit, field);
    else visit(value, field);
  }
}

function validateHomeAssistantValues(options) {
  visitValues(options, (value, field) => {
    if (value === null) throw new Error(`Home Assistant does not support null: ${field}. Use an empty string for optional text, or remove the field in Home Assistant settings.`);
    if (typeof value === 'string' && value.startsWith('!secret '))
      throw new Error(`Use the actual value in secrets.json instead of a Home Assistant secret reference: ${field}.`);
  });
}

function containsReferences(options) {
  let found = false;
  visitValues(options, value => { found ||= typeof value === 'string' && value.startsWith('!secret '); });
  return found;
}

// All private options, token headers and import fingerprints remain in closures.
// The callbacks separate validation, persistence and application so main can
// reject startup-only changes and restore equipment before saving an import.
export function createConfigurationSource({ env, cwd, buildConfig, paths = configurationPaths(env, cwd),
  fetchImpl = (...args) => fetch(...args) }) {
  const environment = { ...env }, addon = env.STMQ_ADDON === '1';
  let slug = null;
  const publicInfo = () => ({ environment: addon ? 'home-assistant' : 'ubuntu', defaultsPath: paths.defaultsPath,
    privatePath: paths.privatePath, importPath: paths.importPath,
    privateFileRole: addon ? 'startup-fallback' : 'permanent-overrides',
    externalImportPath: slug ? `/addon_configs/${slug}/secrets.json` : null });
  async function supervisor(method, endpoint, body) {
    if (!environment.SUPERVISOR_TOKEN) throw new Error('Supervisor authentication is unavailable.');
    let response;
    try {
      response = await fetchImpl(`http://supervisor/addons/self/${endpoint}`, { method,
        headers: { Authorization: `Bearer ${environment.SUPERVISOR_TOKEN}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000), redirect: 'error' });
    } catch { throw new Error('The Home Assistant Supervisor could not be reached.'); }
    let result;
    try { result = await response.json(); } catch { throw new Error('Supervisor returned an invalid configuration response.'); }
    if (!response.ok || result.result !== 'ok') throw new Error(`Supervisor could not ${method === 'POST' ? 'save' : 'read'} the configuration.`);
    return result.data;
  }
  async function currentOptions() {
    const info = await supervisor('GET', 'info');
    if (!object(info?.options)) throw new Error('Supervisor did not return this add-on’s settings.');
    if (typeof info.slug === 'string' && /^[a-zA-Z0-9_-]+$/.test(info.slug)) slug = info.slug;
    return currentGarageOptions(withoutRetiredEaseeTokens(info.options));
  }
  const source = {
    publicInfo,
    async prepare({ startup = false } = {}) {
      const defaults = manifest(paths.defaultsPath);
      validateOptionFields(defaults.options, defaults.schema);
      if (!addon) {
        const overrides = privateOptions(paths.privatePath, Boolean(environment.STMQ_CONFIG));
        validateOptionFields(overrides, defaults.schema);
        return { config: buildConfig(mergeOptions(defaults.options, overrides), publicInfo(), source), imported: false,
          async persist() {}, async complete() { return { cleanupPending: false }; } };
      }
      const file = snapshot(paths.importPath);
      let current;
      try { current = await currentOptions(); }
      catch (error) {
        if (!startup || file) throw error;
        current = withoutRetiredEaseeTokens(privateOptions(paths.privatePath, Boolean(environment.STMQ_CONFIG)));
      }
      const receipt = file ? readReceipt(paths.receiptPath) : null;
      const sameReceipt = sameFile(file, receipt);
      const currentDigest = optionsDigest(mergeOptions(defaults.options, current));
      const uncertain = sameReceipt && receipt.state === 'saving';
      if (uncertain && ![receipt.previousDigest, receipt.optionsDigest].includes(currentDigest))
        throw new Error('Home Assistant settings changed during an interrupted import. Remove the retained import file to load the current settings.');
      const saved = sameReceipt && (!uncertain || currentDigest === receipt.optionsDigest);
      if (file && !saved) {
        validateHomeAssistantValues(file.options);
        validateOptionFields(file.options, defaults.schema);
      }
      const options = mergeOptions(defaults.options, file && !saved ? mergeOptions(current, file.options) : current);
      let resolvedCurrent = current;
      if (containsReferences(current)) {
        resolvedCurrent = currentGarageOptions(withoutRetiredEaseeTokens(await supervisor('GET', 'options/config')));
        validateHomeAssistantValues(resolvedCurrent);
      }
      const runtimeOptions = mergeOptions(defaults.options, file && !saved ? mergeOptions(resolvedCurrent, file.options) : resolvedCurrent);
      validateHomeAssistantValues(runtimeOptions);
      validateOptionFields(runtimeOptions, defaults.schema);
      const config = buildConfig(runtimeOptions, publicInfo(), source);
      let persisted = !file || saved;
      return { config, imported: Boolean(file),
        async persist() {
          if (persisted) return;
          if (!sameFile(file, snapshot(paths.importPath))) throw new Error('The import file changed. Apply configuration again.');
          // Do not replace HA settings changed while main checked the runtime.
          if (!isDeepStrictEqual(await currentOptions(), current)) throw new Error('Home Assistant settings changed. Apply configuration again.');
          writeReceipt(paths.receiptPath, receiptFor(file, 'saving', {
            previousDigest: currentDigest, optionsDigest: optionsDigest(runtimeOptions) }));
          await supervisor('POST', 'options', { options });
          const verified = mergeOptions(defaults.options, await currentOptions());
          if (!isDeepStrictEqual(verified, runtimeOptions)) throw new Error('Supervisor settings could not be verified. The import file was retained.');
          writeReceipt(paths.receiptPath, receiptFor(file, 'saved'));
          persisted = true;
        },
        async complete() {
          if (!file) return { cleanupPending: false };
          if (!persisted) throw new Error('Configuration must be saved before completing its import.');
          try {
            writeReceipt(paths.receiptPath, receiptFor(file, 'applied'));
            const present = snapshot(paths.importPath);
            if (sameFile(file, present)) unlinkSync(paths.importPath);
            return { cleanupPending: Boolean(present && !sameFile(file, present)) };
          } catch { return { cleanupPending: true }; }
        },
      };
    },
  };
  return source;
}
