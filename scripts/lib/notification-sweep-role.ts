/** The sweeps log in with MIGRATION_DATABASE_URL and notification projection switches DOWN to ai_hr_app with
 * SET LOCAL ROLE. PostgreSQL 16 checks that against the LOGIN, so the login needs an explicit INHERIT FALSE/SET TRUE
 * edge. Only an installation DBA can grant it (the owner holds no ADMIN on ai_hr_app), so no migration can repair its
 * absence. Staging ran without it from 25 October 2026: the 03:00 review sweep exited 1 every night and the minute
 * notification sweep failed whenever events were pending, both with an opaque "Failed query: SET LOCAL ROLE".
 * Kept out of core/: projection sources are inside the AI provider-data digest. */
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';

export const NOTIFICATION_ROLE_PREREQUISITE = 'deploy/runner-control/notification-role-prerequisite.sql';
export const NOTIFICATION_ROLE_MISSING = `Sweep login cannot switch to ai_hr_app, so notification projection cannot run; an installation DBA must run ${NOTIFICATION_ROLE_PREREQUISITE}.`;

/** Read-only catalog probe shared by both sweeps and the deploy preflight. */
export async function notificationDowngradeReady(tx: Pick<Tx, 'execute'>): Promise<boolean> {
  const [edge] = await tx.execute(sql`SELECT pg_catalog.pg_has_role(session_user,'ai_hr_app','SET')
    AND NOT pg_catalog.pg_has_role('ai_hr_app',session_user,'MEMBER') AS ready`) as unknown as { ready: boolean }[];
  return edge?.ready === true;
}
