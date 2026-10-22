import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSetupTerminal } from '../scripts/lib/linux-setup-terminal.js';

const terminalModule = new URL('../scripts/lib/linux-setup-terminal.js', import.meta.url).href;
const secret = 'synthetic-terminal-password-1234567890';

// Use an actual pseudo-terminal: fake streams cannot establish whether kernel
// echo, readline rendering or external program handoff exposes pasted secrets.
const harness = String.raw`import os,sys,json,select,subprocess,time,termios,signal
master,slave=os.openpty()
before=termios.tcgetattr(slave)
process=subprocess.Popen([sys.argv[1],sys.argv[2],sys.argv[3]],stdin=slave,stdout=slave,stderr=slave,close_fds=True,start_new_session=True)
transcript=bytearray()
def receive(marker=None,timeout=8):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.05)
  if ready:
   try:chunk=os.read(master,65536)
   except OSError:chunk=b''
   if chunk:transcript.extend(chunk)
  if marker is not None and marker in transcript:return
  if process.poll() is not None and not ready:return
 if marker is not None:raise RuntimeError('Expected terminal stage did not arrive')
try:
 mode=sys.argv[3]
 if mode in ('paste','interrupt','eof'):
  receive(b'Finish with a line containing only END.')
  if mode=='paste':os.write(master,b'{"mqtt":{"pw":"synthetic-terminal-password-1234567890"},"label":"synthetic-unicode-\xc3\xa4"}\nEND\n')
  elif mode=='interrupt':
   os.write(master,b'synthetic-terminal-password-1234567890')
   os.write(master,b'\x03')
  else:
   os.write(master,b'synthetic-terminal-password-1234567890\n')
   os.write(master,b'\x04')
 elif mode=='external':
  receive(b'EXTERNAL_ACTIVE')
  receive(b'NEXT_INPUT')
  os.write(master,b'continue\n')
 elif mode=='abort-external':
  receive(b'EXTERNAL_ACTIVE')
  os.kill(process.pid,signal.SIGTERM)
 elif mode=='abort-editor':
  receive(b'EDITOR_ACTIVE')
  os.kill(process.pid,signal.SIGTERM)
 else:raise RuntimeError('Unknown fixture mode')
 receive(timeout=8)
 process.wait(timeout=2)
 after=termios.tcgetattr(slave)
 mask=termios.ECHO|termios.ICANON|termios.ISIG
 print(json.dumps({'exitCode':process.returncode,'output':transcript.decode('utf8','replace'),'restored':(before[3]&mask)==(after[3]&mask)}))
finally:
 if process.poll() is None:
  process.kill()
  process.wait(timeout=2)
 os.close(master)
 os.close(slave)
`;

function exercise(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'st-mq-terminal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = join(directory, 'fixture.mjs'), editor = join(directory, 'editor.mjs');
  writeFileSync(editor, "process.on('SIGTERM',()=>{});console.log('EDITOR_ACTIVE');setInterval(()=>{},1000);\n", { mode: 0o600 });
  writeFileSync(child, `import assert from 'node:assert/strict';
import{createSetupTerminal}from${JSON.stringify(terminalModule)};
const abort=new AbortController();process.once('SIGTERM',()=>abort.abort());
const io=createSetupTerminal({signal:abort.signal});
try{
 const mode=process.argv[2];
 if(['paste','interrupt','eof'].includes(mode)){
  const value=JSON.parse(await io.paste());
  assert.equal(value.mqtt.pw,${JSON.stringify(secret)});
  assert.equal(value.label,'synthetic-unicode-ä');
  io.log('PASTE_ACCEPTED');
 }else if(mode==='external'){
  await io.external(async()=>{assert.equal(process.stdin.isRaw,false);io.log('EXTERNAL_ACTIVE');await new Promise(yes=>setTimeout(yes,30));});
  assert.equal(process.stdin.isRaw,true);
  assert.equal(await io.ask('NEXT_INPUT'),'continue');io.log('EXTERNAL_COMPLETE');
 }else if(mode==='abort-external'){
  await io.external(()=>new Promise((yes,no)=>{const timer=setInterval(()=>{},1000);assert.equal(process.stdin.isRaw,false);io.log('EXTERNAL_ACTIVE');abort.signal.addEventListener('abort',()=>{clearInterval(timer);no(Error('fixture cancelled'));},{once:true});}));
 }else if(mode==='abort-editor'){
  process.env.VISUAL=${JSON.stringify(process.execPath + ' ' + editor)};
  await io.edit(${JSON.stringify(join(directory, 'draft.json'))});
 }
}catch{io.log('CANCELLED');}finally{io.close();}
`, { mode: 0o600 });
  const result = execFileSync('python3', ['-c', harness, process.execPath, child, mode], {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(result);
}

test('configuration paste stays hidden in a real terminal and accepts complete Unicode JSON', t => {
  const result = exercise(t, 'paste');
  assert.equal(result.exitCode, 0); assert.match(result.output, /PASTE_ACCEPTED/);
  assert.equal(result.output.includes(secret), false); assert.equal(result.restored, true);
});

for (const mode of ['interrupt', 'eof']) test(`terminal ${mode} cancels hidden paste and restores terminal modes`, t => {
  const result = exercise(t, mode);
  assert.equal(result.exitCode, 0); assert.match(result.output, /CANCELLED/);
  assert.equal(result.output.includes(secret), false); assert.equal(result.restored, true);
});

test('external terminal handoff restores interactive readline after the operation', t => {
  const result = exercise(t, 'external');
  assert.equal(result.exitCode, 0); assert.match(result.output, /EXTERNAL_COMPLETE/);
  assert.equal(result.restored, true);
});

for (const mode of ['abort-external', 'abort-editor']) test(`${mode} restores terminal modes after cancellation`, t => {
  const result = exercise(t, mode);
  assert.equal(result.exitCode, 0); assert.match(result.output, /CANCELLED/);
  assert.equal(result.restored, true);
});

test('noninteractive streams are refused before configuration can be read', () => {
  assert.throws(() => createSetupTerminal({ input: { isTTY: false }, output: { isTTY: true } }), /interactive terminal/);
  assert.throws(() => createSetupTerminal({ input: { isTTY: true }, output: { isTTY: false } }), /interactive terminal/);
});
