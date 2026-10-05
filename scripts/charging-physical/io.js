import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const outside = file => file !== root && !file.startsWith(root + path.sep);

// Evidence and credentials are installation data, never repository fixtures.
export function privatePath(file) {
  if (typeof file !== 'string' || !file) throw Error('An external private path is required');
  const full = path.resolve(file), parent = fs.realpathSync(path.dirname(full));
  const stat = fs.statSync(parent);
  if (!outside(parent) || (stat.mode & 0o077) !== 0)
    throw Error('Use an external directory with mode 0700');
  return path.join(parent, path.basename(full));
}

export function readPrivateJson(file) {
  const full = privatePath(file), stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 2 * 1024 * 1024)
    throw Error('Expected a private JSON file, at most 2 MiB, with mode 0600');
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

export function openPrivateOutput(file) {
  return fs.openSync(privatePath(file), 'wx', 0o600);
}

export function parseArgs(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.slice(2), value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !allowed.includes(name) || Object.hasOwn(result, name)
      || !value || value.startsWith('--')) throw Error('Invalid arguments; use --help');
    result[name] = value;
  }
  return result;
}

export function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw Error('Argument is outside its supported bounds');
  return number;
}

export function objectKeys(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw Error('Unsupported configuration fields');
}

export async function boundedJson(response, maximum = 2 * 1024 * 1024) {
  if (!response.ok) throw Error('Read-only request failed');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw Error('Read-only response exceeds its size limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
