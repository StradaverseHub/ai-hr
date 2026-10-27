/**
 * The sidebar's Talent/Development offer against the workspace it links to, with real RLS.
 *
 * performanceNavigationOffer is the cheap read the root layout runs on every request; performanceWorkspace is
 * the page's full worklist. They share one item derivation (reviewWorkspaceParts and the same review, feedback
 * and BG-leader reads); every case here pins offer === workspaceNavigationOffer(performanceWorkspace()), so the
 * cheap path cannot drift from the page it advertises.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import { resolveWorkspaceSelection, workspaceNavigationOffer } from '../packs/performance/onehr/workspace-model';
import framework from '../packs/performance/onehr/framework.json';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const year = Number(todayInKualaLumpur().slice(0, 4));

describe('performance navigation offer (real RLS)', () => {
  let b: Base, a: SessionContext, gradeId: string, self: SessionContext, mgr: SessionContext, cycleId: string, reviewId: string;
  let subject: { employmentId: string; personId: string }, manager: { employmentId: string; personId: string };
  const hire = (name: string) => hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@onehr.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
  const ctx = async (personId: string, role: 'employee' | 'manager'): Promise<SessionContext> => ({ ...a, userId: await createAppUser(b.tenantId, personId, role), personId, roles: [role], grants: undefined });
  const view = async (who: SessionContext) => { const v = await perf.getOnehrReview(who, reviewId); if (!v) throw Error('Missing view'); return v; };
  /** The cheap offer, pinned against the full worklist it summarises. */
  const offer = async (who: SessionContext) => {
    const [cheap, items] = await Promise.all([perf.performanceNavigationOffer(who), perf.performanceWorkspace(who)]);
    expect(cheap).toEqual(workspaceNavigationOffer(items));
    return { offer: cheap, items };
  };
  const kpiId = randomUUID();
  async function approvedScorecard() {
    await perf.saveOnehrKpis(self, reviewId, (await view(self)).revision, [{ id: kpiId, title: 'Deliver agreed outcomes', description: '', weightBp: 10000, unit: 'units', scoring: { mechanism: 'A', method: 'more', rates: [0, 50, 100, 150, 200] }, moderatorEmploymentId: manager.employmentId }], true);
    await perf.approveOnehrScorecard(mgr, reviewId, (await view(mgr)).revision, true, 'Agreed objectives');
  }

  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'performance', 'active'); a = await entitledCtx(b);
    subject = await hire('Navigation subject'); manager = await hire('Navigation manager');
    self = await ctx(subject.personId, 'employee'); mgr = await ctx(manager.personId, 'manager');
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning(); gradeId = grade.id;
    for (const e of [subject, manager]) await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.id, e.employmentId));
    await setReportingLine(a, { subordinateEmploymentId: subject.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
    ({ cycleId } = await perf.createCycle(a, { name: 'Navigation annual assessment', companyId: b.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }));
    const policy = defaultPolicy(framework);
    policy.profiles = [{ id: randomUUID(), companyId: b.companyId, grade: '12', name: 'Engineering', competencies: [{ id: 'skill-1', principle: 'Technical', text: 'Current skill', future: false }] }];
    await perf.configureOnehrCycle(a, cycleId, null, policy); await perf.openCycle(a, { cycleId });
    const [r] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, subject.employmentId)));
    reviewId = r.id;
  });
  afterAll(closeAll);

  it('locks an employee mid check-in, and a crafted ?module=idp does not select the plan', async () => {
    await approvedScorecard();
    const { offer: own, items } = await offer(self);
    expect(own).toEqual({ tm: true, idp: 'locked' });
    expect(items.find(i => i.id === reviewId && i.module === 'pm')).toMatchObject({ stage: 'results', state: 'open' });
    const picked = resolveWorkspaceSelection(items, { module: 'idp' });
    expect(picked).toMatchObject({ view: 'mine', module: 'pm', lockedModules: ['idp'] });
    // The review page reads the same lock (ownPlanLocked), so its plan form is withheld too.
    expect((await view(self)).planLocked).toBe(true);
    expect((await view(mgr)).planLocked).toBe(false);
  });

  it('opens the plan once the own KPI results and competency self-assessment are submitted', async () => {
    await approvedScorecard();
    await perf.submitOnehrResults(self, reviewId, (await view(self)).revision, [{ id: kpiId, actual: 100, note: 'Completed' }], 'Completed the agreed outcomes.');
    expect((await offer(self)).offer).toEqual({ tm: true, idp: 'locked' });
    expect((await view(self)).planLocked).toBe(true);
    await perf.submitOnehrCompetencies(self, reviewId, (await view(self)).revision, { 'skill-1': { answer: 'yes', remark: '' } }, false, 'Practised through assigned work.');
    const { offer: own, items } = await offer(self);
    expect(own).toEqual({ tm: true, idp: 'open' });
    expect((await view(self)).planLocked).toBe(false);
    expect(resolveWorkspaceSelection(items, { module: 'idp' })).toMatchObject({ view: 'mine', module: 'idp', lockedModules: [] });
  });

  it('never locks the line manager, whose plan work is in the team view', async () => {
    await approvedScorecard();
    const { offer: line, items } = await offer(mgr);
    expect(line).toEqual({ tm: true, idp: 'open' });
    expect(resolveWorkspaceSelection(items, { module: 'idp' })).toMatchObject({ view: 'team', module: 'idp' });
  });

  it('offers Talent to a 360 rater whose only TM work is the feedback card', async () => {
    // Hired after the cycle opened: no review of their own, so the panel card is their only work.
    const raters = [];
    for (let i = 0; i < 4; i++) raters.push(await hire(`Navigation peer rater ${i}`));
    for (const r of raters) await owner.db.update(schema.employment).set({ gradeId }).where(eq(schema.employment.id, r.employmentId));
    const raterCtx = await ctx(raters[0].personId, 'employee');
    expect((await offer(raterCtx)).offer).toEqual({ tm: false, idp: 'none' });
    await perf.assignOnehrPanel(mgr, reviewId, (await view(mgr)).revision, raters.map(r => ({ employmentId: r.employmentId, relationship: 'peer' })));
    const { offer: rating, items } = await offer(raterCtx);
    expect(rating).toEqual({ tm: true, idp: 'none' });
    expect(items).toEqual([expect.objectContaining({ kind: 'feedback', module: 'tm', view: 'mine' })]);
  });

  it('offers a calibration-only reviewer neither Talent nor Development', async () => {
    const outsider = await hire('Calibration-only reviewer');
    const reviewer = await ctx(outsider.personId, 'employee');
    await perf.createOnehrCalibration(a, cycleId, { name: 'Navigation BU calibration', companyId: b.companyId, tier: 'bu', reviewerUserIds: [reviewer.userId!], reviewIds: [reviewId], pbtAchievement: 100, mode: 'after' });
    const { offer: cal, items } = await offer(reviewer);
    expect(cal).toEqual({ tm: false, idp: 'none' });
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map(i => i.module))).toEqual(new Set(['cal']));
    for (const module of ['pm', 'tm', 'idp']) expect(resolveWorkspaceSelection(items, { module }).module).toBe('cal');
  });
});
