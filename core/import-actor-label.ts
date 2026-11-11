import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {importActorFromFacts, type ImportActor, type ImportActorEmployment} from '../lib/import-reference';

/**
 * Board 8d02748a — "Imported by" for every import log, resolved in ONE set-wise read per page.
 *
 * `app.import_log_actor_facts` (migration 5112) is the authority: it returns facts only for log rows the
 * caller may already see under that log's own read rule, and only for people recorded on those rows
 * (creator, reverter, audit actor). There is no directory lookup and no per-row function call.
 */
export type ImportLogKind =
  | 'payroll_individual_job'
  | 'payroll_individual_attempt'
  | 'payroll_history'
  | 'import_attempt'
  | 'employee_import_run'
  | 'clocking_run'
  | 'leave_bf_run'
  | 'leave_history_run';

/** Larger than any log page (100–200 rows plus a cursor probe). */
export const IMPORT_ACTOR_ROW_LIMIT = 500;

export type ImportRowActors = {
  /** The person who started the import. */
  creator: ImportActor;
  /** Every recorded actor on the row (creator, reverter, audit events), keyed by app_user id. */
  byUser: Map<string, ImportActor>;
};

type FactRow = {
  row_id: string;
  is_creator: boolean;
  actor_user_id: string | null;
  user_exists: boolean;
  full_name: string | null;
  login_suffix: string | null;
  import_date: string | Date;
  company_ids: string[] | string | null;
  employments: ImportActorEmployment[] | string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable: ImportActor = {kind: 'unavailable'};

const isoDate = (value: string | Date) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
const uuidArray = (value: FactRow['company_ids']) =>
  Array.isArray(value) ? value : typeof value === 'string' ? value.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : [];

export async function resolveImportActors(tx: Tx, log: ImportLogKind, rowIds: readonly string[]): Promise<Map<string, ImportRowActors>> {
  const ids = [...new Set(rowIds)].filter(id => UUID.test(id));
  const out = new Map<string, ImportRowActors>();
  if (!ids.length) return out;
  if (ids.length > IMPORT_ACTOR_ROW_LIMIT) throw new Error(`import actor labels are bounded to ${IMPORT_ACTOR_ROW_LIMIT} rows`);
  const rows = await tx.execute<FactRow>(sql`
    select row_id, is_creator, actor_user_id, user_exists, full_name, login_suffix, import_date::text as import_date, company_ids::text[] as company_ids, employments
    from app.import_log_actor_facts(${log}, ${`{${ids.join(',')}}`}::uuid[])`);
  for (const row of rows) {
    const employments = typeof row.employments === 'string' ? JSON.parse(row.employments) as ImportActorEmployment[] : row.employments ?? [];
    const actor = importActorFromFacts({
      userExists: row.user_exists,
      fullName: row.full_name,
      loginSuffix: row.login_suffix,
      importDate: isoDate(row.import_date),
      companyIds: uuidArray(row.company_ids),
      employments,
    });
    const entry = out.get(row.row_id) ?? {creator: unavailable, byUser: new Map<string, ImportActor>()};
    if (row.is_creator) entry.creator = actor;
    if (row.actor_user_id) entry.byUser.set(row.actor_user_id, actor);
    out.set(row.row_id, entry);
  }
  return out;
}

/** The creator label for a row, or "Unavailable user" when the row returned no facts. */
export function creatorOf(actors: Map<string, ImportRowActors>, rowId: string): ImportActor {
  return actors.get(rowId)?.creator ?? unavailable;
}

/** A recorded actor's label on a row (reverter, audit event), or "Unavailable user". */
export function actorOn(actors: Map<string, ImportRowActors>, rowId: string, userId: string | null | undefined): ImportActor {
  return (userId && actors.get(rowId)?.byUser.get(userId)) || unavailable;
}
