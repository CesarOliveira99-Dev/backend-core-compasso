import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const environment = { ...process.env, SEED_DEMO: process.argv.includes('--demo') ? 'true' : process.env.SEED_DEMO || 'false' };
const compiler = require.resolve('typescript/bin/tsc');
const start = args => spawn(process.execPath, args, { cwd: root, env: environment, stdio: 'inherit' });
const initialBuild = start([compiler]);
const code = await new Promise(resolvePromise => initialBuild.on('exit', resolvePromise));
if (code !== 0) process.exit(Number(code) || 1);
const children = [start(['--watch', 'dist/main.js']), start([compiler, '--watch', '--preserveWatchOutput'])];
let stopping = false;
function stop() { if (stopping) return; stopping = true; children.forEach(child => child.kill()); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); setTimeout(() => process.exit(), 250); });
children.forEach(child => { child.on('error', error => { console.error(error.message); stop(); }); child.on('exit', exitCode => { if (!stopping && exitCode) { process.exitCode = exitCode; stop(); } }); });
