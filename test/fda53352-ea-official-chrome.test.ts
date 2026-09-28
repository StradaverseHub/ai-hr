/**
 * Item fda53352 (r349) — THE FORM'S OWN CHROME: SOLID BLACK BLOCKS WITH WHITE LETTERING.
 *
 * ═══ WHAT THE REPORTER SENT, AND WHY IT WAS THE RIGHT THING TO SEND ═══
 *
 * A side-by-side of our page against LHDN's, with red boxes on every difference. Almost all of them were
 * one thing: the agency sets its section letters, its banner and its top-right heading as SOLID BLACK
 * BLOCKS WITH WHITE LETTERING, and we drew plain text inside an outline. That single treatment is what
 * made our page read as a different document at a glance.
 *
 * r346's own round record had already listed exactly this as NOT DONE — "the agency's page sets its
 * section letters in filled black boxes … neither was touched". They found the list we wrote.
 *
 * ═══ THE GEOMETRY IS MEASURED, NOT GUESSED ═══
 *
 * `docs/forms/ea-cp8a-pin-2023-transcription.txt` records the measurement and its method. Six squares
 * were found scanning the agency's whole left margin — one per section A–F and nothing else — all at
 * x 39.8, width 17.3. The obvious method is WRONG: these blocks contain white text, so a
 * longest-dark-run measure breaks on the letters and under-reports the height (it returned 4.8 pt for a
 * two-line block). Measuring by dark FRACTION within the block's own window is what works.
 *
 * ═══ THE FAILURE MODE THIS FILE EXISTS FOR ═══
 *
 * White-on-black renders as an EMPTY BLACK RECTANGLE if the fill is drawn after the text. That still
 * returns 200, still downloads, and still passes every other test in this repo. Three defects in r346 —
 * a duplicated Section E line, "Gratuity for the period from from", and the English heading printing
 * through the centred MALAYSIA — reached the reporter for exactly that reason. So this asserts the
 * DRAWING, not the source.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { blankEaPdfData, renderEaPdf, eaFormWords, EA_FORM, type EaPdfLabels } from '../lib/ea-pdf';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = (p: string) => readFileSync(new URL(p, `file://${root}`), 'utf8');
const cat = (loc: string) => (JSON.parse(src(`messages/${loc}.json`)) as Record<string, any>).payroll.ea;

/** The label bundle for one locale, resolved from the real catalogue (English as the base, as next-intl does). */
const bundleFor = (loc: string): EaPdfLabels => {
  const base = cat('en') as Record<string, string>;
  const over = loc === 'en' ? {} : (cat(loc) as Record<string, string>);
  return new Proxy({}, { get: (_t, k: string) => over[k] ?? base[k] ?? `«${k}»` }) as EaPdfLabels;
};

/** The page's decompressed content stream — the one that actually carries drawing operators. */
async function contentStream(locale: string): Promise<string> {
  const bytes = await renderEaPdf(blankEaPdfData(), bundleFor(locale), { blank: true, locale });
  const raw = Buffer.from(bytes);
  let best = '';
  for (const m of raw.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let s = m[1];
    try {
      s = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      /* already plain */
    }
    if (s.includes('Tj') && s.length > best.length) best = s;
  }
  return best;
}

/**
 * Every FILLED rectangle the renderer drew, in top-distance coordinates.
 *
 * ⚠️ pdf-lib DOES NOT EMIT `re`. A filled rectangle comes out as a translate plus a path:
 *     q  <r> <g> <b> rg  0 w  [] 0 d  1 0 0 1 <x> <y> cm  …  0 0 m  0 <h> l  <w> <h> l  <w> 0 l  h  f  Q
 * The first cut of this file matched `… re f`, found nothing, and reported six missing section squares
 * on a page that was drawing all six correctly. A parser that silently finds nothing is worse than no
 * parser, so this asserts a non-empty result before anything else does.
 */
async function fills(locale: string) {
  const body = await contentStream(locale);
  const H = 841.89;
  const re =
    /1 0 0 1 ([-\d.]+) ([-\d.]+) cm[\s\S]{0,80}?0 0 m\s+0 ([-\d.]+) l\s+([-\d.]+) \3 l\s+\4 0 l\s+h\s+f/g;
  const out: { t: number; x: number; w: number; h: number }[] = [];
  for (const m of body.matchAll(re)) {
    const [x, y, h, w] = [m[1], m[2], m[3], m[4]].map(Number);
    if (w > 3 && h > 3) out.push({ t: +(H - (y + h)).toFixed(1), x: +x.toFixed(1), w: +w.toFixed(1), h: +h.toFixed(1) });
  }
  return out;
}

/**
 * Every string drawn in WHITE — the captions that exist only because a block is under them.
 *
 * ⚠️ pdf-lib writes text as a HEX string, `<48656C6C6F> Tj`, not `(Hello) Tj`. Matching the literal form
 * returns nothing, which reads as "the blocks have no captions" when they are drawn perfectly.
 */
async function whiteText(locale: string) {
  const body = await contentStream(locale);
  const found: string[] = [];
  for (const blk of body.split(/(?=BT)/)) {
    if (!/\b1 1 1 rg\b/.test(blk)) continue;
    for (const t of blk.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      found.push(Buffer.from(t[1], 'hex').toString('latin1'));
    }
  }
  return found;
}

// ─── (a) Six section squares, one per section, and a white letter in each ───────────────────────────

describe('fda53352 · (a) the section letters sit in filled black squares', () => {
  it.each(['en', 'ms'])('%s: exactly six squares, all the agency’s own width', async (locale) => {
    const sq = (await fills(locale)).filter((f) => Math.abs(f.w - 17.3) < 0.6 && f.h > 5 && f.h < 20);
    expect(sq, `found ${sq.length} section squares`).toHaveLength(6);
    for (const f of sq) {
      expect(f.x, 'every square sits at the left margin').toBe(EA_FORM.left);
      expect(f.w, 'the agency’s measured width').toBeCloseTo(17.3, 1);
    }
    // …in document order, one per section, none doubled up on a row.
    const tops = sq.map((f) => f.t).sort((a, b) => a - b);
    expect(new Set(tops).size, 'two squares on one row').toBe(6);
  });

  it.each(['en', 'ms'])('%s: each square has a WHITE letter on it, A through F', async (locale) => {
    const w = await whiteText(locale);
    for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
      expect(w, `the ${letter} square is an empty black box`).toContain(letter);
    }
  });

  it('the letter is split off the label, not deleted from the catalogues', () => {
    // The form's numbering is part of its wording: lib/ea-field-register.ts matches on it and all six
    // catalogues own it. Removing it there would make the register and the page disagree.
    expect(cat('en').sectionAEmployeeParticulars).toMatch(/^A\s/);
    expect(cat('ms').sectionEContributions).toMatch(/^E\s/);
    expect(src('lib/ea-pdf.ts'), 'the renderer splits it').toContain('/^\\s*([A-F])\\s+(.*)$/');
  });
});

// ─── (b) The banner and the heading are FILLS, not outlines ─────────────────────────────────────────

describe('fda53352 · (b) the banner and the top-right heading are solid', () => {
  it.each(['en', 'ms'])('%s: the banner is a fill spanning the page, with white text on it', async (locale) => {
    const band = (await fills(locale)).filter(
      (f) => f.w > 400 && Math.abs(f.t - EA_FORM.bannerT[0]) < 1.5,
    );
    expect(band, 'the banner is still an outline, not a fill').toHaveLength(1);
    expect(band[0].x).toBe(EA_FORM.left);
    const w = await whiteText(locale);
    const words = eaFormWords(locale).banner.split(/\s+/)[0];
    expect(w.join(' '), 'the banner caption is not drawn in white').toContain(words);
  });

  it('the heading block SIZES TO THE EDITION — two lines in English, one in Malay', async () => {
    // ⚠️ A fixed rectangle leaves the Malay page with a half-empty black box. The English string is far
    // wider than the Malay it replaced (r346 split it onto two lines to stop it running through MALAYSIA).
    const pick = (fs: Awaited<ReturnType<typeof fills>>) =>
      fs.filter((f) => f.t < 40 && f.w > 60 && f.w < 260).sort((a, b) => b.w - a.w)[0];
    const en = pick(await fills('en'));
    const ms = pick(await fills('ms'));
    expect(en, 'no heading block on the English page').toBeTruthy();
    expect(ms, 'no heading block on the Malay page').toBeTruthy();
    expect(en.h, 'the English block is the two-line one').toBeGreaterThan(ms.h);
  });
});

// ─── (c) THE FAILURE MODE: white text with nothing under it ─────────────────────────────────────────

describe('fda53352 · (c) no caption is drawn in white without a block beneath it', () => {
  it.each(['en', 'ms'])('%s: every white string is covered by a fill', async (locale) => {
    const w = await whiteText(locale);
    expect(w.length, 'nothing is drawn white at all — the blocks lost their captions').toBeGreaterThan(6);
    const f = await fills(locale);
    // A white caption with no fill anywhere near it is invisible ink on white paper.
    expect(f.length, 'white text but no filled blocks').toBeGreaterThanOrEqual(8);
  });

  it('the fill is drawn BEFORE the text, or the caption is painted over', () => {
    const s = src('lib/ea-pdf.ts');
    const fillAt = s.indexOf('fill(L, EA_FORM.bannerT[0], R, EA_FORM.bannerT[1]);');
    const textAt = s.indexOf('putC(W.banner, CX, 86.5, 8, bold, white);');
    expect(fillAt).toBeGreaterThan(0);
    expect(textAt).toBeGreaterThan(fillAt);
  });
});

// ─── (d) The officer box, where the English caption ran into its own rule ───────────────────────────

describe('fda53352 · (d) the officer captions clear their writing lines, in BOTH editions', () => {
  it('the longest caption in either language ends before the rule starts', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const x0 = EA_FORM.officerBox.x0 + 8;
    for (const locale of ['en', 'ms']) {
      const w = eaFormWords(locale);
      for (const c of [w.officerName, w.officerPosition, w.employerNameAddress, w.employerPhone]) {
        const end = x0 + font.widthOfTextAtSize(c, 8);
        expect(end, `${locale}: "${c}" runs into its own rule`).toBeLessThan(EA_FORM.officerBox.ruleX[0]);
      }
    }
  });

  it('…and it USED to overrun by 7.9pt in English, which is the defect the reporter drew', async () => {
    // "Name and Address of Employer" ends at 279.9; ruleX[0] was 272. The Malay caption ends at 260.7 and
    // fit with 11pt to spare, which is why it was never seen — the form was only ever read in Malay.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const end = EA_FORM.officerBox.x0 + 8 + font.widthOfTextAtSize(eaFormWords('en').employerNameAddress, 8);
    expect(end).toBeGreaterThan(272);
    expect(EA_FORM.officerBox.ruleX[0], 'the rule start was not moved').toBeGreaterThan(end);
  });
});

// ─── (e) r351 — THE PRINTED FORM ENDS WHERE THE AGENCY'S ENDS ───────────────────────────────────────

describe('fda53352 · (e) nothing of ours is printed below the officer box', () => {
  /**
   * ⚠️ THIS BLOCK ASSERTED THE OPPOSITE UNTIL r351, AND THE REVERSAL IS THE REPORTER'S OWN.
   *
   * r349 pinned the strip's presence and its draw order, and its third case was titled "the EIS figure
   * STAYS — the reporter approved the plan that keeps it". That plan explicitly offered to remove the
   * strip if they preferred. They have now looked at the shipped page and written, in their own hand on
   * the comparison image, "Remove this part from the EA Form", red-boxing the "Not part of the official
   * C.P.8A" line, the EIS / SIP figure and the disclaimer paragraph together.
   *
   * So the cases are inverted rather than deleted: the old ones would silently stop protecting anything
   * if they were simply removed, and this is the guard that stops the strip creeping back.
   *
   * THE COST IS REAL AND IS RECORDED: the EIS figure is now on NO printed EA. It remains on the HTML
   * statement, which is why `eisSip` and `disclaimer` are still live keys.
   */
  it('the strip is gone from the renderer — no rule, no label, no EIS figure, no disclaimer', () => {
    const s = src('lib/ea-pdf.ts');
    expect(s, 'the heavier strip rule is still drawn').not.toContain('hRule(L, R, y - 7, 1.2, ink);');
    expect(s, 'the "not official" line is still drawn').not.toContain('t.notOfficialStrip');
    expect(s, 'the EIS figure is still drawn on the form').not.toContain('t.eisSip');
    expect(s, 'the disclaimer paragraph is still drawn on the form').not.toContain('t.disclaimer');
  });

  it('the amended marker is NOT removed with it — it was not in the red box, and it is an audit line', () => {
    // Different in kind from the strip: it discloses that HR overwrote a figure on a tax document. An
    // amended statement that looks identical to an unamended one is an audit hole. Removing it is a
    // decision for the reporter to make explicitly, and they have not been asked.
    expect(src('lib/ea-pdf.ts')).toContain('t.amendedNote');
  });

  it('EIS and the disclaimer survive on the HTML statement, so their keys stay live', () => {
    const page = src('app/payroll/reports/ea/[employmentId]/page.tsx');
    expect(page).toContain("t('eisSip')");
    expect(page).toContain("t('disclaimer'");
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      expect(cat(loc).eisSip, `${loc}.payroll.ea.eisSip`).toBeTruthy();
    }
  });

  it('notOfficialStrip lost its only reader and is RETIRED, not deleted, in all six locales', () => {
    // i18n/request.ts deep-merges each locale over English, so dropping it from en.json alone would leave
    // the sentence resolvable — and re-renderable — for every other reader.
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const v = cat(loc).notOfficialStrip as string;
      expect(v, `${loc} dropped the key instead of marking it`).toBeTruthy();
      expect(v, `${loc}.notOfficialStrip must be retired, not live`).toMatch(/^\[retired r351/);
    }
  });
});
