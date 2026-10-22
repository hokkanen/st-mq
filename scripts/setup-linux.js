#!/usr/bin/env node
import { main } from './lib/linux-deployment.js';
import { DeploymentSafetyError } from './lib/paired-deployment.js';
const abort = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => abort.abort());
try { await main('setup', process.argv.slice(2), { signal: abort.signal }); }
catch (error) { console.error(error instanceof DeploymentSafetyError ? error.message : 'Linux setup failed; private error details suppressed.'); process.exitCode = 1; }
