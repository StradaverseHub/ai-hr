/**
 * D-P1-32 PT-X1: the one facts builder against real RLS. The Feedback tab follows the source: a confirmed 360
 * subject (own review in an open cycle with the 360 on) gets it before any release; the fact goes away when the
 * cycle runs no 360. The pure gate table lives in p1-performance-area-tabs.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { adminCtx, closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const year = Number(todayInKualaLumpur().slice(0, 4));

describe('getPerformanceAreaFacts: own 360 report', () => {
  let b: Base, a: SessionContext, self: SessionContext, cycleId: string;
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); a = adminCtx(b); await setModule(b.tenantId, 'performance', 'active'); a = await entitledCtx(b);
    const hire = (name: string) => hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@onehr.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    const subject = await hire('Area subject'), manager = await hire('Area manager');
    self = { ...a, userId: await createAppUser(b.tenantId, subject.personId, 'employee'), personId: subject.personId, roles: ['employee'], grants: undefined };
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    for (const e of [subject, manager]) await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.id, e.employmentId));
    await setReportingLine(a, { subordinateEmploymentId: subject.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
    ({ cycleId } = await perf.createCycle(a, { name: 'Area cycle', companyId: b.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }));
    const policy = defaultPolicy(framework);
    policy.profiles = [{ id: randomUUID(), companyId: b.companyId, grade: '12', name: 'Engineering', competencies: [{ id: 'skill-1', principle: 'Technical', text: 'Current skill', future: false }] }];
    await perf.configureOnehrCycle(a, cycleId, null, policy); await perf.openCycle(a, { cycleId });
  });
  afterAll(closeAll);

  it('a confirmed 360 subject has an own report before release, so the Feedback tab shows', async () => {
    const facts = await perf.getPerformanceAreaFacts(self);
    expect(facts.performanceOn).toBe(true);
    expect(facts.items.some(item => item.view === 'mine' && item.module === 'pm')).toBe(true);
    expect(facts.ownFeedbackReport).toBe('confirmed');
    expect(perf.performanceTabState(facts, 'feedback.feedback')).toBe('open');
    const access = await perf.performanceTabAccess(self, 'feedback.feedback');
    expect(access).toMatchObject({ state: 'open', mayOpen: true });
  });

  it('a cycle that runs no 360 leaves no own report, so the Feedback tab is hidden and refused', async () => {
    const cycle = await perf.getOnehrCycle(a, cycleId);
    await perf.updateAssessmentModules(a, cycleId, cycle!.revision, { ...cycle!.policy.modules, tm: false });
    const facts = await perf.getPerformanceAreaFacts(self);
    expect(facts.ownFeedbackReport).toBe('none');
    expect(perf.performanceTabState(facts, 'feedback.feedback')).toBe('hidden');
    expect(await perf.performanceTabAccess(self, 'feedback.feedback')).toMatchObject({ state: 'hidden', mayOpen: false });
  });

  it('the admin, who holds no review of their own, has no own report', async () => {
    expect((await perf.getPerformanceAreaFacts(a)).ownFeedbackReport).toBe('none');
  });
});
