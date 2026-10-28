/**
 * WP-A3 — leader status data for the home cards (app.onehr_leader_status, 0666; getLeaderStatus), against real
 * RLS as ai_hr_app.
 *
 * Writes are an HR administrator's app-role session (seats, HOD assignments, calibration groups, calibration
 * rows as generation would write them, releases through the release service). `owner` only builds fixture
 * state no service under test owns: the org tree, grades, the line manager's confirmed band and, for the
 * between-cycles tally, the cycle's closed status. Dates come from todayInKualaLumpur().
 *
 * Org: Holding (business group node) <- Acme (unit, seedBase), Beta, Gamma and Delta (units; Gamma and Delta
 * have nobody). Elsewhere is a separate root holding the seat holders, so they never count in a seat's people.
 *   Acme: hodA (Finance) heads A1, A2; hodA2 (Operations) heads A3.   Beta: hodB (Sales) heads B1, B2.
 *   Seats: buA (Acme), buB (Beta), bgCeo (Holding, and Gamma's BU seat), hodA2 (Delta's BU seat), chief (group
 *   of A1, A2 and B1, B1 in batch "North"). outsider holds nothing.
 * W3-F6 (D-P1-22 E7, ADR-0150): a seat or HOD assignment whose holder employment is out of the cycle by the unit
 * rule gives no card and no tally, per acting employment (D9); rules are saved and ended through the service.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy, type Policy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
import { bringBack, exclude, moveTo } from './performance-unit-exclusion-fixture';

const today = todayInKualaLumpur();
const year = Number(today.slice(0, 4));
const BAND = /\b(UA|BE|ME|AE|OU|Low|Mid|High|Super Star|Star|Solid Core|PIP)\b/;
/** Every key the projection may carry, at any depth. Anything else is a leak by construction. */
const ALLOWED_KEYS = new Set([
  'seat', 'mode', 'cycleId', 'midYear', 'units', 'companyId', 'label', 'people', 'departments', 'state', 'axes', 'axis', 'lockedOn', 'in', 'of',
  'depts', 'name', 'performanceInOn', 'potentialInOn', 'ready', 'locked', 'total', 'rows', 'gated', 'performance', 'potential', 'talent',
  'released', 'waiting', 'departmentReviews', 'bands',
]);
/** The only keys inside a tally's `bands` array: an aggregate count per band, never a person. */
const BAND_ENTRY_KEYS = ['band', 'n'];
/** The value with every tally `bands` array removed, and the entries that were removed. */
function withoutBands(value: unknown, removed: unknown[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutBands(v, removed));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    if (k === 'bands') { if (Array.isArray(v)) removed.push(...v); return [k, null]; }
    return [k, withoutBands(v, removed)];
  }));
  return value;
}
const PEOPLE = ['hodA', 'hodA2', 'hodB', 'A1', 'A2', 'A3', 'B1', 'B2', 'buA', 'buB', 'bgCeo', 'chief', 'outsider'] as const;
type Name = (typeof PEOPLE)[number];
type Hired = { employmentId: string; personId: string };
/** The between-cycles tally (BU CEO, BG CEO, HOD); a group chief's record carries none. */
type Tally = Extract<perf.LeaderStatus, { mode: 'record'; performance: unknown }>;

let b: Base, a: SessionContext, holding: string, beta: string, gamma: string, delta: string, cycleId: string;
const P = {} as Record<Name, Hired>;
const U = {} as Record<Name, SessionContext>;
const R = {} as Record<Name, string>;

const hire = (name: string, companyId: string, departmentId: string, ctx = a) => hireEmployee(ctx, { person: { fullName: name, primaryEmail: `${randomUUID()}@leader-status.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
async function login(person: Hired, tenantId = b.tenantId, entitlements = a.entitlements): Promise<SessionContext> {
  const userId = await createAppUser(tenantId, person.personId, 'manager');
  return { tenantId, userId, personId: person.personId, roles: ['manager'], grants: [{ role: 'manager', companyId: null }], entitlements };
}
async function gradeEveryone(tenantId: string) {
  const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId, code: '12', name: 'Grade 12' }).returning();
  await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.tenantId, tenantId));
}
/** A tenant-wide OneHR cycle, so every unit's people take part. */
async function openCycle(name: string, kind: Policy['kind'] = 'year_end') {
  const { cycleId: id } = await perf.createCycle(a, { name, companyId: null, periodStart: `${year}-01-01`, periodEnd: kind === 'mid_year' ? `${year}-06-30` : `${year}-12-31` });
  const policy = defaultPolicy(framework); policy.kind = kind;
  await perf.configureOnehrCycle(a, id, null, policy);
  await perf.openCycle(a, { cycleId: id });
  return id;
}
async function reviewOf(cycle: string, e: Hired) {
  const [r] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycle), eq(schema.performanceReview.employmentId, e.employmentId)));
  expect(r, 'the opened cycle has a review for the fixture person').toBeDefined();
  return r.id;
}
async function assignHod(subjects: Hired[], hod: Hired) {
  const input = { subjectEmploymentIds: subjects.map((s) => s.employmentId), hodEmploymentId: hod.employmentId };
  const preview = await perf.previewHodChange(a, input);
  return perf.applyHodChange(a, { ...input, fingerprint: preview.fingerprint, acknowledged: true });
}
const seatOn = (seatType: 'bu_ceo' | 'bg_ceo', companyId: string, holder: Hired, ctx = a) => perf.appointLeaderSeat(ctx, { seatType, companyId, holderEmploymentId: holder.employmentId });
type Entry = { reviewId: string; employmentId: string; performance?: string | null; potential?: string | null; performanceLockedAt?: Date | null; lockedAt?: Date | null };
/** One calibration scope as generation writes it, by the HR administrator's own session, with its entries. */
async function scope(cycle: string, values: { tier: 'hod' | 'bu' | 'bg' | 'group' | 'final'; companyId?: string | null; anchorKind?: string; anchorEmploymentId?: string; performanceLockedAt?: Date | null; potentialLockedAt?: Date | null }, entries: Entry[] = []) {
  return withTenant(a, async (tx) => {
    const id = randomUUID();
    await tx.insert(schema.onehrCalibration).values({ id, tenantId: b.tenantId, cycleId: cycle, companyId: b.companyId, name: `${values.tier} scope`, reviewerUserIds: [], ...values });
    for (const e of entries) await tx.insert(schema.onehrCalibrationEntry).values({ tenantId: b.tenantId, sessionId: id, ...e });
    return id;
  });
}
const hodReview = (cycle: string, hod: Hired, locks: { performance?: boolean; potential?: boolean }) =>
  scope(cycle, { tier: 'hod', companyId: holding, anchorKind: 'hod', anchorEmploymentId: hod.employmentId, performanceLockedAt: locks.performance ? new Date() : null, potentialLockedAt: locks.potential ? new Date() : null });
const status = (ctx: SessionContext, cycle?: string) => perf.getLeaderStatus(ctx, cycle);
const raw = (ctx: SessionContext, cycle: string) => withTenant(ctx, async (tx) => (await tx.execute<{ v: unknown }>(sql`select app.onehr_leader_status(${cycle}::uuid) as v`))[0].v);
const waiting = (of: number, inn = 0) => ({ state: 'waiting', lockedOn: null, in: inn, of });
/** The employment's company and its current assignment's department (fixture read-back; one assignment each). */
async function homeOf(e: Hired) {
  const rows = await owner.db.select({ companyId: schema.employment.companyId, departmentId: schema.assignment.departmentId }).from(schema.employment)
    .innerJoin(schema.assignment, eq(schema.assignment.employmentId, schema.employment.id))
    .where(and(eq(schema.employment.id, e.employmentId), isNull(schema.assignment.supersededAt)));
  expect(rows, 'the fixture person has one current assignment').toHaveLength(1);
  expect(rows[0].departmentId, 'the fixture person has a department').toBeTruthy();
  return { companyId: rows[0].companyId, departmentId: rows[0].departmentId! };
}
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, into));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { into.add(k); keysOf(v, into); }
  return into;
}

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'performance', 'active');
  a = await entitledCtx(b);
  ({ id: holding } = await createCompany(a, { legalName: 'Holding Group Bhd' }));
  ({ id: beta } = await createCompany(a, { legalName: 'Beta Sdn Bhd' }));
  ({ id: gamma } = await createCompany(a, { legalName: 'Gamma Sdn Bhd' }));
  ({ id: delta } = await createCompany(a, { legalName: 'Delta Sdn Bhd' }));
  const { id: elsewhere } = await createCompany(a, { legalName: 'Elsewhere Bhd' });
  await owner.db.update(schema.company).set({ parentCompanyId: holding }).where(inArray(schema.company.id, [b.companyId, beta, gamma, delta]));
  const [sales] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: beta, name: 'Sales' }).returning({ id: schema.department.id });
  const [office] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: elsewhere, name: 'Office' }).returning({ id: schema.department.id });
  const where: Record<Name, [string, string]> = {
    hodA: [b.companyId, b.deptA], A1: [b.companyId, b.deptA], A2: [b.companyId, b.deptA], hodA2: [b.companyId, b.deptB], A3: [b.companyId, b.deptB],
    hodB: [beta, sales.id], B1: [beta, sales.id], B2: [beta, sales.id],
    buA: [elsewhere, office.id], buB: [elsewhere, office.id], bgCeo: [elsewhere, office.id], chief: [elsewhere, office.id], outsider: [elsewhere, office.id],
  };
  for (const name of PEOPLE) P[name] = await hire(`Person ${name}`, ...where[name]);
  await gradeEveryone(b.tenantId);
  await assignHod([P.A1, P.A2], P.hodA);
  await assignHod([P.A3], P.hodA2);
  await assignHod([P.B1, P.B2], P.hodB);
  await seatOn('bu_ceo', b.companyId, P.buA);
  await seatOn('bu_ceo', beta, P.buB);
  await seatOn('bg_ceo', holding, P.bgCeo);
  await seatOn('bu_ceo', gamma, P.bgCeo);
  await seatOn('bu_ceo', delta, P.hodA2);
  const groupId = await perf.createCalibrationGroup(a, { name: 'Group calibration' });
  await perf.addCalibrationGroupMembers(a, groupId, { employmentIds: [P.A1.employmentId, P.A2.employmentId] });
  await perf.addCalibrationGroupMembers(a, groupId, { employmentIds: [P.B1.employmentId], segment: 'North' });
  await perf.appointLeaderSeat(a, { seatType: 'group_chief', calibrationGroupId: groupId, holderEmploymentId: P.chief.employmentId });
  for (const name of PEOPLE) U[name] = await login(P[name]);
  cycleId = await openCycle('Annual assessment');
  for (const name of PEOPLE) R[name] = await reviewOf(cycleId, P[name]);
}, 180_000);
afterAll(closeAll);

describe('while the cycle runs', () => {
  it('a BU CEO sees their own unit only: people, departments, each axis and each department review as states and dates', async () => {
    expect(await status(U.buA, cycleId)).toEqual({ seat: 'bu', mode: 'running', cycleId, midYear: false, units: [{
      companyId: b.companyId, label: 'Acme Sdn Bhd', people: 5, departments: 2, state: 'open',
      axes: [{ axis: 'performance', ...waiting(2) }, { axis: 'potential', ...waiting(2) }],
      depts: [{ name: 'Finance', performanceInOn: null, potentialInOn: null }, { name: 'Operations', performanceInOn: null, potentialInOn: null }],
    }] });
    await hodReview(cycleId, P.hodA, { performance: true, potential: true });
    let unit = (await status(U.buA, cycleId)) as Extract<perf.LeaderStatus, { seat: 'bu'; mode: 'running' }>;
    expect(unit.units[0].axes).toEqual([{ axis: 'performance', ...waiting(2, 1) }, { axis: 'potential', ...waiting(2, 1) }]);
    expect(unit.units[0].depts).toEqual([{ name: 'Operations', performanceInOn: null, potentialInOn: null }, { name: 'Finance', performanceInOn: today, potentialInOn: today }]);
    await hodReview(cycleId, P.hodA2, { performance: true });
    unit = (await status(U.buA, cycleId)) as typeof unit;
    expect(unit.units[0].axes).toEqual([{ axis: 'performance', state: 'ready', lockedOn: null, in: 2, of: 2 }, { axis: 'potential', ...waiting(2, 1) }]);
    expect(unit.units[0].depts.map((d) => d.name)).toEqual(['Operations', 'Finance']);
    await scope(cycleId, { tier: 'bu', companyId: b.companyId, performanceLockedAt: new Date() });
    unit = (await status(U.buA, cycleId)) as typeof unit;
    expect(unit.units[0]).toMatchObject({ state: 'part', axes: [{ axis: 'performance', state: 'locked', lockedOn: today, in: 2, of: 2 }, { axis: 'potential', state: 'waiting', in: 1, of: 2 }] });
    // Cross-company: the other unit's CEO sees their own unit, and neither sees the other's labels.
    const other = await status(U.buB, cycleId);
    expect(other).toEqual({ seat: 'bu', mode: 'running', cycleId, midYear: false, units: [{
      companyId: beta, label: 'Beta Sdn Bhd', people: 3, departments: 1, state: 'open',
      axes: [{ axis: 'performance', ...waiting(1) }, { axis: 'potential', ...waiting(1) }], depts: [{ name: 'Sales', performanceInOn: null, potentialInOn: null }],
    }] });
    expect(JSON.stringify(unit)).not.toMatch(/Beta|Sales/);
    expect(JSON.stringify(other)).not.toMatch(/Acme|Finance|Operations/);
  }, 120_000);

  it('a BG CEO sees one row per business unit: calibrating, ready once both BU axes lock, locked once the unit is locked in the Talent Box', async () => {
    expect(await status(U.bgCeo, cycleId)).toEqual({ seat: 'bg', mode: 'running', cycleId, midYear: false, ready: 0, locked: 0, total: 2, rows: [
      { companyId: b.companyId, label: 'Acme Sdn Bhd', people: 5, state: 'calibrating', lockedOn: null, in: 0, of: 2 },
      { companyId: beta, label: 'Beta Sdn Bhd', people: 3, state: 'calibrating', lockedOn: null, in: 0, of: 1 },
    ] });
    await scope(cycleId, { tier: 'bu', companyId: beta, performanceLockedAt: new Date(), potentialLockedAt: new Date() });
    const acme = (['hodA', 'hodA2', 'A1', 'A2', 'A3'] as const).map((n) => ({ reviewId: R[n], employmentId: P[n].employmentId, lockedAt: new Date() }));
    await scope(cycleId, { tier: 'bg', companyId: holding }, acme);
    expect(await status(U.bgCeo, cycleId)).toEqual({ seat: 'bg', mode: 'running', cycleId, midYear: false, ready: 1, locked: 1, total: 2, rows: [
      { companyId: beta, label: 'Beta Sdn Bhd', people: 3, state: 'ready', lockedOn: today, in: 0, of: 1 },
      { companyId: b.companyId, label: 'Acme Sdn Bhd', people: 5, state: 'locked', lockedOn: today, in: 0, of: 2 },
    ] });
  }, 120_000);

  it('a group chief sees one row per batch (the segment, else the department): ready once every rating is confirmed, locked by their calls', async () => {
    expect(await status(U.chief, cycleId)).toEqual({ seat: 'group', mode: 'running', cycleId, midYear: false, ready: 0, locked: 0, total: 2, rows: [
      { label: 'Finance', people: 2, state: 'calibrating', lockedOn: null, in: 0, of: 2 },
      { label: 'North', people: 1, state: 'calibrating', lockedOn: null, in: 0, of: 1 },
    ] });
    await owner.db.update(schema.onehrReview).set({ managerPerformance: 'ME' }).where(eq(schema.onehrReview.reviewId, R.B1));
    await scope(cycleId, { tier: 'group' }, (['A1', 'A2'] as const).map((n) => ({ reviewId: R[n], employmentId: P[n].employmentId, performanceLockedAt: new Date() })));
    expect(await status(U.chief, cycleId)).toEqual({ seat: 'group', mode: 'running', cycleId, midYear: false, ready: 1, locked: 1, total: 2, rows: [
      { label: 'North', people: 1, state: 'ready', lockedOn: null, in: 1, of: 1 },
      { label: 'Finance', people: 2, state: 'locked', lockedOn: today, in: 0, of: 2 },
    ] });
  }, 120_000);

  it('the highest seat wins; an HOD, a non-leader and an administrator get nothing', async () => {
    // BG CEO who also holds a BU seat: the BG card only.
    expect((await status(U.bgCeo, cycleId))?.seat).toBe('bg');
    // HOD who also holds a BU seat: the BU card for their unit (nobody in it), never the department.
    expect(await status(U.hodA2, cycleId)).toEqual({ seat: 'bu', mode: 'running', cycleId, midYear: false, units: [{
      companyId: delta, label: 'Delta Sdn Bhd', people: 0, departments: 0, state: 'open',
      axes: [{ axis: 'performance', state: 'ready', lockedOn: null, in: 0, of: 0 }, { axis: 'potential', state: 'ready', lockedOn: null, in: 0, of: 0 }], depts: [],
    }] });
    for (const ctx of [U.hodA, U.hodB, U.outsider, U.A1, a]) {
      expect(await status(ctx, cycleId)).toBeNull();
      expect(await raw(ctx, cycleId)).toBeNull();
    }
    expect(await status(U.hodA)).toBeNull();
  }, 120_000);

  it('Mid-Year: one department-review count per unit, and the newest running cycle is the default', async () => {
    const mid = await openCycle('Mid-year assessment', 'mid_year');
    expect(await status(U.buA, mid)).toMatchObject({ seat: 'bu', midYear: true, units: [{ people: 5, departments: 2, axes: [{ axis: 'departmentReviews', state: 'waiting', lockedOn: null, in: 0, of: 2 }] }] });
    await hodReview(mid, P.hodA, { performance: true, potential: true });
    await hodReview(mid, P.hodA2, { performance: true, potential: true });
    expect(await status(U.buA, mid)).toMatchObject({ units: [{ axes: [{ axis: 'departmentReviews', state: 'ready', lockedOn: null, in: 2, of: 2 }] }] });
    expect(await status(U.bgCeo, mid)).toMatchObject({ seat: 'bg', midYear: true, ready: 1, locked: 0, rows: [
      { label: 'Acme Sdn Bhd', state: 'ready', lockedOn: null, in: 2, of: 2 }, { label: 'Beta Sdn Bhd', state: 'calibrating', lockedOn: null, in: 0, of: 1 },
    ] });
    // The annual cycle ends later than the Mid-Year one, so it is the default and is untouched by the Mid-Year reviews.
    expect(await status(U.buA)).toMatchObject({ cycleId, midYear: false, units: [{ axes: [{ axis: 'performance', in: 0, of: 2 }, { axis: 'potential', in: 0, of: 2 }] }] });
  }, 120_000);

  it('an ended seat shows nothing at once; the successor sees the unit with no rewrite, never counting themself', async () => {
    const seat = (await perf.listLeaderSeats(a, { seatType: 'bu_ceo', liveOnly: true })).find((s) => s.companyId === b.companyId)!;
    await perf.endLeaderSeat(a, seat.id, { validTo: today });
    expect(await status(U.buA, cycleId)).toBeNull();
    await seatOn('bu_ceo', b.companyId, P.A3);
    expect(await status(await login(P.A3), cycleId)).toMatchObject({ seat: 'bu', units: [{ companyId: b.companyId, people: 4, departments: 1, depts: [{ name: 'Finance' }] }] });
    // A3 is not counted, so neither is the department review over A3 alone.
  }, 120_000);

  it('cross-tenant: a cycle of another tenant reads as nothing both ways; the other tenant counts its own people only', async () => {
    const b2 = await seedBase(); await setModule(b2.tenantId, 'performance', 'active');
    const a2 = await entitledCtx(b2);
    const holder = await hire('Foreign holder', b2.companyId, b2.deptA, a2);
    await hire('Foreign person', b2.companyId, b2.deptA, a2);
    await gradeEveryone(b2.tenantId);
    const { cycleId: foreign } = await perf.createCycle(a2, { name: 'Foreign annual', companyId: b2.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` });
    await perf.configureOnehrCycle(a2, foreign, null, defaultPolicy(framework)); await perf.openCycle(a2, { cycleId: foreign });
    await seatOn('bu_ceo', b2.companyId, holder, a2);
    const foreignCeo = await login(holder, b2.tenantId, a2.entitlements);
    expect(await status(foreignCeo, foreign)).toMatchObject({ seat: 'bu', units: [{ companyId: b2.companyId, people: 1, departments: 0 }] });
    expect(await status(foreignCeo, cycleId)).toBeNull();
    expect(await raw(foreignCeo, cycleId)).toBeNull();
    expect(await status(U.buA, foreign)).toBeNull();
    expect(await raw(U.bgCeo, foreign)).toBeNull();
  }, 120_000);
});

describe('W3-F6: leader-off while a unit is out of the cycle (D-P1-22 E7)', () => {
  it('a seat holder whose unit is out gets no card while the cycle runs; a leader who takes part keeps theirs; Bring back restores it', async () => {
    const seats = [U.buA, U.buB, U.bgCeo, U.chief];
    const before = await Promise.all(seats.map((ctx) => status(ctx, cycleId)));
    expect(before.map((x) => x?.seat), 'non-vacuous: every seat has a card before the rule').toEqual(['bu', 'bu', 'bg', 'group']);
    const delta0 = await status(U.hodA2, cycleId);
    const office = await homeOf(P.buA);
    expect(await homeOf(P.chief), 'the seat holders share one department').toEqual(office);
    const { saved } = await exclude(a, cycleId, office.companyId, office.departmentId);
    for (const ctx of seats) {
      expect(await status(ctx, cycleId)).toBeNull();
      expect(await raw(ctx, cycleId)).toBeNull();
    }
    expect(await status(U.hodA2, cycleId), 'the HOD with a BU seat takes part').toEqual(delta0);
    await bringBack(a, cycleId, saved.ruleId);
    expect(await Promise.all(seats.map((ctx) => status(ctx, cycleId)))).toEqual(before);
  }, 120_000);

  it('per acting employment (D9): a seat held through the employment that takes part keeps its card; held through the left-out one, none', async () => {
    const out = (await createDepartment(a, { companyId: b.companyId, name: 'Left out' })).id;
    // The Beta CEO's person also holds a second live employment, in a left-out department of Acme.
    const second = await hireEmployee(a, { person: { id: P.buB.personId }, companyId: b.companyId, departmentId: out, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    const beta0 = await status(U.buB, cycleId);
    expect(beta0, 'non-vacuous: the Beta card before the rule').toMatchObject({ seat: 'bu', units: [{ companyId: beta, people: 3 }] });
    const { saved } = await exclude(a, cycleId, b.companyId, out);
    expect(await status(U.buB, cycleId), 'the seat is held through the employment that takes part').toEqual(beta0);
    await seatOn('bu_ceo', beta, second);
    expect(await status(U.buB, cycleId)).toBeNull();
    expect(await raw(U.buB, cycleId)).toBeNull();
    await bringBack(a, cycleId, saved.ruleId);
    expect(await status(U.buB, cycleId)).toEqual(beta0);
  }, 120_000);

  it('E1: a person whose unit is out leaves every running count unless their result is frozen; Bring back returns them', async () => {
    // A2's result is frozen first, as the release tests freeze one: the line manager's band, the rating record and
    // locked HOD, BU and BG decisions written by the HR administrator, then the freeze service.
    await owner.db.update(schema.onehrReview).set({ managerPerformance: 'ME' }).where(eq(schema.onehrReview.reviewId, R.A2));
    await owner.db.insert(schema.assessmentRatingRecord).values({ reviewId: R.A2, tenantId: b.tenantId, lastEvent: 'admin_capture', recordedBy: b.adminUserId,
      snapshot: { selfBand: 'BE', managerBand: 'ME', valid: true, computedPotential: 'Mid', competencyStatus: null, potential360Pct: 50, competencySelf: null, competencyMax: null, configuration: { weight360: 4000, lowMaxPct: 40, midMaxPct: 74.29 } } });
    for (const tier of ['hod', 'bu', 'bg'] as const) await scope(cycleId, { tier, performanceLockedAt: new Date(), potentialLockedAt: new Date() }, [{ reviewId: R.A2, employmentId: P.A2.employmentId, performance: 'AE', potential: 'Mid' }]);
    await perf.freezeOnehrReview(a, R.A2, (await perf.getOnehrReview(a, R.A2))!.revision);
    expect(await owner.db.select({ id: schema.onehrResult.id }).from(schema.onehrResult).where(eq(schema.onehrResult.reviewId, R.A2)), 'A2 is frozen').toHaveLength(1);
    const counts = async () => {
      const bu = (await status(U.buA, cycleId)) as unknown as { units: { companyId: string; people: number }[] };
      const bg = (await status(U.bgCeo, cycleId)) as unknown as { rows: { companyId: string; people: number }[] };
      const chief = (await status(U.chief, cycleId)) as unknown as { rows: { people: number }[] };
      return { bu: bu.units.find((u) => u.companyId === b.companyId)!.people, bg: bg.rows.find((r) => r.companyId === b.companyId)!.people, chief: chief.rows.reduce((n, r) => n + r.people, 0) };
    };
    expect(await counts(), 'non-vacuous: Acme has five people, the group three').toEqual({ bu: 5, bg: 5, chief: 3 });
    const out = (await createDepartment(a, { companyId: b.companyId, name: 'Left out' })).id;
    for (const p of [P.A1, P.A2]) await moveTo(p, out);
    const { saved } = await exclude(a, cycleId, b.companyId, out);
    expect(await counts(), 'A1 leaves (E1); A2 stays with a frozen result (D7)').toEqual({ bu: 4, bg: 4, chief: 2 });
    await bringBack(a, cycleId, saved.ruleId);
    expect(await counts()).toEqual({ bu: 5, bg: 5, chief: 3 });
  }, 180_000);
});

describe('between cycles', () => {
  /**
   * Final bands: A1 ME/Mid (Solid Core), A2 OU/High (Super Star), A3 AE/Low (Solid Core), B1 ME/Mid, B2 BE/Mid.
   * Released to leaders: A1's performance and talent status. A2's performance was released, then revoked.
   */
  async function closedWithReleases(afterFinals?: () => Promise<void>) {
    const finals: Record<string, [string, string]> = { A1: ['ME', 'Mid'], A2: ['OU', 'High'], A3: ['AE', 'Low'], B1: ['ME', 'Mid'], B2: ['BE', 'Mid'] };
    await scope(cycleId, { tier: 'final', companyId: holding }, (['A1', 'A2', 'A3', 'B1', 'B2'] as const).map((n) => ({ reviewId: R[n], employmentId: P[n].employmentId, performance: finals[n][0], potential: finals[n][1] })));
    // A calibration entry needs a participating review, so a unit rule is saved after the final decisions.
    if (afterFinals) await afterFinals();
    const release = (reviewIds: string[], result: 'performance' | 'talent', action: 'release' | 'revoke') => perf.releaseOnehrResults(a, { cycleId, reviewIds, result, step: 'leaders', action });
    await release([R.A1, R.A2], 'performance', 'release');
    await release([R.A2], 'performance', 'revoke');
    await release([R.A1], 'talent', 'release');
    await owner.db.update(schema.reviewCycle).set({ status: 'closed' }).where(eq(schema.reviewCycle.id, cycleId));
  }
  const pm = (UA: number, BE: number, ME: number, AE: number, OU: number) => Object.entries({ UA, BE, ME, AE, OU }).map(([band, n]) => ({ band, n }));
  const pot = (Low: number, Mid: number, High: number) => Object.entries({ Low, Mid, High }).map(([band, n]) => ({ band, n }));

  it('counts only people released to the BU CEO or HOD, with band counts over them alone; a revoke moves a person back', async () => {
    await closedWithReleases();
    expect(await status(U.buA, cycleId)).toEqual({ seat: 'bu', mode: 'record', cycleId, midYear: false, gated: true, people: 5,
      performance: { released: 1, waiting: 2, bands: pm(0, 0, 1, 0, 0) },
      potential: { released: 0, waiting: 3, bands: pot(0, 0, 0) },
      talent: { released: 1, waiting: 2, bands: [{ band: 'Solid Core', n: 1 }] },
      departmentReviews: { in: 0, of: 2 } });
    expect(await status(U.hodA, cycleId)).toEqual({ seat: 'hod', mode: 'record', cycleId, midYear: false, gated: true, people: 2,
      performance: { released: 1, waiting: 1, bands: pm(0, 0, 1, 0, 0) },
      potential: { released: 0, waiting: 2, bands: null }, talent: { released: 1, waiting: 1, bands: null }, departmentReviews: null });
    expect(await status(U.outsider, cycleId)).toBeNull();
    expect(await status(U.A1, cycleId)).toBeNull();
  }, 120_000);

  it('W3-F6: an HOD whose unit was out on the close day gets no tally (the pin, D8); the BU CEO above still gets theirs', async () => {
    const out = (await createDepartment(a, { companyId: b.companyId, name: 'Left out' })).id;
    await moveTo(P.hodA, out);
    await exclude(a, cycleId, b.companyId, out);
    // The close transaction pins the rule's employments; this fixture closes the cycle directly, so it pins first.
    await withTenant(a, (tx) => tx.execute(sql`select app.assessment_unit_exclusion_pin(${cycleId}::uuid)`));
    const pinned = await owner.db.select({ employmentId: schema.assessmentUnitExclusionPin.employmentId }).from(schema.assessmentUnitExclusionPin).where(eq(schema.assessmentUnitExclusionPin.cycleId, cycleId));
    expect(pinned.map((r) => r.employmentId), 'the HOD alone is out; the people they head take part').toEqual([P.hodA.employmentId]);
    await closedWithReleases();
    expect(await status(U.hodA, cycleId)).toBeNull();
    expect(await raw(U.hodA, cycleId)).toBeNull();
    expect(await status(U.buA, cycleId)).toMatchObject({ seat: 'bu', mode: 'record', performance: { released: 1 } });
  }, 120_000);

  it('E1: a person whose unit was out on the close day is in no tally and no band count (the pin, D8)', async () => {
    await closedWithReleases(async () => {
      const out = (await createDepartment(a, { companyId: b.companyId, name: 'Left out' })).id;
      await moveTo(P.A1, out);
      await exclude(a, cycleId, b.companyId, out);
      await withTenant(a, (tx) => tx.execute(sql`select app.assessment_unit_exclusion_pin(${cycleId}::uuid)`));
    });
    // As the first tally test, without A1 (ME/Mid, Solid Core, the only person released to leaders): A1 has no card,
    // so the releases in closedWithReleases skip A1 too.
    expect(await status(U.buA, cycleId)).toEqual({ seat: 'bu', mode: 'record', cycleId, midYear: false, gated: true, people: 4,
      performance: { released: 0, waiting: 2, bands: pm(0, 0, 0, 0, 0) },
      potential: { released: 0, waiting: 2, bands: pot(0, 0, 0) },
      talent: { released: 0, waiting: 2, bands: [] },
      departmentReviews: { in: 0, of: 2 } });
    expect(await status(U.hodA, cycleId)).toEqual({ seat: 'hod', mode: 'record', cycleId, midYear: false, gated: true, people: 1,
      performance: { released: 0, waiting: 1, bands: pm(0, 0, 0, 0, 0) },
      potential: { released: 0, waiting: 1, bands: null }, talent: { released: 0, waiting: 1, bands: null }, departmentReviews: null });
  }, 120_000);

  it('a person not yet released to the viewer is absent from every band count, though their band exists', async () => {
    await closedWithReleases();
    // A2 (OU, High, Super Star) is not released to leaders on any component.
    for (const ctx of [U.buA, U.hodA]) {
      const s = (await status(ctx, cycleId)) as Tally;
      expect(s.performance.bands!.find((x) => x.band === 'OU')).toEqual({ band: 'OU', n: 0 });
      expect(s.performance.bands!.reduce((sum, x) => sum + x.n, 0)).toBe(s.performance.released);
      expect((s.potential.bands ?? []).find((x) => x.band === 'High')?.n ?? 0).toBe(0);
      expect((s.talent.bands ?? []).map((x) => x.band)).not.toContain('Super Star');
    }
    // Non-vacuity on the one ungated path the source has: a BG CEO who takes the unit's BU CEO seat reads their own
    // business group at once (dash_led passes no viewer), so the same person's bands are counted.
    const acmeSeat = (await perf.listLeaderSeats(a, { seatType: 'bu_ceo', liveOnly: true })).find((x) => x.companyId === b.companyId)!;
    await perf.endLeaderSeat(a, acmeSeat.id, { validTo: today });
    await seatOn('bu_ceo', b.companyId, P.bgCeo);
    expect(await status(U.bgCeo, cycleId)).toEqual({ seat: 'bu', mode: 'record', cycleId, midYear: false, gated: false, people: 5,
      performance: { released: 3, waiting: 0, bands: pm(0, 0, 1, 1, 1) },
      potential: { released: 3, waiting: 0, bands: pot(1, 1, 1) },
      talent: { released: 3, waiting: 0, bands: [{ band: 'Super Star', n: 1 }, { band: 'Solid Core', n: 2 }] },
      departmentReviews: { in: 0, of: 2 } });
  }, 120_000);

  it('a BG CEO gets a tally only with a BU CEO or HOD seat, and then that seat\'s tally; a BG CEO alone gets none', async () => {
    await closedWithReleases();
    // The fixture's BG CEO also holds Gamma's BU seat (nobody in it): the BU CEO's tally for Gamma, not the group's.
    expect(await status(U.bgCeo, cycleId)).toEqual({ seat: 'bu', mode: 'record', cycleId, midYear: false, gated: false, people: 0,
      performance: { released: 0, waiting: 0, bands: pm(0, 0, 0, 0, 0) }, potential: { released: 0, waiting: 0, bands: pot(0, 0, 0) },
      talent: { released: 0, waiting: 0, bands: [] }, departmentReviews: { in: 0, of: 0 } });
    const gammaSeat = (await perf.listLeaderSeats(a, { seatType: 'bu_ceo', liveOnly: true })).find((x) => x.companyId === gamma)!;
    await perf.endLeaderSeat(a, gammaSeat.id, { validTo: today });
    expect(await status(U.bgCeo, cycleId)).toEqual({ seat: 'bg', mode: 'record', cycleId, midYear: false, gated: false, people: 8 });
    expect(await raw(U.bgCeo, cycleId)).toEqual({ seat: 'bg', mode: 'record', cycleId, midYear: false, gated: false, people: 8 });
  }, 120_000);

  it('a group chief gets no tally between cycles, as in the source: only how many people they led', async () => {
    await closedWithReleases();
    expect(await status(U.chief, cycleId)).toEqual({ seat: 'group', mode: 'record', cycleId, midYear: false, gated: false, people: 3 });
    expect(await raw(U.chief, cycleId)).toEqual({ seat: 'group', mode: 'record', cycleId, midYear: false, gated: false, people: 3 });
  }, 120_000);
});

describe('what the projection carries', () => {
  it('only the documented keys, band codes only as aggregate counts, never a per-person band, a name or a person id, in every seat and mode', async () => {
    await owner.db.update(schema.onehrReview).set({ managerPerformance: 'OU' }).where(inArray(schema.onehrReview.reviewId, Object.values(R)));
    await hodReview(cycleId, P.hodA, { performance: true, potential: true });
    await scope(cycleId, { tier: 'group' }, [{ reviewId: R.A1, employmentId: P.A1.employmentId, performance: 'OU', performanceLockedAt: new Date() }]);
    await scope(cycleId, { tier: 'final', companyId: holding }, (['A1', 'A2', 'A3', 'B1', 'B2', 'hodA', 'hodB'] as const).map((n) => ({ reviewId: R[n], employmentId: P[n].employmentId, performance: 'OU', potential: 'High' })));
    await perf.releaseOnehrResults(a, { cycleId, reviewIds: [R.A1, R.B1], result: 'three', step: 'leaders', action: 'release' });
    const running = await Promise.all([U.buA, U.buB, U.bgCeo, U.chief, U.hodA2].map((ctx) => status(ctx, cycleId)));
    await owner.db.update(schema.reviewCycle).set({ status: 'closed' }).where(eq(schema.reviewCycle.id, cycleId));
    const record = await Promise.all([U.buA, U.hodA, U.bgCeo, U.chief].map((ctx) => status(ctx, cycleId)));
    const all = [...running, ...record];
    expect(all.every((s) => s !== null)).toBe(true);
    expect(all.map((s) => `${s!.seat}:${s!.mode}`)).toEqual(['bu:running', 'bu:running', 'bg:running', 'group:running', 'bu:running', 'bu:record', 'hod:record', 'bu:record', 'group:record']);
    // Band codes appear only as aggregate {band, n} entries inside a tally's bands; nowhere else.
    const entries: unknown[] = [];
    const stripped = withoutBands(all, entries);
    expect([...keysOf(stripped)].filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
    expect(JSON.stringify(stripped)).not.toMatch(BAND);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(Object.keys(e as object).sort()).toEqual(BAND_ENTRY_KEYS);
      expect((e as { band: string }).band).toMatch(/^(UA|BE|ME|AE|OU|Low|Mid|High|Super Star|Star|Solid Core|PIP\/Improvement)$/);
      expect(Number.isInteger((e as { n: number }).n)).toBe(true);
    }
    // Only the record seats carry bands; the running cards carry none.
    expect(JSON.stringify(withoutBands(running))).toBe(JSON.stringify(running));
    const text = JSON.stringify(all);
    for (const name of PEOPLE) {
      expect(text).not.toContain(`Person ${name}`);
      expect(text).not.toContain(P[name].employmentId);
      expect(text).not.toContain(P[name].personId);
      expect(text).not.toContain(R[name]);
    }
    // The database payload itself, not only the parsed one, has the same key set.
    expect([...keysOf(withoutBands(await raw(U.buA, cycleId)))].filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
  }, 120_000);

  it('is granted to the app role only, as a definer with a pinned search path; its helpers are not callable', async () => {
    const rows = await owner.client`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('ai_hr_app', p.oid, 'EXECUTE') as app, exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as pub
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'onehr_leader_status%' order by p.proname`;
    expect(rows.map((r) => [r.proname, r.prosecdef, r.app, r.pub])).toEqual([
      ['onehr_leader_status', true, true, false],
      ['onehr_leader_status_department', true, false, false],
      ['onehr_leader_status_depts', true, false, false],
      ['onehr_leader_status_people', true, false, false],
    ]);
    expect(rows.every((r) => (r.proconfig as string[]).includes('search_path=public, pg_temp'))).toBe(true);
  });
});
