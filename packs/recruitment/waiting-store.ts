/**
 * Recruitment slice 17 — the database half of waiting limits, shared by the board (./data), the Overview's per-job counts (./tasks)
 * and the settings, the application page and the "Suggested to archive" list (./waiting). Reached from outside the pack ONLY
 * through ./service. Read-only: nothing here writes, so every read works inside a READ ONLY transaction.
 *
 * Cost. A request reads the rules of the companies in view (one statement, under the caller's row security: administrators and the
 * company's job teams) and, only when a rule counts working days, those companies' public holidays (one statement through the
 * holiday owner, core/holidays.ts companyHolidayDatesByCompany). The cutoffs are computed in TypeScript (./waiting-model) and passed
 * to ONE set-based statement as arrays; no per-company or per-application statement. When an application entered its current stage
 * is one backward probe of the 5218 history index per application (stageEnteredSql).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { companyHolidayDatesByCompany } from '../../core/holidays';
import { RecruitmentError, isUuid } from './model';
import { holidayWindowStart, ruleCutoffs, type WaitingDayKind, type WaitingRule } from './waiting-model';

const ids = (values: readonly string[]) => {
  if (!values.every(isUuid)) throw new RecruitmentError('invalid_input');
  return `{${values.join(',')}}`;
};

/** When the application aliased `a` entered its current stage: its latest 'applied' or 'moved' history row into that stage (an
 *  application with no such row — none is written without one — falls back to when it was received). */
export const stageEnteredSql = sql`coalesce((select max(e.occurred_at) from recruitment_application_event e
  where e.application_id = a.id and e.to_stage_id = a.current_stage_id), a.applied_at)`;
/** …as a Kuala Lumpur calendar day. */
export const stageEnteredDaySql = sql`((${stageEnteredSql}) at time zone 'Asia/Kuala_Lumpur')::date`;
/** The same Kuala Lumpur entry day for a row aliased `alias` that carries an application's id, current_stage_id and applied_at (a
 *  bounded scan's derived table, so the history probe runs only for the rows the scan kept). */
export function stageEnteredDayOf(alias: string): SQL {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Invalid SQL alias.');
  const t = sql.raw(alias);
  return sql`((coalesce((select max(e.occurred_at) from recruitment_application_event e
    where e.application_id = ${t}.id and e.to_stage_id = ${t}.current_stage_id), ${t}.applied_at)) at time zone 'Asia/Kuala_Lumpur')::date`;
}

export type StageCutoff = WaitingRule & { companyId: string; remindOn: string; archiveOn: string | null };
export type WaitingContext = {
  today: string;
  /** By stage id (a stage belongs to one company). */
  cutoffs: Map<string, StageCutoff>;
  /** Public holidays by company, read only for companies with a working-day rule (absent: none read, or none configured). */
  holidays: Map<string, Set<string>>;
};

/** The waiting rules of `companyIds` that the caller may read, their holidays when needed, and today's cutoff days. */
export async function waitingContextTx(tx: Tx, tenantId: string, companyIds: readonly string[], today: string): Promise<WaitingContext> {
  const cutoffs = new Map<string, StageCutoff>();
  const empty: WaitingContext = { today, cutoffs, holidays: new Map() };
  if (!companyIds.length) return empty;
  const rules = await tx.execute<{ stage_id: string; company_id: string; remind_days: number; archive_days: number | null; day_kind: WaitingDayKind }>(sql`
    select stage_id, company_id, remind_days, archive_days, day_kind from recruitment_stage_waiting_rule
    where tenant_id = ${tenantId}::uuid and company_id = any(${ids([...new Set(companyIds)])}::uuid[])`);
  if (!rules.length) return empty;
  const working = [...new Set(rules.filter((r) => r.day_kind === 'working').map((r) => r.company_id))];
  const holidays = working.length ? await companyHolidayDatesByCompany(tx, { companyIds: working, startDate: holidayWindowStart(today), endDate: today }) : new Map<string, Set<string>>();
  for (const r of rules) {
    const rule: WaitingRule = { stageId: r.stage_id, remindDays: r.remind_days, archiveDays: r.archive_days, dayKind: r.day_kind };
    cutoffs.set(r.stage_id, { ...rule, companyId: r.company_id, ...ruleCutoffs(rule, today, holidays.get(r.company_id) ?? new Set()) });
  }
  return { today, cutoffs, holidays };
}

/** The cutoffs as a relation `<alias>(stage_id uuid, remind_on date, archive_on date)` for a FROM clause (stages limited to
 *  `stageIds` when given). Null when there is no rule to apply. */
export function cutoffRelation(ctx: WaitingContext, alias: string, stageIds?: readonly string[]): SQL | null {
  const rows = [...ctx.cutoffs.values()].filter((c) => !stageIds || stageIds.includes(c.stageId));
  if (!rows.length) return null;
  const dates = (values: (string | null)[]) => `{${values.map((v) => v ?? 'NULL').join(',')}}`;
  return sql`unnest(${ids(rows.map((r) => r.stageId))}::uuid[], ${dates(rows.map((r) => r.remindOn))}::date[], ${dates(rows.map((r) => r.archiveOn))}::date[])
    as ${sql.identifier(alias)}(stage_id, remind_on, archive_on)`;
}
