/**
 * e7eb5d83 — Configurable Claim Management. The three things the reporter could not do, and the traps the
 * plan's build notes named by hand:
 *
 *   1. GRADE-FIRST LIMITS. A grade with no row of its own must render the COMPANY-WIDE fallback, not a
 *      blank — hiding the row that actually applies is how HR sets the same limit twice. Sub-types must
 *      nest under their parent and never orphan.
 *   2. FORM DESIGNER. A required custom field blocks submit and an optional one does not; and the four
 *      built-ins (amount / date / description / receipt) cannot be created, renamed into, or deleted
 *      through ANY path — including a forged POST that never touches the screen.
 *   3. MILEAGE RATE TABLE. Banded, grade-scoped, effective-dated; resolved AT SUBMIT and STAMPED on the
 *      claim, so a later rate-table edit does not move a claim already filed.
 *
 * Plus the scope guard both new screens depend on: an out-of-scope ?gradeId= must RESOLVE TO THE
 * COMPANY-WIDE VIEW, never to another tenant's configuration. The refusal is asserted, not just the happy
 * path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import {
  archiveClaimFormField,
  archiveClaimType,
  assertValidMileageBands,
  BUILT_IN_FIELD_KEYS,
  createClaimFormField,
  createClaimItem,
  createClaimType,
  getMileageClaimType,
  listClaimFormFields,
  listClaimLimitsForGrade,
  listMileageRateTables,
  moveClaimFormField,
  priceMileage,
  resolveMileageRateBands,
  setClaimPolicy,
  setMileageRateTable,
  submitClaim,
  updateClaimType,
  validateClaimFieldValues,
  type ClaimFormFieldRowOut,
} from '../core/claims';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

async function makeGrade(tenantId: string, code: string, name: string, rank: number): Promise<string> {
  const [g] = await owner.db.insert(schema.jobGrade).values({ tenantId, code, name, rank }).returning({ id: schema.jobGrade.id });
  return g.id;
}

const field = (over: Partial<ClaimFormFieldRowOut> = {}): ClaimFormFieldRowOut => ({
  id: 'f1',
  claimTypeId: 'ct1',
  fieldKey: 'project_code',
  label: 'Project code',
  kind: 'text',
  required: false,
  options: [],
  sortOrder: 0,
  ...over,
});

// ═══════════════════════ Pure units — no database ═══════════════════════

describe('e7eb5d83 — mileage band pricing (pure)', () => {
  it('prices MARGINALLY across bands, which is what "0.60 for the first 500km and 0.45 after" means', () => {
    const bands = [
      { fromKm: 0, toKm: 500, ratePerKm: 0.6 },
      { fromKm: 500, toKm: null, ratePerKm: 0.45 },
    ];
    // 500×0.60 + 200×0.45 = 300 + 90. NOT 700×0.45 (315) and NOT 700×0.60 (420).
    const { amount, breakdown } = priceMileage(bands, 700);
    expect(amount).toBe(390);
    expect(breakdown).toEqual([
      { fromKm: 0, toKm: 500, ratePerKm: 0.6, km: 500, amount: 300 },
      { fromKm: 500, toKm: null, ratePerKm: 0.45, km: 200, amount: 90 },
    ]);
  });

  it('a distance inside the first band never reaches the later ones', () => {
    const bands = [
      { fromKm: 0, toKm: 500, ratePerKm: 0.6 },
      { fromKm: 500, toKm: null, ratePerKm: 0.45 },
    ];
    const { amount, breakdown } = priceMileage(bands, 120);
    expect(amount).toBe(72);
    expect(breakdown).toHaveLength(1);
  });

  it('refuses a table with a GAP — the distances in it would otherwise be priced at nothing', () => {
    expect(() =>
      assertValidMileageBands([
        { fromKm: 0, toKm: 100, ratePerKm: 0.6 },
        { fromKm: 200, toKm: null, ratePerKm: 0.45 }, // 100–200 km falls through
      ]),
    ).toThrow(/continuous/i);
  });

  it('refuses a table that does not start at 0, or whose last band is closed', () => {
    expect(() => assertValidMileageBands([{ fromKm: 50, toKm: null, ratePerKm: 0.6 }])).toThrow(/start at 0/i);
    expect(() => assertValidMileageBands([{ fromKm: 0, toKm: 500, ratePerKm: 0.6 }])).toThrow(/open-ended/i);
  });
});

describe('e7eb5d83 — custom field validation (pure)', () => {
  it('a REQUIRED field blocks, an OPTIONAL one does not', () => {
    const required = [field({ required: true })];
    expect(() => validateClaimFieldValues(required, {})).toThrow(/Project code/);
    expect(validateClaimFieldValues(required, { project_code: 'PRJ-1' })).toEqual({ project_code: 'PRJ-1' });

    const optional = [field({ required: false })];
    expect(validateClaimFieldValues(optional, {})).toEqual({ project_code: null });
  });

  it('a claim type with NO designed fields stores null — nothing an employee sees changes until configured', () => {
    expect(validateClaimFieldValues([], { anything: 'at all' })).toBeNull();
  });

  it('a dropdown refuses a value outside its choices (or the configured list is decorative)', () => {
    const f = [field({ kind: 'select', options: ['A', 'B'] })];
    expect(validateClaimFieldValues(f, { project_code: 'A' })).toEqual({ project_code: 'A' });
    expect(() => validateClaimFieldValues(f, { project_code: 'Z' })).toThrow(/not one of the choices/i);
  });

  it('a required YES/NO field is satisfied by "no" — an unticked checkbox posts nothing, not a blank', () => {
    const f = [field({ kind: 'boolean', required: true })];
    expect(validateClaimFieldValues(f, {})).toEqual({ project_code: false });
    expect(validateClaimFieldValues(f, { project_code: 'on' })).toEqual({ project_code: true });
  });

  it('an unknown key is DROPPED, not rejected — an archived field must not wedge an old draft forever', () => {
    expect(validateClaimFieldValues([field()], { project_code: 'X', gone_field: 'stale' })).toEqual({ project_code: 'X' });
  });
});

// ═══════════════════════ Against the database ═══════════════════════

describe('e7eb5d83 — configurable claim management', () => {
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

  // ── 1. Grade-first limits ────────────────────────────────────────────────

  it('a grade with NO policy rows renders the company-wide FALLBACK, not a blank', async () => {
    const a = adminCtx(base);
    const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
    const mgr = await makeGrade(base.tenantId, 'MGR', 'Manager', 2);
    const { id } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false });
    await setClaimPolicy(a, { claimTypeId: id, annualBudget: 1000, perClaimCap: null, effectiveFrom: '2026-01-01' });
    await setClaimPolicy(a, { claimTypeId: id, gradeId: exec, annualBudget: 5000, perClaimCap: 500, effectiveFrom: '2026-01-01' });

    const forMgr = await listClaimLimitsForGrade(a, { gradeId: mgr, asOf: '2026-06-01' });
    const mgrRow = forMgr.find((r) => r.claimTypeId === id)!;
    // Not a blank: the tenant-wide row is what actually applies to a Manager, and the screen says so.
    expect(mgrRow.source).toBe('company');
    expect(mgrRow.own).toBeNull();
    expect(mgrRow.effective?.annualBudget).toBe(1000);
    expect(mgrRow.fallback?.annualBudget).toBe(1000);

    const forExec = await listClaimLimitsForGrade(a, { gradeId: exec, asOf: '2026-06-01' });
    const execRow = forExec.find((r) => r.claimTypeId === id)!;
    expect(execRow.source).toBe('grade');
    expect(execRow.effective?.annualBudget).toBe(5000);
    // The fallback is still reported alongside, so the screen can show what the grade is overriding.
    expect(execRow.fallback?.annualBudget).toBe(1000);
  });

  it('a claim type with NO limit row anywhere still appears, as unlimited', async () => {
    const a = adminCtx(base);
    const g = await makeGrade(base.tenantId, 'G1', 'Grade 1', 1);
    const { id } = await createClaimType(a, { code: 'PHONE', name: 'Phone', defaultTaxable: false, requiresReceipt: false });
    // listClaimLimits inner-joins FROM claim_policy and would drop this type entirely; a claim type missing
    // from the limits screen is a claim type nobody can configure.
    const rows = await listClaimLimitsForGrade(a, { gradeId: g, asOf: '2026-06-01' });
    const row = rows.find((r) => r.claimTypeId === id)!;
    expect(row).toBeDefined();
    expect(row.source).toBe('none');
    expect(row.effective).toBeNull();
  });

  it('sub-types nest under their PARENT type and never orphan', async () => {
    const a = adminCtx(base);
    const g = await makeGrade(base.tenantId, 'G1', 'Grade 1', 1);
    const travel = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    const medical = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false });
    await createClaimItem(a, { claimTypeId: travel.id, code: 'MILEAGE', name: 'Mileage' });
    await createClaimItem(a, { claimTypeId: travel.id, code: 'PARKING', name: 'Parking' });

    const rows = await listClaimLimitsForGrade(a, { gradeId: g, asOf: '2026-06-01' });
    const travelRow = rows.find((r) => r.claimTypeId === travel.id)!;
    const medicalRow = rows.find((r) => r.claimTypeId === medical.id)!;
    expect(travelRow.items.map((i) => i.code).sort()).toEqual(['MILEAGE', 'PARKING']);
    expect(medicalRow.items).toEqual([]);
    // Every item belongs to exactly one row — none floats free of a parent.
    const allItemIds = rows.flatMap((r) => r.items.map((i) => i.id));
    expect(new Set(allItemIds).size).toBe(allItemIds.length);
  });

  // ── The scope guard, asserted as a REFUSAL ───────────────────────────────

  it('an OUT-OF-SCOPE gradeId resolves to the company-wide view — never another tenant\'s limits', async () => {
    const a = adminCtx(base);
    const { id } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false });
    await setClaimPolicy(a, { claimTypeId: id, annualBudget: 1000, perClaimCap: null, effectiveFrom: '2026-01-01' });

    // A REAL grade, belonging to a DIFFERENT tenant, with a limit of its own over there.
    const other = await seedBase();
    const otherGrade = await makeGrade(other.tenantId, 'EXEC', 'Executive', 1);
    const otherType = await createClaimType(adminCtx(other), { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false });
    await setClaimPolicy(adminCtx(other), { claimTypeId: otherType.id, gradeId: otherGrade, annualBudget: 99999, perClaimCap: null, effectiveFrom: '2026-01-01' });

    const rows = await listClaimLimitsForGrade(a, { gradeId: otherGrade, asOf: '2026-06-01' });
    const row = rows.find((r) => r.claimTypeId === id)!;
    expect(row.source).toBe('company'); // coerced to "no selection", not honoured
    expect(row.effective?.annualBudget).toBe(1000);
    expect(rows.some((r) => r.effective?.annualBudget === 99999)).toBe(false);
  });

  it('the limits page VALIDATES ?gradeId= against the session\'s own grade list before using it', () => {
    // The guard is what makes the refusal above reachable from the URL. Pinned as source so it cannot be
    // deleted in a refactor that still passes every behavioural test above.
    const src = read('app/admin/claims/limits/page.tsx');
    expect(src).toMatch(/activeGrades\.some\(\(g\) => g\.id === rawGradeId\)/);
    expect(src).toMatch(/searchParams/);
  });

  it('the mileage page validates every URL parameter against what the session can see', () => {
    const src = read('app/admin/claims/mileage/page.tsx');
    // e7eb5d83 rev 4 point 5 — ?claimTypeId= is gone entirely: the screen resolves its claim type from
    // claim_type.is_mileage instead of accepting one from the URL, so the parameter that used to need a
    // guard no longer exists. The remaining two keep the same guard the limits screen uses.
    expect(src).not.toMatch(/rawTypeId/);
    expect(src).toMatch(/getMileageClaimType/);
    expect(src).toMatch(/activeGrades\.some\(\(g\) => g\.id === rawGradeId\)/);
    expect(src).toMatch(/MILEAGE_VEHICLE_CLASSES as readonly string\[\]\)\.includes\(rawClass/);
  });

  it('the mileage page renders an EMPTY STATE rather than falling back to the first claim type', () => {
    // The dangerous version of this screen picks types[0] when nothing is marked, and the admin saves
    // distance bands onto Medical. Pinned as source because the failure is silent: the save succeeds.
    const src = read('app/admin/claims/mileage/page.tsx');
    expect(src).not.toMatch(/\?\? types\[0\]/); // the fallback EXPRESSION, not the prose that explains it
    expect(src).toMatch(/noMileageType/);
  });

  // ── 2. Form designer ─────────────────────────────────────────────────────

  it('a REQUIRED custom field blocks submit; an optional one does not', async () => {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Claimant', primaryEmail: 'claimant@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    await createClaimFormField(a, { claimTypeId: id, label: 'Project code', kind: 'text', required: true });
    const on = todayInKualaLumpur();

    await expect(
      submitClaim(a, { employmentId: E.employmentId, claimTypeId: id, amount: 10, incurredOn: on }),
    ).rejects.toThrow(/Project code/);

    const ok = await submitClaim(a, {
      employmentId: E.employmentId,
      claimTypeId: id,
      amount: 10,
      incurredOn: on,
      fieldValues: { project_code: 'PRJ-7' },
    });
    const [row] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, ok.id));
    expect(row.fieldValues).toEqual({ project_code: 'PRJ-7' });
  });

  it('THE FOUR BUILT-INS cannot be created as custom fields through any path, forged POST included', async () => {
    const a = adminCtx(base);
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    // A forged POST does not go through the screen, so the refusal has to live in the SERVICE. Both the
    // label route (slugified) and an explicitly-supplied fieldKey are refused.
    for (const key of BUILT_IN_FIELD_KEYS) {
      await expect(createClaimFormField(a, { claimTypeId: id, label: key, kind: 'text', fieldKey: key })).rejects.toThrow(/built-in/i);
    }
    await expect(createClaimFormField(a, { claimTypeId: id, label: 'Amount', kind: 'money' })).rejects.toThrow(/built-in/i);
    await expect(createClaimFormField(a, { claimTypeId: id, label: 'Description', kind: 'text' })).rejects.toThrow(/built-in/i);
    expect(await listClaimFormFields(a, { claimTypeId: id })).toEqual([]);
  });

  it('there is no archive path that can name a built-in — archive only accepts a claim_form_field row id', async () => {
    const a = adminCtx(base);
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    const f = await createClaimFormField(a, { claimTypeId: id, label: 'Project code', kind: 'text' });
    // A forged id (a claim type's, say) archives nothing and errors — the built-ins are columns, not rows,
    // so there is no id an attacker could pass that would remove one.
    await expect(archiveClaimFormField(a, id)).rejects.toThrow(/no longer exists/i);
    await archiveClaimFormField(a, f.id);
    expect(await listClaimFormFields(a, { claimTypeId: id })).toEqual([]);
    // Archived, not deleted: the answers stored on filed claims still have a row to explain them.
    const rows = await owner.db.select().from(schema.claimFormField).where(eq(schema.claimFormField.id, f.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].archivedAt).not.toBeNull();
  });

  it('fields reorder without collisions, and a live key cannot be duplicated', async () => {
    const a = adminCtx(base);
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    await createClaimFormField(a, { claimTypeId: id, label: 'Project code', kind: 'text' });
    const second = await createClaimFormField(a, { claimTypeId: id, label: 'Client name', kind: 'text' });
    await expect(createClaimFormField(a, { claimTypeId: id, label: 'Project code', kind: 'text' })).rejects.toThrow(/already has a field/i);

    await moveClaimFormField(a, { id: second.id, direction: 'up' });
    const after = await listClaimFormFields(a, { claimTypeId: id });
    expect(after.map((f) => f.fieldKey)).toEqual(['client_name', 'project_code']);
    expect(after.map((f) => f.sortOrder)).toEqual([0, 1]); // renumbered, no ties
  });

  // ── 3. Mileage rate table ────────────────────────────────────────────────

  it('a grade\'s OWN rate table wins over the company-wide one; a grade with none falls back', async () => {
    const a = adminCtx(base);
    const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
    const mgr = await makeGrade(base.tenantId, 'MGR', 'Manager', 2);
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    await setMileageRateTable(a, {
      claimTypeId: id,
      effectiveFrom: '2026-01-01',
      bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.5 }],
    });
    await setMileageRateTable(a, {
      claimTypeId: id,
      gradeId: exec,
      effectiveFrom: '2026-01-01',
      bands: [
        { fromKm: 0, toKm: 500, ratePerKm: 0.6 },
        { fromKm: 500, toKm: null, ratePerKm: 0.45 },
      ],
    });

    const at = (gradeId: string | null) =>
      withTenant(a, (tx) => resolveMileageRateBands(tx, id, '2026-06-01', gradeId));
    const execTable = await at(exec);
    expect(execTable?.source).toBe('grade');
    expect(execTable?.bands).toHaveLength(2);
    const mgrTable = await at(mgr);
    expect(mgrTable?.source).toBe('company'); // no Manager table ⇒ the company-wide one
    expect(mgrTable?.bands).toEqual([{ fromKm: 0, toKm: null, ratePerKm: 0.5 }]);
    expect((await at(null))?.source).toBe('company');
  });

  it('versions per tier independently — a new Executive table never closes the company-wide one', async () => {
    const a = adminCtx(base);
    const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    await setMileageRateTable(a, { claimTypeId: id, effectiveFrom: '2026-01-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.5 }] });
    await setMileageRateTable(a, { claimTypeId: id, gradeId: exec, effectiveFrom: '2026-01-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.6 }] });
    await setMileageRateTable(a, { claimTypeId: id, gradeId: exec, effectiveFrom: '2026-06-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.7 }] });

    const at = (gradeId: string | null, asOf: string) => withTenant(a, (tx) => resolveMileageRateBands(tx, id, asOf, gradeId));
    expect((await at(exec, '2026-07-01'))?.bands[0].ratePerKm).toBe(0.7);
    expect((await at(exec, '2026-03-01'))?.bands[0].ratePerKm).toBe(0.6); // last year's table still readable
    expect((await at(null, '2026-07-01'))?.bands[0].ratePerKm).toBe(0.5); // company-wide untouched
  });

  it('an empty band list CLOSES a grade override, reverting that grade to the fallback', async () => {
    const a = adminCtx(base);
    const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    await setMileageRateTable(a, { claimTypeId: id, effectiveFrom: '2026-01-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.5 }] });
    await setMileageRateTable(a, { claimTypeId: id, gradeId: exec, effectiveFrom: '2026-01-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.6 }] });
    await setMileageRateTable(a, { claimTypeId: id, gradeId: exec, effectiveFrom: '2026-06-01', bands: [] });

    const t = await withTenant(a, (tx) => resolveMileageRateBands(tx, id, '2026-07-01', exec));
    expect(t?.source).toBe('company');
    expect(t?.bands[0].ratePerKm).toBe(0.5);
  });

  it('the admin read marks an inherited table as inherited, and hides it once the grade has its own', async () => {
    const a = adminCtx(base);
    const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    await setMileageRateTable(a, { claimTypeId: id, effectiveFrom: '2026-01-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.5 }] });

    const before = await listMileageRateTables(a, { claimTypeId: id, gradeId: exec, asOf: '2026-06-01' });
    expect(before.tables).toHaveLength(1);
    expect(before.tables[0].inherited).toBe(true);

    await setMileageRateTable(a, { claimTypeId: id, gradeId: exec, effectiveFrom: '2026-02-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.6 }] });
    const after = await listMileageRateTables(a, { claimTypeId: id, gradeId: exec, asOf: '2026-06-01' });
    expect(after.tables).toHaveLength(1);
    expect(after.tables[0].inherited).toBe(false);
    expect(after.tables[0].bands[0].ratePerKm).toBe(0.6);
  });

  it('A MILEAGE CLAIM STAMPS THE RATE IT WAS SUBMITTED UNDER, and a later edit does NOT move it', async () => {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Driver', primaryEmail: 'driver@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    const on = todayInKualaLumpur();
    // The claim type must be a mileage type for the banded table to apply at all.
    await setClaimPolicy(a, {
      claimTypeId: id,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: '2026-01-01',
      rateConfig: { kind: 'mileage_flat', ratePerKm: 0.3 },
    });
    await setMileageRateTable(a, {
      claimTypeId: id,
      effectiveFrom: '2026-01-01',
      bands: [
        { fromKm: 0, toKm: 500, ratePerKm: 0.6 },
        { fromKm: 500, toKm: null, ratePerKm: 0.45 },
      ],
    });

    const claim = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: id, amount: 0, quantityKm: 700, incurredOn: on });
    const [filed] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
    // The BANDED table beat the legacy flat 0.30 (which would have priced 700 km at RM 210).
    expect(Number(filed.amount)).toBe(390);
    expect(filed.mileageRateApplied).toMatchObject({ source: 'company', vehicleClass: 'any', tableValidFrom: '2026-01-01' });
    expect(filed.mileageRateApplied?.bands).toHaveLength(2);

    // Now change the rate table. The filed claim must not move — neither its amount nor its stamp.
    await setMileageRateTable(a, {
      claimTypeId: id,
      effectiveFrom: on,
      bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.05 }],
    });
    const [after] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
    expect(Number(after.amount)).toBe(390);
    expect(after.mileageRateApplied?.bands).toEqual(filed.mileageRateApplied?.bands);
  });

  it('BACK-COMPAT: a mileage type with no rate table still prices on the legacy flat rate', async () => {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Driver Two', primaryEmail: 'driver2@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    await setClaimPolicy(a, {
      claimTypeId: id,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: '2026-01-01',
      rateConfig: { kind: 'mileage_flat', ratePerKm: 0.3 },
    });
    const claim = await submitClaim(a, {
      employmentId: E.employmentId,
      claimTypeId: id,
      amount: 0,
      quantityKm: 100,
      incurredOn: todayInKualaLumpur(),
    });
    const [row] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
    expect(Number(row.amount)).toBe(30); // 100 × 0.30, exactly as before this round
    expect(row.mileageRateApplied).toBeNull(); // nothing to stamp — there was no table
  });

  it('the grade\'s own table is what a GRADED employee is priced on', async () => {
    const a = adminCtx(base);
    const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
    const E = await hireEmployee(a, {
      person: { fullName: 'Exec Driver', primaryEmail: 'execdriver@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await owner.db.update(schema.employment).set({ gradeId: exec }).where(eq(schema.employment.id, E.employmentId));
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    await setClaimPolicy(a, {
      claimTypeId: id,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: '2026-01-01',
      rateConfig: { kind: 'mileage_flat', ratePerKm: 0.3 },
    });
    await setMileageRateTable(a, { claimTypeId: id, effectiveFrom: '2026-01-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.5 }] });
    await setMileageRateTable(a, { claimTypeId: id, gradeId: exec, effectiveFrom: '2026-01-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 1.0 }] });

    const claim = await submitClaim(a, {
      employmentId: E.employmentId,
      claimTypeId: id,
      amount: 0,
      quantityKm: 100,
      incurredOn: todayInKualaLumpur(),
    });
    const [row] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
    expect(Number(row.amount)).toBe(100); // 100 × 1.00 — the Executive table, not the company-wide 0.50
    expect(row.mileageRateApplied).toMatchObject({ source: 'grade', gradeId: exec });
  });
  // ── 4. THE MILEAGE CLAIM TYPE (e7eb5d83 rev 4, points 4 + 5) ─────────────────────────────────────
  //
  // What used to make a claim a mileage claim: its resolved claim_policy carrying
  // rate_config = {kind:'mileage_flat'}. That answer lived on an effective-dated, PER-GRADE row, so two
  // employees on the SAME claim type could be shown different forms, and the Mileage Rates screen had to
  // keep asking which claim type it was configuring — a question with a wrong answer available every time.
  // It is a tick on the claim type now.

  it('at most ONE live claim type per tenant is the mileage claim, and the refusal NAMES the other', async () => {
    const a = adminCtx(base);
    await createClaimType(a, { code: 'MILEAGE', name: 'Mileage', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    const second = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false, isMileage: true }).catch((e) => e);
    // Not a raw unique-violation an admin cannot act on — the message says which one to untick.
    expect((second as Error).message).toMatch(/"Mileage" is already the mileage claim type/);

    // The same guard on the UPDATE path: ticking a second type from its own panel is refused too.
    const other = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false });
    const promoted = await updateClaimType(a, {
      id: other.id,
      name: 'Medical',
      defaultTaxable: false,
      requiresReceipt: false,
      isMileage: true,
    }).catch((e) => e);
    expect((promoted as Error).message).toMatch(/already the mileage claim type/);
  });

  it('unticking one type frees the flag for another (and archiving does too)', async () => {
    const a = adminCtx(base);
    const first = await createClaimType(a, { code: 'MILEAGE', name: 'Mileage', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    await updateClaimType(a, { id: first.id, name: 'Mileage', defaultTaxable: false, requiresReceipt: false, isMileage: false });
    const second = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    expect((await getMileageClaimType(a))?.id).toBe(second.id);

    // The partial unique index excludes archived rows, so retiring a mileage type does not permanently
    // burn the flag for the tenant.
    await archiveClaimType(a, second.id);
    expect(await getMileageClaimType(a)).toBeNull();
    const third = await createClaimType(a, { code: 'MILEAGE2', name: 'Mileage 2', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    expect((await getMileageClaimType(a))?.id).toBe(third.id);
  });

  it('THE TICK, NOT rate_config, prices a mileage claim — banded table, no legacy flat scalar at all', async () => {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Tick Driver', primaryEmail: 'tickdriver@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { id } = await createClaimType(a, { code: 'MILEAGE', name: 'Mileage', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    // A plain RECEIPT policy: before this round that combination made the claim NOT a mileage claim and
    // the banded table would never have been consulted.
    await setClaimPolicy(a, { claimTypeId: id, annualBudget: null, perClaimCap: null, effectiveFrom: '2026-01-01', rateConfig: { kind: 'receipt' } });
    await setMileageRateTable(a, { claimTypeId: id, effectiveFrom: '2026-01-01', bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.8 }] });

    const claim = await submitClaim(a, {
      employmentId: E.employmentId,
      claimTypeId: id,
      amount: 0,
      quantityKm: 50,
      incurredOn: todayInKualaLumpur(),
    });
    const [row] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
    expect(Number(row.amount)).toBe(40); // 50 × 0.80, from the band table
    expect(row.mileageRateApplied).toMatchObject({ source: 'company' });
  });

  it('a type that LOSES the tick goes back to asking for an amount, legacy rate_config or not', async () => {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Ex Driver', primaryEmail: 'exdriver@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { id } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    // The legacy scalar is still sitting on the policy, untouched by the tick coming off.
    await setClaimPolicy(a, {
      claimTypeId: id,
      annualBudget: null,
      perClaimCap: null,
      effectiveFrom: '2026-01-01',
      rateConfig: { kind: 'mileage_flat', ratePerKm: 0.3 },
    });
    // It must be IGNORED rather than demanded: refusing every claim for want of a distance nobody is
    // asked for would be the loud version of this bug, and the silent version is worse.
    const claim = await submitClaim(a, {
      employmentId: E.employmentId,
      claimTypeId: id,
      amount: 25,
      incurredOn: todayInKualaLumpur(),
    });
    const [row] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
    expect(Number(row.amount)).toBe(25);
    expect(row.quantityKm).toBeNull();
  });

  it('marked as mileage with NO rate anywhere refuses with something an employee can act on', async () => {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Rateless', primaryEmail: 'rateless@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { id } = await createClaimType(a, { code: 'MILEAGE', name: 'Mileage', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    const err = await submitClaim(a, {
      employmentId: E.employmentId,
      claimTypeId: id,
      amount: 0,
      quantityKm: 50,
      incurredOn: todayInKualaLumpur(),
    }).catch((e) => e);
    // NOT "Amount must be greater than zero" — that points at a box the mileage form does not show.
    expect((err as Error).message).toMatch(/No mileage rate has been set up/);
  });

  it('THE LIMIT EDITOR IS GONE, and the grid that replaced it asks for no rate at all', () => {
    // e7eb5d83 rev 5 step 3 — this assertion used to read components/claim-limit-editor.tsx and check
    // that its Calculation dropdown had lost the Mileage option but kept Fixed allowance. That component
    // no longer exists: the one-claim-type-at-a-time card was DELETED, not hidden, because leaving it
    // beside the grid would be two ways to write the same row. So the property worth pinning changed
    // shape — it is no longer "which options does the dropdown offer" but "there is no dropdown".
    expect(() => read('components/claim-limit-editor.tsx')).toThrow(/ENOENT/);

    const grid = read('components/claim-limits-grid.tsx');
    const action = read('app/admin/claims/limits/actions.ts');
    for (const src of [grid, action]) {
      // No rate control, no rate parse, no rate posted — the plan's promise that "saving limits will
      // never touch a rate again". It is only SAFE because setClaimPolicyTx inherits rate_config when the
      // caller supplies none (step 1a): a grid Save touches every changed row of a grade, so a screen
      // that posted a default rate would be the fastest way in the product to delete a live mileage rate.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/rateKind/);
      expect(code).not.toMatch(/ratePerKm/);
      expect(code).not.toMatch(/mileage_flat/);
      expect(code).not.toMatch(/fixed_allowance/);
      expect(code).not.toMatch(/rateConfig/);
    }
    // ⚠️ THE CONSEQUENCE, PINNED SO IT CANNOT BE DISCOVERED IN PRODUCTION. Deleting the editor removes the
    // only screen that could SET a fixed_allowance. Existing ones (MOBILE 001, RM180) survive untouched
    // because inheritance carries them forward through every grid Save — that is what this asserts — but
    // there is currently no UI to create a NEW one. It is a deliberate consequence of the approved plan,
    // not an oversight, and re-adding a rate control belongs on Claim Types, not here.
    expect(grid).toMatch(/setGradeClaimLimitsAction/);
  });

  it('the claim FORM designer lives in the claim-type panel, and the Claim Forms tab is gone', () => {
    const panel = read('components/claim-type-panel.tsx');
    expect(panel).toMatch(/builtInAmount/);
    expect(panel).toMatch(/createFieldAction/);
    // No Remove control on a built-in: the four are rendered with a badge, not a button. (The REAL
    // guarantee is BUILT_IN_FIELD_KEYS in the service, asserted above against a forged POST.)
    expect(panel).toMatch(/builtInBadge/);
    const tabs = read('components/claims-tabs.tsx');
    expect(tabs).not.toMatch(/'forms'/);
    // The route survives for bookmarks — as a guarded permanent redirect, which lib/permissions.ts and
    // test/function-access.test.ts both still require to exist on disk.
    const forms = read('app/admin/claims/forms/page.tsx');
    expect(forms).toMatch(/permanentRedirect\('\/admin\/claims'\)/);
    expect(forms).toMatch(/requireAdmin/);
  });

  it('the Claim Types list opens its create form from a disclosure, not permanently', () => {
    const src = read('app/admin/claims/page.tsx');
    expect(src).toMatch(/<details className="group" open=\{error != null\}>/);
    expect(src).toMatch(/addNewType/);
  });
});
