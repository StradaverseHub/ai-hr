/**
 * D-P1-32 PT-X3 — the Performance & Talent home: the pure composition (card conditions, the slot precedence,
 * the doors, the DQ-1 switch on both sides), the route guards, and the reads against real RLS as ai_hr_app:
 * a participant gets Where you stand with no band before release (nor does their line manager's page carry it);
 * a person out by the D-P1-22 unit rule reads that reason as the stored reviewer of a colleague; a person out
 * with no such review reads the plain reason. Dates come from todayInKualaLumpur(), read at the call.
 * The DOM side is test/p1-performance-home.dom.test.tsx.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import * as perf from '../packs/performance/service';
import { deriveHomeBlock, leaderRailSteps, standingPerformance, WHERE_YOU_STAND_RULE, type PerformanceHomeBlock } from '../packs/performance/onehr/home-cards';
import {
  homeNext, homeSlot, notInReason, pastJourney, performanceHomeLayout, teamCounts, toolDoors,
  type HomeWorkItem, type PerformanceHomeView, type RunningLeaderStatus, type RecordLeaderStatus,
} from '../packs/performance/onehr/performance-home-model';
import { PERFORMANCE_AREA_TABS, performanceTabState, type PerformanceAreaFacts } from '../packs/performance/onehr/tab-model';
import { defaultPolicy, pmBands, type PMBand } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';
import en from '../messages/en.json';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { buildFixture, exclude, type Fixture } from './performance-unit-exclusion-fixture';
import { todayInKualaLumpur } from '../lib/hr-date';

afterAll(closeAll);
const ROOT = path.resolve(__dirname, '..');
const CYCLE = randomUUID();
/** Every key anywhere in a value. */
const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
};
let n = 0;
const item = (o: Pick<HomeWorkItem, 'kind' | 'view' | 'module' | 'stage'> & Partial<HomeWorkItem>): HomeWorkItem =>
  ({ id: `item-${++n}`, cycleId: CYCLE, state: 'open', title: 'Fictional', ...o });
const facts = (items: HomeWorkItem[], locked = false): PerformanceAreaFacts =>
  ({ performanceOn: true, ownFeedbackReport: 'none', items: items.map(({ kind, cycleId, view, module, stage, axis }) => ({ kind, cycleId, view, module, stage, axis, locked: locked && module === 'idp' })) });
const block = (over: Partial<PerformanceHomeBlock> = {}): PerformanceHomeBlock => ({
  cycle: { id: CYCLE, name: 'Fictional', closesOn: '2026-12-31' }, steps: [{ key: 'kpi', state: 'yourTurn' }, { key: 'results', state: 'locked' }], done: 0, total: 2,
  next: { kind: 'kpi', done: 0, total: 1, dueOn: null, href: '/performance/workspace?view=mine&module=pm' }, team: null,
  standing: { performance: { state: 'notReleased' }, competency: null, feedback360: 'notReleased', careerTarget: { state: 'notSet' } }, detailsHref: '/me/performance', ...over,
});
const bu: RunningLeaderStatus = { seat: 'bu', mode: 'running', cycleId: CYCLE, midYear: false, units: [] };
const ledRecord: RecordLeaderStatus = { seat: 'bg', mode: 'record', cycleId: CYCLE, midYear: false, gated: false, people: 40 };

describe('DQ-1: one switch for the Performance row of Where you stand', () => {
  it('follows the source (APR-028): the line manager\'s approved band shows before release', () => {
    expect(WHERE_YOU_STAND_RULE).toBe('lineManagerApproved');
    expect(perf.WHERE_YOU_STAND_RULE).toBe('lineManagerApproved');
  });

  it('released-only: before release a word, never the line manager\'s band; after release the band', () => {
    expect(standingPerformance('releasedOnly', { released: null, managerPerformance: 'AE' })).toEqual({ state: 'notReleased' });
    expect(standingPerformance('releasedOnly', { released: null, managerPerformance: null })).toEqual({ state: 'awaitingManager' });
    expect(standingPerformance('releasedOnly', { released: 'ME', managerPerformance: 'AE' })).toEqual({ state: 'released', band: 'ME' });
  });

  it('flipped: the line manager\'s approved band before release; the released band wins; nothing before approval', () => {
    expect(standingPerformance('lineManagerApproved', { released: null, managerPerformance: 'AE' })).toEqual({ state: 'lineManagerApproved', band: 'AE' });
    expect(standingPerformance('lineManagerApproved', { released: 'ME', managerPerformance: 'AE' })).toEqual({ state: 'released', band: 'ME' });
    expect(standingPerformance('lineManagerApproved', { released: null, managerPerformance: null })).toEqual({ state: 'awaitingManager' });
    // A stored value that is not a band is never shown as one.
    expect(standingPerformance('lineManagerApproved', { released: null, managerPerformance: '3.7' })).toEqual({ state: 'notReleased' });
  });

  it('deriveHomeBlock reads the switch: default and flipped, over the same own-person facts, with no score anywhere', () => {
    const policy = defaultPolicy(framework);
    policy.modules = { pm: true, tm: false, idp: false, evidence: false };
    const review = {
      policy, kpis: [], competencies: [], competencyStatus: 'draft', resultsSubmitted: true, managerPerformance: 'AE', plans: [], planYear: 2027, drafts: [], result: null, careerProfile: null,
    } as unknown as Parameters<typeof deriveHomeBlock>[0]['review'];
    const input = {
      own: { reviewId: randomUUID(), cycleId: CYCLE, cycleName: 'Fictional', periodEnd: `${todayInKualaLumpur().slice(0, 4)}-12-31` },
      review, tasks: [], feedbackOpen: [], feedbackSubmitted: 0, team: [], sessions: [], inCycle: new Set<string>(), now: new Date(),
    };
    const releasedOnly = deriveHomeBlock({ ...input, standingRule: 'releasedOnly' });
    expect(releasedOnly.standing.performance).toEqual({ state: 'notReleased' });
    expect(keysOf(releasedOnly).has('band')).toBe(false);
    expect(JSON.stringify(releasedOnly)).not.toContain('"AE"');
    const byDefault = deriveHomeBlock(input);
    expect(byDefault.standing.performance).toEqual({ state: 'lineManagerApproved', band: 'AE' });
    for (const blk of [releasedOnly, byDefault]) expect([...keysOf(blk)].filter((k) => /score/i.test(k))).toEqual([]);
  });
});

describe('the pure composition', () => {
  it('not-in reasons: the unit rule first, then the source\'s date reasons, else the plain reason', () => {
    const base = { unitOut: false, hiredOn: '2020-01-01', confirmationDate: '2020-04-01', openedOn: '2026-01-15' };
    expect(notInReason({ ...base, unitOut: true, hiredOn: '2026-03-01' })).toBe('unitOut');
    expect(notInReason({ ...base, hiredOn: '2026-03-01' })).toBe('joinedAfterOpen');
    expect(notInReason({ ...base, confirmationDate: '2026-02-01' })).toBe('confirmedAfterOpen');
    expect(notInReason({ ...base, hiredOn: '2025-06-01', confirmationDate: null })).toBe('probation');
    expect(notInReason({ ...base, confirmationDate: null })).toBe('notPart'); // more than a year of service
    expect(notInReason(base)).toBe('notPart');
    expect(notInReason({ ...base, openedOn: null })).toBe('notPart');
  });

  it('team tally by person: waiting on you, still writing theirs, done', () => {
    expect(teamCounts([item({ kind: 'review', view: 'mine', module: 'pm', stage: 'results' })])).toBeNull();
    expect(teamCounts([
      item({ kind: 'review', view: 'team', module: 'pm', stage: 'moderation', id: 'a' }), item({ kind: 'review', view: 'team', module: 'tm', stage: 'competency', id: 'a', state: 'waiting' }),
      item({ kind: 'review', view: 'team', module: 'pm', stage: 'results', id: 'b', state: 'waiting' }),
      item({ kind: 'review', view: 'team', module: 'pm', stage: 'results', id: 'c', state: 'done' }),
    ])).toEqual({ people: 3, turn: 1, wait: 1, done: 1 });
  });

  it('a leader\'s rail has only derivable steps: the 360 owed, the team, the lead work; never a results step', () => {
    expect(leaderRailSteps([
      { id: 'f', kind: 'feedback', view: 'mine', state: 'done' },
      { id: 't1', kind: 'review', view: 'team', state: 'open' }, { id: 't1', kind: 'review', view: 'team', state: 'open' }, { id: 't2', kind: 'review', view: 'team', state: 'waiting' },
      { id: 's', kind: 'calibration', view: 'bg', state: 'done' },
    ])).toEqual([{ key: 'feedback360', state: 'done' }, { key: 'teamReview', state: 'waiting', count: 1 }, { key: 'calibration', state: 'done' }]);
    expect(leaderRailSteps([])).toEqual([]);
  });

  it('Your next step: the own next step holds the button; otherwise the first row that needs the viewer', () => {
    const team = { total: 2, chips: [], href: '/performance/workspace?view=team' };
    const lead = item({ kind: 'calibration', view: 'bu', module: 'cal', stage: 'potential_calibration', axis: 'potential', id: 's1' });
    const own = homeNext(block({ team }), [lead], CYCLE);
    expect(own.primary?.kind).toBe('own');
    expect(own.rows.map((r) => r.kind)).toEqual(['team', 'lead']);
    expect(own.rows[1]).toMatchObject({ tab: 'calibration.potential', href: '/performance/assessment/calibration/s1' });
    const quiet = homeNext(block({ next: { kind: 'none', nextDate: null }, team: { ...team, total: 0 } }), [lead], CYCLE);
    expect(quiet.primary).toMatchObject({ kind: 'row', row: { kind: 'lead' } });
    expect(quiet.rows.map((r) => r.kind)).toEqual(['team']);
    const nothing = homeNext(block({ next: { kind: 'none', nextDate: { kind: 'closes', on: '2026-12-31' } } }), [], CYCLE);
    expect(nothing).toEqual({ primary: null, rows: [], nextDate: { kind: 'closes', on: '2026-12-31' } });
    // Without an own block, the 360 owed is a row; another cycle's work is not.
    const out = homeNext(null, [item({ kind: 'feedback', view: 'mine', module: 'tm', stage: 'feedback', id: 'q1' }), item({ kind: 'calibration', view: 'bu', module: 'cal', stage: 'calibration', cycleId: randomUUID() })], CYCLE);
    expect(out).toEqual({ primary: { kind: 'row', row: { kind: 'feedback', count: 1, href: '/performance/assessment/feedback/q1' } }, rows: [], nextDate: null });
  });

  it('one slot, in the source\'s precedence: leader card, else not-in, else Where you stand', () => {
    const notIn = { cycleName: 'Fictional', reason: 'unitOut' as const };
    expect(homeSlot({ block: block(), leader: bu, notIn, items: [], cycleId: CYCLE })?.kind).toBe('leader');
    expect(homeSlot({ block: null, leader: bu, notIn, items: [], cycleId: CYCLE })?.kind).toBe('leader');
    expect(homeSlot({ block: null, leader: null, notIn, items: [], cycleId: CYCLE })).toMatchObject({ kind: 'notIn', reason: 'unitOut', team: null, leads: false });
    expect(homeSlot({ block: block(), leader: null, notIn: null, items: [], cycleId: CYCLE })?.kind).toBe('stand');
    // An HOD holds no leader seat while the cycle runs (getLeaderStatus returns null): Where you stand.
    expect(homeSlot({ block: block(), leader: null, notIn: null, items: [item({ kind: 'calibration', view: 'dept', module: 'cal', stage: 'department_review' })], cycleId: CYCLE })?.kind).toBe('stand');
    // A record-mode status is never a running card.
    expect(homeSlot({ block: block(), leader: ledRecord, notIn: null, items: [], cycleId: CYCLE })?.kind).toBe('stand');
  });

  it('Your tools: only tabs whose gate is open, never the Dashboard itself, never a locked plan', () => {
    const items = [item({ kind: 'review', view: 'mine', module: 'pm', stage: 'results' }), item({ kind: 'review', view: 'mine', module: 'idp', stage: 'career' })];
    const ids = (f: PerformanceAreaFacts) => toolDoors(f).flatMap((g) => g.tabs.map((t) => t.id));
    expect(ids(facts(items))).toEqual(['pm.my', 'plan.my', 'plan.profile']);
    expect(ids(facts(items, true))).toEqual(['pm.my']);
    expect(ids({ ...facts(items), performanceOn: false })).toEqual([]);
    for (const f of [facts(items), facts(items, true)]) {
      expect(ids(f)).toEqual(PERFORMANCE_AREA_TABS.filter((t) => t.id !== 'home' && performanceTabState(f, t.id) === 'open').map((t) => t.id));
    }
    expect(toolDoors(facts(items)).map((g) => g.strip)).toEqual(['pm', 'plan']);
  });

  it('layout per mode, as approved: rail on top, main and side columns, history below', () => {
    const view = (o: Partial<PerformanceHomeView>): PerformanceHomeView => ({
      mode: 'running', facts: facts([]), rail: { cycleId: CYCLE, cycleName: 'Fictional', closesOn: null, steps: [], done: 0, total: 0 }, next: { primary: null, rows: [], nextDate: null },
      slot: null, past: null, results: null, led: null, plan: null, talentBox: null, history: { rows: [], fullHref: null }, tools: [], checkIns: null, ...o,
    });
    expect(performanceHomeLayout(view({ slot: { kind: 'stand', standing: block().standing, detailsHref: '/me/performance' } }))).toEqual({ top: ['rail'], main: ['next'], side: ['stand', 'tools'], bottom: ['history'] });
    expect(performanceHomeLayout(view({ slot: { kind: 'leader', status: bu } }))).toEqual({ top: ['rail'], main: ['next', 'leader'], side: ['tools'], bottom: ['history'] });
    expect(performanceHomeLayout(view({ slot: { kind: 'notIn', cycleName: 'Fictional', reason: 'notPart', team: null, leads: false } }))).toEqual({ top: ['rail'], main: ['next', 'notIn'], side: ['tools'], bottom: ['history'] });
    const results = { id: 'r', name: 'Old', performance: null, potential: null, talent: null, recordHref: '/me/performance', reportHref: null };
    const plan = { year: 2026, status: 'draft' as const, goals: [], href: '/performance/plan' };
    const past = { cycleName: 'Old', steps: [] };
    expect(performanceHomeLayout(view({ mode: 'record', rail: null, past, results, plan }))).toEqual({ top: ['past'], main: ['results'], side: ['plan', 'tools'], bottom: ['history'] });
    expect(performanceHomeLayout(view({ mode: 'record', rail: null, results, led: ledRecord, plan }))).toEqual({ top: [], main: ['results'], side: ['led', 'tools'], bottom: ['history'] });
    expect(performanceHomeLayout(view({ mode: 'record', rail: null, led: ledRecord, plan }))).toEqual({ top: [], main: ['led'], side: ['plan', 'tools'], bottom: ['history'] });
    expect(performanceHomeLayout(view({ mode: 'record', rail: null }))).toEqual({ top: [], main: ['results'], side: ['tools'], bottom: ['history'] });
  });

  it('the past journey keeps each own step done or closed, dropping steps not required', () => {
    expect(pastJourney([{ key: 'kpi', state: 'done' }, { key: 'competency', state: 'notRequired' }, { key: 'careerPlan', state: 'locked' }, { key: 'results', state: 'released' }]))
      .toEqual([{ key: 'kpi', done: true }, { key: 'careerPlan', done: false }, { key: 'results', done: true }]);
  });
});

describe('route and screen registration', () => {
  it('/performance/home is one SCREENS entry, placed right before onehrAssignments, behind scopedSession', () => {
    const at = SCREENS.findIndex((s) => s.screenKey === 'performanceHome');
    expect(at).toBeGreaterThan(0);
    expect(SCREENS[at + 1]?.screenKey).toBe('onehrAssignments');
    expect(SCREENS[at]).toMatchObject({ href: '/performance/home', guard: 'scopedSession', routes: ['/performance/home'], hasScopeNote: true });
    expect(SCREENS.filter((s) => s.routes.includes('/performance/home')).map((s) => s.screenKey)).toEqual(['performanceHome']);
    expect(REGISTERED_ROUTES.has('/performance/home')).toBe(true);
    expect(typeof en.admin.users.scope.performanceHome).toBe('string');
    const page = fs.readFileSync(path.join(ROOT, 'app/(app)/performance/home/page.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(page).toMatch(/await requireModule\('performance'\)/);
    expect(page).toMatch(/await scopedSession\(\)/);
    expect(page).toMatch(/getPerformanceHome\(s, scopeIds\)/);
    expect(fs.readFileSync(path.join(ROOT, 'app/(app)/performance/home/loading.tsx'), 'utf8').trim()).toBe("export { default } from '@/components/route-loading';");
  });

  it('the leader card reads getLeaderStatus for the running cycle; the page draws the Dashboard strip', () => {
    const service = fs.readFileSync(path.join(ROOT, 'packs/performance/onehr/performance-home-service.ts'), 'utf8');
    expect(service).toContain('getLeaderStatus(ctx, cycle?.id)');
    const view = fs.readFileSync(path.join(ROOT, 'components/performance-home/area-home.tsx'), 'utf8');
    expect(view).toContain('<PerformanceTabStrip strip="home" facts={view.facts} />');
  });
});

describe('getPerformanceHome against real RLS: participation and the unit rule', () => {
  let f: Fixture;
  beforeEach(async () => { f = await buildFixture(); });

  it('a participant gets Where you stand; out by the unit rule, the stored reviewer reads why; out otherwise, the plain reason', async () => {
    const s = await perf.getPerformanceHome(f.U.S!, undefined);
    expect(s.mode).toBe('running');
    expect(s.rail?.cycleId).toBe(f.cycleId);
    expect(s.slot?.kind).toBe('stand');
    expect(s.tools.flatMap((g) => g.tabs.map((t) => t.id))).toContain('pm.setting');
    expect(s.tools.flatMap((g) => g.tabs.map((t) => t.id))).toEqual(PERFORMANCE_AREA_TABS.filter((t) => t.id !== 'home' && performanceTabState(s.facts, t.id) === 'open').map((t) => t.id));
    const before = await perf.getPerformanceHome(f.U.M0!, undefined);
    expect(before.slot?.kind, 'non-vacuous: M0 takes part before the rule').toBe('stand');

    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const m0 = await perf.getPerformanceHome(f.U.M0!, undefined);
    expect(m0.mode).toBe('running');
    expect(m0.rail?.cycleId).toBe(f.cycleId);
    expect(m0.slot).toMatchObject({ kind: 'notIn', reason: 'unitOut' });
    // T is out by the same rule but stores no colleague's review, so the rule is not theirs to read.
    expect((await perf.getPerformanceHome(f.U.T!, undefined)).slot).toMatchObject({ kind: 'notIn', reason: 'notPart' });
    expect((await perf.getPerformanceHome(f.U.S!, undefined)).slot?.kind).toBe('stand');
  });
});

describe('getPerformanceHome against real RLS: no unreleased band, for the employee or their manager', () => {
  let b: Base, a: SessionContext;
  type Hired = { employmentId: string; personId: string };
  const year = () => Number(todayInKualaLumpur().slice(0, 4));
  beforeEach(async () => { await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'performance', 'active'); a = await entitledCtx(b); });

  it('APR-028: the employee sees their manager\'s confirmed band before release, the manager\'s page never carries it, and release shows the released band', async () => {
    const hire = (name: string): Promise<Hired> => hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@pt-x3.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year() - 2}-01-01` });
    const subject = await hire('Home subject'), manager = await hire('Home manager');
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    for (const e of [subject, manager]) await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.id, e.employmentId));
    await setReportingLine(a, { subordinateEmploymentId: subject.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${year() - 2}-01-01` });
    const { cycleId } = await perf.createCycle(a, { name: 'PT-X3 annual', companyId: b.companyId, periodStart: `${year()}-01-01`, periodEnd: `${year()}-12-31` });
    const policy = defaultPolicy(framework);
    policy.modules = { pm: true, tm: false, idp: false, evidence: false };
    await perf.configureOnehrCycle(a, cycleId, null, policy); await perf.openCycle(a, { cycleId });
    const [row] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, subject.employmentId)));
    const reviewId = row!.id;
    const self: SessionContext = { ...a, userId: await createAppUser(b.tenantId, subject.personId, 'employee'), personId: subject.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    const mgr: SessionContext = { ...a, userId: await createAppUser(b.tenantId, manager.personId, 'manager'), personId: manager.personId, roles: ['manager'], grants: [{ role: 'manager', companyId: null }] };
    const rev = async (ctx: SessionContext) => (await perf.getOnehrReview(ctx, reviewId))!.revision;
    const kpiId = randomUUID();
    const kpi = { id: kpiId, title: 'Agreed delivery', description: 'Fictional measure.', weightBp: 10000, unit: 'milestones', scoring: { mechanism: 'A' as const, method: 'more' as const, rates: [0, 1, 2, 3, 4] }, moderatorEmploymentId: manager.employmentId };
    await perf.saveOnehrKpis(self, reviewId, await rev(self), [kpi], true);
    await perf.approveOnehrScorecard(mgr, reviewId, await rev(mgr), true, 'Objectives agreed.');
    await perf.submitOnehrResults(self, reviewId, await rev(self), [{ id: kpiId, actual: 2, note: 'Fictional record.' }], 'Delivered the agreed milestones this year.');
    await perf.moderateOnehrKpi(mgr, reviewId, await rev(mgr), kpiId, 2, 'Verified.');
    let confirmed: PMBand | null = null;
    for (const band of pmBands) {
      try { await perf.confirmOnehrPerformance(mgr, reviewId, await rev(mgr), band, ''); confirmed = band; break; }
      catch (e) { if (!/calculated/i.test((e as Error).message)) throw e; }
    }
    const band = confirmed!;
    expect((await perf.getOnehrReview(self, reviewId))?.managerPerformance, 'non-vacuous: the manager\'s band is decided').toBe(band);

    for (const ctx of [self, mgr]) {
      const view = await perf.getPerformanceHome(ctx, undefined);
      expect(view.mode).toBe('running');
      expect([...keysOf(view)].filter((k) => /score/i.test(k))).toEqual([]);
    }
    // The manager's own page never carries the report's band.
    expect(JSON.stringify(await perf.getPerformanceHome(mgr, undefined))).not.toContain(`"${band}"`);
    // The source's rule (APR-028): the person's own Where you stand shows the manager's confirmed band before release.
    const mine = await perf.getPerformanceHome(self, undefined);
    expect(mine.slot).toMatchObject({ kind: 'stand', standing: { performance: { state: 'lineManagerApproved', band } } });

    await perf.releaseOnehrResult(a, reviewId, 'performance', true);
    expect((await perf.getPerformanceHome(self, undefined)).slot).toMatchObject({ kind: 'stand', standing: { performance: { state: 'released', band } } });
    // The manager's page still carries no person's band (their own row is their own, and unreleased).
    expect(JSON.stringify(await perf.getPerformanceHome(mgr, undefined))).not.toContain(`"${band}"`);
  });

  it('someone with nothing in Performance: between cycles, no record, no doors', async () => {
    const view = await perf.getPerformanceHome(a, undefined);
    expect(view).toMatchObject({ mode: 'record', rail: null, slot: null, results: null, plan: null, talentBox: null, tools: [], checkIns: null });
    expect(performanceHomeLayout(view).main).toEqual(['results']);
  });
});

describe('getPerformanceHome against real RLS: the Check-ins door to /performance (DQ-11)', () => {
  let b: Base, a: SessionContext;
  const year = () => Number(todayInKualaLumpur().slice(0, 4));
  beforeEach(async () => { await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'performance', 'active'); a = await entitledCtx(b); });

  it('a manager with a pending check-in sees the door; the employee does not', async () => {
    const hire = (name: string) => hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@pt-x5.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year() - 2}-01-01` });
    const subject = await hire('Check-in subject'), manager = await hire('Check-in manager');
    await setReportingLine(a, { subordinateEmploymentId: subject.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${year() - 2}-01-01` });
    const self: SessionContext = { ...a, userId: await createAppUser(b.tenantId, subject.personId, 'employee'), personId: subject.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    const mgr: SessionContext = { ...a, userId: await createAppUser(b.tenantId, manager.personId, 'manager'), personId: manager.personId, roles: ['manager'], grants: [{ role: 'manager', companyId: null }] };
    // Before any check-in or review, neither gets the door (non-vacuous: the door follows the work, not the role).
    expect((await perf.getPerformanceHome(mgr, undefined)).checkIns).toBeNull();
    await perf.scheduleCheckIn(a, { subjectEmploymentId: subject.employmentId, scheduledOn: todayInKualaLumpur() });
    // The page's own read sees it for the manager, under the manager's session.
    expect((await perf.managerCheckIns(mgr)).checkins.map((c) => c.status)).toEqual(['scheduled']);
    expect((await perf.getPerformanceHome(mgr, undefined)).checkIns).toBe('/performance');
    expect((await perf.managerCheckIns(self)).checkins).toEqual([]);
    expect((await perf.getPerformanceHome(self, undefined)).checkIns).toBeNull();
  });
});
