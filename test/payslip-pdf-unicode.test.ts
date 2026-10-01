/**
 * 5b2a7f0f — THE PAYSLIP PDF STOPS PRINTING TAMIL, THAI, CHINESE AND VIETNAMESE AS QUESTION MARKS.
 *
 * The defect, measured on main@fbe66e35 over the 68 label strings `lib/payslip-pdf-strings.ts` resolves:
 * zh 63, ta 63, th 63, vi 53 unprintable; en 0, ms 0. Cause: `renderPayslipPdf` drew with the built-in
 * Helvetica (WinAnsi) and the last step of `safe()` folded everything outside Latin-1 to '?'.
 *
 * ─────────────────────────── why these assertions are on the RENDERED TEXT ───────────────────────────
 *
 * A 200 is not a render check and neither is a byte count: a PDF that draws '?' 63 times is a perfectly
 * valid PDF of exactly the size you would expect. So `extractedText` below reads the show-text operands
 * back out of the page content streams AND resolves them through each font's `/ToUnicode` CMap, which is
 * the only way to recover the characters from an embedded subset (its operands are GLYPH IDS, not
 * characters — `drawnText` in test/payslip-pdf.test.ts reads them as latin1 and would return mojibake).
 * Every claim below is a claim about the words that came off the page.
 *
 * The mutation evidence for these tests is in the round entry: with the `embedPayslipFaces` call replaced
 * by `[]`, `zh prints 实发工资` and `ta prints நிகர ஊதியம்` both fail with the question marks this fixes.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { renderPayslipPdf, type PayslipPdfData, type PayslipPdfLabels } from '../lib/payslip-pdf';
import { PAYSLIP_FONT_DIR, payslipFaceScripts } from '../lib/payslip-pdf-fonts';
import { data, labels } from './fixtures/payslip-pdf-fixture';

// ───────────────────────────────── the instrument ─────────────────────────────────

/** A `/ToUnicode` CMap's code → string map. `bfchar` is one entry, `bfrange` is a contiguous span. */
function bfMapOf(cmap: string): Map<number, string> {
  const utf16be = (hex: string) => {
    const b = Buffer.from(hex, 'hex');
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
    return s;
  };
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), utf16be(m[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const dst = parseInt(m[3], 16);
      for (let c = lo; c <= hi; c += 1) map.set(c, String.fromCodePoint(dst + (c - lo)));
    }
  }
  return map;
}

type FontInfo = { composite: boolean; toUnicode: Map<number, string> | null; baseFont: string };

/** Every font resource this page can draw with, keyed by the `/Fx` name the content stream selects. */
function fontsOfPage(page: ReturnType<PDFDocument['getPages']>[number]): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>();
  const dict = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
  if (!dict) return out;
  for (const [key, ref] of dict.entries()) {
    const fd = page.node.context.lookup(ref, PDFDict);
    const tu = fd.get(PDFName.of('ToUnicode'));
    const stream = tu ? page.node.context.lookup(tu) : null;
    out.set(key.asString(), {
      composite: fd.get(PDFName.of('Subtype'))?.toString() === '/Type0',
      baseFont: fd.get(PDFName.of('BaseFont'))?.toString() ?? '',
      toUnicode:
        stream instanceof PDFRawStream
          ? bfMapOf(Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
          : null,
    });
  }
  return out;
}

function contentOf(page: ReturnType<PDFDocument['getPages']>[number]): string {
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((r) => page.node.context.lookup(r))
      : [contents];
  let src = '';
  for (const st of streams) {
    if (st instanceof PDFRawStream) src += Buffer.from(decodePDFRawStream(st).decode()).toString('latin1');
  }
  return src;
}

/** One show-text operand: what was drawn, and AT WHAT SIZE — the size is how `fitSize` is checked. */
type DrawnRun = { text: string; size: number };

/** Every run the document draws, decoded through whichever font drew it. */
async function drawnRuns(bytes: Uint8Array): Promise<DrawnRun[]> {
  const doc = await PDFDocument.load(bytes);
  const out: DrawnRun[] = [];
  for (const page of doc.getPages()) {
    const fonts = fontsOfPage(page);
    let cur: FontInfo | null = null;
    let size = 0;
    for (const m of contentOf(page).matchAll(
      /(\/[A-Za-z0-9#+._-]+)\s+([\d.]+)\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\()])*)\)\s*Tj/g,
    )) {
      if (m[1] != null) {
        cur = fonts.get(m[1]) ?? null;
        size = Number(m[2]);
      } else if (m[3] != null) {
        const hex = m[3].replace(/\s+/g, '');
        if (cur?.composite) {
          let s = '';
          for (let i = 0; i + 4 <= hex.length; i += 4) {
            s += cur.toUnicode?.get(parseInt(hex.slice(i, i + 4), 16)) ?? '\uFFFD';
          }
          out.push({ text: s, size });
        } else {
          out.push({ text: Buffer.from(hex, 'hex').toString('latin1'), size });
        }
      } else if (m[4] != null) {
        out.push({ text: m[4].replace(/\\([()\\])/g, '$1'), size });
      }
    }
  }
  return out;
}

/** The text the document actually DRAWS, decoded through whichever font drew each run. */
async function extractedText(bytes: Uint8Array): Promise<string> {
  return (await drawnRuns(bytes)).map((r) => r.text).join('\n');
}

/**
 * Every `/BaseFont` this document uses, and whether any of them carries an actual font FILE.
 *
 * Read through pdf-lib's object graph, NOT by grepping the file: `save()` packs the font dictionaries and
 * their descriptors into compressed object streams, so `/FontFile2` is not in the raw bytes of a document
 * that embeds one. A regex over the bytes reports "no font embedded" for every document alike — which is
 * exactly the shape of vacuous pass this guard exists to avoid.
 */
async function fontFacts(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  const baseFonts = new Set<string>();
  let embedsFontFile = false;
  let hasCompositeFont = false;
  const descriptorCarriesFile = (fd: PDFDict | undefined) =>
    fd != null &&
    (['FontFile', 'FontFile2', 'FontFile3'] as const).some((k) => fd.get(PDFName.of(k)) != null);
  for (const page of doc.getPages()) {
    const dict = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    if (!dict) continue;
    for (const [, ref] of dict.entries()) {
      const fd = ctx.lookup(ref, PDFDict);
      baseFonts.add(fd.get(PDFName.of('BaseFont'))?.toString() ?? '');
      if (fd.get(PDFName.of('Subtype'))?.toString() === '/Type0') hasCompositeFont = true;
      if (descriptorCarriesFile(fd.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict))) embedsFontFile = true;
      const descendants = fd.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
      for (const d of descendants?.asArray() ?? []) {
        const df = ctx.lookup(d, PDFDict);
        if (descriptorCarriesFile(df.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict))) embedsFontFile = true;
      }
    }
  }
  return { baseFonts: [...baseFonts].sort(), embedsFontFile, hasCompositeFont };
}

/**
 * THE DOCUMENT, WITH THE CLOCK TAKEN OUT OF IT.
 *
 * `PDFDocument.create()` stamps `/CreationDate` and `/ModificationDate`, and `save()` packs the Info dict
 * into a COMPRESSED object stream — so two renders of one payslip a second apart differ in their deflated
 * bytes and by a byte or two in length. Raw-byte equality is therefore not a property this renderer has,
 * and never was. Loading the file back, pinning both dates to the epoch and re-saving is deterministic
 * (verified: same digest across repeated renders), and it compares EVERYTHING else — every page, every
 * content stream, every font resource.
 */
async function documentDigest(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  return createHash('sha256').update(Buffer.from(await doc.save())).digest('hex');
}

// ───────────────────────────────── localized fixtures ─────────────────────────────────

const catalog = (locale: string) =>
  JSON.parse(fs.readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

/** value → dotted path, over the ENGLISH catalogue. First path wins; an equal-valued alternative is a
 *  perfectly good source for the same words, which is all this needs. */
function pathsByEnglishValue(): Map<string, string> {
  const out = new Map<string, string>();
  const en = catalog('en');
  const walk = (node: unknown, prefix: string) => {
    if (typeof node === 'string') {
      if (!out.has(node)) out.set(node, prefix);
      return;
    }
    if (node == null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
  };
  // THE THREE NAMESPACES `lib/payslip-pdf-strings.ts` ACTUALLY RESOLVES, FIRST — so an English word that
  // also appears somewhere else in the catalogue (`Payslip` is a nav item too) resolves to the key the
  // real routes use, and the strings under test are the ones an employee would really be sent.
  const at = (path: string) => path.split('.').reduce<unknown>((a, k) => (a == null ? a : (a as Record<string, unknown>)[k]), en);
  for (const ns of ['me.payslip', 'payroll.individualPayslip', 'payroll.transactions']) walk(at(ns), ns);
  walk(en, '');
  return out;
}
const EN_PATHS = pathsByEnglishValue();

/**
 * The same label object, in another language — every English string looked up in the en catalogue and
 * re-read from the target one.
 *
 * Derived rather than hand-written, so it cannot drift from what the catalogue actually says and so the
 * strings under test are the REAL translations an employee would receive, not a test author's guess. The
 * handful that are English by construction (`periodLabel` "June 2026", `paymentDate`) are not in the
 * catalogue and stay as they are — which is exactly what the two PDF routes do.
 */
function localizeLabels(locale: string): PayslipPdfLabels {
  const cat = catalog(locale);
  const at = (path: string): string | null => {
    const v = path.split('.').reduce<unknown>((a, k) => (a == null ? a : (a as Record<string, unknown>)[k]), cat);
    return typeof v === 'string' && v !== '' ? v : null;
  };
  const conv = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const path = EN_PATHS.get(v);
      return (path && at(path)) ?? v;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]));
    }
    return v;
  };
  return conv(labels) as PayslipPdfLabels;
}

/** How many of a label set's strings carry a codepoint Helvetica cannot draw — the defect's own measure. */
const unprintableCount = (l: PayslipPdfLabels) =>
  Object.values(l).filter((v) => typeof v === 'string' && /[^\x20-\x7E\xA0-\xFF]/.test(v)).length;

const MONEY = /\d[\d,]*\.\d\d/g;
const moneyOf = (text: string) => [...text.matchAll(MONEY)].map((m) => m[0]).sort();

// ───────────────────────────────── the tests ─────────────────────────────────

describe('5b2a7f0f — the payslip PDF prints every locale it offers', () => {
  it('the fixtures under test really are non-Latin — otherwise every assertion below is vacuous', () => {
    expect(unprintableCount(localizeLabels('en'))).toBe(0);
    expect(unprintableCount(localizeLabels('ms'))).toBe(0);
    expect(unprintableCount(localizeLabels('zh'))).toBeGreaterThan(40);
    expect(unprintableCount(localizeLabels('ta'))).toBeGreaterThan(40);
    expect(unprintableCount(localizeLabels('th'))).toBeGreaterThan(40);
    expect(unprintableCount(localizeLabels('vi'))).toBeGreaterThan(30);
  });

  /**
   * NET PAY is drawn `t.netPay.toUpperCase()` — which is a no-op in three of these four scripts and is
   * NOT one in Vietnamese, so the expectation is written the way the document writes it. The catalogue
   * value is asserted beside the render so neither half can drift: if `localizeLabels` ever resolved the
   * wrong key, the first expectation fails and says which string it got.
   */
  it('a zh payslip prints 实发工资, and no label anywhere on it is a question mark', async () => {
    const zh = localizeLabels('zh');
    expect(zh.netPay).toBe('实发工资'); // me.payslip.netPay
    expect(zh.basicSalary).toBe('基本工资');
    const text = await extractedText(await renderPayslipPdf(data, zh));
    expect(text).toContain(zh.netPay.toUpperCase());
    expect(text).toContain(zh.basicSalary);
    expect(text).toContain(zh.generatedNote);
    expect(text).toContain(zh.title);
    expect(text).not.toContain('?');
  });

  /**
   * TAMIL IS SHAPED, AND `extractedText` READS GLYPH ORDER. The pre-base vowel signs ெ and ை are stored
   * after their consonant and DRAWN before it, so "அடிப்படை" comes back out of the content stream with
   * its glyphs in visual order and will not match the logical string. That is the instrument telling the
   * truth about what is on the page, not a fault — and it is why the expectations below are strings with
   * no pre-base vowel in them. (It is also positive evidence that the Indic shaper ran at all: without
   * the `regeneratorRuntime` shim in lib/payslip-pdf-fonts.ts, `drawText` throws before any of this.)
   */
  it('a ta payslip prints நிகர ஊதியம், and no label anywhere on it is a question mark', async () => {
    const ta = localizeLabels('ta');
    expect(ta.netPay).toBe('நிகர ஊதியம்'); // me.payslip.netPay
    expect(ta.basicSalary).toBe('அடிப்படை சம்பளம்');
    const text = await extractedText(await renderPayslipPdf(data, ta));
    expect(text).toContain(ta.netPay.toUpperCase());
    expect(text).toContain('சம்பளம்'); // the second word of ta.basicSalary, drawn as a row label
    expect(text).toContain(ta.generatedNote);
    expect(text).not.toContain('?');
  });

  it('th and vi print too — Thai has its own face, Vietnamese rides the Latin one', async () => {
    const th = localizeLabels('th');
    expect(th.netPay).toBe('รายได้สุทธิ');
    const thText = await extractedText(await renderPayslipPdf(data, th));
    expect(thText).toContain(th.netPay.toUpperCase());
    expect(thText).toContain(th.basicSalary);
    expect(thText).not.toContain('?');

    const vi = localizeLabels('vi');
    expect(vi.netPay).toBe('Lương thực lãnh');
    const viText = await extractedText(await renderPayslipPdf(data, vi));
    // Vietnamese IS cased, so the document really does carry the uppercased form — diacritics and all.
    expect(viText).toContain('LƯƠNG THỰC LÃNH');
    expect(viText).toContain(vi.basicSalary);
    expect(viText).not.toContain('?');
  });

  it('a Latin name inside a Chinese document draws in ONE run with both scripts intact', async () => {
    // The normal case, not the edge case: a Malaysian payroll in Chinese for an employee whose name is
    // romanized, and a Chinese company name beside it.
    const mixed: PayslipPdfData = { ...data, employee: 'Aisyah Rahman', company: '德玛 Demo Sdn Bhd' };
    const text = await extractedText(await renderPayslipPdf(mixed, localizeLabels('zh')));
    expect(text).toContain('Aisyah Rahman');
    expect(text).toContain('德玛 Demo Sdn Bhd');
    expect(text).toContain('实发工资');
    expect(text).not.toContain('?');
    // ONE RUN, ONE FONT: the mixed company name is a single show-text operand, not two.
    expect(text.split('\n')).toContain('德玛 Demo Sdn Bhd');
  });

  it('a Chinese name on an ENGLISH payslip prints — the face follows the text, not the locale', async () => {
    const text = await extractedText(await renderPayslipPdf({ ...data, employee: '李小龙' }, labels));
    expect(text).toContain('李小龙');
    expect(text).toContain('NET PAY'); // and the English labels are untouched beside it
    expect(text).not.toContain('?');
  });

  it('NOT ONE FIGURE MOVES: every amount on the en payslip is on the zh one', async () => {
    const en = moneyOf(await extractedText(await renderPayslipPdf(data, labels)));
    const zh = moneyOf(await extractedText(await renderPayslipPdf(data, localizeLabels('zh'))));
    expect(en.length).toBeGreaterThan(10);
    expect(zh).toEqual(en);
  });
});

describe('5b2a7f0f — the en document is untouched, and that is the regression guard', () => {
  it('an en payslip embeds NO font file: the faces are lazy, per document, per locale', async () => {
    const facts = await fontFacts(await renderPayslipPdf(data, labels));
    expect(facts.baseFonts).toEqual(['/Helvetica', '/Helvetica-Bold']);
    expect(facts.embedsFontFile).toBe(false);
    expect(facts.hasCompositeFont).toBe(false);
  });

  it('…and a zh one does — so the guard above is not passing for want of a font', async () => {
    const facts = await fontFacts(await renderPayslipPdf(data, localizeLabels('zh')));
    expect(facts.embedsFontFile).toBe(true);
    expect(facts.hasCompositeFont).toBe(true);
    expect(facts.baseFonts.some((b) => b.includes('NotoSansSC'))).toBe(true);
  });

  /**
   * THE REGRESSION GUARD. These three digests were taken from main@fbe66e35 — the commit BEFORE any of
   * 5b2a7f0f's changes — by rendering the same three fixtures through the pre-change `renderPayslipPdf`
   * and hashing them the same way. They are the claim "an English payslip is the document it always was",
   * made on the whole file rather than on its size.
   *
   * IF ONE OF THESE HAS TO MOVE, THE ENGLISH PAYSLIP HAS CHANGED AND SOMEONE MUST SAY SO ON PURPOSE.
   * That is what makes it a guard. It is also what fails the moment a face is embedded unconditionally:
   * the smallest subset on this document is 13 KB and it changes every offset in the file.
   *
   * ─── r360 (feedback 1fe55a23) SAYS SO ON PURPOSE, AND THE NUMBERS BELOW DID NOT HAVE TO MOVE ───
   *
   * r360 puts the company registration number back on the letterhead WITH the caption "Reg. no.", which
   * changes the document for a company that HAS one — the fixture is such a company. So these three
   * digests now name the fixture rendered with `companyReg: null`, and that is not a dodge: the plan's
   * promise to the reporter is that a company with NO registration number prints NO line and reserves no
   * space for one, and this is that promise stated to the byte. All three values are UNCHANGED from
   * main@fbe66e35 — the unregistered payslip is not merely the same height, it is the same file.
   *
   * The registered document's own digests are pinned beside them, so "the letterhead grew by one line" is
   * a claim about the whole file as well as about the rule's y (test/payslip-pdf.test.ts measures that).
   *
   * ─── r367 (feedback e0b6e3b8) SAYS SO ON PURPOSE TOO, AND THIS TIME ALL SIX MOVED ───
   *
   * r367 gives the employee band ONE `EMPLOYMENT INFO` heading over both halves and puts the employee's
   * name and code on one line. That changes the panel on EVERY payslip, registered or not, so unlike r360
   * there is no fixture left that hashes to its pre-change value — which is exactly what this guard is for
   * and why the old digests are kept below rather than deleted. They are now asserted NOT to match, so the
   * round's claim ("the English payslip changed, here is the whole file") is made in both directions.
   *
   * WHAT THE READER SHOULD CHECK IF ONE OF THESE FAILS AGAIN: the band is 90pt where it was 92 and every
   * block below it moved UP two points (test/payslip-pdf.test.ts measures that against the produced
   * document at one, three and four identity cells). The page COUNTS did not change — 1, 1 and 2 before
   * and after — and they are asserted below, because a moved page break is the one change a digest cannot
   * describe and the one that would matter most.
   */
  /** The pre-5b2a7f0f values, superseded by r367. Kept as the record of what the document used to be. */
  const MAIN_FBE66E35 = {
    plain: 'ef4286f210d2fe7359babd927e353cc261e7a793419d547ec3a96da9443f3d75',
    logo: '2313b1d75eca5d2b059b131094bac4201d83c5dac617ab8774e36bd20aba4747',
    multipage: 'a8d82f9485a909e3fc25cde3b969e5e0484a0260cdf7d8f79d83d4e371943651',
  };
  /** r360's values, also superseded by r367. Kept for the same reason. */
  const WITH_REG_R360 = {
    plain: 'b320d0ae3f1df2394e3c87480e16fa5be688e163b252b7a84c48237005c65b65',
    logo: 'e20b0afe847cd55942e1e8842cc415b752c653c267e382edd006e6748170ec0f',
    multipage: 'a6c07537806118b3321e69729f5069ba72ef10c4e0f357416935e9fd729393ae',
  };
  /** r378 approved layout — employment card, payment values and no employer cost total. */
  const NO_REG_R367 = {
    plain: 'a959efe73dedef970e7aa3df718a6ac8d9c760d5142c25b39aba5d6de0a659e4',
    logo: '24c15eaeda182ecd42d987c525881d4bc4c3617377a2068540e35da97173e755',
    multipage: 'c89ae89416bbe532d7288adbc7db843ef2fae6439e909aacd9c1cf0f30b11360',
  };
  /** r378 — the same fixtures with a company registration number. */
  const WITH_REG_R367 = {
    plain: '6396dab1551c9a026d4c562be33693265eaebc26ba400bff21d1a979349a39a0',
    logo: '86c44fba0a84c151c4d027d9d715d00edfec3ecb0ad0260ae72c8877dd7a5543',
    multipage: '476fe519812ce79add0455387e27a8ac131e0a62f23514507e4dbdd72cebeb07',
  };
  /** The sheet count is part of the pin: a digest cannot say where a page BROKE. */
  const pageCountOf = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const manyLines = Array.from({ length: 40 }, (_, i) => ({
    code: `PC${i}`,
    name: `Allowance line number ${i} with a deliberately long description`,
    amount: 10,
  }));

  it('an en payslip for a company with NO registration number is pinned to the byte — plain, with a logo, and over two sheets', async () => {
    // r360 — `companyReg: null` is the reporter's own fallback case: no line, no reserved band. A change
    // that "only" reserved space for the missing line, or that printed a dash in its place, fails all three.
    // r367 — these are r367 values, not main@fbe66e35's: the employee band changed on every payslip.
    const noReg = { ...data, companyReg: null };
    const plain = await renderPayslipPdf(noReg, labels);
    const withLogo = await renderPayslipPdf(
      { ...noReg, logo: { bytes: new Uint8Array(PNG_1x1), mimeType: 'image/png' } },
      labels,
    );
    const long = await renderPayslipPdf(
      { ...noReg, allowance: 400, earningLines: manyLines, detailNotRecorded: false },
      labels,
    );
    expect(await documentDigest(plain)).toBe(NO_REG_R367.plain);
    expect(await documentDigest(withLogo)).toBe(NO_REG_R367.logo);
    expect(await documentDigest(long)).toBe(NO_REG_R367.multipage);
    // THE SHEET COUNT, SEPARATELY. r367 took 2pt off the employee band and every block below it moved up;
    // a digest cannot tell "two points higher" from "the page broke somewhere else", and the second would
    // be a real change to an official document.
    expect([await pageCountOf(plain), await pageCountOf(withLogo), await pageCountOf(long)]).toEqual([1, 1, 2]);
    // r367 CHANGED THE DOCUMENT ON PURPOSE, stated in both directions so the round cannot be read as an
    // accident: none of the three still hashes to what it hashed to before.
    expect(await documentDigest(plain), 'r367 changed the unregistered payslip too').not.toBe(
      MAIN_FBE66E35.plain,
    );
  });

  it('r360 — and a company WITH one gets a different, equally pinned document', async () => {
    // NON-VACUITY FOR THE CASE ABOVE: the fixture really carries a registration number, so `companyReg:
    // null` there is a suppression and not a field that was never set.
    expect(data.companyReg).toBeTruthy();
    const plain = await renderPayslipPdf(data, labels);
    const withLogo = await renderPayslipPdf(
      { ...data, logo: { bytes: new Uint8Array(PNG_1x1), mimeType: 'image/png' } },
      labels,
    );
    const long = await renderPayslipPdf(
      { ...data, allowance: 400, earningLines: manyLines, detailNotRecorded: false },
      labels,
    );
    expect(await documentDigest(plain)).toBe(WITH_REG_R367.plain);
    expect(await documentDigest(withLogo)).toBe(WITH_REG_R367.logo);
    expect(await documentDigest(long)).toBe(WITH_REG_R367.multipage);
    expect(WITH_REG_R367.plain, 'the registered and unregistered documents are not the same file').not.toBe(
      NO_REG_R367.plain,
    );
    expect([await pageCountOf(plain), await pageCountOf(withLogo), await pageCountOf(long)]).toEqual([1, 1, 2]);
    // r367, stated in both directions here too.
    expect(await documentDigest(plain), 'r367 changed the registered payslip').not.toBe(WITH_REG_R360.plain);
  });

  it('…and the guard above is a guard: the same fixture in Chinese does NOT hash to it', async () => {
    expect(await documentDigest(await renderPayslipPdf(data, localizeLabels('zh')))).not.toBe(
      WITH_REG_R367.plain,
    );
  });

  it('an ms payslip is the same size as the en one — nothing about ms was Latin-1-bound', async () => {
    const ms = await renderPayslipPdf(data, localizeLabels('ms'));
    expect((await fontFacts(ms)).embedsFontFile).toBe(false);
  });

  it('a subsetted document costs tens of kilobytes, not megabytes', async () => {
    const en = (await renderPayslipPdf(data, labels)).length;
    const zh = (await renderPayslipPdf(data, localizeLabels('zh'))).length;
    const ta = (await renderPayslipPdf(data, localizeLabels('ta'))).length;
    // The CJK source face is 8.3 MB and the Tamil one 116 KB; subsetting is what keeps the DOCUMENT small.
    expect(zh - en).toBeLessThan(120_000);
    expect(ta - en).toBeLessThan(60_000);
    expect(zh).toBeGreaterThan(en); // a face really was embedded
  });
});

describe('5b2a7f0f — a real translation is longer than a question mark, and the layout holds', () => {
  /**
   * THE SECOND DEFECT THIS ROUND FOUND, AND IT WAS ONLY VISIBLE ONCE THE FONTS WORKED.
   *
   * A box's total row puts a caption and an amount on ONE baseline and neither wraps. While every
   * non-Latin label folded to '?', the longest caption on the document was English and everything fitted.
   * Rendered for real, Vietnamese's "TỔNG CHI PHÍ NGƯỜI SỬ DỤNG LAO ĐỘNG" printed straight through
   * "MYR 8,141.55". `fitSize` in lib/payslip-pdf.ts shrinks such a caption until it clears the amount.
   *
   * Caught by RASTERISING the page, not by reading its text layer — the extracted text of the overlapping
   * document was perfectly correct. These assertions are the part of that check a suite can carry.
   */
  const EMPLOYER_COST_EN = labels.totalEmployerCost.toUpperCase();

  it('omits the obsolete employer cost caption in English and Vietnamese while retaining net pay', async () => {
    for (const locale of ['en', 'vi']) {
      const localized = localizeLabels(locale);
      const runs = await drawnRuns(await renderPayslipPdf(data, localized));
      expect(runs.some(r => r.text === localized.totalEmployerCost.toUpperCase())).toBe(false);
      expect(runs.some(r => r.text === localized.netPay.toUpperCase())).toBe(true);
    }
  });

  it('no locale drives any run down to the 5.5pt floor — below that the fit would stop fitting', async () => {
    for (const locale of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const runs = await drawnRuns(await renderPayslipPdf(data, localizeLabels(locale)));
      const smallest = Math.min(...runs.map((r) => r.size));
      expect(smallest, `${locale} drew a run at ${smallest}pt`).toBeGreaterThan(5.5);
    }
  });
});

describe('5b2a7f0f — safe() still folds, and nothing degrades by throwing', () => {
  it('smart quotes, dashes, ellipses and the account-mask bullet still fold to Latin-1', async () => {
    const punctuated: PayslipPdfData = {
      ...data,
      employee: '\u201CAisyah\u201D \u2013 Rahman\u2026',
      bankAccount: '\u2022\u2022\u2022\u20228901',
    };
    const text = await extractedText(await renderPayslipPdf(punctuated, labels));
    expect(text).toContain('"Aisyah" - Rahman...');
    expect(text).toContain('\u00B7\u00B7\u00B7\u00B78901');
    // and the fold alone must not have dragged a font file in
    expect((await fontFacts(await renderPayslipPdf(punctuated, labels))).embedsFontFile).toBe(false);
  });

  it('a script no face covers degrades to ? and still renders a whole document', async () => {
    // Arabic: routed to the Latin face (Noto Sans), which does not carry it. The document must come out.
    const arabic: PayslipPdfData = { ...data, employee: '\u0645\u062D\u0645\u062F' };
    const bytes = await renderPayslipPdf(arabic, labels);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await extractedText(bytes);
    expect(text).toContain('???');
    expect(text).toContain('NET PAY'); // the rest of the payslip is intact
  });

  /**
   * THE SUBSETTER IS PART OF THE FIX, AND IT IS THE PART A FUTURE ROUND WOULD "TIDY" BACK.
   *
   * pdf-lib's own README tells you to register `@pdf-lib/fontkit`, and that fork writes CORRUPT subsets
   * for the faces on this document: the CJK one rendered as unrelated ASCII letters, the TrueType one lost
   * most of its glyphs, and Tamil threw `regeneratorRuntime is not defined` before drawing anything. None
   * of that is visible in the PDF's text layer — `/ToUnicode` extraction came back perfect from the broken
   * file — so no assertion in this suite can catch a swap back. This one can, and the reason travels with
   * it. lib/payslip-pdf-fonts.ts carries the full measurement.
   */
  it('the subsetter is upstream fontkit, NOT @pdf-lib/fontkit — a swap back writes corrupt glyphs', () => {
    const src = fs.readFileSync(new URL('../lib/payslip-pdf-fonts.ts', import.meta.url), 'utf8');
    expect(src).toContain("await import('fontkit')");
    expect(src).not.toContain("import('@pdf-lib/fontkit')");
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.fontkit).toBeTruthy();
    expect(pkg.dependencies['@pdf-lib/fontkit']).toBeUndefined();
  });

  it('the face files this repo ships are the ones the script map asks for', () => {
    expect(payslipFaceScripts(['\u5B9E\u53D1'])).toEqual(['cjk']);
    expect(payslipFaceScripts(['\u0BA8\u0BBF'])).toEqual(['tamil']);
    expect(payslipFaceScripts(['\u0E40\u0E07'])).toEqual(['thai']);
    expect(payslipFaceScripts(['L\u01B0\u01A1ng'])).toEqual(['latin']);
    expect(payslipFaceScripts(['Net pay 1,234.00'])).toEqual([]);
    for (const f of [
      'NotoSans-Regular.ttf.br',
      'NotoSans-Bold.ttf.br',
      'NotoSansTamil-Regular.ttf.br',
      'NotoSansTamil-Bold.ttf.br',
      'NotoSansThai-Regular.ttf.br',
      'NotoSansThai-Bold.ttf.br',
      'NotoSansSC-Regular.otf.br',
      'OFL.txt',
    ]) {
      expect(fs.existsSync(new URL(`../${PAYSLIP_FONT_DIR}/${f}`, import.meta.url)), f).toBe(true);
    }
  });
});


describe('r378 company information in actual localized documents', () => {
  it('renders selected organization fields in all six locales and omits zero basic salary and disabled identity fields', async () => {
    for (const locale of ['en','ms','zh','ta','th','vi']) {
      const messages = JSON.parse(fs.readFileSync(`messages/${locale}.json`, 'utf8'));
      const info = messages.payroll.payslipInformation;
      const localized = localizeLabels(locale);
      const bytes = await renderPayslipPdf({...data,basic:0,informationRows:[
        {label:info.branch,value:'Synthetic North Branch'},
        {label:info.daysWorked,value:'0'},
      ]},localized);
      fs.writeFileSync(`scratchpad/r378-payroll/payslip-${locale}.pdf`,bytes);
      const text = await extractedText(bytes);
      expect(text).toContain('Synthetic North Branch');
      expect(text).not.toContain(data.employee);
      expect(text).not.toContain(localized.basicSalary);
    }
  });
});
