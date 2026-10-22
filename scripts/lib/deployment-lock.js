import { mkdirSync, lstatSync, rmdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DeploymentSafetyError } from './paired-deployment.js';
const owners = new WeakMap();
export function acquireDeploymentLock(runtime) {
  mkdirSync(runtime, { recursive: true });
  const path = join(realpathSync(runtime), 'deployment.lock');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch { throw new DeploymentSafetyError('A deployment lock exists. Inspect the previous operation before removing its empty lock.'); }
  const info = lstatSync(path), owner = {};
  owners.set(owner, { path, device: info.dev, inode: info.ino });
  return owner;
}
export function ownsDeploymentLock(owner, runtime) {
  const held = owners.get(owner);
  if (!held || held.path !== join(realpathSync(runtime), 'deployment.lock')) return false;
  const info = lstatSync(held.path);
  return info.isDirectory() && info.dev === held.device && info.ino === held.inode;
}
export function releaseDeploymentLock(owner, runtime) {
  if (!ownsDeploymentLock(owner, runtime)) throw new DeploymentSafetyError('Deployment lock ownership changed; inspect the installation.');
  rmdirSync(owners.get(owner).path); owners.delete(owner);
}
