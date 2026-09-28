/**
 * 6036dab7 — THE EA BOX CONTRACT, PINNED ACROSS ALL FOUR HALVES THAT HAVE TO AGREE.
 *
 * An EA box is not one thing in one file. It is a name in the amendment vocabulary (EA_FIELDS,
 * localization/my/reports.ts), a figure the read returns, a row on the HTML statement, a row in the
 * "Amend EA figures" panel beneath it, and a line the PDF renderer draws from a label in `EaPdfLabels`.
 * TypeScript enforces exactly two of those joins and no more:
 *   • the route must supply every `EaPdfLabels` key (they are required properties), and
 *   • `derivedField`'s switch in core/ea-override.ts is exhaustive over `EaField` with NO `default:`,
 *     so a new field without a derived baseline will not compile.
 * Everything else is silent. A field can join EA_FIELDS, be storable, be amendable through the server
 * action, and never appear on either surface — HR types a gratuity into an API that accepts it and the
 * printed C.P.8A does not have the box. A label can sit in `EaPdfLabels`, be translated into all six
 * locales, be handed to the renderer, and never be drawn. Neither shows up in a unit test of either side.
 *
 * So this is a SOURCE-SHAPE test over both sides of each unenforced join. It reads the files rather than
 * the runtime because the defect is the absence of a line of code, which no runtime value exposes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EA_FIELDS, EA_PART_B_COMPONENTS } from '../localization/my/reports';
import { EA_FORM_WORDS } from '../lib/ea-pdf';
import { EA_REGISTER, EA_REGISTER_NOTHING_FEEDS, renderEaFieldRegisterMarkdown } from '../lib/ea-field-register';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const PAGE = read('app/payroll/reports/ea/[employmentId]/page.tsx');
const RENDERER = read('lib/ea-pdf.ts');
// r220 — the fifty-odd `payroll.ea` captions moved out of the /me route into a bundle both EA PDF routes
// call (the blank C.P.8A is the second). See test/ea-pdf-i18n-keys.test.ts for why.
const LABELS = read('lib/ea-pdf-labels.ts');

/** The keys declared on `EaPdfLabels` — read off the type declaration, since types are erased at runtime. */
function eaPdfLabelKeys(): string[] {
  const block = RENDERER.match(/export type EaPdfLabels = \{([\s\S]*?)\n\};/);
  expect(block, 'EaPdfLabels declaration not found in lib/ea-pdf.ts').toBeTruthy();
  return [...block![1].matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]);
}

/**
 * r220 — one property of the object `eaPdfLabels()` returns, as source text.
 *
 * The properties are one per line at four spaces of indent, so the object splits on the next such line;
 * a property whose value spans several lines (a ternary, a call with options) comes back whole.
 */
function labelProperty(key: string): string {
  const body = LABELS.slice(LABELS.indexOf('  return {'));
  const chunks = body.split(/\n    (?=[a-zA-Z][a-zA-Z0-9]*:)/);
  return chunks.find((c) => new RegExp(`^\\s*${key}:`).test(c)) ?? '';
}

/** The field ids listed in the page's `amendFields` array literal — the panel HR actually sees. */
function amendPanelFields(): string[] {
  const block = PAGE.match(/const amendFields: AmendField\[\] = \(\s*\[([\s\S]*?)\]\s*as const/);
  expect(block, 'amendFields array literal not found in the EA page').toBeTruthy();
  return [...block![1].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((m) => m[1]);
}

describe('6036dab7 — every EA box reaches every surface', () => {
  it('every field in the EA vocabulary is PRINTED on the HTML statement', () => {
    // `rm(ea.partX.field)` is the render, and only the render: the amend panel's `derivedFor` map reads the
    // same fields WITHOUT `rm(`, so a field that is amendable-but-invisible still fails here.
    const printedOnScreen = (f: string) => ['B', 'C', 'D', 'E'].some((s) => PAGE.includes(`rm(ea.part${s}.${f})`));
    const missing = EA_FIELDS.filter((f) => !printedOnScreen(f));
    expect(missing, `EA fields with no printed row on the EA screen: ${missing.join(', ')}`).toEqual([]);
  });

  it('every field in the EA vocabulary is OFFERED in the amend panel', () => {
    const offered = amendPanelFields();
    const missing = EA_FIELDS.filter((f) => !offered.includes(f));
    expect(missing, `EA fields HR cannot enter: ${missing.join(', ')}`).toEqual([]);
    // …and nothing is offered that the vocabulary does not contain (the service would reject it with
    // `invalidField`, so the row would be a control that always errors).
    const unknown = offered.filter((f) => !(EA_FIELDS as readonly string[]).includes(f));
    expect(unknown, `amend panel offers fields the service rejects: ${unknown.join(', ')}`).toEqual([]);
  });

  /**
   * ⚠️ r351 — `eis` IS THE ONE EA FIELD THE PRINTED FORM DOES NOT CARRY, AND THAT IS NOW DELIBERATE.
   *
   * The official C.P.8A has no EIS box: `da4fc817` established that Section E carries exactly two
   * amounts and EIS is not one of them. It was printed in a strip of OURS below the officer box until
   * the reporter wrote "Remove this part from the EA Form" on the shipped page, so the printed form now
   * ends where the agency's ends. `eis` stays in the EA vocabulary because it is still a real datum on
   * the HTML statement and HR can still amend it — it simply has no box on the paper.
   *
   * The exception is an explicit, single-member list rather than a loosened regex, so a SECOND field
   * quietly dropping off the form still fails this test.
   */
  const NOT_ON_THE_PRINTED_FORM: readonly string[] = ['eis'];

  it('every field in the EA vocabulary is DRAWN by the PDF renderer', () => {
    const missing = EA_FIELDS.filter(
      (f) =>
        !/^(gross)$/.test(f) &&
        !NOT_ON_THE_PRINTED_FORM.includes(f) &&
        !new RegExp(`\\bd\\.part[BCDE]\\.${f}\\b`).test(RENDERER),
    );
    expect(missing, `EA fields the PDF never draws: ${missing.join(', ')}`).toEqual([]);
    expect(RENDERER).toContain('d.partB.gross'); // the total, drawn by its own row
  });

  it('the one field that is NOT on the printed form is still on the HTML statement and still amendable', () => {
    // Otherwise the exception above would be a hole: a field could be dropped from the form AND from the
    // screen and this suite would say nothing.
    const html = read('app/payroll/reports/ea/[employmentId]/page.tsx');
    for (const f of NOT_ON_THE_PRINTED_FORM) {
      expect(EA_FIELDS as readonly string[], `${f} left the vocabulary`).toContain(f);
      expect(html, `${f} is not rendered on the HTML statement either`).toContain(`ea.partE.${f}`);
    }
  });

  it('every label the PDF renderer declares is actually drawn, and is supplied by the route', () => {
    const keys = eaPdfLabelKeys();
    expect(keys.length).toBeGreaterThan(30); // sanity: the declaration parsed
    const undrawn = keys.filter((k) => !new RegExp(`\\bt\\.${k}\\b`).test(RENDERER));
    expect(undrawn, `EaPdfLabels keys nothing prints: ${undrawn.join(', ')}`).toEqual([]);
    // tsc already refuses a route that omits a required key; this catches the other direction — a key
    // wired through `t('…')` under a name the `payroll.ea` namespace does not have would fail
    // test/ea-pdf-i18n-keys.test.ts, and one supplied from a literal would fail here.
    //
    // r220 — READ THE PROPERTY, NOT A SUBSTRING. This used to be `includes(`${k}: t('`)`, which cannot see
    // a key resolved on a BRANCH — and `disclaimer` is now one: a blank C.P.8A gets `blankDisclaimer`,
    // because "Generated from payroll for YA 2026" is false on a page with nothing in it. Splitting the
    // returned object into its properties and requiring a `t(` inside each one is strictly stronger than
    // the substring was: it also catches a key whose value came from somewhere else entirely.
    const notFromNamespace = keys.filter((k) => !/\bt\(['"]/.test(labelProperty(k)));
    expect(notFromNamespace, `EaPdfLabels keys the bundle does not resolve from payroll.ea: ${notFromNamespace.join(', ')}`).toEqual([]);
  });

  it('every Part B component that sums into the total is itself a printed line', () => {
    // The invariant the §0 fix bought: the printed lines sum to the printed total. A component that feeds
    // `partB.gross` without appearing on the form makes the total larger than the lines above it.
    const missing = EA_PART_B_COMPONENTS.filter((f) => !RENDERER.includes(`d.partB.${f}`));
    expect(missing, `Part B components that reach the total but are never printed: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * ⚠️ A BOX THAT PRINTS 0.00 MAKES A CLAIM. AN ABSENT BOX MAKES NONE.
   *
   * None of the manual Part B boxes can be derived from payroll: `payslip` persists only aggregate
   * scalars (basic_salary / allowance / overtime_pay / bonus / gross_pay + a statutory jsonb), there is
   * no payslip-line table, and every earning component is folded into `payslip.allowance` before the
   * row is written. Their only source is an `ea_override` HR has keyed.
   *
   * Printing them unconditionally therefore asserted "this money does not exist" while the same money
   * was printed two lines up under Allowances — a tenant paying a director RM 4,000/month of commission
   * got "Fees (incl. director's fees) RM 0.00" beside an Allowances figure carrying the RM 48,000. That
   * is an affirmative false statement on a C.P.8A, and it is worse than the box being absent, which is
   * what the form did before this round.
   *
   * Source-shape, deliberately, for the same reason as every other case in this file: the defect is
   * which renderer call a line uses, and no runtime value distinguishes "0.00 printed" from "omitted"
   * without rasterising a PDF.
   */
  it('the manual Part B boxes are drawn only when HR has entered a figure', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../lib/ea-pdf.ts'), 'utf8');

    // r219 — THE DECISION IS UNCHANGED; THE SHAPE THAT EXPRESSES IT MOVED. Before the C.P.8A redraw this
    // was `optionalRow(...)`, which OMITTED the whole line when nothing was entered. The form's own
    // caption and rule are now printed whether or not there is a figure — that is what the blank agency
    // page carries — so the conditional narrowed to the AMOUNT: `manual()` yields the figure or an empty
    // string, and an empty string leaves `amountOrRule` drawing the rule and nothing on it.
    //
    // The half that has NOT changed, and is the reason this case exists: a box with no payroll source
    // must never print 0.00 (AGENTS 28; r209 shipped that defect on this exact form).
    expect(src).toMatch(/const derived = \(n: number\): string => amt\(n\);/);
    // A real zero test, not a truthiness check — 0 and '' differ here.
    expect(src).toMatch(
      /const manual = \(n: number\): string =>\s*\(Math\.round\(\(Number\(n\) \|\| 0\) \* 100\) !== 0 \? amt\(n\) : ''\);/,
    );
    // …and an empty amount draws the rule with nothing on it, rather than a placeholder.
    expect(src).toMatch(/const amountOrRule = [\s\S]{0,200}?dotted\(x0, x1, tt \+ 2\.5\);\s*\n\s*if \(v\) \{/);

    // Every box whose ONLY source is an override goes through `manual`…
    for (const box of [
      'taxBorneByEmployer', 'esos', 'gratuity', 'arrears',
      'benefitsInKind', 'livingAccommodation', 'unapprovedFundRefund', 'compensation',
    ]) {
      expect(src, `${box} no longer goes through manual()`).toContain(`manual(d.partB.${box})`);
      expect(src, `${box} is also drawn as a derived figure somewhere`).not.toContain(`derived(d.partB.${box})`);
    }
    // Part C's two boxes are manual for the same reason (this product pays no pensions).
    for (const box of ['pension', 'annuity']) {
      expect(src, `${box} no longer goes through manual()`).toContain(`manual(d.partC.${box})`);
      expect(src, `${box} is also drawn as a derived figure somewhere`).not.toContain(`derived(d.partC.${box})`);
    }

    // …and the boxes that ARE payroll-derived keep printing even at zero, because there a zero is a
    // fact we can stand behind. Suppressing these would hide a real "you were paid no bonus".
    //
    // `directorFee` and `tipsPerquisites` are the two manual boxes that are NOT in the list above: the
    // form's 1(b) and 1(c) are each ONE box covering one derived figure and one manual one.
    //
    // ⚠️ r219's FIX PASS REVERSED HALF OF THIS CASE, AND THE HALF THAT SURVIVES IS THE POINT. Printing
    // that pair through `derived` — which prints at 0.00 — made an ordinary salary-only C.P.8A state
    // "no fees, no director's fees, no commission" and "no tips, perquisites or awards", and the second
    // half of each of those we cannot stand behind: nothing in payroll derives a director's fee, and
    // only an `ea_override` can supply one. Under the agency's own numbered caption that reads MORE
    // authoritative, not less. So a MIXED box prints only when it has something to say, exactly like a
    // manual one — `mixed(derivedHalf, manualHalf)` — while a wholly-derived box still prints at zero,
    // because there a zero is a fact. What did NOT move: each is still ONE box over TWO of our figures,
    // in that order, and neither half may be drawn on a line of its own (AGENTS 18, AGENTS 28).
    expect(src, 'gross salary must still print unconditionally').toContain('derived(d.partB.grossSalary)');
    expect(src, "the form's 1(b) is bonus + director's fees, printed as one box").toContain(
      'mixed(d.partB.bonus, d.partB.directorFee)',
    );
    expect(src, "the form's 1(c) is allowances + tips/perquisites, printed as one box").toContain(
      'mixed(d.partB.allowances, d.partB.tipsPerquisites)',
    );
    // …and the pair may not go back to printing a derived zero over a box half of which has no source.
    expect(src, '1(b) is drawn as a derived figure again').not.toContain('derived(d.partB.bonus + d.partB.directorFee)');
    expect(src, '1(c) is drawn as a derived figure again').not.toContain('derived(d.partB.allowances + d.partB.tipsPerquisites)');
    // The mixed helper is what makes that true, so it must exist and must suppress a zero sum.
    expect(src).toMatch(/const mixed = \(derivedPart: number, manualPart: number\): string => manual\(/);
    for (const field of ['mtd', 'cp38', 'zakat']) {
      expect(src, `${field} must still print unconditionally`).toContain(`derived(d.partD.${field})`);
    }
  });

});

/**
 * ⚠️ r220 (item 61c2e30f) — THE FIELD REGISTER IS THE FIFTH SURFACE, AND IT IS THE ONE A HUMAN READS.
 *
 * `docs/forms/ea-cp8a-field-register.md` is the box-by-box list the reporter asked for: every box on the
 * C.P.8A with its official section, its official box number, the agency's own wording, the kind of value it
 * takes and what feeds it today. It is the document somebody holds beside the blank form to answer "is the
 * EA right?", and it is worth exactly as much as it is CURRENT.
 *
 * A hand-written register would have been right on the day it was written. So it is generated from
 * `lib/ea-field-register.ts` and pinned to the renderer in BOTH directions here — a row naming a caption
 * nothing draws fails, and a caption or a figure the renderer draws that no row names fails. Neither
 * direction is visible to tsc: the register is data, and the renderer is drawing calls.
 */
describe('r220 — the field register and the drawn form describe the same page', () => {
  const REGISTER_DOC = 'docs/forms/ea-cp8a-field-register.md';

  /** The register's caption keys, split by where the caption comes from. */
  const labelCaptions: string[] = EA_REGISTER.filter((r) => r.caption.from === 'label').map((r) => r.caption.key);
  const agencyCaptions: string[] = EA_REGISTER.filter((r) => r.caption.from === 'agency').map((r) => r.caption.key);

  it('every row names a caption the renderer actually draws', () => {
    // A `label` row must be a real `EaPdfLabels` key the renderer reads…
    const declared = eaPdfLabelKeys();
    const unknown = labelCaptions.filter((k) => !declared.includes(k));
    expect(unknown, `register rows naming a label that is not on EaPdfLabels: ${unknown.join(', ')}`).toEqual([]);
    const undrawn = labelCaptions.filter((k) => !new RegExp(`\\bt\\.${k}\\b`).test(RENDERER));
    expect(undrawn, `register rows whose caption nothing draws: ${undrawn.join(', ')}`).toEqual([]);
    // …and an `agency` row must be a real EA_FORM_WORDS key the renderer draws through `W.`.
    const unknownAgency = agencyCaptions.filter((k) => !(k in EA_FORM_WORDS));
    expect(unknownAgency, `register rows naming agency words that do not exist: ${unknownAgency.join(', ')}`).toEqual([]);
    const undrawnAgency = agencyCaptions.filter((k) => !new RegExp(`\\bW\\.${k}\\b`).test(RENDERER));
    expect(undrawnAgency, `register rows whose agency caption nothing draws: ${undrawnAgency.join(', ')}`).toEqual([]);
  });

  it('every caption the renderer draws has a row in the register', () => {
    const missingLabels = eaPdfLabelKeys().filter((k) => !labelCaptions.includes(k));
    expect(missingLabels, `captions drawn on the form with no register row: ${missingLabels.join(', ')}`).toEqual([]);
    // ⚠️ AN AGENCY WORD THAT IS EMPTY IN THIS EDITION IS NOT A BOX (r346). `privateStatement2` is the
    // SECOND LINE of the "Penyata Gaji Pekerja SWASTA" heading, which LHDN's English edition sets on two
    // lines and its Malay edition on one. It is a typesetting split of a heading the register already
    // documents, not a field of its own, so it has no row — and demanding one would put an empty
    // `wording` in the HEADER section, which the last case in this file correctly forbids.
    const documented = EA_FORM_WORDS as Record<string, string>;
    const missingAgency = Object.keys(EA_FORM_WORDS).filter(
      (k) => documented[k] !== '' && !agencyCaptions.includes(k),
    );
    expect(missingAgency, `agency words drawn on the form with no register row: ${missingAgency.join(', ')}`).toEqual([]);
  });

  /**
   * The other direction, on the FIGURES rather than the captions: the register claims to say what feeds
   * each box, so a value the renderer reads off `EaPdfData` that no row names is a box whose source the
   * register is silent about — which is the state the whole mapping was in before this item.
   */
  it('every EaPdfData value the renderer reads is named as some row’s source', () => {
    const body = RENDERER.slice(RENDERER.indexOf('export async function renderEaPdf'));
    const drawnPaths = new Set(
      // `[a-zA-Z0-9]` and not `[a-zA-Z]`: `partD.cp38` and `partD.tp1Relief` carry digits, and a letters-only
      // class silently drops exactly those two — a register that stopped naming CP38 would have passed.
      [...body.matchAll(/\bd\.((?:employer|employee|partB|partC|partD|partE)\.[a-zA-Z0-9]+|year|overrides)\b/g)].map((m) => m[1]),
    );
    expect(drawnPaths.size, 'sanity: the renderer body was found and scanned').toBeGreaterThan(30);
    const registered = new Set(EA_REGISTER.flatMap((r) => r.sources));
    const unlisted = [...drawnPaths].filter((p) => !registered.has(p)).sort();
    expect(unlisted, `values the form draws that the register does not account for: ${unlisted.join(', ')}`).toEqual([]);
    // …and nothing in the register points at a value the renderer never reads.
    const phantom = [...registered].filter((p) => !drawnPaths.has(p)).sort();
    expect(phantom, `register sources the renderer never reads: ${phantom.join(', ')}`).toEqual([]);
  });

  /**
   * ⚠️ THE PROMISE THE REGISTER MAKES ABOUT AN UNFED BOX, AND IT IS AGENTS 28 IN DOCUMENT FORM. A box the
   * agency asks for that this system holds nothing for must SAY SO — "nothing feeds this yet" — rather than
   * carry an empty cell a reader takes for an oversight, or a cell describing a source that does not exist.
   */
  it('a value box with no source says “nothing feeds this yet”, and one with a source does not', () => {
    // `heading` and `note` take no value at all — a section title, the column's RM, our own footnote strip —
    // so the rule is about the boxes somebody would actually write in.
    const lying = EA_REGISTER.filter((r) => !['heading', 'note'].includes(r.value) && r.sources.length === 0 && r.feed !== 'none');
    expect(lying.map((r) => `${r.section}${r.box}`), 'value boxes with no source that claim one').toEqual([]);
    const silent = EA_REGISTER.filter((r) => r.sources.length > 0 && r.feed === 'none');
    expect(silent.map((r) => `${r.section}${r.box}`), 'boxes with a source that claim nothing feeds them').toEqual([]);
    // The exact wording is a promise made to the reporter in the approved plan, so it is pinned.
    expect(EA_REGISTER_NOTHING_FEEDS).toBe('nothing feeds this yet');
    expect(renderEaFieldRegisterMarkdown()).toContain(EA_REGISTER_NOTHING_FEEDS);
    // …and at least one box really is in that state, so the case cannot pass vacuously.
    expect(EA_REGISTER.filter((r) => r.feed === 'none').length).toBeGreaterThan(4);
  });

  /**
   * r219's lesson, applied to the register: a caption that LOOKS like the agency's box while saying
   * something the agency's page does not say is worse than an obviously-ours label, because a reader
   * checking a C.P.8A against the blank form has no reason to doubt a numbered caption. So every wording in
   * the register must appear in the hand transcription of the specimen.
   *
   * Whitespace is normalised (the transcription wraps its longer captions) and runs of underscores are
   * collapsed (it draws the form's fill-in rules as `______`). Nothing else is relaxed.
   */
  it('every official wording in the register appears in the transcription of the specimen', () => {
    const norm = (v: string) => v.replace(/_+/g, '_').replace(/\s+/g, ' ').trim();
    const transcription = norm(read('docs/forms/ea-cp8a-pin-2023-transcription.txt'));
    const worded = EA_REGISTER.filter((r) => r.wording !== '');
    expect(worded.length).toBeGreaterThan(55); // sanity: nearly every row carries agency wording
    const missing = worded.filter((r) => !transcription.includes(norm(r.wording)));
    expect(
      missing.map((r) => `${r.section}${r.box ? ` ${r.box}` : ''}: ${JSON.stringify(r.wording)}`),
      'register wordings that are not in docs/forms/ea-cp8a-pin-2023-transcription.txt',
    ).toEqual([]);
    // The only rows allowed to carry no agency wording are the ones that are not the agency's boxes.
    const wordless = EA_REGISTER.filter((r) => r.wording === '');
    expect([...new Set(wordless.map((r) => r.section))].sort()).toEqual(['BELOW', 'META']);
  });

  /**
   * ⚠️ THE CHAIN THE PLAN PROMISED, AND THE LINK THAT WAS MISSING FROM IT.
   *
   * The case above holds the register's `wording` column to the transcription — but that column is a THIRD
   * hand-typed copy of each caption. The page draws `messages/ms.json` → `payroll.ea.<key>`, and nothing
   * joined the two. Row A/1 could go on carrying `wording: 'Nama Penuh Pekerja / Pesara (Encik/Cik/Puan)'`
   * while the form printed something else entirely, and every other case in this file would stay green: the
   * register would be a document describing a form that does not exist, which is worse than no register at
   * all, because it is the document somebody TRUSTS while checking a C.P.8A.
   *
   * So this closes the chain — PRINTED CAPTION → REGISTER WORDING → TRANSCRIPTION — and it subsumes the
   * hardcoded twenty-one-key list in test/r219-ea-cp8a-form.test.ts, because the register names EVERY drawn
   * caption (the two cases at the top of this describe prove that in both directions). The six section
   * titles, `sectionBExcluding`, every numbered Part A item, the description cues, 1(f)'s two period rules,
   * `fundName`, `contributionAmount` and `formTotal` are all checked here and none of them was on that list.
   *
   * OUR NUMBERING IS STRIPPED FIRST. The form prints its item numbers in its own column, so the caption
   * carries "1(b) ", "5(a) ", "9. ", "(a) " or the section letter "A  " as OUR prefix; everything after it
   * is the agency's and must equal the register's wording exactly.
   */
  it('every register wording is the Malay caption the form actually prints', () => {
    const ms = JSON.parse(read('messages/ms.json')).payroll.ea as Record<string, string>;
    /** OUR prefixes: a section letter, "9. ", "1(f) ", "5(a) ", or a bare "(a) " under item 9. */
    const OURS = /^(?:[A-F] {2}|\d+(?:\([a-z]\))?[.)]?\s+|\([a-z]\)\s+)/;
    const printed = (v: string) => v.replace(OURS, '').trim();

    /**
     * The ONE row whose register wording is deliberately LONGER than the printed caption. 1(f) prints
     * “Ganjaran bagi tempoh” and then draws the form's own `dari ___ hingga ___` rules as two further
     * captions, so the register states the whole box on one row. Those two rules are themselves register
     * rows (`periodFrom` / `periodTo`) and are checked like everything else, so this exception leaves
     * nothing unverified — the printed caption must still be the START of the register's wording.
     */
    const INLINE_RULES = new Set(['gratuity']);

    const rows = EA_REGISTER.filter((r) => r.caption.from === 'label' && r.wording !== '');
    expect(rows.length, 'sanity: the register carries agency wording on its label rows').toBeGreaterThan(40);
    // Resolution is ASSERTED, never filtered. A silently dropped key is exactly how four captions in
    // test/r219-ea-cp8a-form.test.ts went unchecked for a whole round while their guard looked green.
    const unresolved = rows.filter((r) => typeof ms[r.caption.key] !== 'string');
    expect(
      unresolved.map((r) => r.caption.key),
      'register captions with no payroll.ea key in messages/ms.json',
    ).toEqual([]);

    const drifted = rows.filter((r) => {
      const caption = printed(ms[r.caption.key]);
      return INLINE_RULES.has(r.caption.key) ? !r.wording.startsWith(caption) : caption !== r.wording;
    });
    expect(
      drifted.map(
        (r) =>
          `${r.section}${r.box ? ` ${r.box}` : ''} (${r.caption.key}): the form prints ${JSON.stringify(printed(ms[r.caption.key]))}, the register says ${JSON.stringify(r.wording)}`,
      ),
      'captions the form prints that the register does not carry — the transcription of the specimen is the authority for both',
    ).toEqual([]);
  });

  /**
   * The checked-in document is what a reviewer reads in a diff and what the shelf hands an operator, so it
   * cannot lag the data. Regenerate with `pnpm tsx scripts/gen-ea-field-register.ts`.
   */
  it('the shipped register document is up to date with the register data', () => {
    expect(fs.existsSync(path.resolve(__dirname, '..', REGISTER_DOC)), `${REGISTER_DOC} is missing`).toBe(true);
    expect(read(REGISTER_DOC), `${REGISTER_DOC} is stale — run scripts/gen-ea-field-register.ts`).toBe(
      renderEaFieldRegisterMarkdown(),
    );
  });

  /**
   * The blank form and the register are the two halves of what was asked for, and each is reachable from
   * the shelf. Pinned here rather than only in test/statutory-forms-page.test.ts because a route file that
   * disappears takes the register with it and the catalog entry would still look fine.
   */
  it('both downloads exist as routes, and the register is served from the constant rather than from docs/', () => {
    const root = path.resolve(__dirname, '..');
    expect(fs.existsSync(path.join(root, 'app/payroll/ea/blank/route.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'app/payroll/ea/field-register/route.ts'))).toBe(true);
    const route = read('app/payroll/ea/field-register/route.ts');
    expect(route).toContain('renderEaFieldRegisterMarkdown()');
    // Reading docs/ at request time would 404 the download on any deploy that did not carry the folder.
    expect(route).not.toContain('readFileSync');
  });
});
