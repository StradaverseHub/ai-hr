/** PCB formula regression tests: extract the actual rendered PDF through its font ToUnicode CMaps.
 * r377 replaces the previous ASCII approximation with real mathematical glyphs. */
import fs from 'node:fs';
import { extractedText as drawnText } from './helpers/pcb-pdf-text';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFRawStream, decodePDFRawStream, type PDFArray } from 'pdf-lib';
import { pcbPdfText, renderPcbDetailPdf } from '../app/payroll/pcb-detail/slip-pdf';
import { pcbFormulaBlocks } from '../app/payroll/pcb-detail/formulas';
import { explainPcb, type PcbExplanation, type PcbReliefBreakdown } from '../core/pcb-explain';
import { pcbMonth } from '../localization/my/payroll';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The two locales this document is ISSUED in. LHDN publishes in Bahasa Malaysia and English, and
 *  `shared.ts` allowlists exactly these because the embedded Helvetica cannot render the other four. */
const DOC_LOCALES = ['en', 'ms'] as const;

const CURRENT: PcbReliefBreakdown = {
  individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000,
};

const b2 = (v: number) => v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r: number) => `${(r * 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const FMT = { b2, pct, int: (v: number) => `${v}` };

/** A month with every limb of the working alive at once, so no two symbols share one stored zero. */
function bonusMonth(): Extract<PcbExplanation, { kind: 'mtd' }> {
  const r = pcbMonth({
    monthlyWage: 14000,
    epfMonthly: 1540,
    month: 7,
    profile: { category: 2, children: 3 },
    acc: { netRemuneration: 63000, epfClaimed: 800, pcbPaid: 4100, zakatPaid: 250, lpAccumulated: 480 },
    additional: 26000,
    epfOnAdditional: 600,
    lpCurrent: 90,
    zakatCurrent: 60,
  });
  const x = explainPcb(
    { pcb: r.total, pcbBonus: r.additional, epfEmployee: 1540, zakat: 60, lp: 570, pcbMeta: r.snapshot },
    CURRENT,
  );
  if (x.kind !== 'mtd') throw new Error('unreachable — a resident month is an MTD month');
  return x;
}

/** The ordinary month: no additional remuneration, so §D.2 never ran. */
function plainMonth(): Extract<PcbExplanation, { kind: 'mtd' }> {
  const r = pcbMonth({
    monthlyWage: 9000,
    epfMonthly: 990,
    month: 4,
    profile: { category: 2, children: 1 },
    acc: { netRemuneration: 24000, epfClaimed: 2970, pcbPaid: 600, zakatPaid: 0, lpAccumulated: 0 },
  });
  const x = explainPcb({ pcb: r.total, epfEmployee: 990, pcbMeta: r.snapshot }, CURRENT);
  if (x.kind !== 'mtd') throw new Error('unreachable');
  return x;
}

/**
 * The text a reader actually sees, recovered from the rendered file.
 *
 * pdf-lib emits `<hex> Tj` per drawn string and compresses the content stream, so the bytes cannot be
 * grepped directly — they must be decoded. This is deliberately NOT the model handed to the renderer: a
 * fold applied inside the renderer is invisible to any assertion about its input, which is exactly how the
 * '?' shipped.
 */
// ───────────────────────── (a) the fold, and the defect it was shipping ─────────────────────────

describe('r351 — the WinAnsi fold no longer turns LHDN’s symbols into question marks', () => {
  /** The fold EXACTLY as it stood before r351, restated here so this file cannot pass vacuously. It is not
   *  imported: the point is to hold the old behaviour still while the new one is compared against it. */
  const foldBefore = (s: string) =>
    (s ?? '')
      .replace(/[–—−]/g, '-')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...')
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  it('the pre-r351 fold printed ?(Y - K), ?LP and Y? - K? — and the new one does not', () => {
    // The three the reporter would have been holding. Each is a string `core/pcb-explain.ts` emits into a
    // worksheet row that reaches the PDF, so each was really on the downloaded document.
    expect(foldBefore('Σ(Y−K)'), 'the defect, as it shipped').toBe('?(Y-K)');
    expect(foldBefore('ΣLP')).toBe('?LP');
    expect(foldBefore('Y₁ − K₁')).toBe('Y? - K?');

    expect(pcbPdfText('Σ(Y−K)'), 'and what it prints now').toBe('Σ(Y−K)');
    expect(pcbPdfText('ΣLP')).toBe('ΣLP');
    expect(pcbPdfText('Y₁ − K₁')).toBe('Y₁ − K₁');
    // The specification's own sigma is U+2211 where core emits U+03A3; both must fold the same way or the
    // formula and the row it names print differently.
    expect(pcbPdfText('∑LP'), 'U+2211 and U+03A3 fold alike').toBe('ΣLP');
    // Every subscript this screen uses, to its base character.
    expect(pcbPdfText('K₂ₜ')).toBe('K₂ₜ');
    expect(pcbPdfText('P₂ = Σ(Y − K*) + (Yₜ − Kₜ*)')).toBe('P₂ = Σ(Y − K*) + (Yₜ − Kₜ*)');
  });

  it('no caption on the document, in either issued locale, folds to a question mark', () => {
    // A caption added later with a new symbol in it fails HERE rather than on a customer's download. Both
    // namespaces the document resolves are swept: its own, and the agency's seventeen relief lines.
    const strings: [where: string, value: string][] = [];
    const walk = (where: string, node: unknown) => {
      if (typeof node === 'string') strings.push([where, node]);
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(`${where}.${k}`, v);
      }
    };
    for (const loc of DOC_LOCALES) {
      const json = JSON.parse(read(`messages/${loc}.json`)) as {
        payroll: { pcbDetail: unknown };
        taxRelief: unknown;
      };
      walk(`${loc}.payroll.pcbDetail`, json.payroll.pcbDetail);
      walk(`${loc}.taxRelief`, json.taxRelief);
    }
    expect(strings.length, 'the sweep reaches the catalogue').toBeGreaterThan(200);
    for (const [where, value] of strings) {
      if (value.includes('?')) continue; // a genuine question mark in the prose is not a folding failure
      expect(pcbPdfText(value), `${where} folds to a '?' on the PDF`).not.toContain('?');
    }
  });

  it('every caption key the assembly can emit resolves in all six catalogues', () => {
    /**
     * ⚠️ THE GUARD THAT CAUGHT A REAL DEFECT IN THIS ROUND. `formulas.ts` names its headings, formulas,
     * legends, result captions and notes as KEYS, and every one of them is a COMPUTED t() key — invisible
     * to test/i18n-coverage.ts, which only sees literal keys in a single-namespace file. The first draft of
     * `formulas.ts` emitted `stepENotRecorded`, a key that was never written to any catalogue, which would
     * have painted MISSING_MESSAGE onto a statutory screen in production and passed tsc, the gate and
     * `next build`. The keys are therefore collected from the ASSEMBLY ITSELF, over fixtures that between
     * them reach every branch, rather than from a hand-kept list that could drift from it.
     */
    const keys = new Set<string>();
    for (const x of [plainMonth(), bonusMonth()]) {
      for (const fb of pcbFormulaBlocks(x, FMT)) {
        keys.add(fb.heading);
        keys.add(fb.formula);
        keys.add(fb.resultLabel);
        if (fb.legend) keys.add(fb.legend);
        for (const n of fb.notes) keys.add(n);
      }
    }
    expect(keys.size, 'the assembly names captions').toBeGreaterThan(15);
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const) {
      const blk = (JSON.parse(read(`messages/${loc}.json`)) as { payroll: { pcbDetail: Record<string, string> } })
        .payroll.pcbDetail;
      for (const k of keys) {
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc}`).toBeTruthy();
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc} must take no ICU argument`).not.toMatch(/[{}]/);
      }
    }
  });

  it('no symbol core emits, and no expression formulas.ts assembles, folds to a question mark', () => {
    const explain = read('core/pcb-explain.ts');
    const symbols = [...explain.matchAll(/symbol: '([^']*)'/g)].map((m) => m[1]);
    expect(symbols.length, 'core declares the symbols').toBeGreaterThan(20);
    for (const sym of symbols) {
      expect(pcbPdfText(sym), `the symbol ${sym} folds to a '?' on the PDF`).not.toContain('?');
    }
    // And the assembled expressions, which carry Σ and the subscripts several times a line.
    for (const x of [plainMonth(), bonusMonth()]) {
      for (const fb of pcbFormulaBlocks(x, FMT)) {
        for (const s of [fb.substituted, fb.calculation]) {
          if (s == null) continue;
          expect(pcbPdfText(s), `an assembled expression folds to a '?': ${s}`).not.toContain('?');
        }
      }
    }
  });
});

// ───────────────────── (b) the rendered file, read back as a reader receives it ─────────────────────

describe('r377 — rendered document preserves actual Sigma and mathematical minus', () => {
  it('every LHDN symbol and every assembled expression survives into the drawn text', async () => {
    const x = bonusMonth();
    const blocks = pcbFormulaBlocks(x, FMT);
    const bytes = await renderPcbDetailPdf({
      title: 'PCB / MTD calculation detail',
      subtitle: 'Employee · Company · 2026-07',
      sections: [
        {
          heading: 'LHDN worksheet',
          columns: ['Amount'],
          rows: [
            { line: 'Σ(Y−K)', label: 'Accumulated remuneration after EPF', cells: ['63,000.00'] },
            { line: 'ΣLP', label: 'Accumulated optional deductions', cells: ['480.00'] },
            { line: 'K2t', label: 'Re-estimated projected EPF', cells: ['0.00'] },
          ],
        },
        ...blocks.map((fb) => ({
          heading: fb.heading,
          columns: ['Amount'],
          rows: [
            { line: '', label: `Formula:  ${fb.formula}`, cells: [] },
            { line: '', label: `Actual values:  ${fb.substituted ?? 'Not recorded'}`, cells: [] },
            ...(fb.calculation === undefined ? [] : [{ line: '', label: `Calculation:  ${fb.calculation}`, cells: [] }]),
          ],
        })),
      ],
      provenance: ['Our rendering, not the agency’s form.'],
    });

    expect(Buffer.from(bytes).subarray(0, 5).toString(), 'a real PDF').toBe('%PDF-');
    const text = await drawnText(bytes);
    expect(text.length, 'the drawn text was recovered').toBeGreaterThan(200);

    // THE DEFECT, ABSENT. Not one question mark is drawn anywhere on the document — every glyph the
    // renderer was handed is one Helvetica can set, after the fold.
    expect(text, 'a statutory document must not print a question mark for a symbol').not.toContain('?');
    // …and the symbols are LEGIBLE rather than merely not-'?': each is the folded form of itself.
    for (const probe of ['Σ(Y−K)', 'ΣLP', 'K2t']) {
      expect(text, `the drawn text must contain ${probe}`).toContain(probe);
    }
  });

  it('the drawn text carries the agency’s formula, the substitution and the result of every step', async () => {
    const x = bonusMonth();
    const blocks = pcbFormulaBlocks(x, FMT);
    // `fb.formula` is a CAPTION KEY, exactly as it is on the screen; `shared.ts` resolves it with t(). It
    // is resolved here too, or this case would assert that the string "pFormula" reached the paper.
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } })
      .payroll.pcbDetail;
    const bytes = await renderPcbDetailPdf({
      title: 'PCB / MTD calculation detail',
      subtitle: 'Employee',
      sections: blocks.map((fb) => ({
        heading: en[fb.heading],
        columns: ['Amount'],
        rows: [
          { line: '', label: `Formula:  ${en[fb.formula]}`, cells: [] },
          { line: '', label: `Actual values:  ${fb.substituted ?? 'Not recorded'}`, cells: [] },
          { line: '', label: 'Result', cells: [fb.result === null ? 'Not recorded' : b2(fb.result)] },
        ],
      })),
      provenance: ['x'],
    });
    const text = await drawnText(bytes);
    // pdf-lib draws each wrapped line as its own string, so the assertion is per TOKEN rather than on the
    // whole expression: a line break inside a formula is a layout fact, not a content failure.
    for (const token of ['Σ(Y', 'K₂ₜ*)', 'max(', 'DU', 'SU', 'QC']) {
      expect(text, `the drawn text must carry ${token}`).toContain(token);
    }
    // The figure each step landed on, as a figure — and P is the stored P, not a re-derivation.
    expect(text, 'P').toContain(b2(x.chargeableIncome));
    expect(text, 'P2').toContain(b2(x.chargeableIncomeWithAdditional!));
  });
});

// ───────────────── (c) the assembly itself: one formula, two legs, the agency's zero ─────────────────

describe('r351 — the P line always prints the (Yₜ − Kₜ) limb, as the specification does', () => {
  it('a month with no additional remuneration prints the limb as ( 0.00 − 0.00 ) and runs no second leg', () => {
    const x = plainMonth();
    expect(x.chargeableIncomeWithAdditional, '§D.2 did not run').toBeNull();
    const blocks = pcbFormulaBlocks(x, FMT);
    const p1 = blocks.find((b) => b.key === 'p1');
    expect(p1, 'the P block').toBeTruthy();
    // THE POINT OF THE ITEM. The limb used to be absent from the page entirely in this, the ordinary case.
    expect(p1!.substituted, 'the agency prints "Where (Yt – Kt ) = 0" — so do we, in figures').toContain(
      '( 0.00 − 0.00 )',
    );
    expect(p1!.legend, 'and the line says which leg it is').toBe('pLegNormal');
    // …AND THE SUBSTANTIVE POINT BEHIND THE OLD GUARD IS INTACT: no second calculation is invented.
    expect(blocks.some((b) => b.key === 'p2'), 'a P₂ block would assert a calculation that never ran').toBe(false);
  });

  it('a bonus month prints the limb for real, in a SECOND expression, with K₂ₜ and not K₂', () => {
    const x = bonusMonth();
    const blocks = pcbFormulaBlocks(x, FMT);
    const p1 = blocks.find((b) => b.key === 'p1')!;
    const p2 = blocks.find((b) => b.key === 'p2')!;
    const t = x.trace!;

    // P₁ EXCLUDES THE BONUS EVEN IN A BONUS MONTH. This is the assertion that would have caught the
    // original defect: appending the bonus to the P₁ line overshoots the P beside it by the whole bonus.
    expect(t.Yt, 'the fixture really pays a bonus').toBeGreaterThan(0);
    expect(p1.substituted, 'P₁ still carries the zero limb').toContain('( 0.00 − 0.00 )');
    expect(p1.substituted, 'and never the bonus').not.toContain(b2(t.Yt));
    expect(p1.result, 'P₁ is the stored P').toBe(x.chargeableIncome);

    // P₂ is the second calculation: the bonus limb, and the RE-ESTIMATED projected EPF.
    expect(p2.substituted).toContain(`( ${b2(t.Yt)} − ${b2(t.Kt)} )`);
    expect(p2.substituted, 'K₂ₜ, because the bonus ate into the same annual relief cap').toContain(b2(t.K2t));
    expect(p2.result).toBe(x.chargeableIncomeWithAdditional);
    expect(p2.formula, 'the same published formula, with the projected EPF leg named K₂ₜ').toBe('p2Formula');
  });

  it('a step whose intermediate the engine never stored has NO calculation row', () => {
    const x = bonusMonth();
    const by = new Map(pcbFormulaBlocks(x, FMT).map((b) => [b.key, b]));
    const t = x.trace!;
    // [C] and [D] each have one, and it is a STORED figure — the floored bracket tax and the zakat
    // remainder — never an intermediate this code multiplied out.
    expect(by.get('mtd')!.calculation, 'the stored bracket tax resolves the inner bracket').toContain(b2(t.taxOnP1));
    expect(by.get('net')!.calculation, 'the stored zakat remainder resolves the inner clamp').toContain(
      b2(t.zakatLeftover),
    );
    // Step 1[E] has none: X + [ [C] × (n + 1) ] would have to be evaluated here, and the answer is stored.
    expect(by.get('year')!.calculation, 'Step 1[E] is read or absent, never multiplied out').toBeUndefined();
    expect(by.get('year')!.result, 'and the stored answer is what is printed').toBe(t.totalMtdYear);
  });

  it('Step 1[E] shows the formula and NO answer for a month the engine did not record one', () => {
    const x = plainMonth();
    const year = pcbFormulaBlocks(x, FMT).find((b) => b.key === 'year')!;
    expect(x.trace!.totalMtdYear, 'pcbMonth stamps it only inside its Yt > 0 branch').toBeNull();
    expect(year.formula, 'the agency’s step is still stated').toBe('yearFormula');
    expect(year.substituted, 'but nothing is substituted into it').toBeNull();
    expect(year.result).toBeNull();
    expect(year.notes, 'and the absence is worded').toContain('yearNoAdditional');
  });

  it('a payslip with no recorded working gets a formula and an honest absence, never a zero', () => {
    // A run predating 45df860a carries no trace. Every substitution must be NULL so the surfaces word it;
    // a "0.00" in any of them is a claim about someone's tax that nobody made (CLAUDE.md §8).
    const x = explainPcb(
      {
        pcb: 402.65,
        epfEmployee: 0,
        zakat: 15,
        pcbMeta: {
          month: 1, n: 11, ytdNet: 1234.5, epfClaimed: 200, pcbPaid: 90, P1: 75956.07,
          reliefs: { individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000 },
        },
      },
      CURRENT,
    );
    if (x.kind !== 'mtd') throw new Error('unreachable');
    expect(x.trace, 'the fixture predates the trace').toBeNull();
    for (const fb of pcbFormulaBlocks(x, FMT)) {
      expect(fb.formula, `${fb.key} still states the formula`).toBeTruthy();
      expect(fb.substituted, `${fb.key} must not substitute figures it does not have`).toBeNull();
      expect(fb.calculation, `${fb.key} must not carry a calculation row either`).toBeUndefined();
    }
  });
});
