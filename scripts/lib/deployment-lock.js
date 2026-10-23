import { mkdirSync, lstatSync, rmdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DeploymentSafetyError } from './paired-deployment.js';
const owners = new WeakMap();
export function acquireDeploymentLock(runtime) {
  let path = join(resolve(runtime), 'deployment.lock');
  try { mkdirSync(runtime, { recursive: true }); path = join(realpathSync(runtime), 'deployment.lock'); }
  catch { throw new DeploymentSafetyError(`Could not prepare the runtime directory for the deployment lock at ${JSON.stringify(path)}. Check the configured runtime path, directory permissions and storage availability.`); }
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    throw new DeploymentSafetyError(error.code === 'EEXIST'
      ? `A deployment lock exists at ${JSON.stringify(path)}. Inspect the previous operation before removing only that empty lock directory.`
      : `Could not create the deployment lock at ${JSON.stringify(path)}. Check directory permissions and storage availability.`);
  }
  const info = lstatSync(path), owner = {};
  owners.set(owner, { path, device: info.dev, inode: info.ino });
  return owner;
}
export function deploymentLockPath(owner) {
  const held = owners.get(owner);
  if (!held) throw new DeploymentSafetyError('This operation has no deployment lock.');
  return held.path;
}
export function ownsDeploymentLock(owner, runtime) {
  const held = owners.get(owner);
  if (!held) return false;
  try {
    if (held.path !== join(realpathSync(runtime), 'deployment.lock')) return false;
    const info = lstatSync(held.path);
    return info.isDirectory() && info.dev === held.device && info.ino === held.inode;
  } catch { return false; }
}
export function releaseDeploymentLock(owner, runtime) {
  const path = deploymentLockPath(owner);
  if (!ownsDeploymentLock(owner, runtime)) throw new DeploymentSafetyError(`Deployment lock ownership could not be confirmed at ${JSON.stringify(path)}. Inspect the installation; the lock was not removed.`);
  try { rmdirSync(path); }
  catch { throw new DeploymentSafetyError(`Could not remove the deployment lock at ${JSON.stringify(path)}. Inspect the directory and remove it only when empty and the operation has finished.`); }
  owners.delete(owner);
}

export function remoteDeploymentLockPath(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9_-]+$/.test(slug)) throw new DeploymentSafetyError('Invalid HA app identity.');
  return `/tmp/st-mq-deploy-${slug}.lock`;
}

/** Setup and deployment share the same HA SSH-app lock and refusal policy. */
export async function acquireRemoteDeploymentLock(ssh, slug) {
  const path = remoteDeploymentLockPath(slug);
  const result = await ssh.run(`umask 077\nif mkdir ${path}; then exit 0; fi\nif test -e ${path} || test -L ${path}; then exit 73; fi\nexit 74`, { timeoutMs: 15000 });
  if (result.exitCode === 73) throw new DeploymentSafetyError(`A deployment lock already exists at ${JSON.stringify(path)} on HA in the SSH app. Confirm the previous setup/deployment and any Supervisor rebuild have finished, then remove only that empty lock directory.`);
  if (result.exitCode !== 0) throw new DeploymentSafetyError(`Could not create the remote deployment lock at ${JSON.stringify(path)} on HA in the SSH app. Check directory permissions and storage availability.`);
  return path;
}
