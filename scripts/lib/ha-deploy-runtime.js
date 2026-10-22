import { ownsApplicationListener } from './deployment-process.js';
import { DeploymentSafetyError } from './paired-deployment.js';
import { shellQuote } from './ha-deploy-transport.js';

// Send current read-only probe code over stdin: initial preflight cannot assume
// the installed image already contains the target commit's deployment helpers.
export function containerProbe({ allowWaiting = false, pid = 1, directory = '/st-mq' } = {}) {
  return `import * as fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const ownsApplicationListener=${ownsApplicationListener.toString()};
const waiting=${JSON.stringify(allowWaiting)}, directory=${JSON.stringify(directory)}, pid=${JSON.stringify(pid)};
try {
 const {loadConfig}=await import(pathToFileURL(directory+'/src/app/config.js'));
 const config=loadConfig();
 const origin='http://'+(config.host?.includes(':')?'[::1]':'127.0.0.1')+':'+config.port;
 if(!ownsApplicationListener({pid,executable:process.execPath,directory,entrypoint:directory+'/src/main.js',origin},fs)) {
  if(!waiting)throw Error();
  console.log(JSON.stringify({state:'waiting'}));
 } else {
  let response;
  try {response=await fetch(origin+'/api/pair',{headers:config.token?{Authorization:'Bearer '+config.token}:{},redirect:'error',signal:AbortSignal.timeout(5000)});}catch{if(!waiting)throw Error();}
  if(!response || response.status===503 && waiting) console.log(JSON.stringify({state:'waiting'}));
  else {
   if(!response.ok)throw Error();
   const reader=response.body.getReader(),chunks=[];let bytes=0;
   while(true){const{done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1048576){await reader.cancel();throw Error();}chunks.push(Buffer.from(value));}
   const p=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!p || typeof p!=='object' || Array.isArray(p))throw Error();
   const pair={};for(const key of ['role','nodeId','pairId','canControl','busy','phase','bootstrapPending'])pair[key]=p[key];
   pair.error=p.error==null?null:'present';pair.vip={owned:p.vip?.owned};
   pair.peer={};for(const key of ['nodeId','role','reachable','lastSeenAt'])pair.peer[key]=p.peer?.[key];
   pair.sync={state:p.sync?.state,error:p.sync?.error==null?null:'present'};
   pair.recovery={state:p.recovery?.state,pendingRelease:Boolean(p.recovery?.pendingRelease)};
   pair.actions={promote:p.actions?.promote===true};
   console.log(JSON.stringify({state:'ready',pair,observedAt:Date.now()}));
  }
 }
}catch{console.log(JSON.stringify({state:'error'}));}
`;
}

export async function readHARuntime(ssh, app, { allowWaiting = false, expectedContainer, expectedImage } = {}) {
  if (!/^[a-z0-9_-]+$/.test(app.slug)) throw new DeploymentSafetyError('Invalid HA app identity.');
  const code = `import json,subprocess
rows=[json.loads(x) for x in subprocess.check_output(['docker','container','ls','--all','--no-trunc','--filter','name=^/(app|addon)_${app.slug}$','--format','{{json .}}'],text=True).splitlines()]
assert len(rows)<=1
if not rows or rows[0]['State']!='running':
 assert ${allowWaiting ? 'True' : 'False'}
 print(json.dumps({'state':'waiting'}))
else:
 row=rows[0]
 assert row['Names'] in ['app_${app.slug}','addon_${app.slug}']
 info=json.loads(subprocess.check_output(['docker','inspect',row['ID']],text=True))[0]
 assert info['Name'] in ['/app_${app.slug}','/addon_${app.slug}'] and info['State']['Running'] is True
 print(json.dumps({'state':'running','id':info['Id'],'image':info['Image']}))
`;
  const metadata = await ssh.run(`python3 -c ${shellQuote(code)}`, { timeoutMs: 15000 });
  if (metadata.exitCode !== 0) throw new DeploymentSafetyError('The selected HA container could not be identified unambiguously.');
  let container;
  try { container = JSON.parse(metadata.output); } catch { throw new DeploymentSafetyError('Invalid HA container observation; private output suppressed.'); }
  if (container.state === 'waiting' && allowWaiting) return null;
  if (container.state !== 'running' || !/^[a-f0-9]{64}$/.test(container.id) || !/^sha256:[a-f0-9]{64}$/.test(container.image)
    || expectedContainer && container.id !== expectedContainer || expectedImage && container.image !== expectedImage)
    throw new DeploymentSafetyError('The HA container or running image does not match the selected deployment.');
  const result = await ssh.run(`docker exec -i ${container.id} node --input-type=module`, { input: Buffer.from(containerProbe({ allowWaiting })), timeoutMs: 15000 });
  if (result.exitCode !== 0) throw new DeploymentSafetyError('HA runtime observation failed; private container output suppressed.');
  let snapshot;
  try { snapshot = JSON.parse(result.output); } catch { throw new DeploymentSafetyError('Invalid HA runtime observation; private output suppressed.'); }
  if (snapshot.state === 'waiting' && allowWaiting) return null;
  if (snapshot.state !== 'ready' || !snapshot.pair || !Number.isFinite(snapshot.observedAt)) throw new DeploymentSafetyError('Authenticated HA pair status or application listener ownership could not be verified.');
  return { ...snapshot, container: container.id, image: container.image };
}
