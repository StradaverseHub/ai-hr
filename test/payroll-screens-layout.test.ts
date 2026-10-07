/**
 * 152fea7f — the Payroll module has ONE width standard, and the employee panel survives it.
 *
 * WHY THIS FILE EXISTS AT ALL. Payroll's page width has now been decided four times, in four different
 * places, by four different rounds, and each time the answer was written as a hand-typed class on one
 * page's outer <div>:
 *
 *   • c002b3c3 widened Personnel and, in passing, several Payroll screens to `mx-auto max-w-[100rem]`.
 *   • 1372d169 found Transaction View capping four of its five tabs at `max-w-6xl` and moved that page
 *     to `pageWideCls` — the FULL browser width — leaving the module split between two "wide" values.
 *   • payroll-backpay-statutory-layout put Back Pay and Statutory Adjustment on `pageWideCls` too, and
 *     recorded in prose that Fixed Transaction was being left on the older cap on purpose.
 *   • 152fea7f is the reporter asking for the split to end: every Payroll screen, one container.
 *
 * The failure mode is not that a screen looks wrong — it is that NOTHING FAILS when a screen drifts.
 * A width is a string; tsc, the suite and `next build` are all indifferent to it, so the only thing
 * that can hold sixteen files to one decision is an assertion that reads them. That is this file.
 *
 * One case in section A deliberately does NOT read the round's edit list: it walks app/payroll from
 * disk. A guard whose input is the set of files just changed can only ever confirm that the change
 * happened, and the drift this file exists to catch is in the screens NOBODY thought about.
 *
 * Modelled on test/attendance-screens-layout.test.ts and test/claims-config-layout.test.ts, deliberately
 * — a fourth guard invented from scratch is a fourth thing to keep in sync.
 *
 * SECTION C IS NOT AN AFTERTHOUGHT. The approved plan asked the reporter one question: does "all
 * screens" include the single-record FORM pages (one payslip's declaration, one loan, one pay item),
 * where full width makes a form harder to fill in, not easier? The approved answer was "widen the
 * list/table/workspace screens, keep single-column forms at a comfortable reading width". Section C is
 * that answer, written down where the next sweep will trip over it. Without it, "make Payroll full
 * width" reads as licence to take the forms too, and there is nothing to say otherwise.
 *
 * SECTION D IS THE ROUND-TRIP GUARD. r179 removed the left-hand employee rail to give a table more
 * room; the reporter contested it and 98e69987 put it back. The reporter asked for THIS change with
 * "keep the Hide Employee List toggle" attached, precisely because they expected it to cost them the
 * panel again. It does not: widening the page container is ORTHOGONAL to the panel, which fills
 * whatever width its parent allows. Section D pins that nobody quietly traded the panel for the width.
 *
 * Limits, inherited from the precedents: a className composed through cn() or through a variable
 * escapes a source check. Every class this file reads is a string literal, a template literal, or the
 * named `pageWideCls` const.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { pageWideCls } from '../components/ui';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** All string-literal className values in a source file (double-quoted or template literal). */
const classNameLiterals = (source: string): string[] =>
  [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);

/**
 * A PAGE-level cap: ONE className carrying BOTH `mx-auto` AND a max-width.
 *
 * The attendance and claims guards spell the width half as `max-w-\d*xl`, which is right for what they
 * were reversing (`max-w-4xl`, `max-w-5xl`). It is NOT enough here: the cap this round removes is
 * `max-w-[100rem]`, an ARBITRARY value, and the narrower predicate walks straight past it — the claims
 * guard says so in its own comment. So the bracket form is matched too. `max-w-lg` / `max-w-xs` and
 * friends are still out of reach by construction, which keeps legitimate inner measures (a centred
 * hint paragraph on Statutory Forms) from reading as page caps.
 *
 * `print:`-prefixed tokens are dropped first, and section B is why: Individual Payslip legitimately
 * carries `print:mx-auto print:max-w-4xl`. That is a rule for PAPER, where a 1600px measure is not a
 * width the sheet has; it says nothing about the screen. Only the `print:` variant is stripped, not
 * every variant — a `lg:max-w-*` beside an `mx-auto` really would cap the page on a desktop, and this
 * predicate should keep seeing it.
 */
const screenClasses = (cls: string) =>
  cls
    .split(/\s+/)
    .filter((t) => !t.startsWith('print:'))
    .join(' ');

const capsPage = (raw: string) => {
  const cls = screenClasses(raw);
  return /\bmx-auto\b/.test(cls) && /\bmax-w-(?:\d*xl\b|\[)/.test(cls);
};

// ─────────────────── A. the sixteen screens this round standardised ───────────────────

/**
 * Every Payroll list / table / workspace screen that was NOT already on `pageWideCls`. Eleven under
 * /payroll and five Payroll-owned screens under /admin (Loans, Pay Items, Payroll Cycles, Payroll
 * Policies, Payroll Settings) — the module is split across two route trees and a guard that only
 * walked app/payroll would miss a third of it.
 */
const STANDARDISED = [
  'app/payroll/page.tsx',
  // 65e2d5de — the three screens under app/payroll/[batchId] that 152fea7f's sweep missed: the run VIEW
  // screen (max-w-6xl), Reprocess and Remove Employee Payroll (max-w-5xl, on BOTH branches each — the
  // refusal render as well as the main one). They are the working screens of the Payroll Process
  // workflow and were the last three still boxed into a narrow column.
  'app/payroll/[batchId]/page.tsx',
  'app/payroll/[batchId]/reprocess/page.tsx',
  'app/payroll/[batchId]/remove/page.tsx',
  'app/payroll/individual-payslip/page.tsx',
  'app/payroll/process/page.tsx',
  'app/payroll/reports/page.tsx',
  'app/payroll/setup/page.tsx',
  'app/payroll/statutory-forms/page.tsx',
  'app/payroll/transactions/page.tsx',
  'app/payroll/transactions/fixed/page.tsx',
  'app/payroll/transactions/individual/page.tsx',
  'app/payroll/transactions/tp1/page.tsx',
  'app/payroll/transactions/zakat/page.tsx',
  'app/admin/loans/page.tsx',
  'app/admin/pay-components/page.tsx',
  'app/admin/payroll-config/page.tsx',
  'app/admin/payroll-cycle/page.tsx',
  'app/admin/payroll-policy/page.tsx',
] as const;

/** The three that were already there, and against which "the same setting" is defined. */
const ALREADY_WIDE = [
  'app/payroll/transaction-view/page.tsx',
  'app/payroll/back-pay/page.tsx',
  'app/payroll/statutory-adjustment/page.tsx',
] as const;

/**
 * SCREENS A LATER ROUND MOVED ONTO THE SAME CONTAINER, kept apart from STANDARDISED so that list stays a
 * true record of what 152fea7f swept rather than a bucket every future round appends to. Each entry is a
 * decision this file used to pin the OTHER way, and the reasoning for the reversal is left beside the
 * list it moved out of — Section C's NARROW_FORMS and CAPPED_BY_DESIGN below.
 */
const WIDENED_LATER = [
  // 7ad37961 (r210) — the Edit TP1 Relief page. See NARROW_FORMS in section C for why the single-record
  // exception no longer holds for it.
  'app/payroll/transactions/tp1/[year]/[month]/page.tsx',
  // 711adcd2 (r254) — the Pay Item form, for the SAME reason and on the reporter's own drawing. See
  // NARROW_FORMS in section C.
  'app/admin/pay-components/component-form.tsx',
  // r402 (f3cf2444) — the statutory-form criteria step, on the reporter's own request ("the first step
  // also uses the full screen width instead of a narrow box"). See CAPPED_BY_DESIGN in section A for the
  // r256 reason it used to be capped; the boxes now sit in one row across the width instead.
  'app/payroll/statutory-forms/open/page.tsx',
] as const;

const ALL_WIDE = [...STANDARDISED, ...ALREADY_WIDE, ...WIDENED_LATER];

/**
 * THE MODULE AS IT IS ON DISK, not as this round edited it. Every `.tsx` under app/payroll is walked,
 * so a screen that exists today and was never touched — and, more to the point, a screen added
 * tomorrow — is inside the enumeration without anyone remembering to list it here.
 *
 * Known limit, stated rather than hidden: the five Payroll-owned screens under /admin cannot be
 * discovered the same way (app/admin also holds Personnel and the org screens, which keep the old cap
 * legitimately), so they come from STANDARDISED. A SIXTH Payroll screen filed under /admin would
 * therefore escape this walk until it is added there.
 */
const tsxUnder = (rel: string): string[] =>
  fs
    .readdirSync(path.join(ROOT, rel), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? tsxUnder(`${rel}/${e.name}`)
        : e.name.endsWith('.tsx')
          ? [`${rel}/${e.name}`]
          : [],
    );

const PAYROLL_MODULE_ON_DISK = [
  ...tsxUnder('app/payroll'),
  ...STANDARDISED.filter((f) => f.startsWith('app/admin/')),
].sort();

/**
 * The Payroll files that STILL carry `mx-auto max-w-[100rem]`, deliberately and by name. All FOUR are
 * printed statutory DOCUMENTS, not screens: the Borang A, Borang 8A and CP39 previews and one rendered
 * statutory form. They are Section C's category — a single record laid out to be read and filed, whose
 * on-screen measure mirrors the sheet — reached FROM the widened Statutory Forms screen rather than
 * sub-menus of their own, and the approved scope kept that class of page at a reading width.
 *
 * This list is the point of the assertion below, not a nuisance beside it: to move one of these you
 * must delete its line here and say why, which is the review this width has failed to get four times.
 *
 * CP39's preview joined the list when e0cd4583 built it, and the guard caught it in the same release —
 * which is the behaviour advertised two cases below ("it fails when a NEW Payroll screen is born carrying
 * the old cap"). It is admitted rather than swept because it is the same category as its three
 * neighbours: a printed LHDN form built to mirror the Borang A three-layer split, previewed at the
 * measure of the sheet it prints to. If CP39's preview ever stops being a document, this line goes.
 */
const CAP_SURVIVORS = [
  'app/payroll/borang-8a/preview/page.tsx',
  'app/payroll/borang-a/preview/page.tsx',
  'app/payroll/cp39/preview/page.tsx',
  'app/payroll/statutory-forms/[formId]/page.tsx',
] as const;

describe('152fea7f · A — every Payroll screen uses the one full-width container', () => {
  it.each(ALL_WIDE)('%s APPLIES pageWideCls', (file) => {
    // The APPLICATION, not the import — the lesson e7eb5d83 rev 6 learned by reverting one page and
    // watching an import-only check stay green. Individual Payslip composes it with its print variant,
    // so both spellings are accepted; what is refused is a file that imports the const and then
    // hand-writes a width anyway.
    const src = read(file);
    const applied =
      src.includes('<div className={pageWideCls}>') || src.includes('className={`${pageWideCls}');
    expect(applied, `${file} must APPLY the named pageWideCls constant, not merely import it`).toBe(true);
  });

  it.each(ALL_WIDE)('%s has no page-level width cap', (file) => {
    const offending = classNameLiterals(read(file)).filter(capsPage);
    expect(offending, `${file} re-introduces a page-level width cap: ${offending.join(' | ')}`).toEqual([]);
  });

  it('the superseded max-w-[100rem] cap survives on the printed documents ONLY — the module read from disk', () => {
    // THIS CASE IS THE ONLY ONE HERE THAT LOOKS OUTSIDE THIS ROUND'S EDIT LIST, and that is the whole
    // reason it exists. An earlier version of it iterated ALL_WIDE — the nineteen files the round had
    // just changed — under the name "gone from the module, not merely from most of it". It could not
    // fail: those files are asserted to APPLY pageWideCls two cases above, and `capsPage` (which
    // matches the bracket form) already refuses any page-level cap on them one case above. It read as
    // coverage of the module while checking only the diff, which is worse than not being there.
    //
    // So the module is enumerated from disk instead, and the survivors are pinned by name. It fails
    // when a NEW Payroll screen is born carrying the old cap, when a swept screen regresses to it, and
    // when one of the four documents below is widened without this list being updated to say so. It
    // also fails if the walk itself breaks, because the expected list is not empty.
    const carriers = PAYROLL_MODULE_ON_DISK.filter((f) => read(f).includes('mx-auto max-w-[100rem]'));
    expect(
      carriers,
      'the Payroll module carries the superseded cap somewhere other than the four printed documents',
    ).toEqual([...CAP_SURVIVORS]);
  });

  /**
   * 65e2d5de — THE CENSUS THAT WOULD HAVE CAUGHT THIS ROUND'S GAP, and the reason the case above did not.
   *
   * The `max-w-[100rem]` case greps for ONE literal. The three screens the 152fea7f sweep missed carried
   * `max-w-6xl` and `max-w-5xl`, so that grep walked straight past them for two releases, while `capsPage`
   * — which matches every `max-w-*xl` and the bracket form — was applied only to the ENUMERATED list of
   * files each round had already edited. A guard whose input is the diff cannot see the screens nobody
   * thought about. So this one applies `capsPage` to the module READ FROM DISK and pins the exceptions.
   *
   * WHAT THE LIST BELOW IS, honestly: a snapshot of every Payroll file that caps its container TODAY, not
   * a claim that each was individually approved to. Three categories are genuinely settled — the four
   * printed documents (CAP_SURVIVORS), the single-record forms of section C, and the statutory
   * CONFIGURATION pages, which are one-record settings forms of the same kind. The rest are simply
   * untouched by any width round so far. The value of naming them is that adding a NEW capped Payroll
   * screen, or regressing a swept one, now fails here and has to be argued for in this list — which is
   * exactly the review the module's width has failed to get five times.
   */
  const CAPPED_BY_DESIGN = [
    // Printed statutory documents — see CAP_SURVIVORS.
    'app/payroll/borang-8a/preview/page.tsx',
    'app/payroll/borang-a/preview/page.tsx',
    'app/payroll/cp39/preview/page.tsx',
    'app/payroll/statutory-forms/[formId]/page.tsx',
    // r256 858a1128 — the per-form CRITERIA step STOOD HERE (`max-w-3xl`, "a prompt stretched across a 27"
    // monitor puts its label at one edge and its select at the other"). ⚠️ r402 (f3cf2444) moved it to
    // WIDENED_LATER on the reporter's request; the label-at-one-edge worry is answered by laying the boxes
    // out in a row of equal columns rather than one long line.
    // One-record previews and forms — section C's category.
    'app/payroll/cp22/[employmentId]/preview/page.tsx',
    'app/payroll/reports/ea/[employmentId]/page.tsx',
    'app/payroll/transactions/fixed/[id]/page.tsx',
    // 7ad37961's TP1 month page STOOD HERE for two rounds and is now in WIDENED_LATER instead — r210
    // withdrew the exception for that ONE page, on the reporter's request, and the reasoning is recorded
    // in NARROW_FORMS below. Its `[year]` sibling is a REDIRECT (47 lines, no layout, nothing to cap), so
    // it belongs in no list here either. Everything else on this list keeps its cap.
    'app/payroll/transactions/zakat/election/page.tsx',
    // Statutory Configuration — single-record settings forms, one agency each.
    'app/payroll/configuration/page.tsx',
    'app/payroll/configuration/eis/page.tsx',
    'app/payroll/configuration/epf/page.tsx',
    'app/payroll/configuration/hrdf/page.tsx',
    'app/payroll/configuration/pcb/page.tsx',
    'app/payroll/configuration/skbbk/page.tsx',
    'app/payroll/configuration/socso/page.tsx',
    // Narrow by nature: a task list, a wizard outcome, an upload form, a panel host, a detail read-out —
    // none of them a grid the reporter asked to widen. Untouched by any width round, and named so.
    'app/payroll/[batchId]/anomalies/page.tsx',
    'app/payroll/process/result/page.tsx',
    'app/payroll/history-import/page.tsx',
    'app/payroll/pcb-detail/page.tsx',
    // 6b4ca488 — the Statutory Explanation, capped for the SAME reason its PCB sibling above is and with
    // the same `mx-auto max-w-5xl`: it is one payslip's working read top to bottom, six short blocks of
    // label-and-figure rows, not a grid anybody reconciles sideways. Stretching that to a 27" monitor
    // puts a caption at one edge and its number at the other. Its Transaction View twin is NOT a second
    // exception — the tab renders the same component inside that screen's own pageWideCls container.
    'app/payroll/statutory-detail/page.tsx',
    'app/payroll/transactions/adjustments/page.tsx',
    'app/payroll/transactions/import-components/page.tsx',
    // Not a page at all: an INNER measure inside the transaction-view history tab.
    'app/payroll/transaction-view/history-table.tsx',
  ] as const;

  it('no Payroll file on disk caps its container except the ones named as deliberate', () => {
    const carriers = PAYROLL_MODULE_ON_DISK.filter((f) => classNameLiterals(read(f)).some(capsPage));
    expect(
      carriers,
      'a Payroll screen caps its page width without saying why — add it to CAPPED_BY_DESIGN with a reason, or move it to pageWideCls',
    ).toEqual([...CAPPED_BY_DESIGN].sort());
  });

  it('CAPPED_BY_DESIGN names only files that exist and really do cap — no permanent holes', () => {
    // Without this, a renamed or widened file would leave an entry that silently excuses nothing, and the
    // list would rot into a set of names rather than a set of decisions.
    for (const f of CAPPED_BY_DESIGN) {
      expect(fs.existsSync(path.join(ROOT, f)), `${f} is listed as capped but no longer exists`).toBe(true);
      expect(classNameLiterals(read(f)).some(capsPage), `${f} no longer caps — drop it from the list`).toBe(true);
    }
  });

  it('pageWideCls is still the full-width container and not quietly re-capped at source', () => {
    // If someone "standardises" by editing components/ui.tsx instead, every assertion above stays green
    // while every screen in the product narrows at once. Cheap to pin; catastrophic to miss.
    expect(pageWideCls).toBe('w-full space-y-6');
  });
});

// ─────────────────── B. Individual Payslip prints at a page width ───────────────────

describe('152fea7f · B — widening the SCREEN did not widen the PRINTOUT', () => {
  const PAYSLIP = 'app/payroll/individual-payslip/page.tsx';

  it('keeps its print cap, and keeps it CENTRED', () => {
    // `print:max-w-4xl` was carried alongside `mx-auto`, and inherited the centring from it. pageWideCls
    // has no `mx-auto`, so dropping the cap's other half would have left a printed payslip hard against
    // the left edge of the sheet — a change nobody asked for, on the one Payroll artefact that leaves
    // the building. Both halves are pinned because only the pair reproduces the old print layout.
    const src = read(PAYSLIP);
    expect(src, 'the printed payslip keeps its reading measure').toContain('print:max-w-4xl');
    expect(src, 'the printed payslip stays centred on the sheet').toContain('print:mx-auto');
  });
});

// ─────────────────── C. single-record forms stay at a reading width ───────────────────

/**
 * The approved scope, written as an assertion. These are one-record forms and one-record documents
 * reached FROM the widened screens, not screens of their own — a 1920px-wide two-field form is worse
 * to use, not better.
 *
 * ── THE ONE EXIT FROM THIS LIST, AND WHAT IT DOES NOT LICENCE (r210, 7ad37961) ──────────────────────
 * The Edit TP1 Relief page (`transactions/tp1/[year]/[month]`) was listed here from r209 and has moved to
 * WIDENED_LATER. The rule above is NOT being softened; the page turned out not to be an instance of it.
 * "A single record" was doing the work of "a handful of fields", and that is true of a fixed-transaction
 * row or a zakat election. The TP1 record is the seventeen numbered items of the official LHDN Section C,
 * most with lettered sub-lines, each carrying a limit, an accumulated and a remaining figure — inside a
 * 48rem column that can only be ONE very tall list, which is what the reporter came back about.
 * So the test of this list is the SHAPE OF THE RECORD, not its cardinality: a form whose fields fit a
 * reading column belongs here; a form that is really a table of items does not. Everything else on the
 * list is still the first kind, and widening one of them still needs its own argument here.
 *
 * ── THE SECOND EXIT, AND ITS ARGUMENT (r254, 711adcd2) ──────────────────────────────────────────────
 * `app/admin/pay-components/component-form.tsx` was on this list and has moved to WIDENED_LATER. This is
 * NOT the rule being softened for a second time; it is the same test applied to a record that changed
 * shape, and the reporter is the one who changed it. 711adcd2 splits the Pay Item into FOUR titled
 * sections they drew themselves — General Information, Ordinary Rate of Pay, Calculation, Statutory
 * Configuration — and the approved plan asks in as many words for "a full-width layout with the sections
 * you drew", with Back top-left and Cancel/Save bottom-right. A four-section screen carrying two
 * independent ORP tick boxes and the whole statutory panel is no longer "a handful of fields in a
 * reading column"; inside a 48rem cap it is one very tall list, which is exactly the complaint that moved
 * the TP1 page out.
 *
 * ⚠️ AND THIS CASE IS UPDATED RATHER THAN DELETED, DELIBERATELY. The guard pinned a decision the reporter
 * has now reversed for ONE screen, and the other five entries below still hold — a fixed-transaction row,
 * a zakat election, an EA document, and the two loan forms are all still the first kind. Deleting the
 * case to make a red gate green would have retired the rule for all six.
 */
const NARROW_FORMS = [
  'app/payroll/transactions/fixed/[id]/page.tsx',
  'app/payroll/transactions/zakat/election/page.tsx',
  'app/payroll/reports/ea/[employmentId]/page.tsx',
  'app/admin/loans/new/page.tsx',
  'app/admin/loans/[id]/page.tsx',
] as const;

describe('152fea7f · C — the single-record forms were deliberately NOT swept in', () => {
  it.each(NARROW_FORMS)('%s keeps its reading-width cap', (file) => {
    const capped = classNameLiterals(read(file)).filter(capsPage);
    expect(
      capped.length,
      `${file} is a single-record FORM and the reporter approved keeping it at a comfortable width`,
    ).toBeGreaterThan(0);
  });
});

// ─────────────────── D. the employee panel survived the widening ───────────────────

/** Every Payroll screen with an employee list; `individual` mounts it inside its workspace island. */
const PANEL_SCREENS = [
  'app/payroll/transaction-view/page.tsx',
  'app/payroll/individual-payslip/page.tsx',
  'app/payroll/transactions/fixed/page.tsx',
  'app/payroll/transactions/individual/txn-workspace.tsx',
  'app/payroll/transactions/tp1/page.tsx',
  'app/payroll/transactions/zakat/page.tsx',
  'app/admin/loans/page.tsx',
] as const;

describe('152fea7f · D — full width was NOT bought by removing the employee list', () => {
  it.each(PANEL_SCREENS)('%s still mounts the collapsible employee panel', (file) => {
    expect(read(file), `${file} lost the panel the reporter explicitly asked to keep`).toContain(
      '<CollapsibleEmployeePanel',
    );
  });

  it('the shell still collapses to ONE column with no left cell — that is what full width buys', () => {
    // The mechanism that makes the reporter's "Employee List Hidden ⇒ detail occupies the new width"
    // sketch true. It is the panel's own behaviour, unchanged by this round; asserted here so that the
    // width promise and the thing that delivers it fail together rather than one at a time.
    const shell = read('components/collapsible-employee-panel.tsx');
    expect(shell).toContain('lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]');
    expect(shell).toContain('lg:grid-cols-1');
    expect(shell).toContain('{open && <div className="min-w-0">{panel}</div>}');
    // …and the shell itself carries no width of its own, which is WHY widening the page reaches it.
    expect(classNameLiterals(shell).filter(capsPage)).toEqual([]);
  });
});
