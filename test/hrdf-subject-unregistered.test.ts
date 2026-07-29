/**
 * r79 — "Subject to HRDF = Yes" at a company that is NOT registered for HRD Corp.
 *
 * Production evidence: two employees carry an explicit Yes at unregistered companies; one of those
 * companies processed EIGHT payrolls in that state. The payslip recorded them as subject and then
 * levied zero, and nothing said so at the moment it mattered — the only signal was a warning on the
 * employee's own Bank & Statutory screen, which nobody is looking at while they run payroll.
 *
 * What is deliberately NOT changed: the levy. r75 settled that hrdfLevy is correct — an unregistered
 * employer genuinely owes nothing — and the guards below re-pin that (the levy figure on a registered
 * company is untouched, and the zero on an unregistered one stays zero). The fault was silence.
 *
 * Three guards, matching the three changes:
 *   (A) RUN-LEVEL CHECK — preProcessAdvisory / preProcessAdvisoryForSelection name every in-scope
 *       employee whose explicit Yes cannot take effect, and name nobody when it can. WARNS, never
 *       blocks: generatePayslips still produces the payslip, but generateAction refuses to proceed
 *       without an explicit acknowledgement, so it cannot ride through unseen a ninth time.
 *   (B) PAYSLIP STAMP — an unchargeable Yes no longer stamps `hrdfSubject: true` beside a structural
 *       zero. The slip records the EFFECTIVE false plus what HR actually set and why it was
 *       suppressed, so the audit trail gains information rather than losing it.
 *   (C) NO ISSUED PAYSLIP IS ALTERED — the stamp change lives inside the payslip INSERT, so it reaches
 *       future runs only; a closed run's stored blob is byte-identical after the new check runs over it.
 *
 * Plus the source-static + i18n guards the surfaces need (the group lists are rendered through a
 * COMPUTED key, `t(`preChecks.${key}`)`, which the i18n coverage guard's check C cannot see at all).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setOthersStatutoryMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import {
  BatchNotDraftError,
  closeBatch,
  createBatch,
  generatePayslips,
  preProcessAdvisory,
  preProcessAdvisoryForSelection,
} from '../core/payroll';
import { generateAction } from '../app/payroll/actions';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// generateAction resolves its own session/translations and always redirects; mirror the wiring the
// other action-driving suites use so the redirect target is observable instead of fatal.
let SESSION: SessionContext;
let LAST_REDIRECT = '';
vi.mock('../lib/session', () => ({ getSession: async () => SESSION }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const at = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

const PERIOD = '2026-05';
let base: Base;

/** A fully-set-up employee: salary + statutory profile + bank, so the ONLY advisory row an employee can
 *  contribute is the HRDF contradiction (a half-filled fixture would make the warning counts unreadable). */
async function hireComplete(a: SessionContext, name: string, ic: string) {
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@hrdf79.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 4000,
    monthlyAllowance: 500,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(a, {
    personId: e.personId,
    icNumber: ic,
    bankName: 'Maybank',
    bankAccountNo: '1234567890',
  });
  return e;
}

const slipFor = async (batchId: string, employmentId: string) => {
  const [ps] = await owner.db
    .select()
    .from(schema.payslip)
    .where(eq(schema.payslip.employmentId, employmentId));
  expect(ps.batchId).toBe(batchId);
  return ps;
};
const st = (ps: { statutory: unknown }) => ps.statutory as Record<string, unknown>;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  LAST_REDIRECT = '';
});
afterAll(async () => {
  await closeAll();
});

describe('(A) run-level check — the contradiction is named where the run happens', () => {
  it('names the employee whose explicit Yes cannot take effect, and only that employee', async () => {
    const a = await entitledCtx(base);
    // No company_statutory_my row at all — exactly the live state of six of eight companies (the kernel
    // defaults such a company to not_registered, so the levy is structurally impossible).
    const yes = await hireComplete(a, 'Hrdf Explicit Yes', '900101015041');
    const no = await hireComplete(a, 'Hrdf Explicit No', '900101015042');
    const untouched = await hireComplete(a, 'Hrdf Untouched', '900101015043');
    await setOthersStatutoryMY(a, { personId: yes.personId, subjectToHrdf: true });
    await setOthersStatutoryMY(a, { personId: no.personId, subjectToHrdf: false });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(a, batchId);

    expect((checks.hrdfSubjectUnregistered ?? []).map((r) => r.employmentId)).toEqual([yes.employmentId]);
    // An explicit No is no contradiction (the employee is excluded either way), and a null row simply
    // FOLLOWS the unregistered default — flagging either would be a false alarm on six of eight companies.
    const flagged = (checks.hrdfSubjectUnregistered ?? []).map((r) => r.employmentId);
    expect(flagged).not.toContain(no.employmentId);
    expect(flagged).not.toContain(untouched.employmentId);
    // The row carries what the operator needs to act: who, and their code.
    expect((checks.hrdfSubjectUnregistered ?? [])[0].name).toBe('Hrdf Explicit Yes');
    // Nothing else about this fixture is wrong — no blocker, and no other warning class fires.
    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.zeroBasic ?? []).toHaveLength(0);
    expect(checks.missingStatutory).toHaveLength(0);
    expect(checks.missingBank).toHaveLength(0);
  });

  it('says nothing once the company IS registered — the check is about registration, not the tick', async () => {
    const a = await entitledCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    const yes = await hireComplete(a, 'Hrdf Registered Yes', '900101015044');
    await setOthersStatutoryMY(a, { personId: yes.personId, subjectToHrdf: true });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(a, batchId);
    expect(checks.hrdfSubjectUnregistered ?? []).toHaveLength(0);
  });

  it('reaches the Process wizard too — preProcessAdvisoryForSelection MERGES the list, before any batch exists', async () => {
    // The wizard's Validation step renders the same groups off preProcessAdvisoryForSelection; a list the
    // per-company core produces but the merge drops would be a warning that exists and never appears.
    const a = await entitledCtx(base);
    const yes = await hireComplete(a, 'Hrdf Wizard Yes', '900101015045');
    await setOthersStatutoryMY(a, { personId: yes.personId, subjectToHrdf: true });

    const checks = await preProcessAdvisoryForSelection(a, {
      companyIds: [base.companyId],
      payPeriod: PERIOD,
    });
    expect((checks.hrdfSubjectUnregistered ?? []).map((r) => r.employmentId)).toEqual([yes.employmentId]);
  });

  it('WARNS, it does not REFUSE: the kernel still pays the run', async () => {
    // The decision, pinned. Refusing would strand a payroll on a data-quality issue the operator often
    // cannot fix in the moment (completing an HRD Corp registration is not a five-minute job), and the
    // people in the run still need paying. The levy is correctly zero either way — nothing is mispaid.
    const a = await entitledCtx(base);
    const yes = await hireComplete(a, 'Hrdf Pay Me', '900101015046');
    await setOthersStatutoryMY(a, { personId: yes.personId, subjectToHrdf: true });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await expect(generatePayslips(a, { batchId })).resolves.toBeDefined();
    const ps = await slipFor(batchId, yes.employmentId);
    expect(Number(ps.netPay)).toBeGreaterThan(0);
  });

  it('but generation requires an EXPLICIT acknowledgement — silence is exactly what failed for eight runs', async () => {
    const a = await entitledCtx(base);
    SESSION = a;
    const yes = await hireComplete(a, 'Hrdf Ack', '900101015047');
    await setOthersStatutoryMY(a, { personId: yes.personId, subjectToHrdf: true });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });

    const submit = async (ack: boolean) => {
      const f = new FormData();
      f.set('batchId', batchId);
      if (ack) f.set('ackWarnings', '1');
      LAST_REDIRECT = '';
      await expect(generateAction(f)).rejects.toThrow('NEXT_REDIRECT');
      return LAST_REDIRECT;
    };

    // Unacknowledged: bounced back to the run with the confirm-required message, and NO payslip written.
    expect(await submit(false)).toContain('error=preChecksConfirmRequired');
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(0);
    // Acknowledged: the run proceeds. Warn-and-proceed, with the operator having had to see it.
    expect(await submit(true)).toContain('toast=');
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(1);
  });
});

describe('(B) payslip stamp — the slip no longer contradicts itself', () => {
  it('an unchargeable Yes records subject=false, keeps the levy at zero, and preserves what HR set and why it was suppressed', async () => {
    const a = await entitledCtx(base);
    const yes = await hireComplete(a, 'Hrdf Suppressed', '900101015048');
    await setOthersStatutoryMY(a, { personId: yes.personId, subjectToHrdf: true });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });

    const ps = await slipFor(batchId, yes.employmentId);
    // THE FIX: the slip used to say `hrdfSubject: true` here, beside a levy that can never be non-zero.
    expect(st(ps).hrdfSubject).toBe(false);
    // The operator's intent is not erased — it is recorded, with the reason it could not take effect.
    expect(st(ps).hrdfSubjectSet).toBe(true);
    expect(st(ps).hrdfSubjectSuppressed).toBe('company_not_registered');
    // The LEVY is untouched by all of this (r75: an unregistered employer owes nothing).
    expect(st(ps).hrdf).toBe(0);
    const [batch] = await owner.db
      .select()
      .from(schema.payrollBatch)
      .where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBe(0);
    // Employer cost carries no levy either: wages + employer statutory only.
    const expected =
      4500 + Number(st(ps).epfEmployer) + Number(st(ps).socsoEmployer) + Number(st(ps).eisEmployer);
    expect(Number(ps.employerCost)).toBeCloseTo(expected, 2);
  });

  it('a REGISTERED company is byte-identical: subject=true, the 1% levy, and no suppression keys', async () => {
    const a = await entitledCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    const yes = await hireComplete(a, 'Hrdf Charged', '900101015049');
    await setOthersStatutoryMY(a, { personId: yes.personId, subjectToHrdf: true });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });

    const ps = await slipFor(batchId, yes.employmentId);
    expect(st(ps).hrdfSubject).toBe(true);
    expect('hrdfSubjectSet' in st(ps)).toBe(false);
    expect('hrdfSubjectSuppressed' in st(ps)).toBe(false);
    // Base 4000 + 500 fixed allowance → 1% = 45.00, the figure signed off in test/hrdf-subject.test.ts.
    expect(st(ps).hrdf).toBeCloseTo(45, 2);
  });

  it('an explicit NO and an untouched flag are unchanged at an unregistered company', async () => {
    const a = await entitledCtx(base);
    const no = await hireComplete(a, 'Hrdf No', '900101015050');
    const untouched = await hireComplete(a, 'Hrdf Null', '900101015051');
    await setOthersStatutoryMY(a, { personId: no.personId, subjectToHrdf: false });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });

    // An explicit No still stamps the effective false — it was never a contradiction, so no suppression.
    const noSlip = await slipFor(batchId, no.employmentId);
    expect(st(noSlip).hrdfSubject).toBe(false);
    expect('hrdfSubjectSuppressed' in st(noSlip)).toBe(false);
    expect(st(noSlip).hrdf).toBe(0);
    // A null row keeps NO key at all — the pre-flag snapshot, byte for byte.
    const nullSlip = await slipFor(batchId, untouched.employmentId);
    expect('hrdfSubject' in st(nullSlip)).toBe(false);
    expect('hrdfSubjectSet' in st(nullSlip)).toBe(false);
    expect(st(nullSlip).hrdf).toBe(0);
  });
});

describe('(C) no issued payslip is altered', () => {
  it('a CLOSED run keeps its stored statutory blob exactly, and cannot be regenerated', async () => {
    const a = await entitledCtx(base);
    const yes = await hireComplete(a, 'Hrdf Issued', '900101015052');
    await setOthersStatutoryMY(a, { personId: yes.personId, subjectToHrdf: true });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });

    const before = JSON.stringify((await slipFor(batchId, yes.employmentId)).statutory);
    // The new run-level check is a pure read, and the stamp change lives inside the payslip INSERT — a
    // closed run has no INSERT to reach. Re-running the advisory over it changes nothing…
    await preProcessAdvisory(a, batchId);
    // …and regeneration is refused outright by the batch-status gate (assert the CLASS, not any throw).
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(BatchNotDraftError);
    expect(JSON.stringify((await slipFor(batchId, yes.employmentId)).statutory)).toBe(before);
  });
});

describe('(D) the surfaces render it, and say it in six languages', () => {
  it('the batch pre-checks card lists the group as a WARNING and counts it among the confirm-to-proceed warnings', () => {
    const PAGE = read('app/payroll/[batchId]/page.tsx');
    expect(PAGE).toContain("['hrdfSubjectUnregistered', preChecks.hrdfSubjectUnregistered ?? [], false]");
    expect(PAGE).toContain('(preChecks.hrdfSubjectUnregistered?.length ?? 0)');
    // It must NOT reach the blocker tally — that would refuse the run, which is the decision we did not take.
    const blockerLine = PAGE.slice(PAGE.indexOf('const preBlockers ='), PAGE.indexOf('const preWarnings ='));
    expect(blockerLine).not.toContain('hrdfSubjectUnregistered');
  });

  it('the Process wizard Validation step lists it as a warning too', () => {
    const STEP = read('app/payroll/process/steps/step-validation.tsx');
    expect(STEP).toContain("['hrdfSubjectUnregistered', advisory.hrdfSubjectUnregistered ?? [], false]");
    expect(STEP).toContain('(advisory.hrdfSubjectUnregistered?.length ?? 0)');
    const blockerLine = STEP.slice(STEP.indexOf('const blockers ='), STEP.indexOf('// 297ae65a'));
    expect(blockerLine).not.toContain('hrdfSubjectUnregistered');
  });

  it('generateAction gates on it as a warning, never as a blocker', () => {
    const ACTIONS = read('app/payroll/actions.ts');
    expect(ACTIONS).toContain('(checks.hrdfSubjectUnregistered?.length ?? 0)');
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function generateAction'), ACTIONS.indexOf('export async function setPayrollInputAction'));
    const blockerLine = fn.slice(fn.indexOf('const blockers ='), fn.indexOf('// 297ae65a'));
    expect(blockerLine).not.toContain('hrdfSubjectUnregistered');
  });

  it('the employee card says it BEFORE the tick is set, without disturbing the post-save warning', () => {
    const PAGE = read('app/admin/personnel/[employmentId]/page.tsx');
    const card = PAGE.slice(PAGE.indexOf('const othersStatutoryCard'), PAGE.indexOf('const tp3Card'));
    // efece4ce's stored-Yes warning is untouched…
    expect(card).toContain('statutory?.subjectToHrdf === true && companyHrdfUnregistered');
    // …and the pre-emptive note covers the case it cannot: the choice has not been made yet.
    expect(card).toContain('statutory?.subjectToHrdf !== true && companyHrdfUnregistered');
    expect(card).toContain("{t('subjectToHrdfCompanyUnregisteredNote')}");
    // 57840a6e must not regress: the company band still never reaches the select's initial state.
    const select = card.slice(card.indexOf('<select'), card.indexOf('</select>'));
    expect(select).not.toContain('companyHrdf');
  });

  it('carries every new key in all six locales — the group labels are COMPUTED keys the i18n guard cannot see', () => {
    const keys = [
      'payroll.batch.preChecks.hrdfSubjectUnregistered',
      'payroll.process.validationCheck.hrdfSubjectUnregistered',
      'people.detail.subjectToHrdfCompanyUnregisteredNote',
    ];
    for (const loc of LOCALES) {
      const msg = JSON.parse(read(`messages/${loc}.json`));
      for (const k of keys) {
        const v = at(msg, k);
        expect(typeof v, `messages/${loc}.json missing ${k}`).toBe('string');
        expect((v as string).trim().length, `messages/${loc}.json ${k} empty`).toBeGreaterThan(0);
      }
    }
  });
});
