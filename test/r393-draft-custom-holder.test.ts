/**
 * r393 — item 685d2380 STEP 3a, the draft's custom payment holder, AT ACTIVATE.
 *
 * The plan's sentences this file pins ("Bank & Statutory tab", first bullet):
 *   - "Bank Information on the draft gets the same 'Use a custom holder name' and 'Use a custom holder
 *     identification' ticks as the active profile."                                      (DOM file)
 *   - "Ticking one opens its box; a ticked box must be filled in before the employee can be activated."
 *                                                                                         → §1, §3
 *   - "Everything entered is carried onto the active profile at Activate; every check is made before the
 *     employee is created."                                                               → §2, §3, §4
 *
 * §3 asserts ZERO NEW EMPLOYMENT ROWS for every refusal, not merely that something threw: `setBank` itself
 * would also refuse, AFTER `hireEmployee` had committed, leaving the half-created employee the plan rules out.
 * §5 pins that a draft with no holder keys activates exactly as before — four columns at their defaults and
 * `setBank` never called (spied on the pack object `requirePackFor` hands `completeEmployeeDraft`).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { draftCustomHolder, missingByTab, type EmployeeDraftData } from '../lib/employee-draft-schema';
import { customHolderGaps, IncompleteCustomHolderError } from '../lib/custom-holder';
import { IncompleteCustomHolderError as PackIncompleteCustomHolderError } from '../localization/my/statutory';
import { completeEmployeeDraft, getEmployeeDraft, saveEmployeeDraft } from '../core/employee-draft';
import { packFor } from '../localization/registry';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await closeAll();
});

/** The four Create fields plus the three Activate needs, and the statutory section given. */
const minimal = (statutory?: NonNullable<EmployeeDraftData['statutory']>): EmployeeDraftData => ({
  profile: {
    fullName: 'Custom Holder',
    employeeCode: `CH${randomUUID().slice(0, 6).toUpperCase()}`,
    employeeIdMode: 'manual',
    primaryEmail: `ch.${randomUUID().slice(0, 8)}@r393.test`,
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

async function statutoryOf(employmentId: string) {
  const [emp] = await owner.db
    .select({ personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  const [row] = await owner.db
    .select()
    .from(schema.employeeStatutoryMy)
    .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
  return row;
}

async function bankEvents(): Promise<number> {
  const [{ n }] = await owner.db
    .select({ n: count() })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'employee.bank.updated')));
  return Number(n);
}

async function activate(data: EmployeeDraftData) {
  const ctx = adminCtx(b);
  const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 3 });
  const { employmentId } = await completeEmployeeDraft(ctx, id);
  return { id, employmentId };
}

// ── §1 the "still needed" rule ──────────────────────────────────────────────────────────────────────
describe('§1 a ticked custom holder box left blank is named on the Bank & Statutory tab', () => {
  const named = (statutory: EmployeeDraftData['statutory']) => missingByTab({ statutory }).bankStatutory;

  it('names customHolderName / customHolderId for a ticked blank box, and only then', () => {
    expect(named({ enableCustomHolderName: 'yes' }), 'name ticked, no value').toEqual(['customHolderName']);
    expect(named({ enableCustomHolderName: 'yes', customHolderName: '   ' }), 'name ticked, spaces').toEqual(['customHolderName']);
    expect(named({ enableCustomHolderId: 'yes', customHolderId: '' }), 'id ticked, empty').toEqual(['customHolderId']);
    expect(named({ enableCustomHolderName: 'yes', enableCustomHolderId: 'yes' }), 'both ticked, both blank').toEqual([
      'customHolderName',
      'customHolderId',
    ]);
    expect(named({ enableCustomHolderName: 'yes', customHolderName: 'Siti' }), 'name ticked and filled').toEqual([]);
    expect(named({ enableCustomHolderName: 'no' }), 'name un-ticked, blank').toEqual([]);
    expect(named({ customHolderId: '' }), 'no tick at all').toEqual([]);
    expect(named({}), 'nothing').toEqual([]);
  });

  it('a value is carried only while its tick is on', () => {
    expect(draftCustomHolder({ enableCustomHolderName: 'no', customHolderName: 'Left behind' })).toEqual({
      enableCustomHolderName: false,
      customHolderName: null,
      enableCustomHolderId: false,
      customHolderId: null,
    });
    expect(draftCustomHolder({ enableCustomHolderId: 'yes', customHolderId: '  910202025050 ' }).customHolderId).toBe(
      '910202025050',
    );
  });

  it('ONE predicate and ONE error: the draft rule, the pre-flight and the pack setter all use customHolderGaps', () => {
    expect(customHolderGaps({ enableCustomHolderName: true, customHolderName: ' ' })).toEqual(['name']);
    expect(PackIncompleteCustomHolderError, 'the pack re-exports the lib class').toBe(IncompleteCustomHolderError);
    const stat = read('localization/my/statutory.ts');
    const at = stat.indexOf('export async function setBankProfileMY(');
    expect(at, 'setBankProfileMY not found').toBeGreaterThanOrEqual(0);
    const writer = stat.slice(at, stat.indexOf('\n}\n', at));
    expect(writer.length, 'the writer slice parsed empty').toBeGreaterThan(500);
    expect(writer).toContain('customHolderGaps(');
    expect(writer).toContain('throw new IncompleteCustomHolderError(gap)');
    expect(read('lib/employee-draft-schema.ts')).toContain('customHolderGaps(draftCustomHolder(s))');
    const core = read('core/employee-draft.ts');
    expect(core).toContain('customHolderGaps(holder)');
    // Reached through the pack, never by importing localization/my into core/.
    expect(core).toContain('pack.statutory.setBank(ctx,');
    expect(core).not.toMatch(/from '\.\.\/localization\/my\//);
  });
});

// ── §2 the round trip ────────────────────────────────────────────────────────────────────────────────
describe('§2 everything entered lands on the active profile', () => {
  it('both holders ticked and filled: all four columns land, with distinct values, and the bank survives', async () => {
    const { employmentId } = await activate(
      minimal({
        bankName: 'Maybank',
        bankAccountNo: '512345678901',
        epfNumber: '11223344',
        enableCustomHolderName: 'yes',
        customHolderName: 'Siti Spouse',
        enableCustomHolderId: 'yes',
        customHolderId: '910202025050',
      }),
    );
    const row = await statutoryOf(employmentId);
    expect(row, 'a statutory row exists').toBeTruthy();
    expect(row.enableCustomHolderName, 'employee_statutory_my.enable_custom_holder_name').toBe(true);
    expect(row.customHolderName, 'employee_statutory_my.custom_holder_name').toBe('Siti Spouse');
    expect(row.enableCustomHolderId, 'employee_statutory_my.enable_custom_holder_id').toBe(true);
    expect(row.customHolderId, 'employee_statutory_my.custom_holder_id').toBe('910202025050');
    // setBank is a total write of the bank columns: it must have been handed the SAME bank just stored.
    expect(row.bankName, 'employee_statutory_my.bank_name survives setBank').toBe('Maybank');
    expect(row.bankAccountNo, 'employee_statutory_my.bank_account_no survives setBank').toBe('512345678901');
    expect(row.epfNumber, 'the rest of the statutory row is untouched').toBe('11223344');
    expect(await bankEvents(), 'through the record writer, so its audit event too').toBe(1);
  });

  it('a holder is the ONLY statutory value on the draft: the row is created, then the holder lands', async () => {
    const { employmentId } = await activate(minimal({ enableCustomHolderId: 'yes', customHolderId: 'A1234567' }));
    const row = await statutoryOf(employmentId);
    expect(row, 'a ticked holder needs a statutory row').toBeTruthy();
    expect(row.enableCustomHolderId).toBe(true);
    expect(row.customHolderId).toBe('A1234567');
    expect(row.enableCustomHolderName).toBe(false);
    expect(row.customHolderName).toBeNull();
  });
});

// ── §3 every refusal is made before the employee exists ─────────────────────────────────────────────
describe('§3 a ticked blank box is refused before hireEmployee, writing nothing', () => {
  async function refuses(data: EmployeeDraftData, field: 'name' | 'id') {
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 3 });
    const before = await employmentCount();
    let caught: unknown = null;
    try {
      await completeEmployeeDraft(ctx, id);
    } catch (e) {
      caught = e;
    }
    expect(caught, 'Activate must refuse').toBeInstanceOf(IncompleteCustomHolderError);
    expect((caught as IncompleteCustomHolderError).field, 'the refusal names the box').toBe(field);
    expect(await employmentCount(), 'no employment was created').toBe(before);
    expect(await getEmployeeDraft(ctx, id), 'the draft is kept').not.toBeNull();
  }

  it('name ticked, box blank', async () => {
    await refuses(minimal({ bankName: 'Maybank', bankAccountNo: '5123', enableCustomHolderName: 'yes', customHolderName: '  ' }), 'name');
  });
  it('identification ticked, box absent', async () => {
    await refuses(minimal({ enableCustomHolderId: 'yes' }), 'id');
  });
});

// ── §4 a tick that is off carries nothing ───────────────────────────────────────────────────────────
describe('§4 a box whose tick is off is not carried', () => {
  it('name on, identification off with a value left in its box: the id column is NULL', async () => {
    const { employmentId } = await activate(
      minimal({
        bankName: 'CIMB Bank',
        bankAccountNo: '8001234567',
        enableCustomHolderName: 'yes',
        customHolderName: 'Authorised Payee',
        enableCustomHolderId: 'no',
        customHolderId: 'LEFT-BEHIND',
      }),
    );
    const row = await statutoryOf(employmentId);
    expect(row.enableCustomHolderName).toBe(true);
    expect(row.customHolderName).toBe('Authorised Payee');
    expect(row.enableCustomHolderId, 'enable_custom_holder_id').toBe(false);
    expect(row.customHolderId, 'custom_holder_id — the un-ticked value is not carried').toBeNull();
  });

  it('both off, values left behind, a bank on the draft: columns default, setBank never called', async () => {
    const setBank = vi.spyOn(packFor('MY')!.statutory, 'setBank');
    const { employmentId } = await activate(
      minimal({
        bankName: 'Maybank',
        bankAccountNo: '5123',
        enableCustomHolderName: 'no',
        customHolderName: 'Stale Name',
        customHolderId: 'Stale Id',
      }),
    );
    const row = await statutoryOf(employmentId);
    expect(row.customHolderName, 'custom_holder_name').toBeNull();
    expect(row.customHolderId, 'custom_holder_id').toBeNull();
    expect(row.enableCustomHolderName).toBe(false);
    expect(row.enableCustomHolderId).toBe(false);
    expect(setBank, 'setBank is not called with no tick on').not.toHaveBeenCalled();
  });

  it('both off and NOTHING else statutory: an un-ticked box conjures no statutory row', async () => {
    const { employmentId } = await activate(minimal({ enableCustomHolderName: 'no', customHolderName: 'Stale Name' }));
    expect(await statutoryOf(employmentId), 'no statutory row').toBeUndefined();
  });
});

// ── §5 a draft with no holder keys is unchanged ─────────────────────────────────────────────────────
describe('§5 a draft with no holder keys activates exactly as before', () => {
  it('the four columns stay at their defaults and setBank is not called', async () => {
    const setBank = vi.spyOn(packFor('MY')!.statutory, 'setBank');
    const { employmentId, id } = await activate(minimal({ bankName: 'Maybank', bankAccountNo: '512345678901' }));
    const row = await statutoryOf(employmentId);
    expect(row.bankName).toBe('Maybank');
    expect(row.enableCustomHolderName, 'enable_custom_holder_name').toBe(false);
    expect(row.customHolderName, 'custom_holder_name').toBeNull();
    expect(row.enableCustomHolderId, 'enable_custom_holder_id').toBe(false);
    expect(row.customHolderId, 'custom_holder_id').toBeNull();
    expect(setBank, 'setBank not called').not.toHaveBeenCalled();
    expect(await bankEvents(), 'no employee.bank.updated event').toBe(0);
    expect(await getEmployeeDraft(adminCtx(b), id), 'the draft is gone').toBeNull();
  });

  it('a draft with no statutory section at all still creates no statutory row', async () => {
    const { employmentId } = await activate(minimal());
    expect(await statutoryOf(employmentId)).toBeUndefined();
  });
});
