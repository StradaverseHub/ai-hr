/**
 * Item 4ca06dea — PROCESS STAYS ENABLED FOR A PAY STRUCTURE THE RUN WILL REFUSE.
 *
 * `generatePayslips` refuses a run on FOUR pre-process blockers (core/payroll.ts, `const blocked =`):
 * missingCompensation + zeroBasic + unpayablePayMode + tp3YearMismatch. Three screens predict that
 * refusal, and all three counted only THREE of the four — `unpayablePayMode` (ADR-0078: a
 * `custom_period` pay structure with no calculation behind it) was in none of them. A custom_period
 * employee in scope therefore left the Process button ENABLED, and the reason arrived as an error
 * AFTER the press, misdescribed as a missing salary record.
 *
 * ── WHY THE COUNTS ARE EVALUATED, NOT GREPPED ───────────────────────────────────────────────────────
 * `step-validation.tsx` counts blockers in TWO places (`hasBlockers`, which gates the button, and
 * `blockers`, which colours the panel), and its own comment says they must agree: "one file counting
 * blockers two ways is how a card and a button disagree." A `toMatch` on the source proves a term is
 * PRESENT somewhere; it cannot prove two expressions are the SAME SET. So this file extracts each count
 * expression from the real source and EVALUATES it against a probe advisory whose per-key list lengths
 * are distinct powers of two. The sum is then a bitmask of exactly which terms an expression reads, and
 * `===` between two sums is set equality. A fifth blocker added to one count and not the other changes
 * one bitmask and fails here; a blocker added to a SCREEN but not to the server fails here too, which is
 * the direction core/payroll.ts's own comment calls out ("a card on the screen that the server never
 * enforces").
 *
 * The three source assertions and the DB arm are deliberately in one file: the defect WAS the gap
 * between them.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  createBatch,
  generatePayslips,
  preProcessAdvisory,
  preProcessAdvisoryForSelection,
  PreProcessBlockedError,
} from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
const LOCALES = Object.keys(CATALOGUES) as (keyof typeof CATALOGUES)[];

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// The probe: one distinct power of two per advisory key, so a sum names the exact set of terms read.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

const WEIGHT = {
  missingCompensation: 1,
  zeroBasic: 2,
  unpayablePayMode: 4,
  tp3YearMismatch: 8,
  staleBasicComponent: 16,
  missingStatutory: 32,
  missingBank: 64,
  currencyMismatch: 128,
  hrdfSubjectUnregistered: 256,
} as const;

/** The four blockers the server's exact set adds up. 1 + 2 + 4 + 8. */
const BLOCKER_MASK = WEIGHT.missingCompensation + WEIGHT.zeroBasic + WEIGHT.unpayablePayMode + WEIGHT.tp3YearMismatch;

const probe = () =>
  Object.fromEntries(Object.entries(WEIGHT).map(([k, n]) => [k, Array.from({ length: n }, () => ({}))]));

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Line comments out, so a `;` inside prose cannot truncate an extracted expression. */
const strip = (src: string) => src.replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Pull `const <name> = <expr>;` out of real source and evaluate it with `varName` bound to the probe.
 * `extra` declarations (the batch card composes its total from three named counts) are evaluated first,
 * in source order, inside the same function body.
 */
function evalCount(src: string, names: string[], varName: string): number {
  const body: string[] = [];
  for (const name of names) {
    const m = new RegExp(`const ${name} =([\\s\\S]*?);`).exec(strip(src));
    expect(m, `declaration of ${name} not found`).toBeTruthy();
    // `hasBlockers` ends in a `> 0` comparison; drop it so the SUM is readable as a bitmask. Nothing
    // else is rewritten — the terms themselves are the file's own text.
    body.push(`const ${name} = ${m![1].replace(/>\s*0\s*$/, '')};`);
  }
  body.push(`return ${names[names.length - 1]};`);
  // eslint-disable-next-line no-new-func -- evaluating the SHIPPED expression is the whole point
  return Number(new Function(varName, body.join('\n'))(probe()));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · (b) + (e) — THE COUNTS ARE ONE SET, AND IT IS THE SERVER'S SET
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('4ca06dea · every surface that predicts the refusal counts the server’s exact four', () => {
  const STEP = read('app/payroll/process/steps/step-validation.tsx');
  const CARD = read('app/payroll/[batchId]/page.tsx');
  const ACTION = read('app/payroll/actions.ts');
  const CORE = read('core/payroll.ts');

  it('(e) the server’s exact set is EXACTLY the four — a silent fifth addition fails here', () => {
    // core/payroll.ts calls this an "EXACT SET, UPDATED AND NOT LOOSENED". Nothing was added to it this
    // round; this assertion is the tripwire that makes a later one-sided addition visible.
    expect(evalCount(CORE, ['blocked'], 'checks')).toBe(BLOCKER_MASK);
  });

  it('(b) step-validation’s TWO counts agree with each other, term for term', () => {
    const gate = evalCount(STEP, ['hasBlockers'], 'a'); // drives the Process button
    const panel = evalCount(STEP, ['blockers'], 'advisory'); // drives the red/amber panel
    expect(gate).toBe(panel);
    expect(gate).toBe(BLOCKER_MASK);
  });

  it('the batch card and generateAction count the same four', () => {
    expect(evalCount(CARD, ['preSalaryBlockers', 'prePayModeBlockers', 'preTp3Blockers', 'preBlockers'], 'preChecks')).toBe(
      BLOCKER_MASK,
    );
    // generateAction refuses on the UNION of its three counts (if/else-if chain), so the union is what
    // must equal the server's set. Each is read separately: a term dropped from one and duplicated in
    // another would still sum to the mask, but the weights are powers of two, so a duplicate overflows
    // its bit and the total stops equalling BLOCKER_MASK.
    expect(
      evalCount(ACTION, ['blockers'], 'checks') +
        evalCount(ACTION, ['payModeBlockers'], 'checks') +
        evalCount(ACTION, ['tp3Blockers'], 'checks'),
    ).toBe(BLOCKER_MASK);
  });

  it('(a) the wizard NAMES the new blocker as a blocker, not only counts it', () => {
    // A count with no row disables Process without saying why. Both screens render the group, flagged
    // `true` (= blocker red), and the merge in core is what lets the row reach the wizard at all.
    for (const [p, src] of [
      ['app/payroll/process/steps/step-validation.tsx', STEP],
      ['app/payroll/[batchId]/page.tsx', CARD],
    ] as const) {
      expect(strip(src), p).toMatch(/\['unpayablePayMode',[\s\S]{0,60}?, true\]/);
    }
    expect(strip(CORE)).toMatch(/merged\.unpayablePayMode!\.push/);
  });

  it('(d) the three older blockers are still counted by all three surfaces', () => {
    // BLOCKER_MASK above already proves this arithmetically; this spells out which bits, so a failure
    // says WHICH blocker went missing rather than only that a number moved.
    for (const [label, n] of [
      ['gate', evalCount(STEP, ['hasBlockers'], 'a')],
      ['panel', evalCount(STEP, ['blockers'], 'advisory')],
      ['card', evalCount(CARD, ['preSalaryBlockers', 'prePayModeBlockers', 'preTp3Blockers', 'preBlockers'], 'preChecks')],
      ['server', evalCount(CORE, ['blocked'], 'checks')],
    ] as const) {
      expect(n & WEIGHT.missingCompensation, `${label} missingCompensation`).toBeGreaterThan(0);
      expect(n & WEIGHT.zeroBasic, `${label} zeroBasic`).toBeGreaterThan(0);
      expect(n & WEIGHT.tp3YearMismatch, `${label} tp3YearMismatch`).toBeGreaterThan(0);
      expect(n & WEIGHT.unpayablePayMode, `${label} unpayablePayMode`).toBeGreaterThan(0);
    }
  });

  it('(c) no WARNING was promoted to a blocker — an ordinary run is unchanged', () => {
    // The complaint was a missing blocker, not a missing warning. If any warning bit had crept into a
    // blocker count, a run with a stale BASIC item or a non-MYR salary would stop being processable —
    // exactly the "nobody becomes unpayable who was not already" line.
    const warnBits =
      WEIGHT.staleBasicComponent |
      WEIGHT.missingStatutory |
      WEIGHT.missingBank |
      WEIGHT.currencyMismatch |
      WEIGHT.hrdfSubjectUnregistered;
    for (const n of [
      evalCount(STEP, ['hasBlockers'], 'a'),
      evalCount(STEP, ['blockers'], 'advisory'),
      evalCount(CARD, ['preSalaryBlockers', 'prePayModeBlockers', 'preTp3Blockers', 'preBlockers'], 'preChecks'),
      evalCount(CORE, ['blocked'], 'checks'),
    ]) {
      expect(n & warnBits).toBe(0);
    }
  });

  it('the old note claiming this gap is out of scope is gone', () => {
    // It said `unpayablePayMode` "is counted by NEITHER of this file's two counts" and deferred the fix.
    // Leaving that sentence behind would make the file lie about itself.
    expect(STEP).not.toMatch(/DELIBERATELY NOT CHANGED HERE/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · WHAT THE SCREENS SAY, IN ALL SIX LOCALES
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('4ca06dea · the new strings exist in all six locales and are six different sentences', () => {
  type Cat = {
    payroll: {
      batch: {
        preChecks: { unpayablePayMode: string };
        preChecksPayModeBlockerHint: string;
        preChecksBlockedPayModeError: string;
      };
      process: { validationCheck: { unpayablePayMode: string } };
    };
  };

  it('every locale carries all four keys, with {n} where the copy counts people', () => {
    // i18n/request.ts DEEP-MERGES each locale over English, so a key missing from ms.json renders the
    // ENGLISH sentence and looks fine on the screen. These read the raw catalogues, unmerged.
    for (const l of LOCALES) {
      const m = CATALOGUES[l] as unknown as Cat;
      expect(m.payroll.process.validationCheck.unpayablePayMode, `${l} validationCheck`).toBeTruthy();
      expect(m.payroll.batch.preChecks.unpayablePayMode, `${l} preChecks`).toBeTruthy();
      expect(m.payroll.batch.preChecksPayModeBlockerHint, `${l} hint`).toContain('{n}');
      expect(m.payroll.batch.preChecksBlockedPayModeError, `${l} blocked`).toContain('{n}');
    }
  });

  it('the six are DISTINCT — nothing was left as the English fallback', () => {
    for (const field of [
      (m: Cat) => m.payroll.process.validationCheck.unpayablePayMode,
      (m: Cat) => m.payroll.batch.preChecks.unpayablePayMode,
      (m: Cat) => m.payroll.batch.preChecksPayModeBlockerHint,
      (m: Cat) => m.payroll.batch.preChecksBlockedPayModeError,
    ]) {
      const values = LOCALES.map((l) => field(CATALOGUES[l] as unknown as Cat));
      expect(new Set(values).size, values.join(' | ')).toBe(LOCALES.length);
    }
  });

  it('every new message FORMATS, in every locale — the check a plain seed cannot render', async () => {
    // §8 GAP, STATED RATHER THAN PAPERED OVER. `pnpm db:seed` creates ZERO payroll runs ("Total runs 0
    // — No payroll processes yet" on the rendered /payroll), so `/payroll/[batchId]` — where the batch
    // card and its two new `{n}` strings live — is NOT reachable from a plain seed at all, and the
    // six-locale dev-server render for this round covers /payroll/process only. A malformed ICU string
    // throws FORMATTING_ERROR at RENDER time and returns a 200 with the block missing: invisible to tsc,
    // to `next build` and to a key-presence assertion. So the formatter is RUN here instead.
    const { createTranslator } = await import('next-intl');
    for (const l of LOCALES) {
      // ⚠️ `onError` IS LOAD-BEARING: next-intl swallows MISSING_MESSAGE / FORMATTING_ERROR by default
      // and hands back the key, so an assertion on the output alone would pass on a broken string.
      const boom = (e: unknown) => {
        throw e;
      };
      const messages = CATALOGUES[l] as unknown as Record<string, unknown>;
      const tb = createTranslator({ locale: l, messages, namespace: 'payroll.batch', onError: boom as never });
      const tp = createTranslator({ locale: l, messages, namespace: 'payroll.process', onError: boom as never });
      for (const [key, n] of [
        ['preChecksPayModeBlockerHint', 1],
        ['preChecksPayModeBlockerHint', 7],
        ['preChecksBlockedPayModeError', 1],
        ['preChecksBlockedPayModeError', 7],
      ] as const) {
        const out = tb(key as never, { n } as never);
        expect(out, `${l}.${key}`).toContain(String(n));
        // next-intl hands back the dotted key path when a message is missing or fails to format.
        expect(out, `${l}.${key} did not resolve`).not.toContain('payroll.batch');
        expect(out, `${l}.${key} left ICU unrendered`).not.toMatch(/[{}]/);
      }
      for (const [t, ns, key] of [
        [tb, 'payroll.batch', 'preChecks.unpayablePayMode'],
        [tp, 'payroll.process', 'validationCheck.unpayablePayMode'],
      ] as const) {
        const out = (t as (k: never) => string)(key as never);
        expect(out, `${l}.${ns}.${key}`).toBeTruthy();
        expect(out, `${l}.${ns}.${key} did not resolve`).not.toContain(ns);
        expect(out, `${l}.${ns}.${key} left ICU unrendered`).not.toMatch(/[{}]/);
      }
    }
  });

  it('the refusal message does NOT reuse the missing-salary-record wording', () => {
    // The whole complaint: the operator pressed Generate and was told these people had no salary record.
    // They have one; it carries a pay mode payroll cannot calculate.
    const b = (en as unknown as Cat).payroll.batch;
    expect(b.preChecksBlockedPayModeError).not.toBe(
      (en as unknown as { payroll: { batch: { preChecksBlockedError: string } } }).payroll.batch.preChecksBlockedError,
    );
    expect(b.preChecksBlockedPayModeError).not.toMatch(/no current salary record/i);
    expect(b.preChecksPayModeBlockerHint).not.toMatch(/no current salary record/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE DATA PATH THE WIZARD ACTUALLY USES
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The Validation step does NOT read a batch: it calls `validatePayrollSelection`, which is
 * `preProcessAdvisoryForSelection` over companies + period + the wizard's touched selection. The
 * pre-existing coverage (test/employee-pay-structure.test.ts arm i) proves the per-BATCH advisory names
 * a custom_period employee. This arm proves the SELECTION path does too, because that is the payload the
 * newly-counted term is computed from — and that the run this screen is about really does refuse it.
 */
describe('4ca06dea · a custom_period employee reaches the wizard’s own advisory, and the run refuses', () => {
  let b: Base;
  let icSeq = 0;
  const PERIOD = '2026-05';
  const nextIc = () => `900101${String(310000 + icSeq++).padStart(6, '0')}`;

  async function seedPayable(name: string, basicSalary: number, structure?: { payMode: string; rateAmount?: number }) {
    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `pbp_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary,
      monthlyAllowance: 0,
      effectiveFrom: '2024-01-01',
      ...(structure ?? {}),
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
    return e;
  }

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    icSeq = 0;
  });
  afterAll(async () => {
    await closeAll();
  });

  it('(a) the selection advisory names the custom_period employee, so the counted term is non-zero', async () => {
    const a = adminCtx(b);
    const eCustom = await seedPayable('Custom Carla', 3000, { payMode: 'custom_period' });
    const eMonthly = await seedPayable('Monthly Mira', 4000);

    const advisory = await preProcessAdvisoryForSelection(a, {
      companyIds: [b.companyId],
      payPeriod: PERIOD,
      employmentIds: [eCustom.employmentId, eMonthly.employmentId],
    });
    expect(advisory.unpayablePayMode?.map((r) => r.name)).toEqual(['Custom Carla']);
    // The other three blocker lists are empty, so the ONLY thing standing between this selection and a
    // green panel is the term this round added. Before it, `blockers` was 0 and Process was enabled.
    expect(advisory.missingCompensation).toHaveLength(0);
    expect(advisory.zeroBasic ?? []).toHaveLength(0);
    expect(advisory.tp3YearMismatch ?? []).toHaveLength(0);

    // And the run the enabled button would have started refuses, writing nothing.
    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [eCustom.employmentId, eMonthly.employmentId] },
    });
    expect((await preProcessAdvisory(a, batchId)).unpayablePayMode?.map((r) => r.name)).toEqual(['Custom Carla']);
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(PreProcessBlockedError);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(0);
  });

  it('(c) an ordinary selection with no such employee is all-clear, exactly as before', async () => {
    const a = adminCtx(b);
    const eMonthly = await seedPayable('Monthly Mira', 4000);
    const eDaily = await seedPayable('Daily Dita', 3000, { payMode: 'daily', rateAmount: 120 });

    const advisory = await preProcessAdvisoryForSelection(a, {
      companyIds: [b.companyId],
      payPeriod: PERIOD,
      employmentIds: [eMonthly.employmentId, eDaily.employmentId],
    });
    // The added term contributes ZERO here, so every count on every surface is the number it was before
    // this round. Nobody became unpayable who was not already.
    expect(advisory.unpayablePayMode ?? []).toHaveLength(0);
    expect(advisory.missingCompensation).toHaveLength(0);
    expect(advisory.zeroBasic ?? []).toHaveLength(0);
    expect(advisory.tp3YearMismatch ?? []).toHaveLength(0);

    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [eMonthly.employmentId, eDaily.employmentId] },
    });
    await generatePayslips(a, { batchId });
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(2);
  });
});
