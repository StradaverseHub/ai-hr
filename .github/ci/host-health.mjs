/** Small read-only admission check; never kills work, clears swap, or changes the database. */
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const GiB = 1024 ** 3;
const command = (bin, args) => { try { return execFileSync(bin, args, {encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']}); } catch { return null; } };
export function parseHealth({platform, disk, pressure, swap}) {
  const lines = disk?.trim().split('\n'), columns = lines?.at(-1)?.trim().split(/\s+/);
  const available = columns && Number(columns[3]);
  return {
    platform,
    availableDiskBytes: Number.isFinite(available) ? available * 1024 : null,
    memoryFreePercent: platform === 'darwin' ? Number(pressure?.match(/System-wide memory free percentage:\s*(\d+)%/)?.[1] ?? NaN) : null,
    swapUsedBytes: platform === 'darwin' ? Number(swap?.match(/used\s*=\s*([\d.]+)M/)?.[1] ?? NaN) * 1024 ** 2 : null,
  };
}
export function assessHealth(snapshot) {
  const reasons = [], warnings = [];
  if (!Number.isFinite(snapshot.availableDiskBytes)) reasons.push('Available disk space could not be measured');
  else if (snapshot.availableDiskBytes < 20 * GiB) reasons.push('Less than 20 GiB available on the worktree volume');
  if (snapshot.platform === 'darwin') {
    if (!Number.isFinite(snapshot.memoryFreePercent)) reasons.push('Mac memory pressure could not be measured');
    else if (snapshot.memoryFreePercent < 10) reasons.push('Mac memory availability indicator is below 10%');
    if (!Number.isFinite(snapshot.swapUsedBytes)) warnings.push('Current swap usage is unavailable');
    if (snapshot.swapUsedBytes >= 4 * GiB) warnings.push('Swap use exceeds 4 GiB; inspect pressure and running jobs before adding local work');
  }
  return {ok: reasons.length === 0, reasons, warnings};
}
export function hostHealth(cwd = process.cwd()) {
  const snapshot = parseHealth({platform: process.platform, disk: command('df', ['-Pk', cwd]),
    pressure: process.platform === 'darwin' ? command('memory_pressure', ['-Q']) : null,
    swap: process.platform === 'darwin' ? command('sysctl', ['vm.swapusage']) : null});
  return {...snapshot, at: new Date().toISOString(), ...assessHealth(snapshot)};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const health = hostHealth(); console.log(JSON.stringify(health, null, 2));
  if (!['', '--check'].includes(process.argv[2] ?? '')) throw Error('Usage: host-health.mjs [--check]');
  if (process.argv[2] === '--check' && !health.ok) process.exitCode = 2;
}
