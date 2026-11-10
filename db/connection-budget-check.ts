import {client, withPoolWork} from './client';
import {assertFleetFitsServer} from './capacity';

/** Logged at web server start. The deploy preflight refuses the same mismatch before a restart. */
export async function warnIfFleetExceedsServer(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (env.AIHR_DB_TOTAL_CONNECTIONS === undefined) return;
  try {
    const [row] = await withPoolWork('authentication', () => client<{maxconn: string; reserved: string}[]>`
      select current_setting('max_connections') as maxconn,
        (current_setting('superuser_reserved_connections')::int
          + coalesce(current_setting('reserved_connections', true)::int, 0))::text as reserved`);
    assertFleetFitsServer(env, {maxConnections: Number(row.maxconn), superuserReserved: Number(row.reserved)});
  } catch (error) {
    console.error('[database-capacity] Connection budget check failed:', error instanceof Error ? error.message : 'unknown error');
  }
}
