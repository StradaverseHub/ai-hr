/**
 * r307 — "what is needed next" on the People list, and the two claims it rests on.
 *
 * 1. THE CHIP FILTERS THE POPULATION, NOT THE PAGE. "Needs action" narrows through the shared employee
 *    WHERE (`employmentIds`), so the pager total counts the same set the rows come from. The bug this
 *    pins is the tempting shortcut — fetch a page, drop the rows with no gap — which leaves a count
 *    that is true of a population the user never sees and a page 2 that is a different question.
 *    Present-but-empty must match NOTHING, or a filter for "these zero people" quietly lists the
 *    whole company.
 *
 * 2. ONE DEFINITION OF "MISSING". `gapsForEmployments` and `employmentIdsWithGaps` are new projections
 *    over `gapsForRecord`, the function core/record-readiness.ts exists to be the only answer to that
 *    question. Both are checked against it here rather than against a hand-written expectation, so a
 *    change to the rule cannot leave one screen disagreeing with the Record Readiness screen.
 *
 * The gating claim — that a non-admin sees no column, no chip and issues neither read — is a property
 * of app/personnel/page.tsx and is pinned in test/people-needs-action-gating.test.ts, which can read
 * the page's source; a server component cannot be rendered in this project.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { listEmployeesPage } from '../core/read';
import {
  employmentIdsWithGaps,
  gapsForEmployments,
  gapsForRecord,
  GAP_BLOCKS,
} from '../core/record-readiness';

let b: Base;
let ctx: SessionContext;

const uniqEmail = () => `needs_${Math.random().toString(36).slice(2)}@t.local`;

async function hire(name: string, opts: { withPay?: boolean } = {}) {
  const e = await hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  if (opts.withPay) {
    await setCompensation(ctx, {
      employmentId: e.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2024-01-01',
    });
  }
  return e;
}

/** A complete statutory + bank row, i.e. every gap this file is about, closed. */
async function completeRecord(personId: string) {
  await owner.db.insert(schema.employeeStatutoryMy).values({
    tenantId: b.tenantId,
    personId,
    icNumber: '900101-14-5501',
    taxNumber: 'SG 12345678',
    epfNumber: '1234567',
    socsoNumber: 'A1234567',
    bankAccountNo: '1234567890',
  });
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ctx = await entitledCtx(b);
});

describe('gapsForEmployments (the per-person view)', () => {
  it('agrees with gapsForRecord rather than carrying its own idea of "missing"', async () => {
    const withPay = await hire('Needs Bank Only', { withPay: true });
    const noPay = await hire('Needs Everything');

    const map = await gapsForEmployments(ctx, [withPay.employmentId, noPay.employmentId]);

    // Neither has a statutory row, so both are missing bank + identity + the three numbers; only the
    // second is also missing pay set-up. The exact ids come from the shared rule, not from this test.
    expect(map.get(withPay.employmentId)).toEqual(
      gapsForRecord({ hasComp: true, paymentMethod: null, bankAccountNo: null, ic: null, passport: null, taxNumber: null, epfNumber: null, socsoNumber: null }),
    );
    expect(map.get(noPay.employmentId)).toEqual(
      gapsForRecord({ hasComp: false, paymentMethod: null, bankAccountNo: null, ic: null, passport: null, taxNumber: null, epfNumber: null, socsoNumber: null }),
    );
  });

  it('puts the worst consequence first, so the column names the thing that stops most', async () => {
    const noPay = await hire('Needs Everything');
    const [first] = (await gapsForEmployments(ctx, [noPay.employmentId])).get(noPay.employmentId)!;
    // Pay set-up stops the RUN; a missing bank account only stops the payment; a missing tax number
    // only stops a filing. The column shows one thing, so it has to be that one.
    expect(first).toBe('no_compensation');
    expect(GAP_BLOCKS[first!]).toBe('payroll');
  });

  it('omits a complete record entirely, so "complete" cannot read as "not checked"', async () => {
    const e = await hire('All Good', { withPay: true });
    await completeRecord(e.personId);
    const map = await gapsForEmployments(ctx, [e.employmentId]);
    expect(map.has(e.employmentId)).toBe(false);
    expect(map.size).toBe(0);
  });

  it('asks about nobody when given nobody, instead of asking about everybody', async () => {
    await hire('Someone With Gaps');
    expect((await gapsForEmployments(ctx, [])).size).toBe(0);
  });

  it('returns only the employments asked about', async () => {
    const a = await hire('Person A');
    await hire('Person B');
    const map = await gapsForEmployments(ctx, [a.employmentId]);
    expect([...map.keys()]).toEqual([a.employmentId]);
  });
});

describe('employmentIdsWithGaps (the set behind the chip)', () => {
  it('holds everyone with a gap and nobody without', async () => {
    const incomplete = await hire('Incomplete');
    const complete = await hire('Complete', { withPay: true });
    await completeRecord(complete.personId);

    const ids = await employmentIdsWithGaps(ctx);
    expect(ids.has(incomplete.employmentId)).toBe(true);
    expect(ids.has(complete.employmentId)).toBe(false);
  });

  it('counts every id rather than a readable sample', async () => {
    // recordReadiness caps names per gap at PEOPLE_PER_GAP (25) for the screen's sake. The chip's count
    // and its filter must not inherit that cap, so this hires past it deliberately.
    const hired = [];
    for (let i = 0; i < 27; i++) hired.push(await hire(`Bulk ${String(i).padStart(2, '0')}`));
    const ids = await employmentIdsWithGaps(ctx);
    for (const h of hired) expect(ids.has(h.employmentId), `${h.employmentId} missing from the set`).toBe(true);
    expect(ids.size).toBeGreaterThanOrEqual(27);
  });
});

describe('the employmentIds narrowing on the shared employee WHERE', () => {
  it('filters the population, so rows and the pager total are the same question', async () => {
    const a = await hire('Chip Person A');
    const bb = await hire('Chip Person B');
    await hire('Not In The Chip');

    const page = await listEmployeesPage(ctx, {
      companyIds: [b.companyId],
      employmentIds: [a.employmentId, bb.employmentId],
      limit: 25,
      offset: 0,
    });
    expect(page.rows.map((r) => r.employmentId).sort()).toEqual([a.employmentId, bb.employmentId].sort());
    // THE POINT: the total is the narrowed population's size, not the company's.
    expect(page.total).toBe(2);
  });

  it('matches nothing when the set is empty — never everything', async () => {
    await hire('Should Not Appear');
    const page = await listEmployeesPage(ctx, { companyIds: [b.companyId], employmentIds: [], limit: 25, offset: 0 });
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('is ANDed with the other filters, not substituted for them', async () => {
    const a = await hire('Filter Combo');
    const page = await listEmployeesPage(ctx, {
      companyIds: [b.companyId],
      employmentIds: [a.employmentId],
      // A search that cannot match the one id: the answer must be empty, proving both applied.
      q: 'zzzz-no-such-person',
      limit: 25,
      offset: 0,
    });
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
  });
});
