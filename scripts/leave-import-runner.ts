/** Dedicated worker for background leave ledger imports. Separate process and small pool, so a long
 * import never competes with the web application's connections. MIGRATION_DATABASE_URL only finds jobs;
 * DATABASE_URL owns every HR transaction under the initiating user's authority. */
import postgres from 'postgres';
import {runLeaveImportTick} from '../core/leave-import-worker';
import {client} from '../db/client';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required by the leave import worker.');
const owner = postgres(url, {max: 1, onnotice: () => {}});
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function main() {
  try {
    do {
      const worked = await runLeaveImportTick(owner);
      if (process.argv.includes('--once')) break;
      await new Promise(resolve => setTimeout(resolve, worked ? 25 : 1000));
    } while (!stopping);
  } finally {
    await owner.end({timeout: 5});
    await client.end({timeout: 5});
  }
}
main().catch(() => { console.error('Leave import worker stopped. Check its database access, migrations and runtime configuration.'); process.exitCode = 1; });
