import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** Single service with the persistent disk; never expose backup credentials through an HTTP route. */
export function startBackupScheduler() {
  if (process.env.R2_BACKUP_ENABLED === 'false' || !['R2_BUCKET', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].every(key => process.env[key]) ||
      !process.env.DATABASE_PATH || process.env.DATABASE_PATH === ':memory:') return;
  let active = false;
  const run = () => {
    if (active) return;
    active = true;
    const child = spawn(process.execPath, [resolve('scripts/backup-r2.mjs')], { stdio: ['ignore', 'inherit', 'inherit'] });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30 * 60000);
    timeout.unref();
    const finish = () => { clearTimeout(timeout); active = false; };
    child.once('error', () => { console.error('backup_r2_process_failed'); finish(); });
    child.once('exit', finish);
  };
  run();
  const timer = setInterval(run, 3600000);
  timer.unref();
}

