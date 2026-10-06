/**
 * r393 — item 685d2380 STEP 3b, the draft's Statutory (Malaysia) section, AT ACTIVATE. MONEY-AFFECTING.
 *
 * The plan's sentences this file pins ("Bank & Statutory tab", second bullet, and "For all three tabs"):
 *   - "That adds the EPF rate and amount boxes, Subject to SKBBK, Employer bears tax contribution and the full
 *     list of income tax residency choices."                                         → §1, §3, §5
 *   - "Everything entered on the draft … is carried onto the active profile when you press Activate."
 *                                                                                      → §1, §3, §5
 *   - "Every check is made before the employee is created, so Activate never stops halfway."  → §2
 *
 * §1 IS THE PARITY CLAIM, and it is made against the REAL Active action, not a restatement of it: the same
 * raw strings are activated on a draft AND posted to `setStatutoryAction` (the Personnel Bank & Statutory
 * form's own server action), and the six EPF columns of the two rows must be IDENTICAL, for every category.
 * The units are the form's: rates in PERCENT as typed (`mapEpfUiMode` divides by 100), amounts in RINGGIT.
 *
 * §2 asserts ZERO NEW EMPLOYMENT ROWS for every refusal, not merely that something threw: the statutory
 * writer would also refuse — AFTER `hireEmployee` had committed, leaving the half-created employee the plan
 * rules out. §4 pins that a draft with NONE of the new keys activates exactly as before, column by column,
 * against the writer calls the pre-r393 activation made (reproduced verbatim from d358d909).
 */
import { randomUUID } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { missingByTab, type EmployeeDraftData } from '../lib/employee-draft-schema';
import { mapEpfUiMode } from '../lib/epf-mode-map';
import { InvalidEpfElectionError } from '../localization/my/statutory';
import { myClientPack } from '../localization/my/client';
import {
  completeEmployeeDraft,
  DraftStatutorySetupError,
  getEmployeeDraft,
  saveEmployeeDraft,
} from '../core/employee-draft';
import { hireEmployee } from '../core/org';
import { packFor } from '../localization/registry';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// The Active action needs a session (requireAdmin) and Next's redirect/revalidate; the harness has neither.
let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
const { setStatutoryAction } = await import('../app/admin/personnel/[employmentId]/actions');

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
  LAST_REDIRECT = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await closeAll();
});

type Statutory = NonNullable<EmployeeDraftData['statutory']>;

/** The four Create fields plus the three Activate needs, and the statutory section given. */
const minimal = (statutory?: Statutory): EmployeeDraftData => ({
  profile: {
    fullName: 'Statutory Draft',
    employeeCode: `SD${randomUUID().slice(0, 6).toUpperCase()}`,
    employeeIdMode: 'manual',
    primaryEmail: `sd.${randomUUID().slice(0, 8)}@r393.test`,
  },
  employment: { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-03-01' },
  ...(statutory ? { statutory } : {}),
  payroll: { basicSalary: '3000' },
});

async function employmentCount(): Promise<number> {
  const [{ n }] = await owner.db
    .select({ n: count() })
    .from(schema.employment)
    .where(eq(schema.employment.tenantId, b.tenantId));
  return Number(n);
}

async function personOf(employmentId: string): Promise<string> {
  const [emp] = await owner.db
    .select({ personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return emp.personId;
}

async function statutoryOf(employmentId: string) {
  const personId = await personOf(employmentId);
  const [row] = await owner.db
    .select()
    .from(schema.employeeStatutoryMy)
    .where(eq(schema.employeeStatutoryMy.personId, personId));
  return row;
}

async function selectionOf(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.employmentTaxSelectionMy)
    .where(
      and(eq(schema.employmentTaxSelectionMy.tenantId, b.tenantId), eq(schema.employmentTaxSelectionMy.employmentId, employmentId)),
    );
  return row;
}

async function activate(data: EmployeeDraftData) {
  const ctx = adminCtx(b);
  const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 3 });
  const { employmentId } = await completeEmployeeDraft(ctx, id);
  return { id, employmentId };
}

const epfColumns = (row: Awaited<ReturnType<typeof statutoryOf>>) => ({
  epfMode: row.epfMode,
  epfEmployeeRate: row.epfEmployeeRate,
  epfEmployerRate: row.epfEmployerRate,
  epfEmployeeAmount: row.epfEmployeeAmount,
  epfEmployerAmount: row.epfEmployerAmount,
  epfManualReason: row.epfManualReason,
});

/** Post the Personnel Bank & Statutory form's EPF fields, as strings, to the REAL Active action. */
async function saveThroughActiveAction(employmentId: string, epf: Record<string, string | undefined>) {
  const fd = new FormData();
  fd.set('employmentId', employmentId);
  fd.set('personId', await personOf(employmentId));
  fd.set('epfCitizenship', 'citizen');
  // The form posts only the boxes the category RENDERS (an unrendered input posts nothing), so an
  // undefined value is simply not appended — exactly the browser's behaviour.
  for (const [k, v] of Object.entries(epf)) if (v !== undefined) fd.set(k, v);
  await expect(setStatutoryAction(fd)).rejects.toThrow('NEXT_REDIRECT');
  expect(LAST_REDIRECT, `the Active action saved (redirect was ${LAST_REDIRECT})`).toContain('toast=Saved');
}

// ── §1 Active-vs-draft parity, per category ─────────────────────────────────────────────────────────
describe('§1 the same strings on the draft and through the Active action give IDENTICAL EPF columns', () => {
  // Each case is what a person types; the draft stores the strings, the Active form posts them. Boxes the
  // category does not show are given LEFT-BEHIND values on the draft (a previous category's figures) —
  // the form would not post them, and the draft must not store them either.
  const CASES: Record<string, { draft: Statutory; posted: Record<string, string | undefined>; expect: ReturnType<typeof epfColumns> }> = {
    auto: {
      draft: { epfMode: 'auto', epfEmployeeRate: '15', epfEmployeeAmount: '700' },
      posted: { epfMode: 'auto' },
      expect: { epfMode: 'auto', epfEmployeeRate: null, epfEmployerRate: null, epfEmployeeAmount: null, epfEmployerAmount: null, epfManualReason: null },
    },
    manual_percentage: {
      draft: { epfMode: 'manual_percentage', epfEmployeeRate: '14.5', epfEmployerRate: '16', epfEmployeeAmount: '900' },
      posted: { epfMode: 'manual_percentage', epfEmployeeRate: '14.5', epfEmployerRate: '16' },
      expect: { epfMode: 'voluntary_excess', epfEmployeeRate: '0.1450', epfEmployerRate: '0.1600', epfEmployeeAmount: null, epfEmployerAmount: null, epfManualReason: null },
    },
    'manual_percentage, employer box blank': {
      draft: { epfMode: 'manual_percentage', epfEmployeeRate: '12', epfEmployerRate: '' },
      posted: { epfMode: 'manual_percentage', epfEmployeeRate: '12', epfEmployerRate: '' },
      expect: { epfMode: 'voluntary_excess', epfEmployeeRate: '0.1200', epfEmployerRate: null, epfEmployeeAmount: null, epfEmployerAmount: null, epfManualReason: null },
    },
    semi_auto: {
      draft: { epfMode: 'semi_auto', epfEmployeeRate: '20', epfEmployerRate: '18' },
      posted: { epfMode: 'semi_auto', epfEmployeeRate: '20' },
      expect: { epfMode: 'voluntary_excess', epfEmployeeRate: '0.2000', epfEmployerRate: null, epfEmployeeAmount: null, epfEmployerAmount: null, epfManualReason: null },
    },
    manual_employee_amount: {
      draft: { epfMode: 'manual_employee_amount', epfEmployeeAmount: '450.5', epfEmployerAmount: '999', epfManualReason: 'Pre-1998 member', epfEmployeeRate: '15' },
      posted: { epfMode: 'manual_employee_amount', epfEmployeeAmount: '450.5', epfManualReason: 'Pre-1998 member' },
      expect: { epfMode: 'manual_amount', epfEmployeeRate: null, epfEmployerRate: null, epfEmployeeAmount: '450.50', epfEmployerAmount: null, epfManualReason: 'Pre-1998 member' },
    },
    manual_employer_amount: {
      draft: { epfMode: 'manual_employer_amount', epfEmployerAmount: '612', epfEmployeeAmount: '1', epfManualReason: 'Agreed with KWSP' },
      posted: { epfMode: 'manual_employer_amount', epfEmployerAmount: '612', epfManualReason: 'Agreed with KWSP' },
      expect: { epfMode: 'manual_amount', epfEmployeeRate: null, epfEmployerRate: null, epfEmployeeAmount: null, epfEmployerAmount: '612.00', epfManualReason: 'Agreed with KWSP' },
    },
    manual_both_amount: {
      draft: { epfMode: 'manual_both_amount', epfEmployeeAmount: '300', epfEmployerAmount: '390.25', epfManualReason: '  Grandfathered  ' },
      posted: { epfMode: 'manual_both_amount', epfEmployeeAmount: '300', epfEmployerAmount: '390.25', epfManualReason: '  Grandfathered  ' },
      expect: { epfMode: 'manual_amount', epfEmployeeRate: null, epfEmployerRate: null, epfEmployeeAmount: '300.00', epfEmployerAmount: '390.25', epfManualReason: 'Grandfathered' },
    },
    'manual_both_amount, employee box blank': {
      draft: { epfMode: 'manual_both_amount', epfEmployeeAmount: '', epfEmployerAmount: '410', epfManualReason: 'One side only' },
      posted: { epfMode: 'manual_both_amount', epfEmployeeAmount: '', epfEmployerAmount: '410', epfManualReason: 'One side only' },
      expect: { epfMode: 'manual_amount', epfEmployeeRate: null, epfEmployerRate: null, epfEmployeeAmount: null, epfEmployerAmount: '410.00', epfManualReason: 'One side only' },
    },
    'none (exempt)': {
      draft: { epfMode: 'none', epfEmployeeRate: '15', epfEmployeeAmount: '100', epfManualReason: 'stale' },
      posted: { epfMode: 'none' },
      expect: { epfMode: 'exempt', epfEmployeeRate: null, epfEmployerRate: null, epfEmployeeAmount: null, epfEmployerAmount: null, epfManualReason: null },
    },
  };

  for (const [name, c] of Object.entries(CASES)) {
    it(`${name}: draft and Active action store the same six EPF columns`, async () => {
      const viaDraft = await activate(minimal({ epfNumber: '11223344', ...c.draft }));
      const draftRow = epfColumns(await statutoryOf(viaDraft.employmentId));
      // The Active side: an employee whose statutory row exists, then the record's own form saved.
      const other = await activate(minimal({ epfNumber: '55667788' }));
      await saveThroughActiveAction(other.employmentId, c.posted);
      const activeRow = epfColumns(await statutoryOf(other.employmentId));
      expect(draftRow, `${name}: draft row`).toEqual(c.expect);
      expect(activeRow, `${name}: Active row`).toEqual(c.expect);
      expect(draftRow, `${name}: PARITY draft vs Active`).toEqual(activeRow);
    });
  }

  it('UNITS: a rate box is PERCENT (13 → 0.1300) and an amount box is RINGGIT (13 → 13.00), on both paths', () => {
    expect(mapEpfUiMode('manual_percentage', '13', '13').epfEmployeeRate, 'percent ÷ 100').toBe(0.13);
    expect(mapEpfUiMode('manual_employee_amount', null, null, '13', null, 'r').epfEmployeeAmount, 'ringgit unscaled').toBe(13);
  });
});

// ── §2 every refusal is made before the employee exists ─────────────────────────────────────────────
describe('§2 an EPF election the writer would refuse is refused before hireEmployee, writing nothing', () => {
  async function refuses(statutory: Statutory, field: string, Err: typeof InvalidEpfElectionError | typeof DraftStatutorySetupError = InvalidEpfElectionError) {
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data: minimal(statutory), currentStep: 3 });
    const before = await employmentCount();
    let caught: unknown = null;
    try {
      await completeEmployeeDraft(ctx, id);
    } catch (e) {
      caught = e;
    }
    expect(caught, `Activate must refuse (${field})`).toBeInstanceOf(Err);
    expect(await employmentCount(), `no employment was created (${field})`).toBe(before);
    expect(await getEmployeeDraft(ctx, id), `the draft is kept (${field})`).not.toBeNull();
    // …and the tab names the same box, through the CLIENT pack's copy of the SAME rule.
    expect(missingByTab({ statutory }, myClientPack.statutory).bankStatutory, `the tab names ${field}`).toContain(field);
    return caught;
  }

  it('a rate below the statutory floor (employee 10%)', async () => {
    await refuses({ epfMode: 'manual_percentage', epfEmployeeRate: '10', epfEmployerRate: '13' }, 'epfEmployeeRate');
  });
  it('an employer rate below its floor (semi-auto cannot carry one, manual percentage at 11%)', async () => {
    await refuses({ epfMode: 'manual_percentage', epfEmployeeRate: '11', epfEmployerRate: '11' }, 'epfEmployerRate');
  });
  it('a rate over 100%', async () => {
    await refuses({ epfMode: 'semi_auto', epfEmployeeRate: '101' }, 'epfEmployeeRate');
  });
  it('a negative amount', async () => {
    await refuses({ epfMode: 'manual_employee_amount', epfEmployeeAmount: '-5', epfManualReason: 'x' }, 'epfEmployeeAmount');
  });
  it('a manual category with no amount on either side', async () => {
    await refuses({ epfMode: 'manual_both_amount', epfEmployeeAmount: '', epfEmployerAmount: '  ', epfManualReason: 'x' }, 'epfEmployeeAmount');
    await refuses({ epfMode: 'manual_employer_amount', epfManualReason: 'x' }, 'epfEmployerAmount');
  });
  it('a manual category with no reason', async () => {
    await refuses({ epfMode: 'manual_employee_amount', epfEmployeeAmount: '500', epfManualReason: '   ' }, 'epfManualReason');
  });
  it('Position C-Suites with a Malaysian-citizen (or unset) EPF citizenship', async () => {
    const e = await refuses({ taxResidency: 'c_suite', taxNumber: 'SG1' }, 'taxResidency', DraftStatutorySetupError);
    expect((e as DraftStatutorySetupError).reason).toBe('tax_residency_citizenship');
    await refuses({ taxResidency: 'c_suite', epfCitizenship: 'citizen' }, 'taxResidency', DraftStatutorySetupError);
  });
  it('a residency that is not one of the five choices', async () => {
    const e = await refuses({ taxResidency: 'expat' }, 'taxResidency', DraftStatutorySetupError);
    expect((e as DraftStatutorySetupError).reason).toBe('tax_residency_invalid');
  });
});

// ── §3 a blank box is null, never zero ──────────────────────────────────────────────────────────────
describe('§3 a blank box stays statutory (null), never 0% or RM0.00', () => {
  it('blank and whitespace RATE boxes on Manual (By Percentage) activate with that side statutory', async () => {
    // Number('') and Number('   ') are 0 — a parse of the box would have refused this as 0% < 11%.
    const { employmentId } = await activate(minimal({ epfMode: 'manual_percentage', epfEmployeeRate: '   ', epfEmployerRate: '' }));
    const row = await statutoryOf(employmentId);
    expect(row.epfMode, 'epf_mode').toBe('voluntary_excess');
    expect(row.epfEmployeeRate, 'epf_employee_rate — blank is statutory').toBeNull();
    expect(row.epfEmployerRate, 'epf_employer_rate — blank is statutory').toBeNull();
    expect(missingByTab(minimal({ epfMode: 'manual_percentage', epfEmployeeRate: '   ' }), myClientPack.statutory).bankStatutory).toEqual([]);
  });

  it('a blank AMOUNT box on the side a category asks for is null, not 0.00', async () => {
    const { employmentId } = await activate(
      minimal({ epfMode: 'manual_both_amount', epfEmployeeAmount: '520', epfEmployerAmount: ' ', epfManualReason: 'Agreed' }),
    );
    const row = await statutoryOf(employmentId);
    expect(row.epfEmployeeAmount, 'epf_employee_amount').toBe('520.00');
    expect(row.epfEmployerAmount, 'epf_employer_amount — blank is null, not 0.00').toBeNull();
  });

  it('EPF boxes the category does not use conjure no statutory row on their own', async () => {
    const { employmentId } = await activate(minimal({ epfEmployeeRate: '15', epfEmployeeAmount: '200' }));
    expect(await statutoryOf(employmentId), 'no statutory row').toBeUndefined();
  });
});

// ── §5 the new switches and the residency land ──────────────────────────────────────────────────────
describe('§5 Subject to SKBBK, Employer bears tax contribution and the income tax residency land', () => {
  it('subjectToSkbbk and employerBearsTax yes → true', async () => {
    const { employmentId } = await activate(minimal({ subjectToSkbbk: 'yes', employerBearsTax: 'yes', taxNumber: 'SG 777' }));
    const row = await statutoryOf(employmentId);
    expect(row.subjectToSkbbk, 'employee_statutory_my.subject_to_skbbk').toBe(true);
    expect(row.employerBearsTax, 'employee_statutory_my.employer_bears_tax').toBe(true);
    expect(row.taxNumber, 'the tax writer was handed the tax number back').toBe('SG 777');
  });

  it("'no' lands as false, and absent leaves both at the new-employee defaults", async () => {
    const a = await statutoryOf((await activate(minimal({ subjectToSkbbk: 'no', employerBearsTax: 'no' }))).employmentId);
    expect(a.subjectToSkbbk).toBe(false);
    expect(a.employerBearsTax).toBe(false);
    const c = await statutoryOf((await activate(minimal({ epfNumber: '1' }))).employmentId);
    expect(c.subjectToSkbbk, 'absent ⇒ default false').toBe(false);
    expect(c.employerBearsTax, 'absent ⇒ default false').toBe(false);
  });

  it('taxResidency non_resident: hire selection, is_resident and tax_residency all non-resident', async () => {
    const { employmentId } = await activate(minimal({ taxResidency: 'non_resident' }));
    const row = await statutoryOf(employmentId);
    expect(row.isResident, 'is_resident').toBe(false);
    expect(row.taxResidency, 'tax_residency').toBe('non_resident');
    const sel = await selectionOf(employmentId);
    expect(sel.scheme, 'employment_tax_selection_my.scheme').toBe('non_resident');
    expect(sel.transitionState).toBe('resolved');
  });

  for (const scheme of ['rep', 'knowledge_worker'] as const) {
    it(`taxResidency ${scheme}: the employer-scoped selection is moved onto it, resolved`, async () => {
      const { employmentId } = await activate(minimal({ taxResidency: scheme, taxNumber: 'SG 42' }));
      const sel = await selectionOf(employmentId);
      expect(sel.scheme, 'employment_tax_selection_my.scheme').toBe(scheme);
      expect(sel.transitionState, 'transition_state').toBe('resolved');
      const row = await statutoryOf(employmentId);
      expect(row.isResident, 'an incentive scheme is resident').toBe(true);
      expect(row.taxNumber).toBe('SG 42');
    });
  }

  it('taxResidency c_suite with a non-citizen EPF citizenship lands', async () => {
    const { employmentId } = await activate(minimal({ taxResidency: 'c_suite', epfCitizenship: 'non_citizen' }));
    expect((await selectionOf(employmentId)).scheme).toBe('c_suite');
    expect((await statutoryOf(employmentId)).epfCitizenship).toBe('non_citizen');
  });

  it('LEGACY isResident maps forward when there is no taxResidency (no → non_resident, yes → resident)', async () => {
    const no = await activate(minimal({ isResident: 'no', epfNumber: '1' }));
    expect((await statutoryOf(no.employmentId)).isResident, 'isResident no').toBe(false);
    expect((await selectionOf(no.employmentId)).scheme, 'isResident no → non_resident selection').toBe('non_resident');
    const yes = await activate(minimal({ isResident: 'yes', epfNumber: '2' }));
    expect((await statutoryOf(yes.employmentId)).isResident, 'isResident yes').toBe(true);
    expect((await selectionOf(yes.employmentId)).scheme).toBe('resident');
  });

  it('an explicit taxResidency WINS over a legacy isResident', async () => {
    const { employmentId } = await activate(minimal({ isResident: 'no', taxResidency: 'resident' }));
    expect((await statutoryOf(employmentId)).isResident, 'explicit resident beats legacy no').toBe(true);
    expect((await selectionOf(employmentId)).scheme).toBe('resident');
    const k = await activate(minimal({ isResident: 'no', taxResidency: 'knowledge_worker' }));
    expect((await selectionOf(k.employmentId)).scheme, 'explicit knowledge_worker beats legacy no').toBe('knowledge_worker');
  });

  it('"Not subject to income tax" makes a stored residency moot: not judged, not moved', async () => {
    const { employmentId } = await activate(minimal({ taxCategory: 'none', taxResidency: 'c_suite' }));
    const row = await statutoryOf(employmentId);
    expect(row.taxCircumstance).toBe('none');
    expect((await selectionOf(employmentId)).scheme, 'the hire-time selection stays').toBe('resident');
  });
});

// ── §4 a draft with none of the new keys is unchanged, column by column ────────────────────────────
describe('§4 a draft with NONE of the new keys activates exactly as before', () => {
  // A pre-r393 draft: every statutory key it could hold, none of the r393 ones.
  const LEGACY: Statutory = {
    bankName: 'Maybank',
    bankAccountNo: '512345678901',
    epfNumber: '11223344',
    socsoNumber: '990101105577',
    taxNumber: 'SG 12345678901',
    taxCategory: '2',
    numChildren: '1',
    socsoCategory: 'first',
    eisEligible: 'no',
    isResident: 'no',
    epfCitizenship: 'pr',
    epfMode: 'semi_auto',
    employerBearsEpf: 'yes',
    employerBearsSocso: 'no',
    employerBearsEis: 'yes',
    employerBearsSkbbk: 'no',
    disabledIndividual: 'yes',
    disabledSpouse: 'no',
    childReliefMode: 'manual',
  };

  it('every employee_statutory_my column equals the row the pre-r393 writer calls produce', async () => {
    const viaDraft = await activate(minimal(LEGACY));
    const ctx = adminCtx(b);
    const pack = packFor('MY')!;
    // THE REFERENCE: the hire and the two writer calls d358d909's completeEmployeeDraft made for this draft,
    // with its helpers' answers written out (str/numOrUndef/boolOrUndef/citizenship of the values above).
    const ref = await hireEmployee(ctx, {
      initialTaxScheme: 'non_resident',
      person: { fullName: 'Reference', primaryEmail: `ref.${randomUUID().slice(0, 8)}@r393.test` },
      employeeCode: `RF${randomUUID().slice(0, 6).toUpperCase()}`,
      companyId: b.companyId,
      departmentId: b.deptA,
      gradeId: null,
      employmentType: 'full_time',
      hiredOn: '2026-03-01',
      provisionalEndOn: null,
      grantLeaveTypes: [],
    });
    await pack.statutory.set(ctx, {
      personId: ref.personId,
      icNumber: null,
      epfNumber: '11223344',
      socsoNumber: pack.statutory.defaultSocsoEisNumber({ socsoNumber: '990101105577', icNumber: undefined, nationality: undefined }),
      taxNumber: 'SG 12345678901',
      taxCategory: 2,
      numChildren: 1,
      socsoCategory: 'first',
      eisCategory: 'none',
      isResident: false,
      epfCitizenship: 'pr',
      ...mapEpfUiMode('semi_auto', null, null, null, null, null),
      employerBearsEpf: true,
      employerBearsSocso: false,
      employerBearsEis: true,
      employerBearsSkbbk: false,
      bankName: 'Maybank',
      bankAccountNo: '512345678901',
    });
    await pack.statutory.setTax(ctx, {
      personId: ref.personId,
      disabledIndividual: true,
      disabledSpouse: false,
      childReliefMode: 'manual',
      taxNumber: 'SG 12345678901',
      taxCategory: 2,
      numChildren: 1,
      taxResidency: 'non_resident',
    });
    const strip = (r: Awaited<ReturnType<typeof statutoryOf>>) => {
      const { id: _id, personId: _p, createdAt: _c, updatedAt: _u, ...rest } = r;
      return rest;
    };
    const got = strip(await statutoryOf(viaDraft.employmentId));
    const want = strip(await statutoryOf(ref.employmentId));
    for (const col of Object.keys(want) as (keyof typeof want)[])
      expect(got[col], `employee_statutory_my.${String(col)}`).toEqual(want[col]);
    const [gs, ws] = [await selectionOf(viaDraft.employmentId), await selectionOf(ref.employmentId)];
    expect([gs.scheme, gs.transitionState, gs.source], 'employment_tax_selection_my').toEqual([ws.scheme, ws.transitionState, ws.source]);
  });

  it('and the pack writers receive exactly the pre-r393 arguments: setTax is not called without a relief', async () => {
    const setTax = vi.spyOn(packFor('MY')!.statutory, 'setTax');
    await activate(minimal({ epfNumber: '11223344', isResident: 'no', employerBearsEpf: 'yes' }));
    expect(setTax, 'no relief, no new key ⇒ no tax write, as before').not.toHaveBeenCalled();
  });
});
