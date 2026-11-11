/**
 * AI-native batch (11 November 2026) — the grouped Exceptions reader (app/control-tower/exceptions/data.ts) and its bulk
 * "Mark as expected" (app/control-tower/exceptions/bulk.ts) on a real database, at the shape of a real group
 * (docs/SCALE-AND-RELEASE-RULES.md rule 3): 72 companies and 1,080 employments, read under "All companies" and under
 * one company.
 *
 * What it pins:
 *  - EQUIVALENCE with the previous reader (`openExceptionsAcrossRuns`, which Today still uses): the same totals, the same
 *    exceptions (every group's pages together list exactly the old reader's rows, in its order within each group) and
 *    the same bucket split, for each role;
 *  - the group counts are over EVERY open exception, far beyond the old 100-row page, and match an independently
 *    written expectation from the fixture itself, including the bank-reason and pay-item sub-groups;
 *  - a non-administrator is refused before anything is read;
 *  - bulk "Mark as expected" closes only the non-blocking, single-check exceptions that were requested, each through
 *    the anomaly owner's resolve (audited), refuses a blocking group outright and never closes a smuggled blocking one.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { openExceptionsAcrossRuns } from '../core/payroll-anomaly';
import { GROUP_PAGE_SIZE, ExceptionsReadRefused, groupedExceptions, type ExceptionItem } from '../app/control-tower/exceptions/data';
import { markGroupExpected } from '../app/control-tower/exceptions/bulk';
import { BulkExpectRefused, bucketCounts, groupKey, parseGroupKey, type GroupIdentity } from '../lib/payroll-exceptions';
import { closeAll, entitledCtx, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const COMPANIES = 72;
const PER_COMPANY = 15; // 1,080 employments
const OCT = '2026-10', SEP = '2026-09';

type F = { checkId: string; severity: 'block' | 'review'; variant: string | null; facts: Record<string, string | number> };
/** The fixture's patterns, by employment index. `variant` is written out here, not derived. */
function patternOf(i: number): { disposition: 'block' | 'review' | 'auto_clear'; findings: F[]; excluded?: 'resolved' | 'superseded' } {
  const tax: F = { checkId: 'missing-tax-profile', severity: 'review', variant: null, facts: { pcb: 0 } };
  const attendance: F = { checkId: 'pay-without-attendance', severity: 'review', variant: null, facts: { netPay: 2500, attendanceDays: 0, approvedLeaveDays: 0 } };
  switch (i % 12) {
    case 0: return { disposition: 'block', findings: [{ checkId: 'negative-net', severity: 'block', variant: null, facts: { netPay: -300, grossPay: 100, totalDeductions: 400 } }] };
    case 1: return { disposition: 'block', findings: [{ checkId: 'missing-bank-profile', severity: 'block', variant: 'payment-method-not-set', facts: { netPay: 900, paymentMethod: 'unset', reason: 'payment-method-not-set' } }] };
    case 2: return { disposition: 'block', findings: [{ checkId: 'missing-bank-profile', severity: 'block', variant: 'bank-details-missing', facts: { netPay: 900, paymentMethod: 'bank_transfer', reason: 'bank-details-missing' } }] };
    case 3: return { disposition: 'block', findings: [{ checkId: 'missing-bank-profile', severity: 'block', variant: null, facts: { netPay: 900, paymentMethod: 'unset' } }] };
    case 4: return { disposition: 'review', findings: [tax] };
    case 5: return { disposition: 'review', findings: [attendance] };
    case 6: return { disposition: 'review', findings: [attendance, tax] };
    case 7: return { disposition: 'review', findings: [{ checkId: 'component-appeared', severity: 'review', variant: 'hrdf', facts: { component: 'hrdf', amount: 12 } }] };
    case 8: return { disposition: 'review', findings: [{ checkId: 'component-appeared', severity: 'review', variant: 'other', facts: { component: 'mysteryItem', amount: 3 } }] };
    case 9: return { disposition: 'review', findings: [{ checkId: 'net-swing', severity: 'review', variant: null, facts: { netPay: 2000, priorNetPay: 1000, movementPct: 100, thresholdPct: 30 } }] };
    case 10: return { disposition: 'auto_clear', findings: [] };
    default: return { disposition: 'review', findings: [attendance], excluded: i % 24 === 11 ? 'resolved' : 'superseded' };
  }
}

type Spec = { verdictId: string; employmentId: string; companyId: string; batchId: string; disposition: string; findings: F[]; open: boolean };
let b: Base;
let all: SessionContext;
let one: SessionContext;
let companyIds: string[] = [];
let specs: Spec[] = [];

async function chunked<T>(rows: T[], insert: (part: T[]) => Promise<unknown>) {
  for (let at = 0; at < rows.length; at += 400) await insert(rows.slice(at, at + 400));
}

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  all = await entitledCtx(b);
  one = { ...all, grants: [{ role: 'hr_admin', companyId: b.companyId }] };
  const extra = await owner.db.insert(schema.company)
    .values(Array.from({ length: COMPANIES - 1 }, (_, i) => ({ tenantId: b.tenantId, legalName: `Fictional ${String(i + 1).padStart(2, '0')} Sdn Bhd` })))
    .returning({ id: schema.company.id });
  companyIds = [b.companyId, ...extra.map(c => c.id)];
  const periods = await owner.db.insert(schema.payPeriod)
    .values([...companyIds.map(companyId => ({ tenantId: b.tenantId, companyId, period: OCT, status: 'open' as const })),
      ...companyIds.slice(0, 7).map(companyId => ({ tenantId: b.tenantId, companyId, period: SEP, status: 'open' as const }))])
    .returning({ id: schema.payPeriod.id, companyId: schema.payPeriod.companyId, period: schema.payPeriod.period });
  const batches = await owner.db.insert(schema.payrollBatch)
    .values(periods.map(p => ({ tenantId: b.tenantId, companyId: p.companyId, payPeriodId: p.id, payPeriod: p.period, batchDate: `${p.period}-28`, status: 'processed' as const })))
    .returning({ id: schema.payrollBatch.id, companyId: schema.payrollBatch.companyId, payPeriod: schema.payrollBatch.payPeriod });
  const batchOf = new Map(batches.map(x => [`${x.companyId}|${x.payPeriod}`, x.id]));
  const total = COMPANIES * PER_COMPANY;
  const people: { id: string }[] = [];
  await chunked(Array.from({ length: total }, (_, i) => ({ tenantId: b.tenantId, fullName: `Person ${i}`, primaryEmail: `p${i}_${randomUUID()}@fictional.test` })),
    async part => people.push(...await owner.db.insert(schema.person).values(part).returning({ id: schema.person.id })));
  const employments: { id: string; companyId: string }[] = [];
  await chunked(people.map((p, i) => ({ tenantId: b.tenantId, personId: p.id, companyId: companyIds[Math.floor(i / PER_COMPANY)], hiredOn: '2020-01-01' })),
    async part => employments.push(...await owner.db.insert(schema.employment).values(part).returning({ id: schema.employment.id, companyId: schema.employment.companyId })));
  // One October verdict per employment, plus a September one for the first 100 (the same people in a second run; half of
  // them also flagged for a missing tax profile, so a set-up page mixes single-check and mixed exceptions).
  const base = Date.parse('2026-10-28T00:00:00Z');
  const rows: (Spec & { computedAt: Date; excluded?: string })[] = [];
  employments.forEach((e, i) => {
    const p = patternOf(i);
    rows.push({ verdictId: randomUUID(), employmentId: e.id, companyId: e.companyId, batchId: batchOf.get(`${e.companyId}|${OCT}`)!, disposition: p.disposition,
      findings: p.findings, open: p.disposition !== 'auto_clear' && !p.excluded, excluded: p.excluded, computedAt: new Date(base + i * 1000) });
    if (i < 100) rows.push({ verdictId: randomUUID(), employmentId: e.id, companyId: e.companyId, batchId: batchOf.get(`${e.companyId}|${SEP}`)!, disposition: 'review',
      findings: patternOf(i % 2 === 0 ? 5 : 6).findings, open: true, computedAt: new Date(base - 86_400_000 + i * 1000) });
  });
  await chunked(rows, part => owner.db.insert(schema.payrollAnomalyVerdict).values(part.map(r => ({ id: r.verdictId, tenantId: b.tenantId, batchId: r.batchId,
    employmentId: r.employmentId, disposition: r.disposition, detectorsRun: ['negative-net'], detectorsSkipped: [], computedAt: r.computedAt,
    ...(r.excluded === 'resolved' ? { resolvedAt: new Date(), resolution: 'accepted' } : {}), ...(r.excluded === 'superseded' ? { supersededAt: new Date() } : {}) }))));
  await chunked(rows.flatMap(r => r.findings.map(f => ({ tenantId: b.tenantId, verdictId: r.verdictId, detectorId: f.checkId, severity: f.severity, facts: f.facts,
    suggestedAction: 'anomaly.action.fixture' }))), part => owner.db.insert(schema.payrollAnomalyFinding).values(part));
  specs = rows;
}, 180_000); // Unmeasured fixture of ~3,500 rows; generous headroom until a gate duration is recorded.
afterAll(closeAll);

/** Every row of one group, page by page, as the page would list them. */
async function allPages(ctx: SessionContext, focus: GroupIdentity): Promise<ExceptionItem[]> {
  const out: ExceptionItem[] = [];
  for (let page = 1; page < 200; page++) {
    const view = await groupedExceptions(ctx, { focus, page });
    const items = view.items.get(groupKey(focus)) ?? [];
    out.push(...items);
    if (items.length < GROUP_PAGE_SIZE) break;
  }
  return out;
}

/** The expected groups, written from the fixture spec (not from the reader under test). */
function expectedGroups(scope: string[] | null) {
  const out = new Map<string, { verdicts: Set<string>; people: Set<string>; companies: Set<string>; runs: Set<string> }>();
  for (const s of specs) {
    if (!s.open || (scope && !scope.includes(s.companyId))) continue;
    for (const f of s.findings) {
      const key = groupKey(f);
      const g = out.get(key) ?? { verdicts: new Set(), people: new Set(), companies: new Set(), runs: new Set() };
      g.verdicts.add(s.verdictId); g.people.add(s.employmentId); g.companies.add(s.companyId); g.runs.add(s.batchId);
      out.set(key, g);
    }
  }
  return new Map([...out].map(([k, g]) => [k, { exceptions: g.verdicts.size, people: g.people.size, companies: g.companies.size, runs: g.runs.size }]));
}

describe.each([['All companies', () => all, null], ['one company', () => one, () => [b.companyId]]] as const)('%s', (_label, ctxOf, scopeOf) => {
  it('counts every open exception, by group, exactly as the fixture says, and the same totals as the previous reader', async () => {
    const ctx = ctxOf();
    const scope = scopeOf ? scopeOf() : null;
    const view = await groupedExceptions(ctx);
    const old = await openExceptionsAcrossRuns(ctx, { limit: 100_000 });
    const openSpecs = specs.filter(s => s.open && (!scope || scope.includes(s.companyId)));
    expect(view.total).toBe(openSpecs.length);
    expect(view.total).toBe(old.total);
    expect(view.blocking).toBe(old.blocking);
    expect(view.blocking).toBe(openSpecs.filter(s => s.disposition === 'block').length);
    if (!scope) expect(view.total, 'far beyond the old 100-row page').toBeGreaterThan(900);
    // Groups, against the independent expectation (including the bank-reason and pay-item sub-groups).
    const expected = expectedGroups(scope);
    expect(new Map(view.groups.map(g => [g.key, { exceptions: g.exceptions, people: g.people, companies: g.companies, runs: g.runs }]))).toEqual(expected);
    if (!scope) {
      expect([...expected.keys()].sort()).toEqual(['component-appeared.review.hrdf', 'component-appeared.review.other', 'missing-bank-profile.block.-',
        'missing-bank-profile.block.bank-details-missing', 'missing-bank-profile.block.payment-method-not-set', 'missing-tax-profile.review.-',
        'negative-net.block.-', 'net-swing.review.-', 'pay-without-attendance.review.-']);
      // 72 companies; the set-up group names three and counts the rest.
      const attendance = view.groups.find(g => g.key === 'pay-without-attendance.review.-')!;
      expect(attendance.companies).toBe(COMPANIES);
      expect(attendance.companyNames).toEqual(['Acme Sdn Bhd', 'Fictional 01 Sdn Bhd', 'Fictional 02 Sdn Bhd']);
    }
    // The bucket split agrees with the previous reader's own rows.
    const signatures = new Map<string, { disposition: string; signature: string[]; count: number }>();
    for (const row of old.rows) {
      const signature = [...new Set(row.findings.map(f => `${f.detectorId}:${f.severity}`))].sort();
      const key = `${row.disposition}|${signature.join(',')}`;
      signatures.set(key, { disposition: row.disposition, signature, count: (signatures.get(key)?.count ?? 0) + 1 });
    }
    expect(view.buckets).toEqual(bucketCounts([...signatures.values()]));
    expect(view.bucketsPartial).toBe(false);
    // Months with an open block, for the acknowledged list.
    expect(view.blockPeriods).toEqual([OCT]);
  }, 120_000);

  it('lists exactly the previous reader\'s exceptions, page by page, in its order within each group', async () => {
    const ctx = ctxOf();
    const view = await groupedExceptions(ctx);
    const old = await openExceptionsAcrossRuns(ctx, { limit: 100_000 });
    const listed = new Set<string>();
    for (const group of view.groups) {
      const rows = await allPages(ctx, parseGroupKey(group.key)!);
      expect(rows.length, group.key).toBe(group.exceptions);
      const expectedOrder = old.rows.filter(r => r.findings.some(f => groupKey({ checkId: f.detectorId, severity: f.severity,
        variant: specs.find(s => s.verdictId === r.verdictId)!.findings.find(x => x.checkId === f.detectorId)!.variant }) === group.key)).map(r => r.verdictId);
      expect(rows.map(r => r.verdictId), group.key).toEqual(expectedOrder);
      for (const r of rows) listed.add(r.verdictId);
    }
    expect([...listed].sort()).toEqual(old.rows.map(r => r.verdictId).sort());
    // The overview's previews are the first rows of each group, bounded.
    for (const group of view.groups) expect((view.items.get(group.key) ?? []).length, group.key).toBe(Math.min(3, group.exceptions));
  }, 120_000);
});

describe('who may read it', () => {
  it('refuses a non-administrator before opening a transaction', async () => {
    for (const roles of [['employee'], ['manager'], ['payroll_partner']]) {
      await expect(groupedExceptions({ ...all, roles, grants: roles.map(role => ({ role, companyId: b.companyId })) })).rejects.toBeInstanceOf(ExceptionsReadRefused);
    }
    await expect(groupedExceptions({ ...all, userId: undefined })).rejects.toBeInstanceOf(ExceptionsReadRefused);
  });
});

describe('bulk "Mark as expected"', () => {
  const ATTENDANCE = { checkId: 'pay-without-attendance', severity: 'review', variant: null };
  const state = async (ids: string[]) => owner.db.select({ id: schema.payrollAnomalyVerdict.id, resolution: schema.payrollAnomalyVerdict.resolution,
    resolvedBy: schema.payrollAnomalyVerdict.resolvedByUserId }).from(schema.payrollAnomalyVerdict).where(inArray(schema.payrollAnomalyVerdict.id, ids));

  it('refuses a blocking group outright and closes nothing', async () => {
    const blocked = specs.filter(s => s.open && s.disposition === 'block').slice(0, 3).map(s => s.verdictId);
    for (const group of ['negative-net.block.-', 'missing-bank-profile.block.payment-method-not-set', 'pay-without-attendance.block.-', 'net-swing.review.-']) {
      await expect(markGroupExpected(all, { group, verdictIds: blocked, note: 'Fixture' })).rejects.toMatchObject({ reason: 'blocking' });
    }
    expect((await state(blocked)).every(r => r.resolution === null)).toBe(true);
    await expect(markGroupExpected({ ...all, roles: ['employee'], grants: [{ role: 'employee', companyId: b.companyId }] },
      { group: 'pay-without-attendance.review.-', verdictIds: blocked, note: 'Fixture' })).rejects.toBeInstanceOf(BulkExpectRefused);
    await expect(markGroupExpected(all, { group: 'pay-without-attendance.review.-', verdictIds: blocked, note: '  ' })).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('closes the requested single-check exceptions through the owner\'s resolve, and skips mixed and smuggled blocking ones', async () => {
    const page = await groupedExceptions(all, { focus: ATTENDANCE, page: 1 });
    const items = page.items.get(groupKey(ATTENDANCE))!;
    expect(items).toHaveLength(GROUP_PAGE_SIZE);
    const single = items.filter(i => i.signature.length === 1).map(i => i.verdictId);
    const mixed = items.filter(i => i.signature.length > 1).map(i => i.verdictId);
    expect(single.length).toBeGreaterThan(0);
    expect(mixed.length).toBeGreaterThan(0);
    const smuggled = specs.find(s => s.open && s.disposition === 'block')!.verdictId;
    const result = await markGroupExpected(all, { group: groupKey(ATTENDANCE), verdictIds: [...items.map(i => i.verdictId).slice(0, 24), smuggled], note: 'These companies do not use clock-in' });
    const requested = items.slice(0, 24);
    const closable = requested.filter(i => i.signature.length === 1).map(i => i.verdictId);
    expect(result).toEqual({ resolved: closable.length, skipped: 25 - closable.length });
    const after = new Map((await state([...requested.map(i => i.verdictId), smuggled])).map(r => [r.id, r]));
    for (const id of closable) expect(after.get(id)).toMatchObject({ resolution: 'accepted', resolvedBy: all.userId });
    for (const id of requested.filter(i => i.signature.length > 1).map(i => i.verdictId)) expect(after.get(id)?.resolution, 'mixed stays open').toBeNull();
    expect(after.get(smuggled)?.resolution, 'a blocking exception is never closed in bulk').toBeNull();
    // Audited, one event per closed exception, by the anomaly owner.
    expect(await eventTypesFor(b.tenantId, closable[0])).toContain('payroll.anomaly.resolved');
    const [note] = await owner.db.select({ note: schema.payrollAnomalyVerdict.resolutionNote }).from(schema.payrollAnomalyVerdict).where(eq(schema.payrollAnomalyVerdict.id, closable[0]));
    expect(note.note).toBe('Expected (marked with its group): These companies do not use clock-in');
    // The counts move by exactly what was closed.
    const view = await groupedExceptions(all);
    expect(view.total).toBe(specs.filter(s => s.open).length - closable.length);
  }, 120_000);
});
