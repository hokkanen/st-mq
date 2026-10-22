import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { DeploymentSafetyError } from './paired-deployment.js';

export function createSetupTerminal({ input = process.stdin, output = process.stdout, signal } = {}) {
  if (!input.isTTY || !output.isTTY) throw new DeploymentSafetyError('Setup needs an interactive terminal. Run it directly in a terminal; do not pipe a configuration file into it.');
  let muted = false, pending, closed = false;
  const lines = [];
  const display = new Writable({ write(chunk, encoding, callback) { if (!muted) output.write(chunk, encoding); callback(); } });
  // Readline owns the terminal's raw mode; suppress its output while pasting so
  // credentials never reach terminal scrollback or readline history.
  const reader = createInterface({ input, output: display, terminal: true, historySize: 0 });
  reader.on('line', line => { if (pending) { const next = pending; pending = null; next(line); } else lines.push(line); });
  reader.on('close', () => { closed = true; if (pending) { const next = pending; pending = null; next(null); } });
  const nextLine = () => lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve(null) : new Promise(resolve => { pending = resolve; });
  const abort = () => reader.close(); signal?.addEventListener('abort', abort, { once: true });
  const terminal = {
    log: message => output.write(message + '\n'),
    async ask(label, fallback = '') {
      if (signal?.aborted) throw new DeploymentSafetyError('Setup cancelled.');
      output.write(label + (fallback !== '' ? ` [${fallback}]` : '') + ': ');
      const line = await nextLine();
      if (line === null) throw new DeploymentSafetyError('Setup cancelled before completion.');
      return line.trim() || String(fallback);
    },
    async choose(label, options, fallback = options[0]) {
      terminal.log(label);
      options.forEach((option, index) => terminal.log(`  ${index + 1}. ${option}`));
      while (true) {
        const value = await terminal.ask('Choose', String(options.indexOf(fallback) + 1));
        const selected = options[Number(value) - 1];
        if (selected) return selected;
        terminal.log('Enter one of the listed numbers.');
      }
    },
    async confirm(label, fallback = false) {
      while (true) {
        const answer = (await terminal.ask(label + (fallback ? ' (Y/n)' : ' (y/N)'), fallback ? 'yes' : 'no')).toLowerCase();
        if (['yes', 'y'].includes(answer)) return true;
        if (['no', 'n'].includes(answer)) return false;
      }
    },
    async paste() {
      terminal.log('Paste the complete JSON. Input is hidden. Finish with a line containing only END.');
      const chunks = []; let bytes = 0;
      muted = true;
      try {
        while (true) {
          const line = await nextLine();
          if (line === null) throw new DeploymentSafetyError('Configuration paste cancelled.');
          if (line === 'END') break;
          bytes += Buffer.byteLength(line) + 1;
          if (bytes > 1048576) throw new DeploymentSafetyError('Configuration exceeds its size limit.');
          chunks.push(line);
        }
      } finally { muted = false; output.write('\n'); }
      return chunks.join('\n');
    },
    async external(action) {
      const wasRaw = input.isRaw;
      reader.pause(); input.setRawMode?.(false);
      try {
        return await action();
      } finally {
        if (!closed && !signal?.aborted) { input.setRawMode?.(wasRaw); reader.resume(); }
        else input.setRawMode?.(false);
      }
    },
    async edit(path) {
      return terminal.external(async () => {
        const command = process.env.VISUAL || process.env.EDITOR || 'nano';
        // Support ordinary editor flags, without executing a shell expression.
        const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(part => part.replace(/^(['"])(.*)\1$/, '$2'));
        if (!parts?.length) throw new DeploymentSafetyError('No editor is configured.');
        await new Promise((resolve, reject) => {
          const child = spawn(parts[0], [...parts.slice(1), path], { stdio: 'inherit', shell: false });
          let killer;
          const stop = () => { child.kill('SIGTERM'); killer = setTimeout(() => child.kill('SIGKILL'), 1000); }; signal?.addEventListener('abort', stop, { once: true });
          const cleanup = () => { clearTimeout(killer); signal?.removeEventListener('abort', stop); };
          child.once('error', () => { cleanup(); reject(new DeploymentSafetyError('The editor could not start. Set EDITOR or edit the displayed private draft in another terminal.')); });
          child.once('exit', code => { cleanup(); code === 0 && !signal?.aborted ? resolve() : reject(new DeploymentSafetyError('The editor did not complete. The private draft was retained.')); });
          if (signal?.aborted) stop();
        });
      });
    },
    close() { signal?.removeEventListener('abort', abort); reader.close(); display.end(); },
  };
  return terminal;
}
