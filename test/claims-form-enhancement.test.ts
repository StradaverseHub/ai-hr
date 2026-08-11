/**
 * Claim Submission Form enhancement — dependent Claim Item, per-type rate config (mileage/fixed),
 * the 45-day receipt-date window, the attachment MIME allowlist, and the ADR-0030 payload guard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import {
  addClaimAttachment,
  createClaimItem,
  createClaimType,
  listClaimsForEmployment,
  setClaimPolicy,
  submitClaim,
} from '../core/claims';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, eventTypesFor, latestEventPayload, migrateTestDb, resetDb, seedBase, type Base } from './harness';

// The kernel judges these dates in MYT (bb4f2265); a fixture built in UTC disagrees with it
// between 00:00 and 08:00 MYT, which is a test that fails only at night.
import { todayInKualaLumpur } from '../lib/hr-date';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

// UTC date helpers relative to the real today() the service uses (the receipt window is dynamic).
const utcToday = (): string => todayInKualaLumpur();
const utcMinusDays = (days: number): string =>
  new Date(new Date(`${utcToday()}T00:00:00Z`).getTime() - days * 86400000).toISOString().slice(0, 10);
const utcPlusDays = (days: number): string =>
  new Date(new Date(`${utcToday()}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
const within = () => utcMinusDays(5); // a date safely inside the 45-day window

describe('Claim form enhancement — items, rate config, receipt window, MIME', () => {
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

  // ── Dependent claim item (D5) ──
  it('creates a claim item with an event', async () => {
    const a = adminCtx(base);
    const { id: typeId } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    const { id: itemId } = await createClaimItem(a, { claimTypeId: typeId, code: 'parking', name: 'Parking' });
    expect(await eventTypesFor(base.tenantId, itemId)).toContain('claim-item.created');
  });

  it('requires + validates the item when the type has items; allows none when it has zero', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Subject');
    const { id: typeId } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    const otherType = await createClaimType(a, { code: 'MEALS', name: 'Meals', defaultTaxable: false, requiresReceipt: false });
    const { id: itemId } = await createClaimItem(a, { claimTypeId: typeId, code: 'PARKING', name: 'Parking' });
    const otherItem = await createClaimItem(a, { claimTypeId: otherType.id, code: 'LUNCH', name: 'Lunch' });

    // type-with-items + no item → rejected.
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 30, incurredOn: within() })).rejects.toThrow(/item is required/i);
    // item belongs to a different type → rejected.
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, claimItemId: otherItem.id, amount: 30, incurredOn: within() })).rejects.toThrow(/does not belong/i);
    // correct item → resolves.
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, claimItemId: itemId, amount: 30, incurredOn: within() });
    expect((await listClaimsForEmployment(a, E.employmentId)).find((c) => c.id === id)?.itemName).toBe('Parking');

    // a type with ZERO items submits with no item (no claimItemId required).
    const empty = await createClaimType(a, { code: 'PHONE', name: 'Phone', defaultTaxable: false, requiresReceipt: false });
    const ne = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: empty.id, amount: 15, incurredOn: within() });
    expect((await listClaimsForEmployment(a, E.employmentId)).find((c) => c.id === ne.id)?.itemName).toBeNull();
  });

  it('normalizes item code (parking then PARKING collide on the partial-unique index)', async () => {
    const a = adminCtx(base);
    const { id: typeId } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    await createClaimItem(a, { claimTypeId: typeId, code: 'parking', name: 'Parking' });
    await expect(createClaimItem(a, { claimTypeId: typeId, code: 'PARKING', name: 'Parking 2' })).rejects.toThrow();
  });

  // ── Receipt-date window ──
  it('enforces the receipt-date window (future + >45d rejected; in-window + exactly 45d back accepted)', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Subject');
    const { id: typeId } = await createClaimType(a, { code: 'MEALS', name: 'Meals', defaultTaxable: false, requiresReceipt: false });
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 10, incurredOn: utcPlusDays(1) })).rejects.toThrow(/future/i);
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 10, incurredOn: utcMinusDays(46) })).rejects.toThrow(/45 days/i);
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 10, incurredOn: utcMinusDays(45) })).resolves.toBeTruthy();
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 10, incurredOn: utcToday() })).resolves.toBeTruthy();
  });

  // ── mileage_flat ──
  it('mileage_flat: amount is km × rate; cap check is against the computed amount', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Driver');
    const { id: typeId } = await createClaimType(a, { code: 'MILEAGE', name: 'Mileage', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: null, perClaimCap: 50, effectiveFrom: '2026-01-01', rateConfig: { kind: 'mileage_flat', ratePerKm: 0.7 } });

    // 100 km × 0.70 = RM70 → exceeds the RM50 cap (raw "amount" 0 would otherwise pass) → rejected.
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 0, quantityKm: 100, incurredOn: within() })).rejects.toThrow(/cap/i);
    // 50 km × 0.70 = RM35 (≤ cap) → stored as the computed amount + km.
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 0, quantityKm: 50, incurredOn: within() });
    const row = (await listClaimsForEmployment(a, E.employmentId)).find((c) => c.id === id);
    expect(row?.amount).toBeCloseTo(35);
    expect(row?.quantityKm).toBeCloseTo(50);
  });

  // ── fixed_allowance ──
  it('fixed_allowance: submits even when entered amount is 0; honours the per-claim cap on the fixed amount', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Exec');
    const { id: typeId } = await createClaimType(a, { code: 'CARALLOW', name: 'Car Allowance', defaultTaxable: true, requiresReceipt: false });
    await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: null, perClaimCap: 800, effectiveFrom: '2026-01-01', rateConfig: { kind: 'fixed_allowance', amount: 600 } });
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 0, incurredOn: within() });
    expect((await listClaimsForEmployment(a, E.employmentId)).find((c) => c.id === id)?.amount).toBeCloseTo(600);

    // a fixed amount above the cap is rejected.
    const { id: t2 } = await createClaimType(a, { code: 'CARALLOW2', name: 'Car Allowance 2', defaultTaxable: true, requiresReceipt: false });
    await setClaimPolicy(a, { claimTypeId: t2, annualBudget: null, perClaimCap: 500, effectiveFrom: '2026-01-01', rateConfig: { kind: 'fixed_allowance', amount: 600 } });
    await expect(submitClaim(a, { employmentId: E.employmentId, claimTypeId: t2, amount: 0, incurredOn: within() })).rejects.toThrow(/cap/i);
  });

  // ── MIME allowlist ──
  it('attachment MIME allowlist: rejects gif/txt, accepts PDF/JPG/PNG', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Subject');
    const { id: typeId } = await createClaimType(a, { code: 'MEALS', name: 'Meals', defaultTaxable: false, requiresReceipt: false });
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 10, incurredOn: within() });
    await expect(addClaimAttachment(a, { claimRequestId: id, fileName: 'r.gif', mimeType: 'image/gif', content: Buffer.from('GIF89a') })).rejects.toThrow(/PDF, JPG, or PNG/);
    await expect(addClaimAttachment(a, { claimRequestId: id, fileName: 'r.txt', mimeType: 'text/plain', content: Buffer.from('hello') })).rejects.toThrow(/PDF, JPG, or PNG/);
    await expect(addClaimAttachment(a, { claimRequestId: id, fileName: 'r.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4') })).resolves.toBeTruthy();
    await expect(addClaimAttachment(a, { claimRequestId: id, fileName: 'r.png', mimeType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })).resolves.toBeTruthy();
    await expect(addClaimAttachment(a, { claimRequestId: id, fileName: 'r.jpg', mimeType: 'image/jpeg', content: Buffer.from([0xff, 0xd8, 0xff]) })).resolves.toBeTruthy();
  });

  // ── ADR-0030 payload guard ──
  it('the submitted event payload carries claimItemId but NOT quantityKm/amount', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Driver');
    const { id: typeId } = await createClaimType(a, { code: 'MILEAGE', name: 'Mileage', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    const { id: itemId } = await createClaimItem(a, { claimTypeId: typeId, code: 'KM', name: 'Distance' });
    await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: null, perClaimCap: null, effectiveFrom: '2026-01-01', rateConfig: { kind: 'mileage_flat', ratePerKm: 0.7 } });
    const { id } = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, claimItemId: itemId, amount: 0, quantityKm: 100, incurredOn: within() });
    const payload = await latestEventPayload(base.tenantId, id, 'claim-request.submitted');
    expect(payload?.claimItemId).toBe(itemId);
    expect(payload && 'quantityKm' in payload).toBe(false);
    expect(payload && 'amount' in payload).toBe(false);
  });
});
