import 'server-only';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../../db/client';
import { readSettlementLeaveSourceTx } from '../../../core/hr-settlement-leave-source';
import { defaultSettlementPolicy, settlement, type NoticePeriod, type Settlement, type SettlementInput } from '../../../lib/lifecycle-v9-calculator';
import type { Case, Config } from '../../../lib/lifecycle-v9-model';
import { V9Error } from '../../../lib/lifecycle-v9-model';

export type SettlementView = Settlement & { sourceRevision: string; basic: number | null; allowances: number; balanceSources: { id: string; name: string; balance: number }[] };
export async function readSettlementTx(tx: Tx, ctx: SessionContext, c: Case, config: Config): Promise<SettlementView | null> {
  if (c.module !== 'off') return null;
  const [permission] = await tx.execute<{ ok: boolean }>(sql`select app.is_admin_for(${c.facts.company}::uuid) OR (${!ctx.userId} AND (current_user='ai_hr_owner' OR EXISTS(select 1 from pg_roles where rolname=current_user and rolsuper))) as ok`);
  if (!permission?.ok) throw new V9Error('Final figures are restricted to authorized HR administrators.', 'forbidden');
  const [employment] = await tx.execute<{ notice_before_confirmation_value: number | null; notice_before_confirmation_unit: NoticePeriod['unit'] | null; notice_after_confirmation_value: number | null; notice_after_confirmation_unit: NoticePeriod['unit'] | null; final_confirmation_date: string | null; grade: string | null; source_version: string }>(sql`select e.notice_before_confirmation_value,e.notice_before_confirmation_unit,e.notice_after_confirmation_value,e.notice_after_confirmation_unit,e.final_confirmation_date::text,g.code as grade,e.xmin::text as source_version from employment e left join job_grade g on g.id=e.grade_id and g.tenant_id=e.tenant_id where e.id=${c.facts.employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid and e.company_id=${c.facts.company}::uuid`);
  if (!employment) throw new V9Error('The employee record is not available.', 'not_found');
  const probation = !!employment.final_confirmation_date && employment.final_confirmation_date > c.facts.noticeDate;
  const count = probation ? employment.notice_before_confirmation_value : employment.notice_after_confirmation_value;
  const unit = probation ? employment.notice_before_confirmation_unit : employment.notice_after_confirmation_unit;
  const policy = config.settlementPolicy ?? defaultSettlementPolicy();
  // A missing confirmation date does not establish probation. Contract status is independent.
  const source: SettlementInput = { type: c.facts.caseType as SettlementInput['type'], noticeDate: c.facts.noticeDate, sourceLastDay: c.facts.lastDay, grade: employment.grade ?? c.facts.grade, employmentType: c.facts.employmentType === 'contract' ? 'contract' : probation ? 'probation' : 'permanent', contractNotice: count !== null && unit ? { value: count, unit } : null, override: c.settlementOptions?.override ?? null, keepSourceDate: c.settlementOptions?.keepSourceDate ?? false, remainingLeave: null, basic: null, allowances: 0, currency: '', offsetLeave: c.settlementOptions?.offsetLeave ?? false, reduceEncashment: c.settlementOptions?.reduceEncashment ?? null };
  const date = settlement(source, policy).lastDay;
  const [salary] = await tx.execute<{ id: string; basic_salary: string; monthly_allowance: string; currency: string; source_version: string }>(sql`select id,basic_salary,monthly_allowance,currency,xmin::text as source_version from compensation where tenant_id=${ctx.tenantId}::uuid and employment_id=${c.facts.employmentId}::uuid and superseded_at is null and valid_from<=${date}::date and (valid_to is null or valid_to>${date}::date) order by valid_from desc,id desc limit 1`);
  const selected = await readSettlementLeaveSourceTx(tx, ctx, { employmentId: c.facts.employmentId, asOf: date, leaveTypeIds: policy.leaveTypeIds });
  const complete = policy.leaveTypeIds.length > 0 && policy.leaveTypeIds.every(id => selected.some(b => b.id === id));
  source.remainingLeave = complete ? Math.round(selected.reduce((total, b) => total + b.balance, 0) * 100) / 100 : null;
  source.basic = salary ? Number(salary.basic_salary) : null; source.allowances = salary ? Number(salary.monthly_allowance) : 0; source.currency = salary?.currency ?? '';
  const result = settlement(source, policy);
  const sourceRevision = createHash('sha256').update(JSON.stringify({ employment: employment.source_version, salary: salary ? [salary.id, salary.source_version] : null, source, policy, balances: selected.map(b => [b.id, b.balance]) })).digest('hex');
  return { ...result, sourceRevision, basic: source.basic, allowances: source.allowances, balanceSources: selected };
}
