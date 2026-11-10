// Deploy preflight: refuses a connection budget the PostgreSQL server cannot honour, before anything
// restarts. Run by deploy/deploy.sh. See db/capacity.ts for the fleet equation.
import postgres from 'postgres';
import {assertFleetFitsServer} from '../db/capacity';
import {fleetEnvForServerBudget} from '../db/pooling';

/** A deploy must not restart the application onto a pooler that is down or logs in as the wrong role. */
async function checkPooler() {
  const pooledUrl = process.env.DATABASE_POOLED_URL?.trim();
  if (!pooledUrl) return;
  const expected = decodeURIComponent(new URL(process.env.DATABASE_URL ?? pooledUrl).username);
  const pooled = postgres(pooledUrl, {max: 1, connect_timeout: 10, onnotice: () => {}});
  try {
    const [row] = await pooled<{role: string}[]>`select current_user as role`;
    if (row.role !== expected) throw new Error(`The pooler logged in as ${row.role}, not ${expected}.`);
    console.log('Pooler reachable and logged in as the application role.');
  } finally {
    await pooled.end({timeout: 5});
  }
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('check-db-connection-budget requires DATABASE_URL or MIGRATION_DATABASE_URL.');
    process.exit(2);
  }
  const sql = postgres(url, {max: 1, connect_timeout: 10, onnotice: () => {}});
  try {
    const [row] = await sql<{maxconn: string; reserved: string}[]>`
      select current_setting('max_connections') as maxconn,
        (current_setting('superuser_reserved_connections')::int
          + coalesce(current_setting('reserved_connections', true)::int, 0))::text as reserved`;
    const budget = assertFleetFitsServer(fleetEnvForServerBudget(process.env), {maxConnections: Number(row.maxconn), superuserReserved: Number(row.reserved)});
    console.log(`Connection budget fits: ${budget.requiredConnections} needed of ${budget.available} available.`);
    await checkPooler();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await sql.end({timeout: 5});
  }
}
void main();
