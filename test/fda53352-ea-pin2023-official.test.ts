/**
 * Item fda53352 (r346) — THE EA IS DRAWN TO LHDN's OWN Pin. 2023, IN THE AGENCY'S OWN WORDS.
 *
 * ═══ THE FINDING THAT LED THIS ROUND, AND IT INVERTED THE TICKET ═══
 *
 * The reporter asked us to rebuild the EA because ours was "not up to date". Ours printed
 * "(C.P.8A - Pin. 2024)". **LHDN does not issue a Pin. 2024.** Verified 2026-09-26 against the agency's
 * own site: `borang_ea__c.p.8a_-_pin._2023_.pdf` returns 206 `application/pdf`, while 2024, 2025 and
 * 2026 at the same path return 404 — and the agency's "EA & EC Guide Notes — Remuneration for the Year
 * 2024" accompany the **Pin. 2023** form. THE REVISION LABEL IS NOT THE YEAR.
 *
 * Our Pin. 2024 claim came from item ece6d75d's attachment, whose PDF Producer is "Developer Express
 * Inc. DXperience v23.2.5" — another payroll vendor's rendering. `docs/forms/…-transcription.txt` had
 * already flagged that file as "a TRACING SOURCE, not LHDN artwork"; the caution was right and the
 * revision number taken from the same file was not.
 *
 * The reporter's attachment is BYTE-IDENTICAL to what hasil.gov.my serves (sha256 6b766381…, 381,770
 * bytes) — the first genuine agency artwork this board has received, and it is now in `docs/forms/`.
 *
 * ═══ WHAT THIS FILE PINS ═══
 *
 * Not the arithmetic: no figure moves in r346. It pins the WORDS and the REVISION, because those are
 * what a reader checks our page against the agency's page with, and both were wrong in ways no test
 * could see — every one of them passed tsc, the suite and `next build` while being visibly incorrect.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eaFormWords, EA_FORM, EA_FORM_WORDS } from '../lib/ea-pdf';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = (p: string) => readFileSync(new URL(p, `file://${root}`), 'utf8');
const bytesOf = (p: string) => readFileSync(new URL(p, `file://${root}`));
const en = () => JSON.parse(src('messages/en.json')) as Record<string, any>;
const ms = () => JSON.parse(src('messages/ms.json')) as Record<string, any>;

const OFFICIAL_EN = 'docs/forms/ea-cp8a-pin-2023-official-en.pdf';
const OFFICIAL_BM = 'docs/forms/ea-cp8a-pin-2023-official-bm.xlsx';

// ─── (a) The revision, everywhere ────────────────────────────────────────────────────────────────────

describe('fda53352 · (a) the form says Pin. 2023, because that is the revision LHDN issues', () => {
  it('the printed form number is Pin. 2023', () => {
    expect(EA_FORM_WORDS.formNo).toBe('(C.P.8A - Pin. 2023)');
    expect(eaFormWords('en').formNo).toBe('(C.P.8A - Pin. 2023)');
    expect(eaFormWords('ms').formNo).toBe('(C.P.8A - Pin. 2023)');
  });

  it('no catalogue in any of the six locales still names Pin. 2024', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      expect(src(`messages/${loc}.json`), `${loc}.json still names a revision LHDN does not issue`).not.toContain(
        'Pin. 2024',
      );
    }
  });

  it('nor does any code that describes the form', () => {
    for (const f of [
      'lib/ea-pdf.ts',
      'lib/ea-field-register.ts',
      'app/payroll/reports/ea/[employmentId]/page.tsx',
      'docs/forms/ea-cp8a-field-register.md',
    ]) {
      expect(src(f), `${f}`).not.toContain('Pin. 2024');
    }
  });
});

// ─── (b) The agency's artwork is on disk, and it is the real file ───────────────────────────────────

describe('fda53352 · (b) the reference is LHDN’s own file, not a rival vendor’s rendering', () => {
  it('the English C.P.8A is present and byte-for-byte what hasil.gov.my serves', () => {
    expect(existsSync(new URL(OFFICIAL_EN, `file://${root}`)), OFFICIAL_EN).toBe(true);
    const b = bytesOf(OFFICIAL_EN);
    expect(b.length, 'the agency file’s exact size').toBe(381_770);
    expect(createHash('sha256').update(b).digest('hex').slice(0, 16)).toBe('6b76638173b9d06a');
  });

  it('it is a VECTOR pdf, not a scan — which is why its own coordinates could be read', () => {
    const head = bytesOf(OFFICIAL_EN).subarray(0, 4).toString('latin1');
    expect(head).toBe('%PDF');
    const all = bytesOf(OFFICIAL_EN).toString('latin1');
    expect(all, 'no rasterised page').not.toContain('/Subtype /Image');
    expect(all, 'and it declares itself Pin. 2023').toContain('Pin. 2023');
  });

  it('the Bahasa Malaysia sheet is present', () => {
    expect(existsSync(new URL(OFFICIAL_BM, `file://${root}`)), OFFICIAL_BM).toBe(true);
    expect(statSync(new URL(OFFICIAL_BM, `file://${root}`)).size).toBeGreaterThan(1_000);
  });

  it('the transcription records the correction rather than quietly adopting it', () => {
    const t = src('docs/forms/ea-cp8a-pin-2023-transcription.txt');
    expect(t, 'it says plainly that the old revision was wrong').toContain('There is no such revision');
    expect(t, 'and names the real source').toContain('ea-cp8a-pin-2023-official-en.pdf');
    expect(t, 'and keeps the byte-identical claim checkable').toContain('381,770');
  });
});

// ─── (c) The form's furniture follows the DOCUMENT's language, as LHDN's two editions do ────────────

describe('fda53352 · (c) an English EA is English all the way to the masthead', () => {
  it('the English edition uses the agency’s English furniture', () => {
    const w = eaFormWords('en');
    expect(w.serialNo).toBe('Serial No.');
    expect(w.employerTin).toBe("Employer's No. E");
    expect(w.lhdnState).toBe('LHDNM State');
    expect(w.masthead2).toBe('INCOME TAX');
    expect(w.banner).toBe(
      'THIS FORM EA MUST BE PREPARED AND PROVIDED TO THE EMPLOYEE FOR INCOME TAX PURPOSE',
    );
    expect(w.officerName).toBe('Name of Officer');
  });

  it('the Malay edition is unchanged, and keeps the agency’s own Malay', () => {
    const w = eaFormWords('ms');
    expect(w.serialNo).toBe('No. Siri');
    expect(w.masthead2).toBe('CUKAI PENDAPATAN');
    expect(w.banner).toContain('BORANG EA INI PERLU DISEDIAKAN');
  });

  it('“No. Majikan E” is a FILE number, not a TIN — the tracing called it TIN Majikan E', () => {
    expect(eaFormWords('ms').employerTin).toBe('No. Majikan E');
    expect(eaFormWords('ms').employerTin).not.toContain('TIN');
    // The employee's TIN is a different box, further right on the same band.
    expect(eaFormWords('ms').employeeTin).toContain('TIN');
  });

  it('“Nama Pegawai” — the inherited typo is gone', () => {
    // It read "Name Pegawai", copied from the DevExpress tracing, with a comment defending it as "the
    // specimen's own spelling". The agency's own BM file says "Nama Pegawai".
    expect(eaFormWords('ms').officerName).toBe('Nama Pegawai');
    expect(src('lib/ea-pdf.ts')).not.toContain("officerName: 'Name Pegawai'");
  });

  it('the renderer picks the edition off the document locale, and defaults to English', () => {
    const s = src('lib/ea-pdf.ts');
    expect(s).toContain("eaFormWords(opts.locale ?? 'en')");
    // All three routes must pass one, or a document gets one language's captions and another's furniture.
    for (const f of [
      'app/me/ea/[employmentId]/pdf/route.ts',
      'app/payroll/ea/blank/route.ts',
      'app/payroll/statutory-forms/ea/shared.ts',
    ]) {
      expect(src(f), `${f} passes the document locale`).toMatch(/\{[^}]*\blocale\b[^}]*\}/);
    }
  });
});

// ─── (d) The English captions are the agency's, not our paraphrase ──────────────────────────────────

describe('fda53352 · (d) every English caption is LHDN’s own wording', () => {
  /** Read off `docs/forms/ea-cp8a-pin-2023-official-en.pdf`. Not translated, not tidied. */
  const AGENCY_EN: Record<string, string> = {
    sectionAEmployeeParticulars: 'A  PARTICULARS OF EMPLOYEE',
    name: '1. Full Name of Employee / Pensioner (Mr./Miss/Madam)',
    jobTitle: '2. Job Designation',
    icNo: '4. New I.C. No',
    socsoNo: '7. SOCSO No.',
    childrenTaxRelief: '8. Number of children qualified for tax relief',
    startedOn: '(a) Date of commencement',
    leftOn: '(b) Date of cessation',
    sectionBEmploymentIncome: 'B  EMPLOYMENT INCOME, BENEFITS AND LIVING ACCOMMODATION',
    taxBorneByEmployer: '1(d) Income tax borne by the employer in respect of his employee',
    arrears: '2. Details of arrears and others for preceding years paid in the current year',
    unapprovedFundRefund: '5. Refund from unapproved Provident / Pension Fund',
    annuity: '2. Annuities or other periodical payments',
    sectionDTotalDeductions: 'D  TOTAL DEDUCTION',
    monthlyTaxDeduction: '1. Monthly tax deductions (MTD) remitted to LHDNM',
    cp38Deductions: '2. CP38 deductions remitted to LHDNM',
    tp1ClaimHeading: '5. Total claim for deduction by employee via Form TP1 in respect of:',
    childRelief: '6. Total qualifying child relief',
    sectionEContributions:
      'E  CONTRIBUTIONS PAID BY EMPLOYEE TO APPROVED PROVIDENT / PENSION FUND AND SOCSO',
    fundName: '1. Name of Provident Fund',
    contributionAmount:
      "Amount of compulsory contribution paid (state the employee's share of contribution only)",
    sectionFExemptAllowances: 'F  TOTAL TAX EXEMPT ALLOWANCES / PERQUISITES / GIFTS / BENEFITS',
  };

  it('each caption is verbatim', () => {
    const ea = en().payroll.ea as Record<string, string>;
    for (const [k, v] of Object.entries(AGENCY_EN)) {
      expect(ea[k], `payroll.ea.${k}`).toBe(v);
    }
  });

  it('the English form says SOCSO, which is what the English form says', () => {
    const ea = en().payroll.ea as Record<string, string>;
    expect(ea.socsoNo).toContain('SOCSO');
    expect(ea.socsoNo, 'PERKESO is the agency’s BM term and belongs on the BM form').not.toContain('PERKESO');
    // …and the BM form keeps it, because there it is the agency's own word.
    expect((ms().payroll.ea as Record<string, string>).socsoNo).toContain('PERKESO');
  });

  it('the Section E caption is SHARED by two lines, so it may not name one of them', () => {
    // It is drawn for E1 (the provident fund) AND for E2, where the renderer prefixes the agency's own
    // "SOCSO:" / "PERKESO :". A caption that named SOCSO would be false on the E1 line under it —
    // CLAUDE.md §8: a shared caption may say only what is true of every member. A first cut of r346
    // prefixed it and the blank form printed "2. PERKESO: 2. SOCSO : Amount of…".
    for (const cat of [en(), ms()]) {
      const v = (cat.payroll.ea as Record<string, string>).contributionAmount;
      expect(v).not.toMatch(/SOCSO|PERKESO/);
      expect(v).not.toMatch(/^\s*\d/);
    }
  });

  it('a caption must not repeat a word the renderer already draws beside it', () => {
    // `gratuity` is followed by `periodFrom` ("from") and `periodTo`. A first cut of r346 ended the
    // caption with "from" too, and the blank form printed "Gratuity for the period from from".
    const ea = en().payroll.ea as Record<string, string>;
    expect(ea.gratuity).toBe('1(f) Gratuity for the period');
    expect(ea.gratuity.trimEnd()).not.toMatch(/\bfrom$/);
  });
});

// ─── (e) The money column sits where the agency's own cells put it ──────────────────────────────────

describe('fda53352 · (e) the money column was traced wrong and is now measured', () => {
  it('it spans the agency’s coordinates, and no longer runs to the page frame', () => {
    const s = src('lib/ea-pdf.ts');
    expect(s).toContain('moneyLeft: 482.3');
    expect(s).toContain('moneyRight: 556.6');
    expect(s, 'the old traced value is gone').not.toContain('moneyLeft: 504.5');
  });

  it('every amount and money rule uses the column’s own right edge, not the page’s', () => {
    const s = src('lib/ea-pdf.ts');
    // If one is left on `R` the column and the figures in it disagree by 14.7pt.
    expect(s, 'a money call still bound to the page frame').not.toMatch(/amountOrRule\([^)]*,\s*MX,\s*R,/);
    expect(s).not.toMatch(/hRule\(MX,\s*R,/);
  });
});

// ─── (f) The heading that needed two lines, and the collision it caused ─────────────────────────────

describe('fda53352 · (f) the English heading wraps instead of running through the masthead', () => {
  it('the English edition splits it and the Malay does not', () => {
    expect(eaFormWords('en').privateStatement).toBe("PRIVATE SECTOR Employee's");
    expect(eaFormWords('en').privateStatement2).toBe('Statement of Remuneration');
    expect(eaFormWords('ms').privateStatement).toBe('Penyata Gaji Pekerja SWASTA');
    expect(eaFormWords('ms').privateStatement2, 'the Malay fits on one line').toBe('');
  });

  it('the one-line English string would have overrun its block — which is why it is two', () => {
    // Helvetica-Bold at 8.5pt. The block runs from the right edge back to the centred masthead's right
    // edge; the joined English string is far wider than the Malay it replaced, and pdf-lib does not clip.
    const joined = `${eaFormWords('en').privateStatement} ${eaFormWords('en').privateStatement2}`;
    expect(joined.length).toBeGreaterThan(eaFormWords('ms').privateStatement.length);
    // r349 replaced the `if (W.privateStatement2)` branch with a block that measures the edition's own
    // lines and sizes a FILLED rectangle to them — the agency sets this heading white-on-black. The
    // property is unchanged and still asserted: the English edition draws two lines and the Malay one.
    expect(src('lib/ea-pdf.ts'), 'the renderer still sizes to the edition').toContain(
      'const lines = W.privateStatement2 ?',
    );
  });
});

// ─── (g) r353 — Section A's two coordinates, and the black blocks that nearly touched ───────────────

/**
 * r353 (point 2) — SECTION A WAS TWO BARE LITERALS WITH NO CONSTANT AND NO TEST, AND THE MEASUREMENT
 * CONTRADICTED THE COMPLAINT.
 *
 * The reporter asked for "breathing room between the heading and the first field". Measured off the
 * agency's own file with the script this round finally COMMITS
 * (`node --import tsx scripts/measure-ea-official-pdf.ts`; r346's and r349's were never committed, so every
 * round since had to take `EA_FORM` on trust):
 *
 *   · the banner strip is tt 78.4 → 92.6;
 *   · Section A's heading row and its black letter square begin at tt 96.6 — 4.0 pt BELOW the banner;
 *   · the heading caption's baseline is 105.9 and item 1's is 119.7, a pitch of 13.8 pt.
 *
 * Ours was 14.5 pt between heading and first field — ALREADY WIDER than the agency's, so there was no
 * breathing room to add there. What was too tight is the gap the plan noticed in passing: our Section A
 * square started 0.6 pt under the banner where the agency leaves 4.0, and two solid black blocks 0.6 pt
 * apart read as one merged block at any print resolution.
 *
 * So the banner rose 3.4 pt into clearance we have and the agency does not, and the two literals became
 * arithmetic off the banner and the agency's two measured gaps. This pins the measurements and the
 * derivation — not the outputs, which are what the derivation is for.
 */
describe('fda53352 · (g) Section A is spaced off the agency’s page, not off a literal', () => {
  /**
   * ⚠️ r372 — THIS CASE IS UPDATED, NOT LOOSENED, AND THE DERIVATION IT PINNED IS GONE BECAUSE THE
   * CONSTRAINT IT WORKED AROUND IS GONE. What it asserted, quoted:
   *
   *     expect(s).toContain('A.bannerT[1] + A.sectionGapUnderBanner + SQUARE_ASCENT');
   *     expect(s).toContain('aHeading + A.sectionAFieldPitch');
   *
   * r353 could not put Section A on the agency's baseline, because everything below it was a traced
   * ~87% compression of the agency's page and moving one heading would have opened a gap it could not
   * close. So it derived Section A's heading FROM the banner and bought the agency's 4.0 pt clearance
   * by moving the banner instead. r372 re-measured the whole page: the banner strip, Section A's letter
   * block and every section baseline are now the agency's own absolute coordinates, so the derivation
   * has nothing left to derive and the two gaps it computed are properties of the measurement.
   *
   * THE PROPERTY IS THE SAME AND IS STILL ASSERTED, on the drawn page rather than on the source text:
   * the two solid black blocks (the banner strip and Section A's letter block) must not read as one,
   * which is what 0.6 pt of clearance did, and the heading→first-field pitch must be the agency's.
   */
  it('the agency’s two measured gaps are named constants, and the measuring script is committed', () => {
    const s = src('lib/ea-pdf.ts');
    expect(s, 'the banner→section gap measured off the agency’s PDF').toContain('sectionGapUnderBanner: 4.0');
    expect(s, 'the agency’s heading→first-field pitch in Section A').toContain('sectionAFieldPitch: 13.8');
    // The two bare literals are still gone from the drawing code…
    expect(s, 'Section A’s heading is a literal again').not.toContain('sectionHeading(t.sectionAEmployeeParticulars, 99.5)');
    expect(s, 'the banner caption is pinned to an absolute baseline again').not.toContain('putC(W.banner, CX, 86.5,');
    // …and every one of them is now a MEASURED coordinate carrying the agency's own name.
    expect(s).toContain('sectionHeading(t.sectionAEmployeeParticulars, A.sectionT.a)');
    expect(s).toContain('putC(W.banner, CX, A.bannerCaptionT');
    expect(existsSync(new URL('scripts/measure-ea-official-pdf.ts', `file://${root}`)), 'the measuring script was not committed — again').toBe(true);
  });

  it('the derivation reproduces the agency’s clearance under the banner, with room left above it', () => {
    // `sectionHeading` hangs the agency's own letter block `letterBlockAscent` above the caption's
    // baseline, so the clearance between the two black blocks is the banner's foot to that block's top.
    // Asserted as arithmetic on EA_FORM so it follows the constants rather than repeating their values.
    const blockTop = EA_FORM.sectionT.a - EA_FORM.letterBlockAscent;
    expect(blockTop - EA_FORM.bannerT[1], 'two black blocks nearly touching again').toBeCloseTo(
      EA_FORM.sectionGapUnderBanner,
      1,
    );
    // 0.6 pt was the shipped gap, and it is what this case exists to refuse coming back.
    expect(EA_FORM.sectionGapUnderBanner).toBeGreaterThan(0.6);
    // The heading→first-field pitch is the agency's own, now read off two measured baselines.
    expect(EA_FORM.rowsA.name - EA_FORM.sectionT.a, 'Section A’s pitch left the agency’s').toBeCloseTo(
      EA_FORM.sectionAFieldPitch,
      1,
    );
    // The banner still clears the header rules above it ("Employer's No. E" / "LHDNM State" at tt 72.5).
    expect(EA_FORM.bannerT[0] - EA_FORM.headerT.employerNo, 'the banner has been pushed into the header rules').toBeGreaterThan(
      4,
    );
  });
});
