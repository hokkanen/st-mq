// Tie authenticated HTTP evidence to systemd's actual application process.
// Linux /proc reads only: no application imports, signals or device operations.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { ownsApplicationListener } from './deployment-process.js';

try {
  const [pid, node, current, origin] = process.argv.slice(2);
  if (!ownsApplicationListener({ pid, executable: node, directory: current, entrypoint: join(current, 'src/main.js'), origin }, fs)) throw new Error();
} catch {
  console.error('The configured status listener is not owned by the expected application service process.');
  process.exitCode = 1;
}
