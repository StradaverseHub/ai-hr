/**
 * df35d60d (STAGE 1) — Form TP3: the previous-employment record, the shared relief taxonomy, and the
 * drawn form.
 *
 * ══ THE THREE THINGS THIS FILE EXISTS TO STOP ═══════════════════════════════════════════════════════
 *
 * 1. A SECOND COPY OF THE RELIEF SCHEDULE. The TP3's Section D asks for the SAME seventeen reliefs, with
 *    the same annual limits and the same lettered sub-lines, as the TP1's Section C. If they are ever
 *    two lists, a limit that changes in one and not the other is a wrong tax figure with nothing to
 *    report it. The identity case below is `toBe`, not `toEqual`: a COPY that happens to be equal today
 *    fails it, which is the whole point.
 *
 * 2. ~~STAGE 2 ARRIVING EARLY~~ — STAGE 2 ARRIVED (item 1bb09a73), so this guard is UPDATED, not
 *    deleted. It used to fail if `core/tp3.ts` learned to write a tax column or `core/payroll.ts`
 *    learned to read `employee_tp3`; both are now REQUIRED, and the cases below assert the required
 *    shape instead. What survives unchanged is the property the guard was really protecting: saving a
 *    form for an EARLIER assessment year must never demote the `tp3_year` the PCB kernel matches on.
 *    The behaviour of the projection itself is pinned in `test/1bb09a73-tp3-pcb-sync.test.ts`.
 *
 * 3. A FORM THAT ASSERTS WHAT NOBODY SAID. An empty box asserts nothing; a printed `0.00` asserts that
 *    the money does not exist, which on a PREVIOUS employer's figures is a claim we are in no position
 *    to make. And the form is RULED FOR TWO previous employers — the row count is tested, because
 *    silently dropping a third off a statutory document is the failure that costs the most.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  deleteTp3,
  deriveAccumulatorSeed,
  getTp3ForPersonYear,
  getTp3Identity,
  listTp3YearsForPerson,
  saveTp3,
  Tp3Error,
  tp3LineNumber,
  TP3_FORM_CODE,
  TP3_MAX_EMPLOYERS,
  TP3_SECTION_C,
  TP3_SECTION_D,
} from '../core/tp3';
import { TP1_ITEMS } from '../core/tax-relief';
import { MY_TP1_2026, MY_TP3_2026 } from '../localization/my/statutory-tables';
import { renderTp3Pdf, Tp3PdfOverflowError, type Tp3PdfData } from '../lib/tp3-pdf';
import { readTp3FormInput } from '../lib/tp3-form-input';
import { SCREENS } from '../lib/permissions';
import {
  adminCtx,
  closeAll,
  createAppUser,
  harnessSnapshot,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';

const ROOT = join(__dirname, '..');
/** Source with comments stripped: a guard that can be satisfied by a comment is not a guard. */
const src = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const CORE_TP3 = src('core/tp3.ts');
const CORE_PAYROLL = src('core/payroll.ts');
const PDF = src('lib/tp3-pdf.ts');
const ROUTE = src('app/payroll/transactions/tp3/pdf/route.ts');
const PAGE = src('app/payroll/transactions/tp3/page.tsx');
const ACTIONS = src('app/payroll/transactions/tp3/actions.ts');
const MIGRATION = readFileSync(join(ROOT, 'db/migrations/0480_employee_tp3.sql'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messages = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(ROOT, `messages/${l}.json`), 'utf8'))]),
) as Record<(typeof LOCALES)[number], Record<string, never>>;

let b: Base;
const YEAR = 2026;

/**
 * Item 1bb09a73 — a Malaysian statutory row for this person, so a money-carrying form has somewhere to
 * land. `saveTp3` refuses one that does not (a form whose figures reach nothing is the defect that item
 * fixed), which is why the three cases below that key real amounts now call this first. The cases that
 * key NO money deliberately do not: a blank form still saves without a statutory profile.
 */
async function withStatutoryRow(personId: string) {
  await owner.db.insert(schema.employeeStatutoryMy).values({
    tenantId: b.tenantId,
    personId,
    icNumber: `900101-10-${Math.floor(Math.random() * 9000 + 1000)}`,
  });
}

async function hire(name = 'TP3 Subject') {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `tp3_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-05-01',
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
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · ONE TAXONOMY, CONSUMED TWICE
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('df35d60d · Section D is the TP1 schedule, not a copy of it', () => {
  it('is the SAME ARRAY OBJECT the TP1 reads — identity, not equality', () => {
    // ⚠️ `toBe`. A second transcription that happens to be equal TODAY is exactly what this refuses:
    // it would pass `toEqual` on the day it was written and diverge silently afterwards.
    expect(MY_TP3_2026.sectionD).toBe(MY_TP1_2026.items);
    expect(TP3_SECTION_D).toEqual(TP1_ITEMS);
    expect(TP3_SECTION_D.map((i) => i.code)).toEqual(TP1_ITEMS.map((i) => i.code));
  });

  it('numbers the SAME items D1–D17 that the TP1 numbers C1–C17, one for one', () => {
    expect(TP3_SECTION_D).toHaveLength(17);
    for (const [i, item] of TP3_SECTION_D.entries()) {
      expect(tp3LineNumber(item.code), `${item.code} is line D${i + 1}`).toBe(i + 1);
      // The persisted key stays `c…` because it is the JSONB key on live tp1_relief rows and the i18n
      // key in six locales. The D-number is DERIVED, and that derivation is the only difference.
      expect(item.code).toBe(`c${i + 1}`);
    }
    expect(tp3LineNumber('not-an-item'), 'an unknown code has no line number').toBeNull();
  });

  it('carries the annual limits the agency’s own TP3 prints, read off the form', () => {
    // Transcribed from PCB FORM /TP3 (1/2026), the reporter's own attachment, page 2 and page 3. This is
    // the INDEPENDENT copy: if the pack catalogue is edited, this case is what says the form no longer
    // matches the paper. Written as the printed D-number so it can be checked against the PDF by eye.
    const printed: Record<number, number | null> = {
      1: 8000, 2: 6000, 3: 7000, 4: 10000, 5: 2500, 6: 1000, 7: 1000, 8: 3000, 9: 8000,
      10: 4000, 11: 7000, 12: 3000, 13: 4000, 14: 350, 15: 2500,
      // D16 prints NO group limit: each house-price band carries its own, and its own accumulated box.
      16: null,
      17: 1000,
    };
    for (const item of TP3_SECTION_D) {
      const n = tp3LineNumber(item.code)!;
      expect(item.limit, `D${n} annual limit`).toBe(printed[n]);
    }
    // The "(Limited RM…)" figures the form prints against individual lettered lines.
    const sub = (n: number, letter: string) =>
      TP3_SECTION_D.find((i) => tp3LineNumber(i.code) === n)!.subItems.find((s) => s.code === letter)!.limit;
    expect(sub(1, 'c'), 'D1(c) full check-up').toBe(1000);
    expect(sub(3, 'c'), 'D3(c) skills enhancement').toBe(2000);
    expect(sub(4, 'c'), 'D4(c) vaccination').toBe(1000);
    expect(sub(4, 'd'), 'D4(d) dental check-up').toBe(1000);
    expect(sub(4, 'e'), 'D4(e) full check-up / mental health / screening').toBe(1000);
    expect(sub(4, 'f'), 'D4(f) learning-disability assessment, 18 and below').toBe(10000);
    expect(sub(11, 'a'), 'D11(a) voluntary EPF incl. mandatory').toBe(4000);
    expect(sub(11, 'b'), 'D11(b) life insurance / voluntary EPF').toBe(3000);
    expect(sub(16, 'a'), 'D16(a) house price up to RM500,000').toBe(7000);
    expect(sub(16, 'b'), 'D16(b) house price RM500,000–RM750,000').toBe(5000);
    expect(TP3_SECTION_D.find((i) => tp3LineNumber(i.code) === 16)!.perSubLimit).toBe(true);
  });

  it('prints Section D from the SAME message keys the TP1 form prints, in all six locales', () => {
    // The labels are not duplicated either. `items.<code>.label` is the TP1's own key; the TP3 renderer
    // resolves the same one, so a reworded relief is reworded on both forms at once.
    expect(ROUTE, 'the route resolves the shared item labels').toContain('t(`items.${item.code}.label`)');
    expect(PAGE).toContain("t(`items.${item.code}.label`)");
    for (const l of LOCALES) {
      const tr = (messages[l] as unknown as { taxRelief: { items: Record<string, { label: string; sub?: Record<string, string> }> } }).taxRelief;
      for (const item of TP3_SECTION_D) {
        expect(tr.items[item.code]?.label, `${l} ${item.code}`).toBeTruthy();
        for (const s of item.subItems) expect(tr.items[item.code]?.sub?.[s.code], `${l} ${item.code}.${s.code}`).toBeTruthy();
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · SECTION C — THE BOXES THE STORED FIGURE COULD NOT BE TAKEN APART INTO
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('df35d60d · Section C, and the arithmetic that could not be run backwards', () => {
  it('has the five lines and the seven boxes the form prints', () => {
    expect(TP3_SECTION_C.map((l) => l.code)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(TP3_SECTION_C.find((l) => l.code === 'c2')!.subItems.map((s) => s.code)).toEqual([
      'i', 'ii', 'iii', 'iv', 'v',
    ]);
    expect(TP3_SECTION_C.find((l) => l.code === 'c4')!.subItems.map((s) => s.code)).toEqual(['i', 'ii']);
    // The form's own restriction on C4(ii), in words, sharing the TP1's key: one rule, one string.
    expect(TP3_SECTION_C.find((l) => l.code === 'c4')!.subItems[1].frequency).toBe('twoClaimsLifetime');
    expect(TP3_FORM_CODE).toBe('PCB FORM /TP3 (1/2026)');
  });

  it('derives the accumulator seed as (C1 − ΣC2) − C3, which is what could not be inverted', async () => {
    const { personId } = await hire();
    await withStatutoryRow(personId);
    await saveTp3(adminCtx(b), {
      personId,
      assessmentYear: YEAR,
      sectionC: {
        c1: { amount: 60000 },
        c2: { subItems: { i: 2400, ii: 1200, iii: 0, iv: 0, v: 400 } },
        c3: { amount: 6600 },
        c4: { subItems: { i: 500, ii: 0 } },
        c5: { amount: 3120.5 },
      },
    });
    const row = (await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR }))!;
    const seed = deriveAccumulatorSeed(row.payload)!;
    expect(seed.gross).toBe(60000);
    expect(seed.exemptTotal, 'the server sums C2, the client never sends a total').toBe(4000);
    expect(seed.epfClaimed, 'the RAW box, because the form prints it').toBe(6600);
    // ⚠️ UPDATED TWICE BY 20837372, not loosened. r342: C3 is 6,600 against an EPF relief cap of 4,000
    // and LHDN DEFINES K as capped, so (Y−K) is struck against the allowable K rather than the raw box.
    // r350: ΣC2 is no longer subtracted at all — C1 carries only the taxable items, so the exempt
    // allowances were never in it. The C2 sub-lines here are all UNDER their own limits (2,400 + 1,200
    // + 400 against 6,000 / 3,000 / none), so there is no taxable excess to add either and ANR is
    // simply C1 − K. Both legs are asserted separately on purpose.
    expect(seed.epfAllowable, 'K as the specification defines it: min(6600, 4000)').toBe(4000);
    expect(seed.excessTotal, 'every C2 box is within its limit').toBe(0);
    expect(seed.netRemuneration, '60000 + 0 − 4000').toBe(56000);
    expect(seed.pcbPaid, 'C5, the form’s own “excluding CP38”').toBe(3120.5);
    expect(seed.zakatPaid, 'C4(i)').toBe(500);

    // ⚠️ THE POINT OF THE WHOLE ITEM, AND IT SURVIVES BOTH CORRECTIONS: the ONE stored figure cannot be
    // taken apart again. A second set of boxes with a different gross and a different exempt total
    // still lands on the SAME figure — 56000 after r350, 52000 after r342, 49400 before either.
    // r350 — the coinciding pair had to be re-chosen. Before r350 a different gross coincided by
    // having a different EXEMPT total; now the exempt total does not enter the sum at all, so the
    // second form coincides by having a different TAXABLE EXCESS instead: C1 55,000 with C2(i) keyed
    // 11,000 is 5,000 over its 6,000 limit, and 55,000 + 5,000 − 4,000 is the same 56,000.
    await saveTp3(adminCtx(b), {
      personId,
      assessmentYear: YEAR + 1,
      sectionC: { c1: { amount: 55000 }, c2: { subItems: { i: 11000, ii: 0, iii: 0, iv: 0, v: 0 } }, c3: { amount: 6600 } },
    });
    const other = (await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR + 1 }))!;
    expect(deriveAccumulatorSeed(other.payload)!.excessTotal, '11,000 against a 6,000 limit').toBe(5000);
    expect(deriveAccumulatorSeed(other.payload)!.netRemuneration).toBe(56000);
    expect(deriveAccumulatorSeed(other.payload)!.gross, 'but the gross differs — hence seven boxes').toBe(55000);
  });

  it('returns a NEGATIVE net rather than clamping it, because a clamp hides the keying error', () => {
    // r350 — ΣC2 no longer comes off, so a negative now needs a C3 that exceeds C1 plus any taxable
    // excess. That is still exactly the shape of a mis-keyed form, and it must still be visible.
    const seed = deriveAccumulatorSeed({
      form: 'tp3-2026',
      sectionC: { c1: { amount: 1000 }, c2: { amount: 900 }, c3: { amount: 4000 } },
      sectionD: {},
    })!;
    expect(seed.netRemuneration, '1000 + 0 − 4000').toBe(-3000);
  });

  it('has no seed at all for a record with no payload — null, never a row of zeroes', () => {
    expect(deriveAccumulatorSeed(null)).toBeNull();
    expect(deriveAccumulatorSeed(undefined)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE STAGE BOUNDARY
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('df35d60d · the stage boundary, as item 1bb09a73 moved it', () => {
  it('the TP3 service writes employee_tp3 AND projects onto the four tax columns', () => {
    expect(CORE_TP3).toMatch(/insert\(employeeTp3\)/);
    // ⚠️ REVERSED BY 1bb09a73 AND SAID SO IN WORDS. Stage 1 asserted `.not.toMatch` here: the whole
    // point of that stage was that the form moved no tax. The reporter's item is that the form reaching
    // nothing is the defect, so the assertion is inverted rather than dropped — a deleted guard leaves
    // no record that the decision changed.
    expect(CORE_TP3, 'projects the seed onto the statutory row').toMatch(/update\(employeeStatutoryMy\)/);
    expect(CORE_TP3, 'still never writes a payroll input').not.toMatch(/payrollInput/);
    expect(CORE_TP3).toMatch(/employeeStatutoryMy\.tp3NetRemuneration/);
  });

  it('the payroll kernel still seeds its accumulators from the five columns, and now guards the year', () => {
    expect(CORE_PAYROLL).toMatch(/tp3Applies = e\.tp3Year === pYear/);
    expect(CORE_PAYROLL).toMatch(/netRemuneration: tp3Applies/);
    // ⚠️ ALSO REVERSED. `employeeTp3` is now read by the PRE-PROCESSING GATE — not by the calculation,
    // which still takes its figures from the five columns. That distinction is what the next two lines
    // pin: the kernel reads the form to REFUSE a run, never to compute one.
    expect(CORE_PAYROLL, 'reads the form table to guard the run').toMatch(/from\(employeeTp3\)/);
    expect(CORE_PAYROLL, 'and the accumulator seed is still the columns').toMatch(
      /netRemuneration: tp3Applies \? Number\(e\.tp3Net/,
    );
  });

  it('saving a TP3 for an EARLIER year never demotes the year the PCB kernel matches on', async () => {
    const { personId } = await hire();
    await owner.db.insert(schema.employeeStatutoryMy).values({
      tenantId: b.tenantId,
      personId,
      icNumber: `900101-10-${Math.floor(Math.random() * 9000 + 1000)}`,
      tp3Year: YEAR,
      tp3NetRemuneration: '49400.00',
      tp3EpfClaimed: '6600.00',
      tp3PcbPaid: '3120.50',
      tp3ZakatPaid: '500.00',
    });
    // Deliberately DISAGREEING figures, so a projection that ran for the wrong year is visible.
    const disagreeing = {
      sectionC: { c1: { amount: 99999 }, c3: { amount: 1 }, c5: { amount: 2 }, c4: { subItems: { i: 3, ii: 0 } } },
    };
    // ⚠️ THE SECOND SAVE IS FOR A DIFFERENT YEAR, AND BOTH THE ORDER AND THE YEAR ARE LOAD-BEARING.
    // Saving only for the SAME year as the stored `tp3_year` makes this case blind to a service that
    // copies the year across: it would write the value already there and the row would compare equal.
    // Saving the differing year LAST is what makes such a copy visible — a mutation that wrote
    // `tp3_year = assessmentYear` passed this case twice (once for the same year, once because a later
    // same-year save put it back) before it was written this way.
    await saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, ...disagreeing });
    await saveTp3(adminCtx(b), { personId, assessmentYear: YEAR - 1, ...disagreeing });

    const after = await owner.db
      .select()
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, personId));
    // ⚠️ UPDATED FOR 1bb09a73, and the load-bearing half is unchanged. The SAME-year save now DOES
    // write the columns — that is the item. What must still hold, and what the original case was really
    // built to catch, is that the following EARLIER-year save leaves `tp3_year` alone: a demotion there
    // would swap a live statutory figure for a stale one with nothing on screen to say so.
    expect(after[0].tp3Year, 'the year the PCB kernel matches on is untouched').toBe(YEAR);
    expect(Number(after[0].tp3NetRemuneration), 'the SAME-year form’s figures, not the earlier form’s').toBe(
      99999 - 1,
    );
    expect(Number(after[0].tp3PcbPaid)).toBe(2);
    expect(Number(after[0].tp3ZakatPaid)).toBe(3);
  });

  it('the screen still carries a stage banner, now saying which section moves the deduction', () => {
    expect(PAGE).toContain("t('tp3.stageNote')");
    for (const l of LOCALES) {
      const note = (messages[l] as unknown as { taxRelief: { tp3: { stageNote: string } } }).taxRelief.tp3.stageNote;
      expect(note, `${l} stageNote`).toBeTruthy();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · THE ROW COUNT THE FORM IS RULED FOR
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('df35d60d · Section A is ruled for two employers, and a third is refused not dropped', () => {
  it('declares two, from the pack rather than from a literal in a screen', () => {
    expect(TP3_MAX_EMPLOYERS).toBe(2);
    expect(MY_TP3_2026.maxEmployers).toBe(2);
    expect(PAGE, 'the screen reads the pack’s number').toContain('TP3_MAX_EMPLOYERS');
    expect(PAGE, 'and never hardcodes it').not.toMatch(/length:\s*2\s*\}/);
  });

  it('stores two and REFUSES a third, quoting the form’s own attachment note', async () => {
    const { personId } = await hire();
    await saveTp3(adminCtx(b), {
      personId,
      assessmentYear: YEAR,
      previousEmployers: [
        { name: 'Alpha Sdn Bhd', tin: 'IG1234567890' },
        { name: 'Beta Sdn Bhd', tin: null },
      ],
    });
    const row = (await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR }))!;
    expect(row.previousEmployers).toEqual([
      { name: 'Alpha Sdn Bhd', tin: 'IG1234567890' },
      { name: 'Beta Sdn Bhd', tin: null },
    ]);

    await expect(
      saveTp3(adminCtx(b), {
        personId,
        assessmentYear: YEAR,
        previousEmployers: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      }),
    ).rejects.toThrow(/additional attachment/i);
    // AND THE REFUSAL LEFT THE RECORD ALONE — a partial write here would be two employers on a form
    // that should have named three.
    const after = (await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR }))!;
    expect(after.previousEmployers).toHaveLength(2);
  });

  it('drops a wholly blank pair but refuses a TIN with no name', async () => {
    const { personId } = await hire();
    await saveTp3(adminCtx(b), {
      personId,
      assessmentYear: YEAR,
      previousEmployers: [{ name: '  ', tin: '  ' }, { name: 'Only One', tin: '' }],
    });
    const row = (await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR }))!;
    expect(row.previousEmployers, 'an empty pair is not an employer with no name').toEqual([
      { name: 'Only One', tin: null },
    ]);

    await expect(
      saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, previousEmployers: [{ tin: 'IG99' }] }),
    ).rejects.toThrow(/no name/i);
  });

  it('the renderer draws EVERY ruled slot, filled or not, and refuses more than it is ruled for', async () => {
    const { cells } = await renderAndRead({ employers: [{ name: 'Alpha Sdn Bhd', tin: 'IG1234567890' }] });
    // Four boxes — A1..A4 — even though only ONE employer was given. A form that stops after the
    // employers it happens to have is a form a reader cannot check against the paper.
    for (const code of ['A1', 'A2', 'A3', 'A4']) expect(cells, `slot ${code}`).toContain(code);
    expect(cells, 'the one employer it does have is printed').toContain('Alpha Sdn Bhd');

    await expect(
      renderTp3Pdf(pdfData({ employers: [{ name: 'A', tin: null }, { name: 'B', tin: null }, { name: 'C', tin: null }] })),
    ).rejects.toBeInstanceOf(Tp3PdfOverflowError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · THE DRAWN FORM
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** A minimal, valid `Tp3PdfData` — every case overrides only the part it is about. */
function pdfData(over: Partial<Tp3PdfData> = {}): Tp3PdfData {
  return {
    formCode: TP3_FORM_CODE,
    deductionMonth: 6,
    deductionYear: YEAR,
    employerSlots: TP3_MAX_EMPLOYERS,
    employers: [],
    employerFootnote: '*Please use additional attachment for the next employment',
    employee: { name: 'TP3 Subject', idNumber: '900101-10-1234', tin: 'IG9876543210' },
    sectionC: TP3_SECTION_C.map((l, i) => ({
      label: `C${i + 1}`,
      description: `Section C line ${i + 1}`,
      limit: null,
      amount: null,
      subItems: l.subItems.map((s) => ({ code: s.code, description: `sub ${s.code}`, limit: null, amount: null })),
    })),
    sectionD: TP3_SECTION_D.map((item) => ({
      label: `D${tp3LineNumber(item.code)}`,
      description: `Relief ${item.code}`,
      limit: item.limit,
      amount: null,
      perSubLimit: item.perSubLimit,
      subItems: item.subItems.map((s) => ({ code: s.code, description: `sub ${s.code}`, limit: s.limit, amount: null })),
    })),
    labels: {
      sectionA: 'SECTION A: EMPLOYER INFORMATION',
      sectionB: 'SECTION B: EMPLOYEE INFORMATION',
      sectionC: 'SECTION C: REMUNERATION INFORMATION / EPF / ZAKAT / PCB',
      sectionCHelp: '(from previous employment)',
      sectionD: 'SECTION D: REMUNERATION DEDUCTION',
      sectionDHelp: '(from previous employment)',
      sectionE: 'SECTION E: EMPLOYEE DECLARATION',
      deductionMonth: 'DEDUCTION MONTH:',
      deductionYear: 'DEDUCTION YEAR:',
      employerName: (i: number) => `Previous Employer Name ${i}`,
      employerTin: () => 'Tax Identification Number (TIN)',
      employeeName: 'Name',
      employeeIdNumber: 'Identity Card/Passport Number',
      employeeTin: 'Tax Identification Number (TIN)',
      colAnnualLimit: 'ANNUAL LIMIT (RM)',
      colAccumulated: 'ACCUMULATED DEDUCTION (RM)',
      date: 'Date:',
      signature: 'Signature',
      note: 'NOTE:',
      noteLines: ['The employer must request the employee to submit this form.'],
    },
    declaration: { text: 'I acknowledge that all the information stated in this form is true.', declaredOn: null },
    provenance: ['Susun atur kami sendiri.', 'Our own layout, drawn to follow the LHDN TP3 form.'],
    ...over,
  };
}

/**
 * Render, then read back EVERY STRING THE DOCUMENT ACTUALLY DRAWS.
 *
 * pdf-lib writes `drawText` into an UNCOMPRESSED content stream, one `<hex> Tj` per call, so the drawn
 * literals can be recovered exactly. That is what lets "a blank box prints no figure" be a test about
 * the DOCUMENT rather than about the source that produced it — the difference between checking the form
 * and checking the code that was supposed to produce it.
 *
 * ONE STRING PER CELL, kept as an ARRAY rather than joined, and that matters: a Section D annual limit
 * of 8,000 prints as "8,000.00", which CONTAINS "0.00". Asking whether any CELL *is* "0.00" is the
 * question; asking whether the page contains those four characters is not.
 *
 * If pdf-lib ever starts compressing content streams or encoding text differently, the "is readable at
 * all" case below fails loudly — it asserts a string that is certainly drawn — rather than every other
 * case here quietly passing on an absence.
 */
async function renderAndRead(over: Partial<Tp3PdfData> = {}): Promise<{ cells: string[]; text: string }> {
  const bytes = await renderTp3Pdf(pdfData(over));
  expect(Buffer.from(bytes.slice(0, 5)).toString('latin1'), 'must be a PDF').toBe('%PDF-');
  const raw = Buffer.from(bytes).toString('latin1');
  // Content streams may or may not be Flate-compressed (pdf-lib decides), so try both and take whichever
  // yields text. Reading only the raw bytes is how this helper silently returns nothing and every case
  // built on it passes on an empty page.
  const cells: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    const chunk = Buffer.from(raw.slice(start, end), 'latin1');
    let body: string;
    try {
      body = inflateSync(chunk).toString('latin1');
    } catch {
      body = chunk.toString('latin1');
    }
    for (const hit of body.matchAll(/<([0-9A-Fa-f]{2,})>\s*Tj/g)) {
      cells.push(Buffer.from(hit[1], 'hex').toString('latin1'));
    }
  }
  return { cells, text: cells.join('\n') };
}

describe('df35d60d · the drawn form says only what is true', () => {
  it('is readable at all — the precondition every other case here depends on', async () => {
    const { cells } = await renderAndRead();
    expect(cells, 'the masthead is certainly drawn').toContain('INLAND REVENUE BOARD OF MALAYSIA');
    expect(cells).toContain('PCB FORM /TP3 (1/2026)');
  });

  it('prints an EMPTY box for a figure nobody recorded, never 0.00', async () => {
    const { cells } = await renderAndRead(); // every amount null
    // NOT `text.includes('0.00')` — an 8,000 annual limit prints "8,000.00". The question is whether any
    // CELL IS a zero, and with every amount absent the answer must be no.
    expect(cells, 'a printed zero asserts that the money does not exist').not.toContain('0.00');
    // …and it is not that the renderer cannot print money: give it one and the figure appears.
    const withMoney = await renderAndRead({
      sectionC: pdfData().sectionC.map((l, i) => (i === 0 ? { ...l, amount: 1234.5 } : l)),
    });
    expect(withMoney.cells).toContain('1,234.50');
    // And a REAL zero, deliberately entered, still prints — the rule is about absence, not about zero.
    const withZero = await renderAndRead({
      sectionC: pdfData().sectionC.map((l, i) => (i === 0 ? { ...l, amount: 0 } : l)),
    });
    expect(withZero.cells, 'a keyed zero is a statement somebody made').toContain('0.00');
  });

  it('prints the sections, the numbering and the agency’s own NOTE block', async () => {
    const { cells, text } = await renderAndRead();
    for (const banner of ['SECTION A', 'SECTION B', 'SECTION C', 'SECTION D', 'SECTION E']) {
      expect(text, banner).toContain(banner);
    }
    for (const n of ['C1', 'C5', 'D1', 'D16', 'D17']) expect(cells, n).toContain(n);
    expect(cells, 'B1–B3').toContain('B3');
    expect(cells).toContain('NOTE:');
    expect(text, 'the employer-keeps-it note').toContain('The employer must request');
  });

  it('prints no group figure where the agency’s Section C has no box for one', async () => {
    // C2 and C4 carry their numeral lines' boxes and NOTHING against the C2 / C4 line itself; Section D
    // is the other way round, where the brace joins the lettered boxes to ONE group figure. Caught by
    // rendering the form and reading it — the screen and the stored payload were both already right.
    expect(ROUTE).toMatch(/amount: line\.subItems\.length === 0 \? figure\(stored\?\.amount\) : null/);
    const { cells } = await renderAndRead({
      sectionC: pdfData().sectionC.map((l) =>
        l.label === 'C2'
          ? { ...l, amount: null, subItems: l.subItems.map((sub) => ({ ...sub, amount: 111.11 })) }
          : l,
      ),
    });
    expect(cells, 'the five numeral boxes print').toContain('111.11');
    expect(cells, 'and no 555.55 group total appears where the form has no box').not.toContain('555.55');
    // Section D keeps its group figure, because its form DOES have that box.
    const withGroup = await renderAndRead({
      sectionD: pdfData().sectionD.map((i) => (i.label === 'D5' ? { ...i, amount: 2500 } : i)),
    });
    expect(withGroup.cells).toContain('2,500.00');
  });

  it('prints Section C with NO annual-limit column, and Section D with one', async () => {
    const { cells } = await renderAndRead();
    expect(cells).toContain('ANNUAL LIMIT (RM)');
    expect(cells).toContain('ACCUMULATED DEDUCTION (RM)');
    // The em dash the renderer prints for "no printed limit" belongs to Section D's D16 only. Section C
    // lines pass `withLimit: false`, so the limit column is not drawn for them at all.
    expect(PDF).toContain('drawItem(item, false)');
    expect(PDF).toContain('drawItem(item, true)');
  });

  it('never formats money inline, and never coalesces a null amount to zero', () => {
    // A `?? 0` or a bare `toFixed` in the money path is how a blank becomes 0.00 without anyone noticing.
    expect(PDF, 'one money formatter').toMatch(/const money = \(n: number\)/);
    expect(PDF.replace(/const money = [^\n]*\n/, ''), 'no second formatter').not.toMatch(/toLocaleString/);
    expect(PDF, 'the empty branch draws a rule').toMatch(/if \(value == null\)[\s\S]{0,200}drawLine/);
  });

  it('refuses to claim it is the agency’s own page', () => {
    // RAW, not comment-stripped: the refusal is a statement in the renderer's own header, which is
    // where lib/tp1-pdf.ts keeps the identical one and where test/statutory-forms-page.test.ts looks.
    expect(readFileSync(join(ROOT, 'lib/tp3-pdf.ts'), 'utf8')).toContain('described as the official form');
    for (const l of LOCALES) {
      const tp3 = (messages[l] as unknown as { taxRelief: { tp3: Record<string, string> } }).taxRelief.tp3;
      expect(tp3.pdfProvenanceEn, `${l}`).toContain('not the agency');
    }
    expect(ROUTE).toContain("t('tp3.pdfProvenanceMs')");
  });

  it('prints the deduction month as the form’s own NUMBER, never a localised month name', () => {
    // Helvetica is WinAnsi and `safe()` folds anything outside it to '?'. A Tamil / Thai / Chinese month
    // name would print as a row of question marks — the finding lib/payslip-pdf-strings.ts records.
    expect(PDF, 'no month formatting in the renderer').not.toMatch(/DateTimeFormat/);
    expect(ROUTE, 'nor in the route that feeds it').not.toMatch(/DateTimeFormat/);
    expect(PDF).toMatch(/data\.deductionMonth \?\? '—'/);
  });

  it('renders in both of the languages the agency issues the form in, and only those', () => {
    expect(ROUTE).toMatch(/const TP3_LANGS = \['en', 'ms'\]/);
    expect(ROUTE, 'an unknown lang falls back rather than reaching next-intl').toContain('isTp3Lang');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · THE SERVICE: LIMITS, GRAIN, AUTHORIZATION, EVENTS
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('df35d60d · the record', () => {
  it('refuses a Section D figure over the annual limit the form prints', async () => {
    const { personId } = await hire();
    // D5 (lifestyle) is 2,500 as a GROUP, over four lettered boxes the server sums itself.
    await expect(
      saveTp3(adminCtx(b), {
        personId,
        assessmentYear: YEAR,
        sectionD: { c5: { subItems: { a: 1500, b: 1500, c: 0, d: 0 } } },
      }),
    ).rejects.toThrow(/D5 must not exceed its annual limit of RM 2500\.00/);

    // …and a sub-limit on its own line: D3(c) skills enhancement is capped at 2,000 INSIDE the 7,000.
    await expect(
      saveTp3(adminCtx(b), {
        personId,
        assessmentYear: YEAR,
        sectionD: { c3: { subItems: { a: 0, b: 0, c: 2500 } } },
      }),
    ).rejects.toThrow(/D3\(c\) must not exceed its limit of RM 2000\.00/);
  });

  it('lets D16 exceed 7,000 across its two bands, because they are two claims and not a group', async () => {
    const { personId } = await hire();
    // ⚠️ ITEM 20837372 — a statutory row is now REQUIRED for a Section-D-only form too. Section D used
    // to reach nothing, so it had nothing to lose and saved against a person the tax calculation could
    // not read. It is now ∑LP, so it is money, and `throwIfNowhereToLand` covers it like the rest.
    await withStatutoryRow(personId);
    await saveTp3(adminCtx(b), {
      personId,
      assessmentYear: YEAR,
      sectionD: { c16: { subItems: { a: 7000, b: 5000 } } },
    });
    const row = (await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR }))!;
    expect(row.payload!.sectionD.c16.subItems).toEqual({ a: 7000, b: 5000 });
  });

  it('computes every item amount server-side — a client total is never trusted', async () => {
    const { personId } = await hire();
    // ⚠️ ITEM 20837372 — a statutory row is now REQUIRED for a Section-D-only form too. Section D used
    // to reach nothing, so it had nothing to lose and saved against a person the tax calculation could
    // not read. It is now ∑LP, so it is money, and `throwIfNowhereToLand` covers it like the rest.
    await withStatutoryRow(personId);
    await saveTp3(adminCtx(b), {
      personId,
      assessmentYear: YEAR,
      // A LIE: the amount says 0 while the sub-lines say 900. The server must use the sub-lines.
      sectionD: { c6: { amount: 0, subItems: { a: 400, b: 500, c: 0, d: 0 } } },
    });
    const row = (await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR }))!;
    expect(row.payload!.sectionD.c6.amount).toBe(900);
  });

  it('keeps ONE record per person per assessment year, updating in place', async () => {
    const { personId } = await hire();
    await withStatutoryRow(personId);
    await saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, sectionC: { c1: { amount: 100 } } });
    await saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, sectionC: { c1: { amount: 200 } } });
    const rows = await owner.db
      .select()
      .from(schema.employeeTp3)
      .where(eq(schema.employeeTp3.personId, personId));
    expect(rows, 'the unique index is the grain').toHaveLength(1);
    expect(Number(rows[0].payload!.sectionC.c1.amount)).toBe(200);

    await saveTp3(adminCtx(b), { personId, assessmentYear: YEAR - 1, sectionC: { c1: { amount: 50 } } });
    // ORDERED IN THE QUERY, newest first — an asserted array from a query needs one.
    expect(await listTp3YearsForPerson(adminCtx(b), { personId })).toEqual([YEAR, YEAR - 1]);
  });

  it('stamps Section E by VALUE, and unticking clears the date', async () => {
    const { personId } = await hire();
    await saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, declarationAccepted: true });
    const declared = (await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR }))!;
    expect(declared.declaredAt, 'a timestamp, not a tick').toBeInstanceOf(Date);

    await saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, declarationAccepted: false });
    const withdrawn = (await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR }))!;
    expect(withdrawn.declaredAt, 'a withdrawn declaration must not keep printing a date').toBeNull();
  });

  it('reads the tick by VALUE and never by presence — the hidden input is always submitted', () => {
    const fd = new FormData();
    fd.set('assessmentYear', String(YEAR));
    fd.append('declarationAccepted', 'no'); // the hidden input the form always sends
    expect(readTp3FormInput(fd).declarationAccepted, 'unticked').toBe(false);
    fd.append('declarationAccepted', 'yes'); // …and the checkbox, when ticked
    expect(readTp3FormInput(fd).declarationAccepted, 'ticked').toBe(true);
    // The emitter renders the hidden `no` FIRST, or the reader above can never see an untick.
    expect(PAGE).toMatch(/name="declarationAccepted" value="no"[\s\S]{0,400}value="yes"/);
  });

  it('refuses a non-admin write in the service, and the policy refuses it again', async () => {
    const { personId } = await hire();
    const employeeUserId = await createAppUser(b.tenantId, personId, 'employee');
    const selfCtx = {
      tenantId: b.tenantId,
      userId: employeeUserId,
      personId,
      roles: ['employee'],
      entitlements: harnessSnapshot(b.tenantId),
    } satisfies SessionContext;
    await expect(saveTp3(selfCtx, { personId, assessmentYear: YEAR })).rejects.toBeInstanceOf(Tp3Error);
    // TWO GATES, not one: the migration's WITH CHECK is app.is_admin().
    expect(MIGRATION).toMatch(/WITH CHECK \("tenant_id" = app\.current_tenant_id\(\) AND app\.is_admin\(\)\)/);
    expect(MIGRATION).toMatch(/USING \("tenant_id" = app\.current_tenant_id\(\) AND app\.can_see_person\("person_id"\)\)/);
  });

  it('appends a before/after event on every write, and on the delete', async () => {
    const { personId } = await hire();
    await withStatutoryRow(personId);
    await saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, sectionC: { c1: { amount: 1000 } } });
    await saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, sectionC: { c1: { amount: 2000 } } });
    await deleteTp3(adminCtx(b), { personId, assessmentYear: YEAR });

    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateType, 'employee-tp3'))
      .orderBy(schema.domainEvent.occurredAt, schema.domainEvent.id);
    expect(events.map((e) => e.eventType)).toEqual([
      'employee.tp3form.updated',
      'employee.tp3form.updated',
      'employee.tp3form.deleted',
    ]);
    const second = events[1].payload as { before: { payload: { sectionC: Record<string, { amount: number }> } } | null };
    expect(second.before!.payload.sectionC.c1.amount, 'the before-image is the record’s history').toBe(1000);
    expect(await getTp3ForPersonYear(adminCtx(b), { personId, assessmentYear: YEAR })).toBeNull();
  });

  it('refuses an implausible year and an out-of-range deduction month', async () => {
    const { personId } = await hire();
    await expect(saveTp3(adminCtx(b), { personId, assessmentYear: 1999 })).rejects.toThrow(/2000 and 2100/);
    await expect(
      saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, deductionMonth: 13 }),
    ).rejects.toThrow(/between 1 and 12/);
    await expect(
      saveTp3(adminCtx(b), { personId, assessmentYear: YEAR, sectionC: { c1: { amount: -5 } } }),
    ).rejects.toThrow(/must not be negative/);
  });

  it('shows the employee’s own identity for Section B, and an absent id as null not a guess', async () => {
    const { personId } = await hire('Identity Subject');
    const bare = await getTp3Identity(adminCtx(b), { personId });
    expect(bare.employee.name).toBe('Identity Subject');
    expect(bare.employee.idNumber, 'no statutory row yet ⇒ the printed box stays blank').toBeNull();

    await owner.db.insert(schema.employeeStatutoryMy).values({
      tenantId: b.tenantId,
      personId,
      passportNumber: 'A1234567',
      taxNumber: 'IG5555555555',
    });
    const withPassport = await getTp3Identity(adminCtx(b), { personId });
    expect(withPassport.employee.idNumber, 'IC first, passport second').toBe('A1234567');
    expect(withPassport.employee.tin).toBe('IG5555555555');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 7 · THE SURFACE
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('df35d60d · the screen and the migration', () => {
  it('the guarded page has a column on the access grid', () => {
    const entry = SCREENS.find((sc) => sc.routes.includes('/payroll/transactions/tp3'));
    expect(entry, 'a guarded page with no column is a screen nobody can grant or revoke').toBeTruthy();
    expect(entry!.guard).toBe('scopedAdmin');
  });

  it('the server actions never cross into a client island as props', () => {
    // r123's 500 was a function prop crossing this boundary while tsc, the suite and `next build` all
    // stayed green. The actions are used as `<form action={…}>` on SERVER-rendered forms only.
    expect(PAGE).toMatch(/action=\{saveTp3Action\}/);
    expect(PAGE).toMatch(/action=\{deleteTp3Action\}/);
    // …and neither action is a PROP on the one client island. Read the island's own JSX rather than a
    // proximity regex: the panel and the save form are near each other in this file by design.
    const islandStart = PAGE.indexOf('<EmployeeScopePanel');
    expect(islandStart, 'the island is rendered').toBeGreaterThan(-1);
    const island = PAGE.slice(islandStart, PAGE.indexOf('/>', islandStart));
    expect(island, 'no server action crosses the boundary').not.toContain('Tp3Action');
    expect(PAGE, 'a server page').not.toContain("'use client'");
  });

  it('resolves the assessment year through the Kuala Lumpur clock, never the host year', () => {
    expect(PAGE).toContain('todayInKualaLumpur()');
    expect(PAGE).not.toMatch(/new Date\(\)\.getFullYear\(\)/);
  });

  it('reaches payroll vocabulary through the pack facade, not core directly', () => {
    expect(PAGE).toContain("from '@/packs/payroll/service'");
    expect(PAGE).not.toContain("from '@/core/tp3'");
    expect(ACTIONS).toContain("from '@/packs/payroll/service'");
    expect(ACTIONS).not.toContain("from '@/core/tp3'");
  });

  it('the migration creates the table, grants on it and turns RLS on', () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "employee_tp3"/);
    // A dev restore has no default privileges and the suite connects as the owner, so no test would
    // otherwise see a missing GRANT (0345 / 0354).
    expect(MIGRATION).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_tp3" TO ai_hr_app/);
    expect(MIGRATION).toMatch(/ALTER TABLE "employee_tp3" ENABLE ROW LEVEL SECURITY/);
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "employee_tp3_person_year_uq"/);
  });

  it('is in the journal, after every entry that precedes it', () => {
    const journal = JSON.parse(readFileSync(join(ROOT, 'db/migrations/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const mine = journal.entries.find((e) => e.tag === '0480_employee_tp3');
    expect(mine, 'the journal entry IS the migration; a .sql without one never runs').toBeTruthy();
    // drizzle's watermark is the last applied `when`: a lower one merged later is a SILENT skip. So what
    // must hold is that 0480 outranks everything BEFORE it — not that nothing ever comes after it.
    //
    // ⚠️ r330 — THE FIRST SPELLING OF THIS GUARD ASSERTED THE LATTER, and it was wrong the moment a
    // later migration landed (0482_system_testing, the very next round). It passed in the worktree that
    // wrote it because 0480 was the newest entry there, and went red only on the merged tree. The INTENT
    // is unchanged and still asserted; what is fixed is that it compares against the entries that
    // actually precede this one, which is what "a lower one merged later is a silent skip" means.
    const at = journal.entries.findIndex((e) => e.tag === mine!.tag);
    for (const e of journal.entries.slice(0, at)) {
      expect(e.idx, `${e.tag} precedes 0480 and must rank below it`).toBeLessThan(mine!.idx);
      expect(e.when, `${e.tag} precedes 0480 and its timestamp must too`).toBeLessThan(mine!.when);
    }
    // …and anything that came later must outrank it, for the same reason in the other direction.
    for (const e of journal.entries.slice(at + 1)) {
      expect(e.idx, `${e.tag} follows 0480 and must rank above it`).toBeGreaterThan(mine!.idx);
      expect(e.when, `${e.tag} follows 0480 and its timestamp must too`).toBeGreaterThan(mine!.when);
    }
  });

  it('carries every new string in all six locales', () => {
    const shape = (o: unknown, p = ''): string[] =>
      o && typeof o === 'object'
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => shape(v, `${p}${k}.`))
        : [p.slice(0, -1)];
    const en = shape((messages.en as unknown as { taxRelief: { tp3: unknown } }).taxRelief.tp3).sort();
    expect(en.length).toBeGreaterThan(40);
    for (const l of LOCALES) {
      const other = shape((messages[l] as unknown as { taxRelief: { tp3: unknown } }).taxRelief.tp3).sort();
      expect(other, `${l} taxRelief.tp3`).toEqual(en);
    }
    for (const l of LOCALES) {
      const sf = (messages[l] as unknown as { payroll: { statutoryForms: Record<string, string> } }).payroll.statutoryForms;
      expect(sf.link_tp3, `${l} link_tp3`).toBeTruthy();
      expect(sf.desc_tp3, `${l} desc_tp3`).toBeTruthy();
      expect(sf.planned_lhdn_tp3, `${l}: the planned keys left with the form`).toBeUndefined();
    }
  });
});
