#!/usr/bin/env node
import { main, LinuxDeploymentError } from './lib/linux-deployment.js';
const abort = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => abort.abort());
try { await main('deploy', process.argv.slice(2), { signal: abort.signal }); }
catch (error) { console.error(error instanceof LinuxDeploymentError ? error.message : 'Linux deployment failed; private error details suppressed.'); process.exitCode = 1; }
