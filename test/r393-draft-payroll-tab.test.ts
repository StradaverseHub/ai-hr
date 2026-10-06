/**
 * r393 — item 685d2380 STEP 2, the draft's Payroll tab: Payment Method and Payroll Policy, AT ACTIVATE.
 *
 * The plan's sentences this file pins:
 *   - "Payment Method is added (Not specified, Bank Transfer, Cheque, Cash) … Bank Transfer needs the bank
 *     and account number on the Bank & Statutory tab; until both are there, the draft's 'still needed'
 *     list says so."                                                                        → §1, §3
 *   - "Payroll Policy is added … your company's active payroll policies, or the Monthly default. It
 *     appears only where Payroll is switched on."                                           → §2, §4
 *   - "Everything entered on the draft … is carried onto the active profile when you press Activate.
 *     Every check is made before the employee is created, so Activate never stops halfway with half an
 *     employee saved."                                                                      → §2, §3
 *
 * §3 asserts ZERO NEW EMPLOYMENT ROWS for every refusal, not merely that something threw: a refusal raised
 * after `hireEmployee` would also throw, and would leave the half-created employee the plan rules out.
 *
 * DECISIONS PINNED HERE (r393):
 *   - PAYROLL OFF + A STORED POLICY → IGNORED, NOT REFUSED (§4). The picker is not shown when Payroll is
 *     off, so a refusal would hold Activate back over a field HR cannot see or clear. The employee
 *     activates on the Monthly default (payroll_policy_id NULL).
 *   - THE COMPANY CANNOT CHANGE ON A DRAFT (fixed since 06f0cb8f; saveEmployeeDraft re-pins it), so there
 *     is nothing for the screen to clear; a blob pairing the draft with ANOTHER company's policy is refused
 *     before anything is written (§3 policy_other_company).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { missingByTab, type EmployeeDraftData } from '../lib/employee-draft-schema';
import { bankTransferLacksBank } from '../lib/payment-methods';
import {
  completeEmployeeDraft,
  DraftPayrollSetupError,
  getEmployeeDraft,
  saveEmployeeDraft,
} from '../core/employee-draft';
import { MissingBankForTransferError } from '../core/org';
import { isModuleEnabledOrFalse } from '../core/entitlements';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

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
afterAll(async () => {
  await closeAll();
});

/** The four Create fields plus the three Activate needs, and nothing else. */
const minimal = (payroll: NonNullable<EmployeeDraftData['payroll']> = {}): EmployeeDraftData => ({
  profile: {
    fullName: 'Payroll Tab',
    employeeCode: `PT${randomUUID().slice(0, 6).toUpperCase()}`,
    employeeIdMode: 'manual',
    primaryEmail: `pt.${randomUUID().slice(0, 8)}@r393.test`,
  },
  employment: { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-03-01' },
  payroll: { basicSalary: '3000', ...payroll },
});

async function policy(p: { companyId?: string; status?: 'active' | 'inactive' } = {}): Promise<string> {
  const [row] = await owner.db
    .insert(schema.payrollPolicy)
    .values({
      tenantId: b.tenantId,
      companyId: p.companyId ?? b.companyId,
      name: `Policy ${randomUUID().slice(0, 6)}`,
      policyType: 'monthly',
      status: p.status ?? 'active',
    })
    .returning({ id: schema.payrollPolicy.id });
  return row.id;
}

async function employmentCount(): Promise<number> {
  const [{ n }] = await owner.db
    .select({ n: count() })
    .from(schema.employment)
    .where(eq(schema.employment.tenantId, b.tenantId));
  return Number(n);
}

async function employmentRow(employmentId: string) {
  const [emp] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
  return emp;
}

// ── §1 the "still needed" rule ──────────────────────────────────────────────────────────────────────
describe('§1 Bank Transfer without bank details is named on the Payroll tab', () => {
  it('names paymentMethodBank for Bank Transfer with no bank, and only then', () => {
    const named = (d: EmployeeDraftData) => missingByTab(d).payroll.includes('paymentMethodBank');
    const base = (statutory: EmployeeDraftData['statutory'], paymentMethod: string): EmployeeDraftData => ({
      statutory,
      payroll: { basicSalary: '1', paymentMethod },
    });
    expect(named(base({}, 'bank_transfer')), 'no bank at all').toBe(true);
    expect(named(base({ bankName: 'Maybank' }, 'bank_transfer')), 'a bank name but no account').toBe(true);
    expect(named(base({ bankAccountNo: '1234' }, 'bank_transfer')), 'an account but no bank name').toBe(true);
    expect(named(base({ bankName: '  ', bankAccountNo: '1234' }, 'bank_transfer')), 'a blank bank name').toBe(true);
    expect(named(base({ bankName: 'Maybank', bankAccountNo: '1234' }, 'bank_transfer')), 'both present').toBe(false);
    expect(named(base({}, 'cheque')), 'cheque needs no bank').toBe(false);
    expect(named(base({}, 'cash')), 'cash needs no bank').toBe(false);
    expect(named(base({}, '')), 'not specified needs no bank').toBe(false);
    expect(named({ payroll: { basicSalary: '1' } }), 'a draft with no payment method').toBe(false);
  });

  it('ONE predicate: the draft rule and the record writer both call bankTransferLacksBank', () => {
    expect(bankTransferLacksBank({ bankName: 'Maybank', bankAccountNo: '1' })).toBe(false);
    expect(bankTransferLacksBank({ bankName: 'Maybank', bankAccountNo: null })).toBe(true);
    const org = read('core/org.ts');
    const at = org.indexOf('export async function setEmploymentPaymentMethod(');
    expect(at, 'setEmploymentPaymentMethod not found').toBeGreaterThanOrEqual(0);
    const writer = org.slice(at, org.indexOf('\n}\n', at));
    expect(writer.length, 'the writer slice parsed empty').toBeGreaterThan(500);
    expect(writer).toContain('bankTransferLacksBank(bank)');
    expect(writer).toContain('throw new MissingBankForTransferError()');
    expect(read('lib/employee-draft-schema.ts')).toContain('bankTransferLacksBank(s)');
    expect(read('core/employee-draft.ts')).toContain('bankTransferLacksBank(s)');
  });
});

// ── §2 the round trip ────────────────────────────────────────────────────────────────────────────────
describe('§2 Payment Method and Payroll Policy land on the activated employment', () => {
  it('Payroll is switched on for the seeded tenant (otherwise §2 and §4 would prove nothing)', () => {
    expect(isModuleEnabledOrFalse(adminCtx(b), 'payroll', b.companyId)).toBe(true);
  });

  it('Cheque and an active policy of the draft company land, through their own writers', async () => {
    const ctx = adminCtx(b);
    const policyId = await policy();
    const { id } = await saveEmployeeDraft(ctx, { data: minimal({ paymentMethod: 'cheque', payrollPolicyId: policyId }), currentStep: 4 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const emp = await employmentRow(employmentId);
    expect(emp.paymentMethod, 'employment.payment_method').toBe('cheque');
    expect(emp.payrollPolicyId, 'employment.payroll_policy_id').toBe(policyId);
    // Through the record's writers, so the audit trail is the record's too.
    const events = await owner.db
      .select({ eventType: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.aggregateId, employmentId)));
    const types = events.map((e) => e.eventType);
    expect(types).toContain('employment.payment-method.changed');
    expect(types).toContain('employment.payroll-policy.assigned');
  });

  it('Bank Transfer lands when the draft carries the bank — the write follows the statutory row', async () => {
    const ctx = adminCtx(b);
    const data = minimal({ paymentMethod: 'bank_transfer' });
    data.statutory = { bankName: 'Maybank', bankAccountNo: '512345678901' };
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 4 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    expect((await employmentRow(employmentId)).paymentMethod, 'employment.payment_method').toBe('bank_transfer');
  });

  it('a draft with NEITHER field activates exactly as before: NULL, NULL, and no event from either writer', async () => {
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data: minimal(), currentStep: 4 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const emp = await employmentRow(employmentId);
    expect(emp.paymentMethod, 'Not specified').toBeNull();
    expect(emp.payrollPolicyId, 'the Monthly default').toBeNull();
    const events = await owner.db
      .select({ eventType: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.aggregateId, employmentId)));
    const types = events.map((e) => e.eventType);
    expect(types).not.toContain('employment.payment-method.changed');
    expect(types).not.toContain('employment.payroll-policy.assigned');
    expect(await getEmployeeDraft(ctx, id), 'the draft is gone').toBeNull();
  });
});

// ── §3 every refusal is made before the employee exists ─────────────────────────────────────────────
describe('§3 each pre-flight refusal throws AND writes no employment', () => {
  /** Activate the draft and require the named refusal, zero new employments, and the draft still there. */
  async function refuses(data: EmployeeDraftData, check: (e: unknown) => void) {
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 4 });
    const before = await employmentCount();
    let caught: unknown = null;
    try {
      await completeEmployeeDraft(ctx, id);
    } catch (e) {
      caught = e;
    }
    expect(caught, 'Activate must refuse').not.toBeNull();
    check(caught);
    expect(await employmentCount(), 'no employment was created').toBe(before);
    expect(await getEmployeeDraft(ctx, id), 'the draft is kept').not.toBeNull();
  }
  const reason = (r: string) => (e: unknown) => {
    expect(e, 'a DraftPayrollSetupError').toBeInstanceOf(DraftPayrollSetupError);
    expect((e as DraftPayrollSetupError).reason).toBe(r);
  };

  it('Bank Transfer with no bank → MissingBankForTransferError, the record writer\'s own error', async () => {
    await refuses(minimal({ paymentMethod: 'bank_transfer' }), (e) => expect(e).toBeInstanceOf(MissingBankForTransferError));
  });
  it('Bank Transfer with half a bank → the same', async () => {
    const data = minimal({ paymentMethod: 'bank_transfer' });
    data.statutory = { bankName: 'Maybank' };
    await refuses(data, (e) => expect(e).toBeInstanceOf(MissingBankForTransferError));
  });
  it('a payment method outside the list → payment_method_invalid', async () => {
    await refuses(minimal({ paymentMethod: 'paypal' }), reason('payment_method_invalid'));
  });
  it('a policy id that names nothing → policy_not_found', async () => {
    await refuses(minimal({ payrollPolicyId: randomUUID() }), reason('policy_not_found'));
  });
  it('a policy "id" that is not an id at all → policy_not_found (not a raw uuid cast error)', async () => {
    await refuses(minimal({ payrollPolicyId: 'monthly' }), reason('policy_not_found'));
  });
  it('an INACTIVE policy of the draft company → policy_inactive', async () => {
    await refuses(minimal({ payrollPolicyId: await policy({ status: 'inactive' }) }), reason('policy_inactive'));
  });
  it('an active policy of ANOTHER company in the tenant → policy_other_company', async () => {
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' })
      .returning({ id: schema.company.id });
    await refuses(minimal({ payrollPolicyId: await policy({ companyId: other.id }) }), reason('policy_other_company'));
  });
});

// ── §4 Payroll switched off ─────────────────────────────────────────────────────────────────────────
describe('§4 where Payroll is switched off, a stored policy is IGNORED (the picker is not shown)', () => {
  it('a valid stored policy is not assigned; the employee activates on the Monthly default', async () => {
    const policyId = await policy();
    await setModule(b.tenantId, 'payroll', 'disabled');
    const ctx = adminCtx(b);
    expect(isModuleEnabledOrFalse(ctx, 'payroll', b.companyId), 'payroll really is off').toBe(false);
    const { id } = await saveEmployeeDraft(ctx, { data: minimal({ payrollPolicyId: policyId, paymentMethod: 'cash' }), currentStep: 4 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const emp = await employmentRow(employmentId);
    expect(emp.payrollPolicyId, 'ignored, not assigned').toBeNull();
    // Payment Method is not Payroll-owned (the record shows it on every tenant), so it still lands.
    expect(emp.paymentMethod).toBe('cash');
  });

  it('even a stored policy that would be REFUSED with Payroll on does not hold Activate back', async () => {
    const policyId = await policy({ status: 'inactive' });
    await setModule(b.tenantId, 'payroll', 'disabled');
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data: minimal({ payrollPolicyId: policyId }), currentStep: 4 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    expect((await employmentRow(employmentId)).payrollPolicyId).toBeNull();
  });
});

// ── §5 wiring ───────────────────────────────────────────────────────────────────────────────────────
describe('§5 the wiring the database tests cannot see', () => {
  it('the draft page offers the draft COMPANY\'s assignable policies, only when Payroll is on', () => {
    const page = read('app/admin/personnel/new/page.tsx');
    expect(page).toContain("isModuleEnabledOrFalse(session, 'payroll', draftCompanyId)");
    expect(page).toContain('listAssignablePolicies(session, draftCompanyId)');
    expect(page).toContain("from '@/packs/payroll/service'");
    expect(page).toContain('payrollOn={payrollOn}');
    expect(page).toContain('payrollPolicies={payrollPolicies}');
  });

  it('activation writes the two fields AFTER the statutory write and BEFORE the draft is deleted', () => {
    const src = read('core/employee-draft.ts');
    const start = src.indexOf('export async function completeEmployeeDraft(');
    expect(start, 'completeEmployeeDraft not found').toBeGreaterThanOrEqual(0);
    const fn = src.slice(start, src.indexOf('\n}\n', start));
    expect(fn.length, 'the function slice parsed empty').toBeGreaterThan(5000);
    const at = (needle: string) => {
      const i = fn.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const hire = at('await hireEmployee(ctx');
    const statutory = at('await pack.statutory.set(ctx');
    const method = at('await setEmploymentPaymentMethod(ctx');
    const assign = at('await assignPolicy(ctx');
    const policyCheck = at("throw new DraftPayrollSetupError('policy_inactive')");
    const bankCheck = at('throw new MissingBankForTransferError()');
    const del = at('tx.delete(employeeDraft)');
    expect(policyCheck, 'policy judged before the hire').toBeLessThan(hire);
    expect(bankCheck, 'bank judged before the hire').toBeLessThan(hire);
    expect(statutory, 'statutory before payment method').toBeLessThan(method);
    expect(method).toBeLessThan(del);
    expect(assign).toBeLessThan(del);
  });
});
