// Public Ed25519 trust anchors from Tailscale, BSD-3-Clause.
// Source: tailscale/tailscale a6a4c25c26e9d2320ad3db3d8611ee22922fe6af,
// clientupdate/distsign/roots/{crawshaw-root,distsign-prod-root-1-pub}.pem.
// These are vendor PUBLIC keys, never installation identity keys. Root changes
// require a reviewed application update; network metadata cannot add roots.
export const TAILSCALE_ROOTS = Object.freeze([
  'Psrabv2YNiEDhPlnLVSMtB5EKACm7zxvKxfvYD4i7X8=',
  'ZjjKhUHBtLNRSO1dhOTjrXJGJ8lDe1594WM2XDuheVQ=',
]);
export const TAILSCALE_SOURCE_REVISION = 'a6a4c25c26e9d2320ad3db3d8611ee22922fe6af';
export const BOOTSTRAP_VERSION = '1.104.1';
export const BOOTSTRAP_SHA256 = Object.freeze({
  amd64: '108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528',
  arm64: 'f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806',
});
