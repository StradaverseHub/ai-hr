/**
 * Staged leave ledger rows for all-or-nothing background leave jobs (draft migration 5031).
 *
 * The old synchronous runs (Generate Entitlement's year-open and its earned Annual Leave part, the A2C re-projection)
 * were each ONE transaction: a failure part-way rolled everything back. On the job kernel they run in short batches
 * of employees, so each batch writes its ledger rows STAGED: stamped with a stage id that only the job's own
 * transactions can see. When every batch is done the job releases the stage in one short transaction, so every
 * reader sees the whole run at the same instant; a failure or a stop discards the staged rows, which nobody saw.
 *
 * WHY THE RELEASE RE-CHECKS EACH EMPLOYEE. While a batch's rows are staged, other writers (a leave approval, the
 * monthly accrual, a profile recalculation) keep working on the same employees and cannot see those rows. Each of
 * them takes the employee's leave-dependency lock, so a writer that touched an employee after its batch was staged
 * has COMMITTED before the release can take that lock. The release therefore takes every employee's lock and
 * compares a fingerprint of everything the engines read for that employee (their ledger rows, the employment and
 * assignment rows, a frozen encashment balance) and of the tenant's leave configuration with what the batch saw.
 * An employee whose inputs changed is computed again (its staged rows dropped, its batch re-run) before release is
 * tried again. So the released rows are exactly what the old single transaction would have written at the moment
 * of release.
 */
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import type {SessionContext, Tx} from '../db/client';
import {lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {lockLeaveDependenciesTx} from './leave-dependency-lock';

/** Transaction-local: the stage this transaction's ledger inserts are stamped with, and the stages it may see. */
export async function useLeaveStageTx(tx: Tx, write: string | null, visible: readonly string[]) {
  await tx.execute(sql`select set_config('app.leave_stage',${write ?? ''},true), set_config('app.leave_stage_visible',${visible.join(',')},true)`);
}

/** Per employment: a digest of every input the leave cohort engines read for that employee, excluding the job's own
 * staged rows (they are the output). Read inside the batch's transaction after the engine ran, under its locks.
 * Another job's released rows count whether or not their markers have been cleared yet. */
export async function leaveStageFingerprintsTx(tx: Tx, employmentIds: readonly string[], ownStages: readonly string[]): Promise<Record<string, string>> {
  if (!employmentIds.length) return {};
  // Draft 5035: one definer digest per employment, the visible set hashed once (row security tested every scanned
  // row against the whole visible-employment array: 0.5-0.7 s for 3,000 employees inside the release).
  const rows = await tx.execute<{id: string; fp: string}>(sql`select employment_id::text as id, digest as fp
    from app.leave_stage_digests(${`{${employmentIds.join(',')}}`}::uuid[], ${`{${ownStages.join(',')}}`}::uuid[], true)`);
  return Object.fromEntries(rows.map(r => [r.id, r.fp]));
}
/** The employments whose inputs differ from what their batch saw (or that are no longer visible). */
export async function leaveStageConflictsTx(tx: Tx, expected: Readonly<Record<string, string>>, ownStages: readonly string[]): Promise<string[]> {
  const ids = Object.keys(expected);
  if (!ids.length) return [];
  const now = await leaveStageFingerprintsTx(tx, ids, ownStages);
  return ids.filter(id => now[id] !== expected[id]);
}
/** The tenant's leave configuration the engines read (types, tables, rules, defaults, leave cycle, year config). Its
 * writers take the leave-dependency configuration lock exclusively; a run's batches and its release take it shared. */
const configDigest = sql`md5(concat_ws('|',
      (select string_agg(t.xmin::text, ',' order by t.id) from leave_type t),
      (select string_agg(t.xmin::text, ',' order by t.id) from entitlement_template t),
      (select string_agg(r.xmin::text, ',' order by r.id) from entitlement_eligibility_rule r),
      (select string_agg(c.id::text||':'||c.leave_cycle::text, ',' order by c.id) from company c),
      (select string_agg(y.xmin::text, ',' order by y.id) from leave_year_config y)))`;
export async function leaveConfigFingerprintTx(tx: Tx): Promise<string> {
  const [row] = await tx.execute<{fp: string}>(sql`select ${configDigest} as fp`);
  return row.fp;
}

/** The configuration digest and, for the given employees (null: none), a digest of the employment and assignment
 * rows the template resolver matches on, in one statement (the accrual job's re-check of its once-per-run reads). */
export async function leaveRunInputFingerprintsTx(tx: Tx, employmentIds: readonly string[] | null): Promise<{configFp: string; orgFp: Record<string, string>}> {
  const [row] = await tx.execute<{fp: string; org: Record<string, string> | null}>(sql`select ${configDigest} as fp,
    ${employmentIds ? sql`(select jsonb_object_agg(d.employment_id::text, d.digest) from app.leave_stage_digests(${`{${employmentIds.join(',')}}`}::uuid[], '{}'::uuid[], false) d)` : sql`null::jsonb`} as org`);
  return {configFp: row.fp, orgFp: row.org ?? {}};
}
/** Release: one row, under the job's own fenced transaction. Every reader sees the stage from its commit on. */
export async function releaseLeaveStageTx(tx: Tx, jobId: string, stageId: string) {
  await tx.execute(sql`select app.leave_stage_release(${jobId}::uuid, ${stageId}::uuid)`);
}
/** Drop a stage's rows that the job's own transaction can see (a batch computed again, or a part that failed). */
export async function dropLeaveStageRowsTx(tx: Tx, stageIds: readonly string[], employmentIds?: readonly string[]) {
  if (!stageIds.length) return 0;
  const rows = await tx.execute<{id: string}>(sql`delete from leave_ledger where stage_id = any(${`{${stageIds.join(',')}}`}::uuid[])
    ${employmentIds ? sql`and employment_id = any(${`{${employmentIds.join(',')}}`}::uuid[])` : sql``} returning id`);
  return rows.length;
}

/** Queue-owner connection, bounded: delete up to `limit` rows of never-released stages (discard). */
export async function discardLeaveStageRows(owner: postgres.ReservedSql, tenantId: string, stageIds: readonly string[], limit = 2000): Promise<number> {
  if (!stageIds.length) return 0;
  const rows = await owner`delete from leave_ledger where ctid in (select ctid from leave_ledger where tenant_id=${tenantId}::uuid and stage_id = any(${stageIds as string[]}::uuid[])
    and not exists(select 1 from app.leave_stage_release r where r.stage_id=leave_ledger.stage_id) limit ${limit}) returning id`;
  return rows.length;
}
/** Queue-owner connection, bounded: clear the markers of released stages (visibility unchanged), then forget the
 * release rows. Returns 'more' while rows remain. */
export async function settleLeaveStages(owner: postgres.ReservedSql, tenantId: string, stageIds: readonly string[], limit = 2000): Promise<'more' | 'done'> {
  if (!stageIds.length) return 'done';
  const rows = await owner`update leave_ledger set stage_id=null where ctid in (select l.ctid from leave_ledger l join app.leave_stage_release r on r.stage_id=l.stage_id
    where l.tenant_id=${tenantId}::uuid and l.stage_id = any(${stageIds as string[]}::uuid[]) limit ${limit}) returning id`;
  if (rows.length) return 'more';
  await owner`delete from app.leave_stage_release where tenant_id=${tenantId}::uuid and stage_id = any(${stageIds as string[]}::uuid[])`;
  return 'done';
}

/** The release's locks, in the cohort writers' order: the tenant's Access lock, then the leave-dependency
 * configuration (shared) and every subject employment (one statement; busy refuses and is retried). */
export async function lockLeaveStageSubjectsTx(tx: Tx, ctx: Pick<SessionContext, 'tenantId'>, employmentIds: readonly string[]) {
  await lockAccessConfigurationWriteTx(tx, ctx.tenantId);
  await lockLeaveDependenciesTx(tx, ctx.tenantId, employmentIds);
}
