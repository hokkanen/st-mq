#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { sshOptions } from '../src/replication/ssh-options.js';

// sqlite3_rsync's --ssh option accepts an executable, not SSH arguments. Keep
// authentication/host checks and dead-peer detection identical on both channels.
const child = spawn('ssh', [...sshOptions(process.env.STMQ_MIRROR_SSH_CONFIG), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
