/**
 * PER BLOCK claim limits (e7eb5d83 rev 4, migration 0428) — "RM2,000 every 2 years", "RM300 every 6
 * months". Its own file rather than a second describe inside test/claims-limits.test.ts: that file's
 * afterAll calls closeAll(), which tears the pool down before a later describe in the same file can run.
 *
 * The window ARITHMETIC (addMonthsClamped / claimBlockWindow) is proven with no database at all in
 * test/claims-compute.test.ts. What is proven here is the only thing the arithmetic is for: which claims
 * the reservation sum counts, and that the reservation is still DERIVED — there is no reserved_amount
 * column and there must never be one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  ClaimError,
  addMonthsClamped,
  createClaimType,
  dateMinusDays,
  decideClaim,
  getEmployeeClaimTypes,
  listClaimLimits,
  setClaimPolicy,
  submitClaim,
} from '../core/claims';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// The kernel judges these dates in MYT (bb4f2265); a fixture built in UTC disagrees with it
// between 00:00 and 08:00 MYT, which is a test that fails only at night.
import { todayInKualaLumpur } from '../lib/hr-date';

// ══════════ PER BLOCK — "RM2,000 every 2 years", "RM300 every 6 months" (e7eb5d83 rev 4, 0428) ══════════
//
// The window arithmetic itself is proven in test/claims-compute.test.ts with no database. What is proven
// HERE is the only thing the arithmetic is for: which claims the reservation sum counts.
//
// ⚠️ EVERY DATE BELOW IS DERIVED FROM TODAY, deliberately. A fixture pinned to literal 2026 dates passes
// in August and fails in February, because submitClaim refuses a receipt dated in the future and the
// "previous block" would move ahead of today. The anchor is placed three months before the first of THIS
// month, so today is always in block index 1 and block 0 is always entirely in the past.
describe('e7eb5d83 — per-block claim limits', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  const today = todayInKualaLumpur();
  const startOfThisMonth = `${today.slice(0, 7)}-01`;
  /** Block 0 = [anchor, startOfThisMonth) · block 1 = [startOfThisMonth, +3 months) ∋ today. */
  const anchor = addMonthsClamped(startOfThisMonth, -3);
  const inPrevBlock = addMonthsClamped(startOfThisMonth, -1);
  const beforeAnchor = addMonthsClamped(anchor, -1);
  /** Earlier than every incurred date used here, so one policy version resolves for all of them. */
  const policyFrom = addMonthsClamped(anchor, -6);

  async function setup() {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Blocky', primaryEmail: 'blocky@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    // A wide receipt window so the fixture can file a claim in the previous block through the REAL submit
    // path rather than by inserting a row behind the engine's back.
    const { id: typeId } = await createClaimType(a, {
      code: 'MEDICAL',
      name: 'Medical',
      defaultTaxable: false,
      requiresReceipt: false,
      maxReceiptAgeDays: 36500,
    });
    return { a, employmentId: E.employmentId, typeId };
  }

  const block = (limit: number, extra: Record<string, unknown> = {}) => ({
    blockLength: 3,
    blockUnit: 'month',
    blockLimit: limit,
    blockStartOn: anchor,
    ...extra,
  });

  it('counts a claim INSIDE the block and ignores one in the PREVIOUS block', async () => {
    const { a, employmentId, typeId } = await setup();
    await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: policyFrom,
      ...block(500),
    });

    // Block 0 filled to 400.
    await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 400, incurredOn: inPrevBlock });
    // Block 1 starts empty — if the previous block leaked in, 400 + 400 would already be over 500.
    await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 400, incurredOn: today });

    const err = await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 200, incurredOn: today }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect((err as Error).message).toMatch(/exceeds the limit of RM 500\.00 for that period/);
    // The refusal names the DAY the pot runs to, not just the amount.
    expect((err as Error).message).toContain(dateMinusDays(addMonthsClamped(startOfThisMonth, 3), 1));
  });

  it('THE BOUNDARY DAY BELONGS TO THE NEW BLOCK — a full previous block does not block it', async () => {
    const { a, employmentId, typeId } = await setup();
    await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: policyFrom,
      ...block(500),
    });
    await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 500, incurredOn: inPrevBlock }); // block 0 full
    // startOfThisMonth is the first instant of block 1, not the last of block 0.
    await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 500, incurredOn: startOfThisMonth });
    const rows = await getEmployeeClaimTypes(a, employmentId);
    expect(rows.find((r) => r.id === typeId)?.balance.usedThisBlock).toBe(500);
  });

  it('a claim BEFORE the anchor skips the per-block check ONLY — the annual limit still applies', async () => {
    const { a, employmentId, typeId } = await setup();
    await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: 1000,
      perClaimCap: null,
      effectiveFrom: policyFrom,
      ...block(100),
    });
    // 900 is nine times the per-block limit and is accepted, because this date is in no block at all.
    await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 900, incurredOn: beforeAnchor });
    // …but the ANNUAL limit is not skipped with it.
    const err = await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 200, incurredOn: beforeAnchor }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect((err as Error).message).toMatch(/annual limit of RM 1,000\.00/);
  });

  it('editing an unrelated field does NOT move block_start_on (the anchor is carried forward)', async () => {
    const { a, typeId } = await setup();
    await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: null,
      perClaimCap: 100,
      effectiveFrom: policyFrom,
      ...block(500),
    });
    // A later version that re-states the rule but says nothing about where it counts from.
    await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: null,
      perClaimCap: 200,
      effectiveFrom: today,
      blockLength: 3,
      blockUnit: 'month',
      blockLimit: 500,
    });
    const row = (await listClaimLimits(a, { asOf: today })).find((l) => l.claimTypeId === typeId);
    expect(row?.perClaimCap).toBe(200); // the edit landed
    expect(row?.block).toMatchObject({ length: 3, unit: 'month', limit: 500, startOn: anchor }); // the window did not restart
  });

  it('approving cannot push a block over its limit (the re-check, not just the submit check)', async () => {
    const { a, employmentId, typeId } = await setup();
    // Filed under a policy with NO per-block rule…
    await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: null, perClaimCap: null, effectiveFrom: policyFrom });
    const { id } = await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 500, incurredOn: today });
    // …then the rule arrives, effective from before the claim was incurred.
    await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: policyFrom,
      ...block(300),
    });
    const err = await decideClaim(a, { claimRequestId: id, decision: 'approve' }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect((err as Error).message).toMatch(/exceed the limit of RM 300\.00 for the period/);
  });

  it('rejecting RELEASES the block reservation — there is no stored counter to get out of step', async () => {
    const { a, employmentId, typeId } = await setup();
    await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: policyFrom,
      ...block(500),
    });
    const { id } = await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 500, incurredOn: today });
    // The pot is full: nothing more fits.
    const blocked = await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 1, incurredOn: today }).catch((e) => e);
    expect(blocked).toBeInstanceOf(ClaimError);
    await decideClaim(a, { claimRequestId: id, decision: 'reject' });
    // …and the moment it is rejected the whole 500 is available again, because the reservation is the
    // set of rows in RESERVING_STATUSES and nothing was ever decremented.
    await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 500, incurredOn: today });
    const rows = await getEmployeeClaimTypes(a, employmentId);
    expect(rows.find((r) => r.id === typeId)?.balance.usedThisBlock).toBe(500);
  });

  it('surfaces the block on the employee balance row (limit, used, remaining, and the END DATE)', async () => {
    const { a, employmentId, typeId } = await setup();
    await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: policyFrom,
      ...block(500),
    });
    await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 120, incurredOn: today });
    const bal = (await getEmployeeClaimTypes(a, employmentId)).find((r) => r.id === typeId)?.balance;
    expect(bal).toMatchObject({
      blockLimit: 500,
      usedThisBlock: 120,
      remainingThisBlock: 380,
      blockEndsOn: dateMinusDays(addMonthsClamped(startOfThisMonth, 3), 1),
    });
  });

  it('a claim type with no per-block rule reports no block at all (today’s behaviour, unchanged)', async () => {
    const { a, employmentId, typeId } = await setup();
    await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: 1000, perClaimCap: null, effectiveFrom: policyFrom });
    await submitClaim(a, { employmentId, claimTypeId: typeId, amount: 900, incurredOn: today });
    const bal = (await getEmployeeClaimTypes(a, employmentId)).find((r) => r.id === typeId)?.balance;
    expect(bal).toMatchObject({ blockLimit: null, usedThisBlock: 0, remainingThisBlock: null, blockEndsOn: null });
    const row = (await listClaimLimits(a, { asOf: today })).find((l) => l.claimTypeId === typeId);
    expect(row?.block).toBeNull();
  });

  it('refuses a HALF-FILLED rule — all four parts or none', async () => {
    const { a, typeId } = await setup();
    const noLength = await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: policyFrom,
      blockLimit: 500,
    }).catch((e) => e);
    expect((noLength as Error).message).toMatch(/Per-block length/);

    const badUnit = await setClaimPolicy(a, {
      claimTypeId: typeId,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: policyFrom,
      blockLength: 2,
      blockUnit: 'fortnight',
      blockLimit: 500,
    }).catch((e) => e);
    expect((badUnit as Error).message).toMatch(/Per-block unit/);
  });

  it('the DB is the backstop: a half-filled row inserted behind the service is refused by the CHECK', async () => {
    const { typeId } = await setup();
    const err = await owner.db
      .insert(schema.claimPolicy)
      .values({
        tenantId: base.tenantId,
        claimTypeId: typeId,
        blockLength: 2,
        blockUnit: 'year',
        // no block_limit, no block_start_on — the exact partial the service refuses first.
        validFrom: policyFrom,
      })
      .catch((e) => e);
    // Drizzle wraps the Postgres error as "Failed query: …", so matching the outer message alone would
    // pass on ANY failure. Walk the cause chain and name the constraint.
    const chain: string[] = [];
    let cur: unknown = err;
    while (cur) {
      chain.push(String((cur as Error).message ?? ''));
      cur = (cur as { cause?: unknown }).cause;
    }
    expect(chain.join(' | ')).toContain('claim_policy_block_ck');
  });

  it('an all-null block on an existing row is accepted — every pre-0428 row is already correct', async () => {
    const { typeId } = await setup();
    const [row] = await owner.db
      .insert(schema.claimPolicy)
      .values({ tenantId: base.tenantId, claimTypeId: typeId, annualBudget: '1000.00', validFrom: policyFrom })
      .returning({ id: schema.claimPolicy.id });
    expect(row.id).toBeTruthy();
  });
});
