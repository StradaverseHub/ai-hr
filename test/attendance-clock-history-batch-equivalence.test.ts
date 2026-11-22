import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { attendanceClockPolicyHistory, scheduleAttendanceClockPolicy } from '../core/attendance-clock-policy';
import { ensureStandardRule } from '../core/attendance-rule';
import { withAttendanceTenant } from '../core/module-gate';
import type { SessionContext, Tx } from '../db/client';
import { validateAttendanceClockPolicy, type AttendanceClockPolicy } from '../lib/attendance-clock-policy';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addDaysIso } from '../lib/roster-month';
import { closeAll, entitledCtx, migrateTestDb, resetDb, seedBase, setModule } from './harness';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';

beforeAll(migrateTestDb);
afterAll(closeAll);

type History = Awaited<ReturnType<typeof attendanceClockPolicyHistory>>;

const refusal = 'This clock policy is outside your company administrator scope.';

async function requireCompanies(tx: Tx, tenantId: string, ids: ReturnType<typeof sql>) {
  const [result] = await tx.execute<{ allowed: boolean }>(sql`
    select not exists (
      select 1 from unnest(${ids}) requested(id)
      where not exists (
        select 1 from company c where c.id=requested.id and c.tenant_id=${tenantId}::uuid
          and app.attendance_policy_principal_current() and app.is_admin_for(c.id)
      )
    ) as allowed
  `);
  if (!result?.allowed) throw new Error(refusal);
}

async function batchedHistory(ctx: SessionContext, companies: readonly string[], ruleId: string) {
  if (!companies.length) return [];
  const ids = sql`${'{' + companies.join(',') + '}'}::uuid[]`;
  return withAttendanceTenant(ctx, async tx => {
    await requireCompanies(tx, ctx.tenantId, ids);
    const rows = await tx.execute<{ companyId: string; id: string; ordinal: number; effectiveFrom: string; policy: unknown; reason: string }>(sql`
      select requested.company_id as "companyId",history.id,history.ordinal,
        history.effective_from::text as "effectiveFrom",history.policy,history.reason
      from unnest(${ids}) with ordinality requested(company_id,position)
      cross join lateral app.attendance_clock_policy_history(requested.company_id,${ruleId}::uuid) history
      order by requested.position,history.ordinal
    `);
    const byCompany = new Map<string, History>();
    for (const { companyId, ...row } of rows) {
      const history = byCompany.get(companyId) ?? [];
      history.push({ ...row, policy: validateAttendanceClockPolicy(row.policy) });
      if (history.length > 500) throw new Error('This clock policy history exceeds the supported review limit.');
      byCompany.set(companyId, history);
    }
    await requireCompanies(tx, ctx.tenantId, ids);
    return companies.map(companyId => byCompany.get(companyId) ?? []);
  });
}

it('preserves the ordered 70-company clock history and refuses unauthorized scopes', async () => {
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'attendance', 'active');
  const group = await entitledCtx(base);
  const fixture = await buildScaleFixture(base, { employments: 1000, events: 0 });
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  expect(fixture.employmentIds).toHaveLength(1000);
  const companies = [fixture.singleCompanyId, ...fixture.companyIds.filter(id => id !== fixture.singleCompanyId)];
  const ruleId = (await ensureStandardRule(group)).id;
  const policy: AttendanceClockPolicy = {
    pairing: { normal: 'auto', rest: 'firstInLastOut', off: 'auto', publicHoliday: 'firstInLastOut' },
    minimumIntervalMinutes: 2,
  };
  const today = todayInKualaLumpur();
  for (const companyId of companies.slice(0, 8)) {
    await scheduleAttendanceClockPolicy(group, {
      companyId, ruleId, expectedOrdinal: 0, effectiveFrom: addDaysIso(today, 3), policy, reason: 'Fictional initial policy',
    });
    await scheduleAttendanceClockPolicy(group, {
      companyId, ruleId, expectedOrdinal: 1, effectiveFrom: addDaysIso(today, 7),
      policy: { ...policy, minimumIntervalMinutes: 5 }, reason: 'Fictional revised policy',
    });
  }
  const original = (ctx: SessionContext, ids: readonly string[]) =>
    Promise.all(ids.map(companyId => attendanceClockPolicyHistory(ctx, { companyId, ruleId })));
  const samples = [];
  for (let pass = 0; pass < 4; pass++) {
    const baselineStartsFirst = pass % 2 === 0;
    const measure = async (read: () => Promise<History[]>) => {
      const start = performance.now();
      const result = await read();
      return { result, elapsedMs: Math.round(performance.now() - start) };
    };
    const baseline = baselineStartsFirst ? await measure(() => original(group, companies)) : null;
    const batch = await measure(() => batchedHistory(group, companies, ruleId));
    const control = baseline ?? await measure(() => original(group, companies));
    expect(batch.result).toEqual(control.result);
    expect(batch.result.slice(0, 8).map(history => history.map(row => row.ordinal))).toEqual(Array.from({length:8}, () => [1, 2]));
    expect(batch.result.slice(8).every(history => history.length === 0)).toBe(true);
    samples.push({ currentMs: control.elapsedMs, batchedMs: batch.elapsedMs });
  }
  const own = [fixture.singleCompanyId];
  const scoped = { ...fixture.personas.single, entitlements: group.entitlements };
  const expectedOwn = await original(scoped, own);
  expect(expectedOwn[0]).toHaveLength(2);
  expect(await batchedHistory(scoped, own, ruleId)).toEqual(expectedOwn);
  await expect(original(scoped, companies.slice(0, 2))).rejects.toThrow(refusal);
  await expect(batchedHistory(scoped, companies.slice(0, 2), ruleId)).rejects.toThrow(refusal);
  const foreign = await seedBase();
  await expect(original(group, [foreign.companyId])).rejects.toThrow(refusal);
  await expect(batchedHistory(group, [foreign.companyId], ruleId)).rejects.toThrow(refusal);

  const evidence = { releaseEligible: false, companies: companies.length, employments: fixture.employmentIds.length,
    nonemptyHistories: 8, source: process.env.AIHR_CI_HEAD, samples };
  console.info('ATTENDANCE_CLOCK_HISTORY_BATCH ' + JSON.stringify(evidence));
  const output = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if (output) writeFileSync(join(output, 'attendance-clock-history-batch.json'), JSON.stringify(evidence, null, 2));
}, 120_000);
