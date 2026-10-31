import {establishRewardMembership,migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget,changeRewardFixtureInputs} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
/**
 * P1 WP-H1 (truthful Post) and WP-G (Rewards approvals board, reward calendar 0646). Fictional fixtures only.
 * Every service call runs through withTenant as the app role (ai_hr_app, NOBYPASSRLS); direct RLS probes too.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createTranslator } from 'next-intl';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { assignRole, createCompany } from '../core/admin';
import { setCompensation } from '../core/comp';
import { createBatch, setPayrollInput } from '../packs/payroll/service';
import { canPostRewardUnit, createRewardUnit, decideRewardUnit, getRewardCalendar, getRewardUnit, listRewardReviewStatus, postRewardUnit, rewardApprovalsBoard, rewardDueWording, saveRewardCalendar, saveRewardEntry, saveRewardPolicy, sendReadyRewardUnits, emptyRewardCalendar } from '../packs/rewards/service';
import { emptyFacts, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
import en from '../messages/en.json';

beforeAll(migrateRewardMembershipFixture);
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const shift = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
type Seat = Exclude<RewardRole, 'gr'> | 'grOnly' | 'payrollOnly';
const OK = 'Reviewed recommendations';

describe('Rewards approvals board, posting authority and reward calendar', () => {
  let b: Base, admin: SessionContext;
  const actors: Partial<Record<Seat, SessionContext>> = {};
  let n = 0;

  async function person(label: string) {
    const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `${label} (fictional)`, primaryEmail: `${label}-${n++}@board.test` }).returning();
    return p;
  }
  async function employee(code: string, salary: number, bu: string) {
    const hire = await hireEmployee(admin, { person: { fullName: `Board ${code}`, primaryEmail: `${code}-${n++}@board.test` }, companyId: b.companyId, departmentId: b.deptA, businessUnitId:bu, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    const [grade] = await owner.db.select().from(schema.jobGrade).where(and(eq(schema.jobGrade.tenantId, b.tenantId), eq(schema.jobGrade.code, '12')));
    await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, hire.employmentId));
    await setCompensation(admin, { employmentId: hire.employmentId, basicSalary: salary, effectiveFrom: `${year - 2}-01-01` });
    return hire.employmentId;
  }
  /** A unit with every seat assigned, policy configured, facts verified. confidentiality by salary. */
  async function unit(code: string, people: { salary: number; confidentiality?: 'standard' | 'bg' | 'ec' }[], buActor: SessionContext = actors.bu!) {
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code, name: `Unit ${code}` }).returning();
    for (const [i, p] of people.entries()) await employee(`${code}-${i}`, p.salary, bu.id);
    const id = await createRewardUnit(admin, { name: 'Board cycle', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    const rev = async () => (await getRewardUnit(admin, id)).unit.revision;
    for (const seat of ['bu', 'bg', 'ctro', 'ec', 'pbp'] as const) await setRewardMember(admin, id, await rev(), (seat === 'bu' ? buActor : actors[seat]!).userId!, seat);
    await setRewardMember(admin, id, await rev(), admin.userId!, 'payroll');
    await setRewardMember(admin, id, await rev(), actors.payrollOnly!.userId!, 'payroll');
    await setRewardMember(admin, id, await rev(), actors.grOnly!.userId!, 'gr');
    const v = await getRewardUnit(admin, id);
    await configureRewardFixture(admin, id, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 600000, 1200000] } });
    for (const row of (await getRewardUnit(admin, id)).rows) {
      const conf = people.find(p => p.salary * 100 === row.source.basicCents)?.confidentiality ?? 'standard';
      await saveRewardEntry(admin, id, await rev(), row.id, row.recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME', confidentiality: conf });
    }
    await refreshRewardFixtureBudget(admin,id);
    return id;
  }
  const submit = async (id: string, who: SessionContext = actors.bu!) => decideRewardUnit(who, id, (await getRewardUnit(who, id)).unit.revision, 'submit', OK);
  const approveTo = async (id: string, stages: ('bg' | 'gr' | 'ctro' | 'ec')[]) => {
    for (const s of stages) { const who = s === 'gr' ? actors.grOnly! : actors[s]!; await decideRewardUnit(who, id, (await getRewardUnit(who, id)).unit.revision, 'approve', OK); }
  };
  const decisions = async (id: string) => owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId, id)).orderBy(asc(schema.rewardDecision.createdAt), asc(schema.rewardDecision.id));

  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const ap = await person('admin');
    await owner.db.update(schema.appUser).set({ personId: ap.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: ap.id };
    await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' });
    for (const seat of ['bu', 'bg', 'ctro', 'ec', 'pbp', 'grOnly', 'payrollOnly'] as const) {
      const p = await person(seat);
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      actors[seat] = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
    }
  });
  afterAll(closeAll);

  // ── H1 ────────────────────────────────────────────────────────────────────────────────────────────────
  describe('H1: Post is offered only when postRewardUnit would accept', () => {
    it('a payroll seat without HR administration sees no Post, the reason, and is still refused', async () => {
      const id = await unit('H1A', [{ salary: 5000 }]);
      await submit(id); await approveTo(id, ['bg', 'gr', 'ctro', 'ec']);
      const v = await getRewardUnit(actors.payrollOnly!, id);
      expect(v.unit.status).toBe('approved');
      expect(v.posting).toBe('needs-admin');
      expect(await canPostRewardUnit(actors.payrollOnly!, id)).toBe(false);
      await expect(postRewardUnit(actors.payrollOnly!, id, v.unit.revision)).rejects.toThrow(/Company administrator access is required/);
      expect((await getRewardUnit(admin, id)).unit.status).toBe('approved');
    });
    // DR-13 (APR-022): the reward design source has no payroll actor, so AI-HR adds no posting authority.
    // These two pins hold rewardPostingAuthorityTx to "payroll seat AND company HR administration".
    /** An account built from the harness: an employee login plus one company-scoped role grant. */
    async function scopedAccount(label: string, role: 'payroll_partner' | 'hr_admin'): Promise<SessionContext> {
      const p = await person(label);
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      await assignRole(admin, { appUserId: userId, role, companyId: b.companyId });
      return { ...admin, userId, personId: p.id, roles: ['employee', role], grants: [{ role: 'employee', companyId: null }, { role, companyId: b.companyId }] };
    }
    const enactedState = async () => ({
      compensation: await owner.db.select().from(schema.compensation).where(eq(schema.compensation.tenantId, b.tenantId)).orderBy(asc(schema.compensation.id)),
      employment: await owner.db.select().from(schema.employment).where(eq(schema.employment.tenantId, b.tenantId)).orderBy(asc(schema.employment.id)),
      payrollInput: await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.tenantId, b.tenantId)).orderBy(asc(schema.payrollInput.id)),
      unit: await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.tenantId, b.tenantId)).orderBy(asc(schema.rewardUnit.id)),
    });
    const isRewardAdmin = (who: SessionContext) => withTenant(who, async tx => (await tx.execute<{ ok: boolean }>(sql`select app.reward_admin(${b.companyId}::uuid) as ok`))[0]?.ok === true);
    it('DR-13: a payroll partner holding the payroll seat but not HR administration cannot post, and nothing is enacted', async () => {
      const partner = await scopedAccount('payroll-partner', 'payroll_partner');
      const id = await unit('DR13A', [{ salary: 5000 }]);
      await setRewardMember(admin, id, (await getRewardUnit(admin, id)).unit.revision, partner.userId!, 'payroll');
      await submit(id); await approveTo(id, ['bg', 'gr', 'ctro', 'ec']);
      const v = await getRewardUnit(partner, id);
      expect(v.unit.status).toBe('approved');
      expect(v.posting).toBe('needs-admin');
      expect(await isRewardAdmin(partner)).toBe(false);
      expect(await canPostRewardUnit(partner, id)).toBe(false);
      const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
      const employmentId = (await getRewardUnit(admin, id)).rows[0].source.employmentId;
      await setPayrollInput(admin, { batchId: batch.batchId, employmentId, overtimeAmount: 123, bonusAmount: 55, tp1Deduction: 44, zakat: 9 });
      const before = await enactedState();
      expect(before.compensation.length).toBeGreaterThan(0);
      expect(before.employment.some(e => e.id === employmentId && e.gradeId)).toBe(true);
      expect(before.payrollInput.some(r => r.batchId === batch.batchId && r.employmentId === employmentId)).toBe(true);
      await expect(postRewardUnit(partner, id, v.unit.revision, batch.batchId)).rejects.toThrow(/Company administrator access is required/);
      await expect(postRewardUnit(partner, id, v.unit.revision)).rejects.toThrow(/Company administrator access is required/);
      expect(await enactedState()).toEqual(before);
      expect((await getRewardUnit(admin, id)).unit.status).toBe('approved');
    });
    it('DR-13: a company HR administrator without the payroll seat is refused on the no-seat path', async () => {
      const hrAdmin = await scopedAccount('company-admin', 'hr_admin');
      const id = await unit('DR13B', [{ salary: 5000 }]);
      await setRewardMember(admin, id, (await getRewardUnit(admin, id)).unit.revision, hrAdmin.userId!, 'pbp');
      await submit(id); await approveTo(id, ['bg', 'gr', 'ctro', 'ec']);
      const v = await getRewardUnit(hrAdmin, id);
      expect(v.unit.status).toBe('approved');
      expect(v.posting).toBe('no-seat');
      expect(await isRewardAdmin(hrAdmin)).toBe(true);
      expect(await canPostRewardUnit(hrAdmin, id)).toBe(false);
      const before = await enactedState();
      expect(before.compensation.length).toBeGreaterThan(0);
      await expect(postRewardUnit(hrAdmin, id, v.unit.revision)).rejects.toThrow(/The assigned payroll role is required/);
      expect(await enactedState()).toEqual(before);
    });
    it('an HR administrator holding the payroll seat sees Post and it posts', async () => {
      const id = await unit('H1B', [{ salary: 5000 }]);
      await submit(id); await approveTo(id, ['bg', 'gr', 'ctro', 'ec']);
      const v = await getRewardUnit(admin, id);
      expect(v.posting).toBe('allowed');
      expect(await canPostRewardUnit(admin, id)).toBe(true);
      const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
      expect(await postRewardUnit(admin, id, v.unit.revision, batch.batchId)).toEqual({ alreadyPosted: false });
      expect((await getRewardUnit(admin, id)).unit.status).toBe('posted');
    });
    it('the page flag and the guard agree for every seat (one predicate)', async () => {
      const id = await unit('H1C', [{ salary: 5000 }]);
      await submit(id); await approveTo(id, ['bg', 'gr', 'ctro', 'ec']);
      for (const who of [actors.payrollOnly!, actors.bu!, actors.grOnly!]) {
        const v = await getRewardUnit(who, id);
        expect(v.posting).not.toBe('allowed');
        await expect(postRewardUnit(who, id, v.unit.revision)).rejects.toThrow(/payroll role|administrator access/);
      }
      expect((await getRewardUnit(admin, id)).posting).toBe('allowed');
    });
    it('the guard and the page both read rewardPostingAuthorityTx (source pin)', () => {
      const svc = readFileSync(new URL('../packs/rewards/service.ts', import.meta.url), 'utf8');
      const start = svc.indexOf('export async function postRewardUnit('), end = svc.indexOf('export async function createOffcycleReview(');
      expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
      const body = svc.slice(start, end);
      expect(body.length).toBeGreaterThan(1500);
      // postRewardUnit's guard now lives in prepareRewardPostTx, which the reviewed Assistant post shares.
      // Pin it exactly where alpha put it: after the locked load and revision check, before any status,
      // calculation or batch read, and as the ONLY posting-authority rule.
      expect(body).toContain('const prepared=await prepareRewardPostTx(tx,ctx,unitId,revision,batchId);');
      const pStart = svc.indexOf('async function prepareRewardPostTx('), pEnd = svc.indexOf('async function currentRewardPostEmployeeTx(', pStart);
      expect(pStart).toBeGreaterThanOrEqual(0); expect(pEnd).toBeGreaterThan(pStart);
      const prepare = svc.slice(pStart, pEnd);
      expect(prepare.length).toBeGreaterThan(800);
      const guardAt = prepare.indexOf('const authority = await rewardPostingAuthorityTx(tx, unit, roles);');
      expect(guardAt).toBeGreaterThan(prepare.indexOf('assertRevision(unit, revision);'));
      expect(prepare.indexOf('assertRevision(unit, revision);')).toBeGreaterThanOrEqual(0);
      expect(guardAt).toBeLessThan(prepare.indexOf("if (unit.status === 'posted')"));
      expect(prepare).toContain("if (authority === 'no-seat') throw new RewardError('The assigned payroll role is required.');");
      expect(prepare).toContain("if (authority === 'needs-admin') throw new RewardError('Company administrator access is required.');");
      // The reviewed Assistant post re-checks through the same owner, never a second copy of the rule.
      expect(body).toContain('authority=await rewardPostingAuthorityTx(tx,nominee,roles)');
      for (const src of [body, prepare]) {
        expect(src).not.toContain("roles.includes('payroll')");
        expect(src).not.toContain("includes('payroll'))throw");
        expect(src).not.toContain('requireAdmin(');
      }
      const page = readFileSync(new URL('../app/(app)/rewards/[unitId]/page.tsx', import.meta.url), 'utf8');
      expect(page).toContain('<RewardPostPanel posting={v.posting}');
      expect(page).not.toContain('postAction} className');
    });
  });

  // ── G: projection parity and leakage ─────────────────────────────────────────────────────────────────
  describe('Approvals board projection', () => {
    const pooledIncrease = (v: Awaited<ReturnType<typeof getRewardUnit>>) => v.rows.filter(r => r.plan !== 'ec').reduce((n, r) => n + r.newBasicCents - r.source.basicCents, 0);
    it('shows each seat exactly what its review page shows, and never aggregates a restricted row', async () => {
      // 5000 standard, 7000 BG-confidential, 9100 Executive plan.
      const id = await unit('VIS', [{ salary: 5000 }, { salary: 7000, confidentiality: 'bg' }, { salary: 9100, confidentiality: 'ec' }]);
      await submit(id);
      const expected: Record<string, number> = {};
      for (const [label, who] of [['bu', actors.bu!], ['bg', actors.bg!], ['pbp', actors.pbp!], ['gr', actors.grOnly!]] as const) {
        const review = await getRewardUnit(who, id);
        const [row] = (await rewardApprovalsBoard(who, [b.companyId])).filter(r => r.id === id);
        expect(row, label).toBeDefined();
        expect(row.people, label).toBe(review.rows.length);
        const [overview]=(await listRewardReviewStatus(who,[b.companyId])).rows;
        expect(overview).toMatchObject({salary:row.salary,bonus:row.bonus,blocking:row.blocking,exceptions:row.exceptions,waiting:row.waiting});
        expect(row.salary?.increaseCents, label).toBe(pooledIncrease(review));
        expect(row.blocking, label).toBe(review.flags.filter(f => f.severity === 'block').length);
        expect(row.exceptions, label).toBe(review.flags.filter(f => f.severity === 'exception').length);
        expect(row.waiting, label).toBe(label === 'bg');
        expected[label] = row.salary!.increaseCents;
        if (label === 'bu' || label === 'pbp') expect(review.rows.map(r => r.source.basicCents).sort()).toEqual([500000]);
      }
      // Absolute totals: BU and PBP aggregate only the standard employee; BG and GR add the BG-confidential one;
      // nobody's pooled total contains the Executive-plan row.
      const gr = await getRewardUnit(actors.grOnly!, id);
      const inc = (cents: number) => { const r = gr.rows.find(x => x.source.basicCents === cents)!; return r.newBasicCents - r.source.basicCents; };
      expect(inc(500000)).toBeGreaterThan(0); expect(inc(700000)).toBeGreaterThan(0);
      expect(expected.bu).toBe(inc(500000)); expect(expected.pbp).toBe(inc(500000));
      expect(expected.bg).toBe(inc(500000) + inc(700000)); expect(expected.gr).toBe(inc(500000) + inc(700000));
      const buJson = JSON.stringify(await rewardApprovalsBoard(actors.bu!, [b.companyId]));
      expect(buJson).not.toContain(String(inc(500000) + inc(700000)));
    });
    it('carries the route progress and next seat of the unit\'s stage after a real decision', async () => {
      const id = await unit('PROG', [{ salary: 5000 }]);
      await submit(id); await approveTo(id, ['bg']);
      expect((await getRewardUnit(admin, id)).unit.status).toBe('gr');
      const [row] = (await rewardApprovalsBoard(actors.grOnly!, [b.companyId])).filter(r => r.id === id);
      expect({ steps: row.progress?.map(p => `${p.seat}:${p.state}`), nextSeat: row.nextSeat, waiting: row.waiting }).toEqual({
        steps: ['bu:done', 'bg:done', 'gr:current', 'ctro:pending', 'ec:pending', 'payroll:pending'], nextSeat: 'ctro', waiting: true });
    });
    it('shows "—" money when the viewer can see no record of the review', async () => {
      const id = await unit('NONE', [{ salary: 5000, confidentiality: 'bg' }]);
      const [row] = (await rewardApprovalsBoard(actors.bu!, [b.companyId])).filter(r => r.id === id);
      expect(row.people).toBe(0); expect(row.salary).toBeNull(); expect(row.bonus).toBeNull();
    });
    it('lists nothing from another company outside scope, a company without a seat, or another tenant', async () => {
      const id = await unit('MAIN', [{ salary: 5000 }]);
      const other = await createCompany(admin, { legalName: 'Board Other Co (fictional)', companyLabel: 'BRD-OTHER' });
      const [obu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: other.id, code: 'OTH', name: 'Other unit' }).returning();
      await establishRewardMembership(admin,{tenantId:b.tenantId,companyId:other.id,businessUnitId:obu.id,year});
      const otherUnit = await createRewardUnit(admin, { name: 'Board cycle', year, companyId: other.id, businessUnitId: obu.id, snapshotDate: today });
      expect((await rewardApprovalsBoard(admin, [b.companyId])).map(r => r.id)).toEqual([id]);
      expect((await rewardApprovalsBoard(admin, [b.companyId, other.id])).map(r => r.id).sort()).toEqual([id, otherUnit].sort());
      expect((await rewardApprovalsBoard(actors.bu!, [b.companyId, other.id])).map(r => r.id)).toEqual([id]);
      const t2 = await seedBase(); await setModule(t2.tenantId, 'rewards', 'active');
      const a2 = await entitledCtx(t2);
      expect(await rewardApprovalsBoard(a2, [b.companyId, t2.companyId])).toEqual([]);
      expect((await rewardApprovalsBoard(admin, [b.companyId, t2.companyId])).map(r => r.id)).toEqual([id]);
    });
  });

  // ── G: bulk ────────────────────────────────────────────────────────────────────────────────────────
  describe('Send all ready', () => {
    it('sends ready units, skips a blocked one, refuses one that changed, one decision per success', async () => {
      // Each BU CEO has their own real People placement; BG remains a group reviewer across units.
      const buActors = new Map<string, SessionContext>();
      async function boardUnit(code: string, salary: number) {
        const p = await person(`${code}-bu`), userId = await createAppUser(b.tenantId, p.id, 'employee');
        const buActor: SessionContext = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
        const id = await unit(code, [{ salary }], buActor); buActors.set(id, buActor); return id;
      }
      const ready1 = await boardUnit('RDY1', 5000), ready2 = await boardUnit('RDY2', 5200);
      const blocked = await boardUnit('BLK', 5400), changed = await boardUnit('CHG', 5600);
      expect(new Set([...buActors.values()].map(actor => actor.userId)).size).toBe(4);
      await expect(getRewardUnit(buActors.get(ready1)!, ready2)).rejects.toThrow(/access has been removed/);
      for (const id of [ready1, ready2, blocked, changed]) await submit(id, buActors.get(id)!);
      // Drift after submission: a record loses verification, so the BG seat sees a blocking restricted check.
      const [entry] = await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId, blocked));
      await owner.db.update(schema.rewardEntry).set({ facts: { ...entry.facts, reviewed: false } }).where(eq(schema.rewardEntry.id, entry.id));
      const board = await rewardApprovalsBoard(actors.bg!, [b.companyId]);
      const seen = board.filter(r => r.waiting && r.action === 'approve').map(r => ({ unitId: r.id, revision: r.revision }));
      expect(seen.map(s => s.unitId).sort()).toEqual([ready1, ready2, blocked, changed].sort());
      expect(board.find(r => r.id === blocked)!.blocking).toBeGreaterThan(0);
      expect(board.find(r => r.id === blocked)!.ready).toBe(false);
      // Another session returns and resubmits `changed` after the page opened: same stage, new revision.
      await decideRewardUnit(actors.bg!, changed, seen.find(s => s.unitId === changed)!.revision, 'return', 'Returned by another session for a fix');
      await submit(changed, buActors.get(changed)!);
      const before = Object.fromEntries(await Promise.all([ready1, ready2, blocked, changed].map(async id => [id, (await decisions(id)).length] as const)));
      const result = await sendReadyRewardUnits(actors.bg!, [b.companyId], seen);
      expect(result.sent.sort()).toEqual([ready1, ready2].sort());
      expect(result.skipped).toEqual([blocked]);
      expect(result.refused.map(r => r.id)).toEqual([changed]);
      expect(result.refused[0].message).toMatch(/changed in another session/);
      for (const id of [ready1, ready2]) {
        const after = await decisions(id);
        expect(after.length).toBe(before[id] + 1);
        expect(after.at(-1)).toMatchObject({ action: 'approve', fromStage: 'bg', toStage: 'gr', actorId: actors.bg!.userId });
        expect((await getRewardUnit(admin, id)).unit.status).toBe('gr');
      }
      expect((await decisions(blocked)).length).toBe(before[blocked]);
      expect((await decisions(changed)).length).toBe(before[changed]);
      expect((await getRewardUnit(admin, changed)).unit.status).toBe('bg');
    });
    it('ignores units the viewer did not see and units not waiting on the viewer', async () => {
      const id = await unit('UNSEEN', [{ salary: 5000 }]);
      await submit(id);
      expect(await sendReadyRewardUnits(actors.bg!, [b.companyId], [])).toEqual({ sent: [], skipped: [], refused: [] });
      const rev = (await getRewardUnit(actors.bu!, id)).unit.revision;
      expect(await sendReadyRewardUnits(actors.ctro!, [b.companyId], [{ unitId: id, revision: rev }])).toEqual({ sent: [], skipped: [], refused: [] });
      expect((await getRewardUnit(admin, id)).unit.status).toBe('bg');
    });
  });

  // ── G: calendar, due wording, RLS ────────────────────────────────────────────────────────────────────
  describe('Reward calendar', () => {
    it('drives Due: today is "today", yesterday is "1 day overdue", none set is —', async () => {
      const id = await unit('DUE', [{ salary: 5000 }]);
      await submit(id);
      const row = async () => (await rewardApprovalsBoard(actors.bg!, [b.companyId])).find(r => r.id === id)!;
      expect((await row()).due).toBeNull();
      const cal = { ...emptyRewardCalendar(), due: { ...emptyRewardCalendar().due, bg: today } };
      await saveRewardCalendar(actors.grOnly!, id, 0, cal);
      expect(await row()).toMatchObject({ due: today, daysUntilDue: 0 });
      expect((await getRewardUnit(actors.bu!, id)).due).toBe(today);
      await saveRewardCalendar(admin, id, 1, { ...cal, due: { ...cal.due, bg: shift(-1) } });
      expect(await row()).toMatchObject({ due: shift(-1), daysUntilDue: -1 });
      const t = createTranslator({ locale: 'en', messages: en, namespace: 'rewards.board' });
      const say = (d: number) => { const w = rewardDueWording(d); return t(w.key, { days: w.days }); };
      expect([say(0), say(-1), say(-3), say(1), say(4)]).toEqual(['today', '1 day overdue', '3 days overdue', 'tomorrow', 'in 4 days']);
    });
    it('lets Group Rewards and an HR administrator write; refuses other seats, outsiders and stale forms', async () => {
      const id = await unit('CAL', [{ salary: 5000 }]);
      const cal = { ...emptyRewardCalendar(), caseDue: shift(10) };
      await expect(saveRewardCalendar(actors.bu!, id, 0, cal)).rejects.toThrow(/Group Rewards or a company HR administrator/);
      expect(await saveRewardCalendar(actors.grOnly!, id, 0, cal)).toBe(1);
      await expect(saveRewardCalendar(admin, id, 0, cal)).rejects.toThrow(/changed in another session/);
      const freshAdmin = await entitledCtx(b); // hr_admin with no Reward Desk seat
      expect(await saveRewardCalendar(freshAdmin, id, 1, cal)).toBe(2);
      expect((await getRewardCalendar(actors.pbp!, id))).toMatchObject({ revision: 2, canEdit: false, values: { caseDue: shift(10) } });
      // Direct RLS as the app role: a BU seat reads but cannot write; an outsider sees nothing.
      expect(await withTenant(actors.bu!, tx => tx.select().from(schema.rewardCalendar))).toHaveLength(1);
      const [u] = await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id, id));
      await expect(withTenant(actors.bu!, tx => tx.insert(schema.rewardCalendar).values({ tenantId: b.tenantId, cycleId: u.cycleId, companyId: b.companyId, updatedBy: actors.bu!.userId! }))).rejects.toThrow();
      expect(await withTenant(actors.bu!, tx => tx.update(schema.rewardCalendar).set({ caseDue: shift(1), updatedBy: actors.bu!.userId! }).returning())).toEqual([]);
      const op = await person('outsider');
      const outsider = { ...admin, userId: await createAppUser(b.tenantId, op.id, 'employee'), personId: op.id, roles: ['employee'] as SessionContext['roles'], grants: undefined };
      expect(await withTenant(outsider, tx => tx.select().from(schema.rewardCalendar))).toEqual([]);
      await expect(getRewardCalendar(outsider, id)).rejects.toThrow();
      const t2 = await seedBase(); await setModule(t2.tenantId, 'rewards', 'active');
      expect(await withTenant(await entitledCtx(t2), tx => tx.select().from(schema.rewardCalendar))).toEqual([]);
      const grants = await owner.db.execute<{ s: boolean; i: boolean; u: boolean; rls: boolean }>(sql`select has_table_privilege('ai_hr_app','reward_calendar','SELECT') s, has_table_privilege('ai_hr_app','reward_calendar','INSERT') i, has_table_privilege('ai_hr_app','reward_calendar','UPDATE') u, (select relrowsecurity from pg_class where relname='reward_calendar') rls`);
      expect(grants[0]).toEqual({ s: true, i: true, u: true, rls: true });
      // No DELETE policy: even a writer removes nothing (a deadline is changed, never erased with its history).
      expect(await withTenant(freshAdmin, tx => tx.delete(schema.rewardCalendar).returning())).toEqual([]);
      expect(await owner.db.select().from(schema.rewardCalendar)).toHaveLength(1);
    });
  });
});
