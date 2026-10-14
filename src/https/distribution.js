import { createHash, createPublicKey, verify } from 'node:crypto';
import { TAILSCALE_ROOTS } from './official-roots.js';
import { httpsError } from './storage.js';

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function key(raw) { return createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), type: 'spki', format: 'der' }); }

export function verifySigningBundle(bundle, signature, roots = TAILSCALE_ROOTS) {
  if (!Buffer.isBuffer(bundle) || !bundle.length || bundle.length > 1024 * 1024 || signature.length !== 64 ||
      !roots.some(root => verify(null, bundle, key(Buffer.from(root, 'base64')), signature))) throw httpsError('vendor_signing_keys_untrusted');
  const text = bundle.toString('ascii');
  const pattern = /-----BEGIN SIGNING PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END SIGNING PUBLIC KEY-----/g;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length || matches.length > 32 || text.replace(pattern, '').trim()) throw httpsError('vendor_signing_keys_invalid');
  return matches.map(match => {
    const raw = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
    if (raw.length !== 32) throw httpsError('vendor_signing_keys_invalid');
    return key(raw);
  });
}

export function verifyArtifactHash(digest, length, signature, signingKeys) {
  if (digest.length !== 32 || !Number.isSafeInteger(length) || length <= 0 || signature.length !== 64) throw httpsError('vendor_artifact_signature_invalid');
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(length));
  if (!signingKeys.some(publicKey => verify(null, Buffer.concat([digest, size]), publicKey, signature))) throw httpsError('vendor_artifact_signature_invalid');
}

export function architecture(value = process.arch) {
  if (value === 'x64' || value === 'amd64') return 'amd64';
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  throw httpsError('helper_architecture_unsupported');
}

export function stableVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match || match.slice(1).some(part => !Number.isSafeInteger(Number(part)) || String(Number(part)) !== part)) throw httpsError('vendor_version_invalid');
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const aa = stableVersion(a); const bb = stableVersion(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return Math.sign(aa[i] - bb[i]);
  return 0;
}

export function releaseCandidate(metadata, arch = architecture()) {
  const version = metadata?.TarballsVersion;
  const [major, minor] = stableVersion(version);
  const name = metadata?.Tarballs?.[arch];
  if (name !== `tailscale_${version}_${arch}.tgz`) throw httpsError('vendor_artifact_metadata_invalid');
  return { version, arch, filename: name, eligible: major === 1 && minor % 2 === 0 && compareVersions(version, '1.104.1') >= 0,
    url: `https://pkgs.tailscale.com/stable/${name}` };
}

export async function fileHash(path) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
