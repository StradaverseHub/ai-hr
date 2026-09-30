/**
 * r369 (item eb949191) — A BASIC SALARY OF ZERO IS ALLOWED, AND PAYROLL SKIPS THE MONTH INSTEAD OF
 * BLOCKING THE COMPANY OR PAYING BELOW ZERO.
 *
 * THE HISTORY THIS FILE HAS TO CARRY. We raised the item ourselves and proposed REFUSING a zero basic
 * salary at the point of entry. The reporter rejected that: a Director paid Director Fees quarterly has no
 * monthly basic, and refusing the zero forces HR to invent a figure. What they specified instead, and what
 * this file pins, is three things:
 *
 *   1. ZERO OR BLANK IS ACCEPTED, once whoever saves it types a REMARK saying why. That remark is the only
 *      thing left of our refusal, and the kernel never reads it to decide money.
 *   2. EVERY MONTH, PER PERSON, PAYROLL ASKS "is there anything to pay them?" Nothing at all ⇒ they are
 *      left out of that month. Something ⇒ they are paid normally, from what was actually keyed.
 *   3. BEING LEFT OUT IS NEVER SILENT. Three surfaces, all pinned here.
 *
 * ── THE LOAD-BEARING ASSERTION, AND WHY IT IS A FIGURE AND NOT A FEELING ────────────────────────────
 * The alternative to skipping is not a harmless zero payslip. `bandFor` returns the FIRST band for a wage
 * of nothing and never falls off the bottom of the table, and `statDeductions` is explicitly never clamped,
 * so a gross of zero produces a NET BELOW ZERO — and files a zero wage with PERKESO for a month nobody was
 * paid. Arm 3 asserts that payslip and its exact net against a REAL processed run, in both statutory
 * configurations, so nobody can "simplify" the predicate later on the belief that a zero-gross payslip
 * costs nothing. It is reached through an HOURLY employee with a positive rate and no worked hours — a
 * shape the kernel still processes today and deliberately does NOT skip (rate × time is the only thing that
 * could pay them, so their record is not the no-monthly-basic case).
 *
 * ── WHAT IS DELIBERATELY *NOT* CHANGED, PINNED HERE SO A LATER ROUND CANNOT DRIFT IT ───────────────
 *   • A DAILY employee with no rate still BLOCKS the run (arm 5). That refusal was never in dispute.
 *   • A SUBSET REPROCESS NEVER SKIPS. It names the person and points at Remove (arm 6), because
 *     `subsetIds` is derived from `emps` and the payslip delete is keyed off it — filtering somebody out
 *     would strand their old payslip on the run with nothing saying why.
 *   • `zeroBasic` KEEPS ITS NAME. It now means the rate leg only; renaming it would churn the
 *     `4ca06dea` bitmask parity guard across three files to say the same four terms.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  NonFiniteSalaryAmountError,
  SalaryRemarkRequiredError,
  setCompensation,
  unpayableSalaryLeg,
  updateCompensation,
} from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  PreProcessBlockedError,
  ReprocessAddBlockedError,
  ReprocessNothingPayableError,
  createBatch,
  generatePayslips,
  listPayslipLessEligible,
  preProcessAdvisory,
  preProcessAdvisoryForSelection,
  setPayrollDeductionInput,
  type PayrollSkipReason,
} from '../core/payroll';
import { listSkippedEmployees, narrowToNothingPayable, pendingBatchMoney } from '../core/payroll-view';
import { createIndividualTxnsBulk } from '../core/payroll-individual-txn';
import { seedPayComponentCatalog, setEmploymentPayComponent } from '../core/pay-components';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
const LOCALES = Object.keys(CATALOGUES) as (keyof typeof CATALOGUES)[];

const PERIOD = '2026-05';
const DIRECTOR_REMARK = 'Paid by quarterly director fees — no monthly basic';

let base: Base;
let icSeq = 0;
const nextIc = () => `900101${String(410000 + icSeq++).padStart(6, '0')}`;

/** Every gate this round's money doors live behind, granted BEFORE the snapshot is taken. */
const typedCtx = async () => {
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
  return entitledCtx(base);
};

async function hire(
  a: Awaited<ReturnType<typeof entitledCtx>>,
  name: string,
  comp: {
    basicSalary: number;
    monthlyAllowance?: number;
    payMode?: string;
    rateAmount?: number;
    remarks?: string;
  },
  stat: { subjectToSkbbk?: boolean } = {},
) {
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `r369_${randomUUID().slice(0, 8)}@zb.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    monthlyAllowance: 0,
    effectiveFrom: '2024-01-01',
    ...comp,
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc(), ...stat });
  return e;
}

const slipsOn = (batchId: string) =>
  owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
const compRow = async (employmentId: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.compensation)
    .where(and(eq(schema.compensation.employmentId, employmentId), isNull(schema.compensation.validTo)));
  return row;
};
const componentId = async (code: string) => {
  const [row] = await owner.db
    .select({ id: schema.payComponent.id })
    .from(schema.payComponent)
    .where(eq(schema.payComponent.code, code))
    .limit(1);
  if (!row) throw new Error(`pay component ${code} not seeded`);
  return row.id;
};
const skippedOf = (g: Awaited<ReturnType<typeof generatePayslips>>) =>
  'skipped' in g && Array.isArray(g.skipped) ? g.skipped : [];

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  icSeq = 0;
});
afterAll(async () => {
  await closeAll();
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE PREDICATE, AND THE TWO LEGS PARTING COMPANY (pure)
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('r369 · unpayableSalaryLeg — one predicate, two legs, opposite consequences', () => {
  it('daily/hourly answer on the RATE and every other mode on the BASIC', () => {
    // The rate leg. basic_salary is the monthly-EQUIVALENT figure for statutory reads on these modes, so a
    // positive basic must not rescue a missing rate — that is the direction the old combined check got right
    // and the direction a "simplification" would break.
    expect(unpayableSalaryLeg('daily', 4600, 0)).toBe('missing_rate');
    expect(unpayableSalaryLeg('daily', 4600, null)).toBe('missing_rate');
    expect(unpayableSalaryLeg('hourly', 4600, 0)).toBe('missing_rate');
    expect(unpayableSalaryLeg('daily', 0, 250)).toBeNull();
    expect(unpayableSalaryLeg('hourly', 0, 20)).toBeNull();
    // The monthly leg — and a missing rate is irrelevant to it.
    expect(unpayableSalaryLeg('monthly', 0, null)).toBe('no_monthly_basic');
    expect(unpayableSalaryLeg('monthly', null, null)).toBe('no_monthly_basic');
    expect(unpayableSalaryLeg('custom_period', 0, null)).toBe('no_monthly_basic');
    expect(unpayableSalaryLeg('monthly', 4000, null)).toBeNull();
  });
});

describe('r369 · every skip reason the kernel can stamp is one the screens can name', () => {
  // TRAP #1, PINNED AT THE SOURCE. `listSkippedEmployees` coerces an UNRECOGNISED reason to
  // NO_TRANSACTION_FOR_CYCLE so an event written by an older build degrades gracefully. That same fallback
  // silently RELABELS any new `PayrollSkipReason` that is not listed in its recogniser — on every screen,
  // with no type error and no failing test anywhere else. So the union and the recogniser are extracted from
  // the real source and compared as sets.
  const unionMembers = (): string[] => {
    const src = readFileSync(new URL('../core/payroll.ts', import.meta.url), 'utf8');
    const m = /export type PayrollSkipReason =([\s\S]*?);/.exec(src);
    expect(m, 'PayrollSkipReason declaration not found').toBeTruthy();
    return [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  };
  const recognisedMembers = (): string[] => {
    const src = readFileSync(new URL('../core/payroll-view.ts', import.meta.url), 'utf8');
    const m = /RECOGNISED_SKIP_REASONS[^=]*= new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m, 'RECOGNISED_SKIP_REASONS declaration not found').toBeTruthy();
    return [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  };

  it('the union in core/payroll.ts and the recogniser in core/payroll-view.ts are the SAME set', () => {
    const union = unionMembers();
    expect(union).toContain('NOTHING_PAYABLE_THIS_PERIOD');
    expect(union).toContain('DEDUCTION_ONLY_THIS_PERIOD');
    expect([...recognisedMembers()].sort()).toEqual([...union].sort());
  });

  it('every reason has a DISTINCT sentence on both screens, in all six locales', () => {
    // i18n/request.ts deep-merges each locale over English, so a key missing from ms.json renders the
    // ENGLISH sentence and looks fine on screen. These read the raw catalogues, unmerged.
    for (const reason of unionMembers()) {
      for (const l of LOCALES) {
        const c = CATALOGUES[l] as unknown as {
          payroll: { batch: { skipped: { reason: Record<string, string> } }; process: { skipReason: Record<string, string> } };
        };
        expect(c.payroll.batch.skipped.reason[reason], `${l} batch.skipped.reason.${reason}`).toBeTruthy();
        expect(c.payroll.process.skipReason[reason], `${l} process.skipReason.${reason}`).toBeTruthy();
      }
    }
    for (const reason of ['NOTHING_PAYABLE_THIS_PERIOD', 'DEDUCTION_ONLY_THIS_PERIOD'] as const) {
      const values = LOCALES.map(
        (l) => (CATALOGUES[l] as unknown as { payroll: { batch: { skipped: { reason: Record<string, string> } } } }).payroll.batch.skipped.reason[reason],
      );
      expect(new Set(values).size, values.join(' | ')).toBe(LOCALES.length);
    }
  });
});

describe('r369 · the "additional run" prose that asserted the old rule is gone', () => {
  // A regular run can now skip, so a note opening "This is an additional run, so …" is FALSE on the very
  // screen it is printed on. Reworded in place (never deleted — the keys are live) in all six locales.
  it('neither skipped-employees note claims the run must be an additional one, in any locale', () => {
    for (const l of LOCALES) {
      const c = CATALOGUES[l] as unknown as {
        payroll: { batch: { skipped: { note: string } }; process: { skippedEmployeesNote: string } };
      };
      for (const [where, text] of [
        ['batch.skipped.note', c.payroll.batch.skipped.note],
        ['process.skippedEmployeesNote', c.payroll.process.skippedEmployeesNote],
      ] as const) {
        expect(text, `${l} ${where}`).toBeTruthy();
        // English is checkable by wording; every locale is checkable by the English word it would have to
        // borrow, because none of the five translations of "additional run" contains the Latin word.
        expect(text.toLowerCase(), `${l} ${where}`).not.toContain('additional run');
      }
    }
    expect(en.payroll.batch.skipped.note.toLowerCase()).not.toMatch(/this is an additional/);
    expect(en.payroll.process.skippedEmployeesNote.toLowerCase()).not.toMatch(/this is an additional/);
    // And the five translations really were touched, not left as the English fallback.
    for (const field of [
      (c: typeof en) => c.payroll.batch.skipped.note,
      (c: typeof en) => c.payroll.process.skippedEmployeesNote,
    ]) {
      const values = LOCALES.map((l) => field(CATALOGUES[l] as unknown as typeof en));
      expect(new Set(values).size, values.join(' | ')).toBe(LOCALES.length);
    }
  });

  it('the badge LEGEND quotes its own namespace\u2019s three labels, on both screens, in all six locales', () => {
    // r369 introduced a THIRD badge state, so each screen carries a legend saying what the three mean.
    // The legend quotes the labels VERBATIM, which is a drift hazard worth pinning rather than avoiding:
    // reword a badge and the legend silently starts naming a badge that is no longer on the screen.
    //
    // PER NAMESPACE, NOT PER LOCALE, and that distinction is real rather than defensive: `ta` and `th`
    // already spell the BLOCKER badge differently in payroll.batch and payroll.process
    // ("\u0b9a\u0bc6\u0baf\u0bb2\u0bbe\u0b95\u0bcd\u0b95\u0ba4\u0bcd\u0ba4\u0bc8\u0ba4\u0bcd" vs "\u0b9a\u0bc6\u0baf\u0bb2\u0bbe\u0b95\u0bcd\u0b95\u0ba4\u0bcd\u0ba4\u0bc8"; "\u0e02\u0e27\u0e32\u0e07" vs "\u0e02\u0e31\u0e14\u0e02\u0e27\u0e32\u0e07"), so one shared legend
    // string would be wrong on one of the two screens in two locales.
    type Cat = {
      payroll: {
        batch: Record<string, string>;
        process: Record<string, string>;
      };
    };
    for (const l of LOCALES) {
      const c = CATALOGUES[l] as unknown as Cat;
      for (const [ns, legendKey, labelKeys] of [
        ['payroll.batch', 'preChecksBadgeLegend', ['preChecksBlockerBadge', 'preChecksWarningBadge', 'preChecksNoticeBadge']],
        ['payroll.process', 'validationBadgeLegend', ['validationBlockerBadge', 'validationWarningBadge', 'validationNoticeBadge']],
      ] as const) {
        const grp = ns === 'payroll.batch' ? c.payroll.batch : c.payroll.process;
        const legend = grp[legendKey];
        expect(legend, `${l} ${ns}.${legendKey}`).toBeTruthy();
        for (const k of labelKeys) {
          expect(legend, `${l} ${ns}.${legendKey} does not quote ${k} ("${grp[k]}")`).toContain(grp[k]);
        }
      }
    }
    // Six genuinely different sentences, not the English fallback five times over.
    for (const pick of [
      (c: Cat) => c.payroll.batch.preChecksBadgeLegend,
      (c: Cat) => c.payroll.process.validationBadgeLegend,
    ]) {
      const values = LOCALES.map((l) => pick(CATALOGUES[l] as unknown as Cat));
      expect(new Set(values).size, values.join(' | ')).toBe(LOCALES.length);
    }
  });

  it('the reworded zeroBasic sentence names the daily/hourly case and no longer says "basic salary … is zero"', () => {
    // The identifier is historical and stays; the SENTENCE is what an operator reads, and it must not tell
    // them a monthly basic of zero blocks the run, because it no longer does.
    expect(en.payroll.batch.preChecks.zeroBasic).toMatch(/daily|hourly/i);
    expect(en.payroll.process.validationCheck.zeroBasic).toMatch(/daily|hourly/i);
    expect(en.payroll.batch.preChecks.zeroBasic).not.toBe('Basic salary or pay rate is zero');
  });
});

describe('r369 · every new message FORMATS, in every locale', () => {
  /**
   * THE §8 GAP THIS CLOSES, STATED RATHER THAN PAPERED OVER. A malformed ICU string throws
   * FORMATTING_ERROR at RENDER time and returns a 200 with the block missing — invisible to tsc, to
   * `next build` and to a key-presence assertion. The dev-server render for this round covers the payroll
   * RUN screen (both states), but the Process wizard's Validation step is a CLIENT component reached only
   * by walking the wizard, so its copy never reaches a server log at all. The formatter is RUN here instead.
   */
  it('no locale leaves a placeholder unrendered or falls back to the key', async () => {
    const { createTranslator } = await import('next-intl');
    // ⚠️ `onError` IS LOAD-BEARING: next-intl swallows MISSING_MESSAGE / FORMATTING_ERROR by default and
    // hands back the key, so an assertion on the output alone would pass on a broken string.
    const boom = (e: unknown) => {
      throw e;
    };
    for (const l of LOCALES) {
      const messages = CATALOGUES[l] as unknown as Record<string, unknown>;
      const tb = createTranslator({ locale: l, messages, namespace: 'payroll.batch', onError: boom as never });
      const tp = createTranslator({ locale: l, messages, namespace: 'payroll.process', onError: boom as never });
      const check = (ns: string, key: string, out: string) => {
        expect(out, `${l}.${ns}.${key}`).toBeTruthy();
        expect(out, `${l}.${ns}.${key} did not resolve`).not.toContain(ns);
        expect(out, `${l}.${ns}.${key} left ICU unrendered`).not.toMatch(/[{}]/);
      };
      for (const [key, n] of [
        ['preChecksNothingPayableHint', 1],
        ['preChecksNothingPayableHint', 7],
      ] as const) {
        const out = tb(key as never, { n } as never);
        check('payroll.batch', key, out);
        expect(out, `${l}.${key}`).toContain(String(n));
      }
      for (const n of [1, 7]) {
        const out = tp('validationNothingPayableTitle' as never, { n } as never);
        check('payroll.process', 'validationNothingPayableTitle', out);
        expect(out).toContain(String(n));
      }
      const remark = tb('preChecksNothingPayableRemark' as never, { remarks: DIRECTOR_REMARK } as never);
      check('payroll.batch', 'preChecksNothingPayableRemark', remark);
      expect(remark).toContain(DIRECTOR_REMARK);
      for (const key of [
        'preChecksBadgeLegend',
        'preChecksNoticeBadge',
        'preChecksNothingPayableNoRemark',
        'preChecks.nothingPayable',
        'reprocessGapNothingPayable',
        'reprocessReasonNothingPayable',
        'skipped.note',
        'skipped.reason.NOTHING_PAYABLE_THIS_PERIOD',
        'skipped.reason.DEDUCTION_ONLY_THIS_PERIOD',
      ] as const) {
        check('payroll.batch', key, (tb as (k: never) => string)(key as never));
      }
      for (const key of [
        'validationBadgeLegend',
        'validationNoticeBadge',
        'validationNothingPayableHint',
        'validationCheck.nothingPayable',
        'skippedEmployeesNote',
        'skipReason.NOTHING_PAYABLE_THIS_PERIOD',
        'skipReason.DEDUCTION_ONLY_THIS_PERIOD',
      ] as const) {
        check('payroll.process', key, (tp as (k: never) => string)(key as never));
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE WRITE PATH — THE CONFIRMATION GESTURE AND THE NaN TRAP
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('r369 · setCompensation / updateCompensation', () => {
  it('a zero basic with NO remark is refused, and nothing is stored', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Noremark Nora', primaryEmail: `r369_${randomUUID().slice(0, 8)}@zb.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await expect(
      setCompensation(a, { employmentId: e.employmentId, basicSalary: 0, monthlyAllowance: 0, effectiveFrom: '2024-01-01' }),
    ).rejects.toBeInstanceOf(SalaryRemarkRequiredError);
    // Read the STORE back, not the return value: the refusal has to happen before the insert.
    expect(await compRow(e.employmentId)).toBeUndefined();
  });

  it('a zero basic WITH a remark is accepted and stored as 0.00 with the remark', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Director Dina', { basicSalary: 0, remarks: DIRECTOR_REMARK });
    const row = await compRow(e.employmentId);
    expect(Number(row.basicSalary)).toBe(0);
    expect(row.remarks).toBe(DIRECTOR_REMARK);
  });

  it('a NON-FINITE basic is refused by the service, so `money(NaN)` can never reach numeric', async () => {
    // core/comp.ts `money` is `typeof n === 'number' ? n.toFixed(2) : String(n)`, so money(NaN) is the
    // STRING "NaN" — and Postgres numeric ACCEPTS NaN. One such row poisons every derived figure silently.
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Nan Nadia', primaryEmail: `r369_${randomUUID().slice(0, 8)}@zb.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await expect(
      setCompensation(a, {
        employmentId: e.employmentId,
        // Exactly what core/employee-draft.ts computes for a blank field today.
        basicSalary: Number(''.replace(/[,_]/g, '')) * NaN,
        monthlyAllowance: 0,
        remarks: DIRECTOR_REMARK,
        effectiveFrom: '2024-01-01',
      }),
    ).rejects.toBeInstanceOf(NonFiniteSalaryAmountError);
    expect(await compRow(e.employmentId)).toBeUndefined();

    // …and on the in-place edit too, where the amount reaches a plain UPDATE.
    const ok = await hire(a, 'Fine Fiona', { basicSalary: 3000 });
    const row = await compRow(ok.employmentId);
    await expect(
      updateCompensation(a, { compensationId: row.id, employmentId: ok.employmentId, basicSalary: NaN }),
    ).rejects.toBeInstanceOf(NonFiniteSalaryAmountError);
    expect(Number((await compRow(ok.employmentId)).basicSalary)).toBe(3000);
  });

  it('editing a basic DOWN to zero needs the remark, and an existing remark satisfies it', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Edited Eve', { basicSalary: 3000 });
    const row = await compRow(e.employmentId);
    await expect(
      updateCompensation(a, { compensationId: row.id, employmentId: e.employmentId, basicSalary: 0 }),
    ).rejects.toBeInstanceOf(SalaryRemarkRequiredError);
    expect(Number((await compRow(e.employmentId)).basicSalary)).toBe(3000);

    // Same edit, with the sentence. Evaluated against the row's RESULTING state, so posting both at once works.
    await updateCompensation(a, {
      compensationId: row.id,
      employmentId: e.employmentId,
      basicSalary: 0,
      remarks: DIRECTOR_REMARK,
    });
    const after = await compRow(e.employmentId);
    expect(Number(after.basicSalary)).toBe(0);
    expect(after.remarks).toBe(DIRECTOR_REMARK);

    // And clearing the remark on a row that has no basic is refused — the gesture cannot be undone in place.
    await expect(
      updateCompensation(a, { compensationId: row.id, employmentId: e.employmentId, remarks: '   ' }),
    ).rejects.toBeInstanceOf(SalaryRemarkRequiredError);
    expect((await compRow(e.employmentId)).remarks).toBe(DIRECTOR_REMARK);
  });

  it('the daily/hourly rate refusal is untouched — a remark does not buy a daily employee out of it', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Daily Dan', primaryEmail: `r369_${randomUUID().slice(0, 8)}@zb.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await expect(
      setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: 0,
        monthlyAllowance: 0,
        payMode: 'daily',
        rateAmount: 0,
        remarks: DIRECTOR_REMARK,
        effectiveFrom: '2024-01-01',
      }),
    ).rejects.toThrow(/rate greater than zero/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE LOAD-BEARING ARM — THE SKIP, AND THE PAYSLIP IT PREVENTS
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('r369 · a REGULAR run over somebody with no basic and nothing payable', () => {
  it('SKIPS them by name, pays everybody else, and no longer blocks the whole company', async () => {
    const a = adminCtx(base);
    const director = await hire(a, 'Director Dina', { basicSalary: 0, remarks: DIRECTOR_REMARK });
    const paid = await hire(a, 'Paid Pete', { basicSalary: 4000 });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    // BEFORE THIS ROUND THIS LINE THREW. `zeroBasic` was a blocker for every pay mode, so one Director
    // stopped the whole company's run — the fault the item was raised about, and the refusal the reporter
    // rejected. Both halves of that are asserted: it does not throw, and it does not pay them zero either.
    const gen = await generatePayslips(a, { batchId });

    const slips = await slipsOn(batchId);
    expect(slips.map((s) => s.employmentId)).toEqual([paid.employmentId]);
    const skipped = skippedOf(gen);
    expect(skipped.map((s) => s.name)).toEqual(['Director Dina']);
    expect(skipped.map((s) => s.employmentId)).toEqual([director.employmentId]);
    expect(skipped[0].reason satisfies PayrollSkipReason).toBe('NOTHING_PAYABLE_THIS_PERIOD');

    // The narrowing of `emps` is what makes the skip safe, so the counts must be the PAYSLIP count.
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(batch.employeeCount).toBe(1);

    // SURFACE 2 — the run's own durable event, read back exactly as both post-run screens read it. A reason
    // missing from `listSkippedEmployees`' recogniser lands here as NO_TRANSACTION_FOR_CYCLE instead.
    const rows = await listSkippedEmployees(a, [batchId]);
    expect(rows.map((r) => ({ name: r.name, reason: r.reason }))).toEqual([
      { name: 'Director Dina', reason: 'NOTHING_PAYABLE_THIS_PERIOD' },
    ]);
  });

  it('WHAT THE SKIP PREVENTS: a gross of nothing is a payslip BELOW zero, and a zero wage filed', async () => {
    // Reached WITHOUT disabling the skip, through the one gross-zero shape the kernel still processes: an
    // HOURLY employee with a positive rate and no worked hours. Their record is not the no-monthly-basic
    // case (rate × time is the only thing that could pay them), so `regularRunNothingPayable` returns null
    // for them and the run writes their payslip — which is precisely why this figure is reachable and why
    // the predicate must never be "simplified" into letting a zero-basic employee through.
    //
    // WHY IT IS BELOW ZERO: EPF's first band is NIL and PCB short-circuits at P <= 5000, but SOCSO's
    // employee column starts at RM0.10, EIS at RM0.05 and SKBBK at RM0.20 — `bandFor` returns the FIRST
    // band for a wage of nothing and never falls off the bottom — and `statDeductions` is explicitly never
    // clamped. BOTH statutory configurations are asserted because `subject_to_skbbk` DEFAULTS FALSE: the
    // ordinary profile nets -0.15 and only an employee ticked subject to SKBBK reaches -0.35. The plan
    // told the reporter "roughly 35 sen below zero", which is the SKBBK-subject figure and NOT the
    // default one; both are below zero, which is what the skip exists for, but -0.35 is not universal.
    const a = adminCtx(base);
    const noSkbbk = await hire(a, 'Hourly Hana', { basicSalary: 4000, payMode: 'hourly', rateAmount: 20 });
    const withSkbbk = await hire(
      a,
      'Hourly Siti',
      { basicSalary: 4000, payMode: 'hourly', rateAmount: 20 },
      { subjectToSkbbk: true },
    );

    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [noSkbbk.employmentId, withSkbbk.employmentId] },
    });
    await generatePayslips(a, { batchId });

    const byEmp = new Map((await slipsOn(batchId)).map((s) => [s.employmentId, s]));
    for (const [id, expectedNet] of [
      [noSkbbk.employmentId, -0.15],
      [withSkbbk.employmentId, -0.35],
    ] as const) {
      const slip = byEmp.get(id)!;
      expect(Number(slip.grossPay), 'no worked hours ⇒ nothing to pay').toBe(0);
      // THE FIGURE. A payslip that owes the employee money, and a zero wage on the month's PERKESO return.
      expect(Number(slip.netPay), `net at a zero wage (skbbk=${expectedNet === -0.35})`).toBeCloseTo(expectedNet, 2);
      const st = slip.statutory as Record<string, number>;
      expect(Number(st.epfEmployee), 'EPF first band is NIL').toBe(0);
      expect(Number(st.pcb), 'PCB short-circuits below P = 5000').toBe(0);
      expect(Number(st.socsoEmployee), 'SOCSO has no zero row — the first band is charged').toBeCloseTo(0.1, 2);
      expect(Number(st.eisEmployee), 'EIS has no zero row either').toBeCloseTo(0.05, 2);
    }
    expect(Number((byEmp.get(withSkbbk.employmentId)!.statutory as Record<string, number>).socsoSkbbk)).toBeCloseTo(0.2, 2);
  });

  it('a DEDUCTION does not keep them in the run, and says so in its own words', async () => {
    // r226's rule "the bias must point at processing" INVERTS for this population: a false "has something"
    // here is not one harmless zero payslip, it is the payslip above. A deduction-only case is therefore
    // skipped — with its own reason, because "nothing was keyed for you" is false beside a TP1 the operator
    // can see on the screen they keyed it on.
    const a = adminCtx(base);
    const director = await hire(a, 'Director Dina', { basicSalary: 0, remarks: DIRECTOR_REMARK });
    await hire(a, 'Paid Pete', { basicSalary: 4000 });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await setPayrollDeductionInput(a, { batchId, employmentId: director.employmentId, tp1Deduction: 200 });
    const gen = await generatePayslips(a, { batchId });

    expect((await slipsOn(batchId)).map((s) => s.employmentId)).not.toContain(director.employmentId);
    expect(skippedOf(gen).map((s) => s.reason)).toEqual(['DEDUCTION_ONLY_THIS_PERIOD']);
  });

  it('a POSITIVE one-off transaction pays them normally — the Director’s quarter', async () => {
    // The reporter's own example: January leaves him out, March pays the fee with EPF/SOCSO/EIS/PCB worked
    // out from it. Nobody removes him from the run by hand and nobody types a salary that is not true.
    const a = await typedCtx();
    await seedPayComponentCatalog(a);
    const director = await hire(a, 'Director Dina', { basicSalary: 0, remarks: DIRECTOR_REMARK });

    await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: PERIOD,
      employmentIds: [director.employmentId],
      rows: [{ kind: 'earning', txnDate: `${PERIOD}-10`, amount: 30000, componentId: await componentId('HOUSING') }],
    });
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [director.employmentId] },
    });
    const gen = await generatePayslips(a, { batchId });

    expect(skippedOf(gen)).toEqual([]);
    const [slip] = await slipsOn(batchId);
    expect(Number(slip.grossPay)).toBeCloseTo(30000, 2);
    expect(Number(slip.netPay), 'a real payslip, not a negative one').toBeGreaterThan(0);
    expect(Number((slip.statutory as Record<string, number>).epfEmployee), 'statutory from what was paid').toBeGreaterThan(0);
  });

  it('a POSITIVE fixed transaction keeps them in the run too', async () => {
    const a = await typedCtx();
    await seedPayComponentCatalog(a);
    const director = await hire(a, 'Director Dina', { basicSalary: 0, remarks: DIRECTOR_REMARK });
    await setEmploymentPayComponent(a, {
      employmentId: director.employmentId,
      componentId: await componentId('HOUSING'),
      amount: 900,
      effectiveFrom: '2024-01-01',
    });

    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [director.employmentId] },
    });
    const gen = await generatePayslips(a, { batchId });
    expect(skippedOf(gen)).toEqual([]);
    expect(Number((await slipsOn(batchId))[0].grossPay)).toBeCloseTo(900, 2);
  });

  it('the LEGACY monthly allowance still pays, so its owner is not skipped', async () => {
    // `earningsOf` adds compensation.monthly_allowance to the wage line on the typed-components-OFF path
    // only. `adminCtx` is that path (its snapshot is env-parity, and typed components are off in the suite).
    // Without mirroring the flag, this employee — a run that pays RM500 — would have been skipped and lost it.
    const a = adminCtx(base);
    const withAllowance = await hire(a, 'Allow Amir', { basicSalary: 0, monthlyAllowance: 500, remarks: DIRECTOR_REMARK });

    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [withAllowance.employmentId] },
    });
    // Not a blocker, not a notice, and not skipped: the record pays something.
    expect((await preProcessAdvisory(a, batchId)).nothingPayable ?? []).toHaveLength(0);
    const gen = await generatePayslips(a, { batchId });
    expect(skippedOf(gen)).toEqual([]);
    expect(Number((await slipsOn(batchId))[0].grossPay)).toBeCloseTo(500, 2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · SURFACE 1 — THE READINESS PANEL, BEFORE THE OPERATOR PRESSES GENERATE
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('r369 · the readiness advisory names them without calling it a fault', () => {
  it('nothingPayable carries the remark; zeroBasic and every blocker stay empty', async () => {
    const a = adminCtx(base);
    const director = await hire(a, 'Director Dina', { basicSalary: 0, remarks: DIRECTOR_REMARK });
    await hire(a, 'Paid Pete', { basicSalary: 4000 });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(a, batchId);
    expect((checks.nothingPayable ?? []).map((r) => ({ id: r.employmentId, remarks: r.remarks }))).toEqual([
      { id: director.employmentId, remarks: DIRECTOR_REMARK },
    ]);
    // THE EXACT SET IS UNCHANGED. Every blocker list is empty, so the four-term sum the server, the batch
    // card and the wizard all compute is zero — which is what makes Generate stay ENABLED.
    expect(checks.zeroBasic ?? []).toHaveLength(0);
    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.unpayablePayMode ?? []).toHaveLength(0);
    expect(checks.tp3YearMismatch ?? []).toHaveLength(0);
  });

  it('the wizard’s own selection advisory carries it too — an unmerged list reaches no screen', async () => {
    const a = adminCtx(base);
    const director = await hire(a, 'Director Dina', { basicSalary: 0, remarks: DIRECTOR_REMARK });
    const paid = await hire(a, 'Paid Pete', { basicSalary: 4000 });
    const advisory = await preProcessAdvisoryForSelection(a, {
      companyIds: [base.companyId],
      payPeriod: PERIOD,
      employmentIds: [director.employmentId, paid.employmentId],
    });
    expect((advisory.nothingPayable ?? []).map((r) => r.name)).toEqual(['Director Dina']);
    expect(advisory.zeroBasic ?? []).toHaveLength(0);
  });

  it('narrowToNothingPayable drops anyone the run WILL pay, so the notice cannot contradict the card', async () => {
    const a = await typedCtx();
    await seedPayComponentCatalog(a);
    const willBePaid = await hire(a, 'March Mimi', { basicSalary: 0, remarks: DIRECTOR_REMARK });
    const willBeSkipped = await hire(a, 'January Jana', { basicSalary: 0, remarks: DIRECTOR_REMARK });
    await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: PERIOD,
      employmentIds: [willBePaid.employmentId],
      rows: [{ kind: 'earning', txnDate: `${PERIOD}-10`, amount: 30000, componentId: await componentId('HOUSING') }],
    });
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [willBePaid.employmentId, willBeSkipped.employmentId] },
    });

    const checks = await preProcessAdvisory(a, batchId);
    const money = await pendingBatchMoney(a, { batchId });
    // The card lists the RM30,000 by name…
    expect(money.lines.filter((l) => l.amount > 0).map((l) => l.employmentId)).toContain(willBePaid.employmentId);
    // …and the record-level list names BOTH, which is what makes the narrowing load-bearing rather than
    // decorative: unnarrowed, this panel would say "will be skipped" about somebody on the same screen's
    // "what will this run pay" card.
    expect((checks.nothingPayable ?? []).map((r) => r.employmentId).sort()).toEqual(
      [willBePaid.employmentId, willBeSkipped.employmentId].sort(),
    );
    expect(narrowToNothingPayable(checks.nothingPayable ?? [], money).map((r) => r.employmentId)).toEqual([
      willBeSkipped.employmentId,
    ]);
    // …and the KERNEL agrees with the narrowed answer, which is the property the derivation exists for.
    expect(skippedOf(await generatePayslips(a, { batchId })).map((s) => s.employmentId)).toEqual([
      willBeSkipped.employmentId,
    ]);
    // With no card (the wizard's pre-batch step) the unnarrowed list is what renders.
    expect(narrowToNothingPayable(checks.nothingPayable ?? [], null)).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · WHAT STILL BLOCKS — THE DAILY/HOURLY RATE LEG
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('r369 · a daily employee with no rate still fails the run closed', () => {
  it('lands in zeroBasic and throws PreProcessBlockedError, writing nothing', async () => {
    const a = adminCtx(base);
    const bad = await hire(a, 'Daily Zero', { basicSalary: 4600, payMode: 'daily', rateAmount: 200 });
    // assertRateForMode guards NEW writes, so a legacy row is simulated exactly as
    // test/payroll-basic-source.test.ts does: the rate is zeroed in place.
    await owner.db
      .update(schema.compensation)
      .set({ rateAmount: '0.00' })
      .where(and(eq(schema.compensation.employmentId, bad.employmentId), isNull(schema.compensation.validTo)));

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(a, batchId);
    expect((checks.zeroBasic ?? []).map((r) => r.employmentId)).toEqual([bad.employmentId]);
    expect(checks.nothingPayable ?? [], 'the rate leg is NOT the skip population').toHaveLength(0);
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(PreProcessBlockedError);
    expect(await slipsOn(batchId)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · THE SUBSET REPROCESS — NAMES THEM, NEVER SKIPS THEM
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('r369 · a reprocess refuses rather than dropping a payslip nobody asked to drop', () => {
  it('names them, points at Remove, and leaves the processed run exactly as it was', async () => {
    const a = adminCtx(base);
    // Processed while they still had a basic, so a payslip EXISTS for them on the run.
    const director = await hire(a, 'Director Dina', { basicSalary: 3000 });
    const paid = await hire(a, 'Paid Pete', { basicSalary: 4000 });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    const before = await slipsOn(batchId);
    expect(before).toHaveLength(2);

    // The basic is then removed, with the remark the reporter asked for.
    await setCompensation(a, {
      employmentId: director.employmentId,
      basicSalary: 0,
      monthlyAllowance: 0,
      remarks: DIRECTOR_REMARK,
      effectiveFrom: `${PERIOD}-01`,
    });

    await expect(
      generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [director.employmentId, paid.employmentId] } }),
    ).rejects.toBeInstanceOf(ReprocessNothingPayableError);
    // THE MECHANICAL HALF: the refusal precedes the snapshot and the delete, so BOTH payslips are intact and
    // neither version was bumped. A skip here would have left Dina's old payslip on the run, unrecomputed,
    // with the run's totals still counting it and nothing anywhere saying why.
    const after = await slipsOn(batchId);
    expect(after).toHaveLength(2);
    expect(after.map((s) => s.version).sort()).toEqual(before.map((s) => s.version).sort());
  });

  it('readiness is scoped to every POSTED id, not only the newly added ones', async () => {
    // The gap: an EXISTING member of the run whose salary record became unpayable after it was processed was
    // recomputed completely unchecked, on the one path where the whole-run gate is deliberately absent.
    const a = adminCtx(base);
    const daily = await hire(a, 'Daily Dita', { basicSalary: 4600, payMode: 'daily', rateAmount: 250 });
    const paid = await hire(a, 'Paid Pete', { basicSalary: 4000 });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    expect(await slipsOn(batchId)).toHaveLength(2);

    await owner.db
      .update(schema.compensation)
      .set({ rateAmount: '0.00' })
      .where(and(eq(schema.compensation.employmentId, daily.employmentId), isNull(schema.compensation.validTo)));

    await expect(
      generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [daily.employmentId, paid.employmentId] } }),
    ).rejects.toBeInstanceOf(ReprocessAddBlockedError);
    // A correction that does NOT name the broken record still goes through — the narrowing that carries the
    // documented reason is "what the operator posted", and a gap belonging to somebody else cannot block it.
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [paid.employmentId] } });
    expect(await slipsOn(batchId)).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 7 · SURFACE 3 — THE CORRECTION SCREEN MUST NOT READ AS "YOU FORGOT THIS PERSON"
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('r369 · listPayslipLessEligible labels a deliberate skip, as a NON-blocker', () => {
  it('carries nothingPayable as a warning so the row is labelled and still addable by hand', async () => {
    const a = adminCtx(base);
    const director = await hire(a, 'Director Dina', { basicSalary: 0, remarks: DIRECTOR_REMARK });
    await hire(a, 'Paid Pete', { basicSalary: 4000 });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });

    const rows = await listPayslipLessEligible(a, { batchId });
    const dina = rows.find((r) => r.employmentId === director.employmentId);
    expect(dina, 'a skipped employee lands on this list automatically').toBeTruthy();
    // BEFORE the split they carried the `zeroBasic` BLOCKER; after it they would carry NOTHING, and a row
    // with no label reads as an oversight. It must also NOT be a blocker: the plan promises the operator can
    // still add them by hand if they disagree with the decision for a given month.
    expect(dina!.warnings).toContain('nothingPayable');
    expect(dina!.blockers, 'never un-tickable — the operator may still add them').toEqual([]);
    // And the label the screen resolves it through exists.
    expect(en.payroll.batch.reprocessGapNothingPayable).toBeTruthy();
    expect(en.payroll.batch.reprocessReasonNothingPayable).toBeTruthy();
  });
});
