import {client, withPoolWork} from './client';
import {assertFleetFitsServer} from './capacity';
import {fleetEnvForServerBudget} from './pooling';

/** Logged at web server start. The deploy preflight refuses the same mismatch before a restart. */
export async function warnIfFleetExceedsServer(env: Record<string, string | undefined> = process.env): Promise<void> {
  try {
    const fleetEnv = fleetEnvForServerBudget(env);
    if (fleetEnv.AIHR_DB_TOTAL_CONNECTIONS === undefined) return;
    // Server start must not wait out a connect timeout when the database is still coming up.
    const [row] = await Promise.race([
      withPoolWork('authentication', () => client<{maxconn: string; reserved: string}[]>`
        select current_setting('max_connections') as maxconn,
          (current_setting('superuser_reserved_connections')::int
            + coalesce(current_setting('reserved_connections', true)::int, 0))::text as reserved`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('database not ready')), 5000).unref?.()),
    ]);
    assertFleetFitsServer(fleetEnv, {maxConnections: Number(row.maxconn), superuserReserved: Number(row.reserved)});
  } catch (error) {
    console.error('[database-capacity] Connection budget check failed:', error instanceof Error ? error.message : 'unknown error');
  }
}
