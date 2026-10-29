/** IDs-only controlled private sender. Credentials and relay are read by their actual owner. */
import { lifecycleV9EmailIpc } from '../../../lib/lifecycle-v9-email-ipc';
import { client } from '../../../db/client';
async function main() {
  try {
    if (process.env.VITEST !== 'true' || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) throw Error('Exact controlled test database required');
    process.stdout.write(JSON.stringify(await lifecycleV9EmailIpc({ deliveryId: process.argv[2], leaseToken: process.argv[3] }))); }
  finally { await client.end(); }
}
main().catch(error=>{ process.stderr.write('Controlled private delivery failed: '+(error instanceof Error?error.name+': '+error.message:'unknown').slice(0,300)); process.exitCode=1; });
