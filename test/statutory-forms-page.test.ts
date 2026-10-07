/**
 * Payroll → Statutory Forms: the shelf (6babf4f6), on top of the home it got at 956cec85.
 *
 * WHAT 956cec85 ESTABLISHED, AND STILL HOLDS. The forms were ALREADY BUILT — localization/my/reports.ts
 * registers EPF (KWSP), SOCSO + EIS (PERKESO), CP39/PCB (LHDN) and Form E/CP8D, each already listing
 * employee name, IC, agency number, gross, the employee/employer split and totals, and already flagging
 * employees MISSING an agency number rather than quietly leaving them off a submission. What did not
 * exist was a home for them, and the landing page is that home. It still GENERATES NOTHING.
 *
 * WHAT 6babf4f6 ADDS, AND WHY THESE ASSERTIONS. The request asks for a category-based redesign on the
 * premise that "the current module contains the required functionality". IT DOES NOT: the pack holds
 * five reports plus the per-employee EA and the CP22/CP22A worklist, and Borang BBCB, PERKESO 8B, SIP 2
 * / 2A, TP3, PCB 2(II), CP21, CP39A and every Other-Statutory report on the reporter's list were never
 * built. So the shelves are driven off the CATALOG.
 *
 * WHAT 587ee719 CHANGES, AND WHY THE LAST DESCRIBE BLOCK WAS REWRITTEN. 6babf4f6 drew the unbuilt forms
 * NOWHERE, and the block below used to pin that absence. Nine days of using it showed the cost: an
 * operator opening EPF (KWSP) looking for Borang A saw one unrelated row and could not tell "not built"
 * from "wrong screen". They are now NAMED, with a status and no action. The pin that matters has moved
 * rather than gone away, and it is stronger: the guarantee is no longer "these strings appear nowhere",
 * it is "no unbuilt form can render an action, and no unbuilt form's NAME can end up on a button that
 * produces something else". That is the "Borang A button emits the EPF spreadsheet" failure, and it is
 * pinned four ways in `the four pins` below.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MY_PLANNED_FORMS, MY_REPORTS, MY_STATUTORY_LINKS } from '../localization/my/reports';
import { myPack } from '../localization/my';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { payrollPack } from '../packs/payroll';
import { PAYROLL_NAV_PHASE } from '../packs/payroll/phases';
import { yearOptions } from '../lib/hr-date';
// r256 — the ONE rule that decides what a form's criteria step asks for, read here so this file's TP1
// case can state the answer rather than grep for the substitution that used to produce it.
import { parseDestination } from '../app/payroll/statutory-forms/criteria';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * Source with its PROSE removed, for the assertions that say "this file must not mention X".
 *
 * These files document exactly what they refuse to do — the landing page's header names Borang BBCB,
 * PERKESO 8B, SIP 2 / 2A, TP3, PCB 2(II), CP21 and CP39A precisely to record that they were never
 * built, and the Reports page explains where `complianceWorklist` went. Scanning the raw text would
 * make an honest comment fail the test that the comment exists to reinforce, and the fix would be to
 * delete the explanation. So the absence checks read CODE: block comments are stripped, which covers
 * JSDoc and braced JSX comments alike, and only WHOLE-LINE double-slash comments go, so a URL inside a
 * string survives.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const PAGE = code('app/payroll/statutory-forms/page.tsx');
const FORM_PAGE = code('app/payroll/statutory-forms/[formId]/page.tsx');
const EXPORT_ROUTE = code('app/payroll/statutory-forms/[formId]/export/route.ts');
const REPORTS_PAGE = code('app/payroll/reports/page.tsx');
const byId = new Map(MY_REPORTS.map((r) => [r.id, r]));

describe('the pack declares where each form is filed, and by when', () => {
  // Sourced from the reporter's own answer (block_trail, resolved 2026-07-30), not invented. This test
  // is what stops a later edit "tidying" a portal name into something nobody actually submits through.
  // `body` joined the tuple at 6babf4f6: it is the SHELF, and it is a key rather than the free-text
  // agency precisely so a tidied label cannot silently split a section in two.
  it.each([
    ['my.epf', 'epf', 'EPF (KWSP)', 'i-Akaun (Employer)', 15],
    ['my.socso-eis', 'perkeso', 'PERKESO', 'PERKESO ASSIST', 15],
    ['my.cp39', 'lhdn', 'LHDN', 'e-PCB / e-Data PCB / e-CP39', 15],
  ])('%s sits on the %s shelf, files to %s via %s by day %i of the following month', (id, body, agency, channel, day) => {
    const sub = byId.get(id as string)?.submission;
    expect(sub?.body).toBe(body);
    expect(sub?.agency).toBe(agency);
    expect(sub?.channel).toBe(channel);
    expect(sub?.dueDayOfNextMonth).toBe(day);
  });

  // An invented statutory deadline is worse than an absent one: somebody files against it.
  it('leaves the annual Form E deadline unset, because it was never stated', () => {
    expect(byId.get('my.cp8d')?.submission?.dueDayOfNextMonth).toBeNull();
    expect(byId.get('my.cp8d')?.submission?.agency).toBe('LHDN');
    expect(byId.get('my.cp8d')?.submission?.body).toBe('lhdn');
  });

  // The overview reconciles; it is not filed anywhere. Absence of `submission` is how the screen knows.
  it('marks the contributions overview as NOT a submission', () => {
    expect(byId.get('my.contributions')?.submission).toBeUndefined();
  });

  /**
   * SOCSO and EIS go up TOGETHER through ASSIST. One shelf, because it is one filing — splitting them
   * would put half a submission under each heading and imply two deadlines.
   *
   * 8ca344bf: THE PERKESO SHELF NOW HOLDS TWO REPORTS, AND THE CLAIM ABOVE IS UNCHANGED. This used to
   * assert the shelf held exactly `my.socso-eis`, which conflated two different things — "SOCSO and EIS
   * are one filing" (still true, and pinned below) and "PERKESO has exactly one form" (never the claim,
   * and no longer the fact). Borang 8A is a DIFFERENT DOCUMENT on the same shelf, not a second half of
   * the combined return, so the half of this test that was still true is what is kept.
   */
  it('keeps SOCSO and EIS on ONE combined return, which is still the only combined one', () => {
    const perkeso = MY_REPORTS.filter((r) => r.submission?.body === 'perkeso');
    expect(perkeso.map((r) => r.id).sort()).toEqual(['my.borang-8a', 'my.socso-eis']);
    // The combined SOCSO+EIS return has not been split, and nothing else claims to be one.
    const combined = perkeso.filter((r) => r.label.includes('EIS'));
    expect(combined.map((r) => r.id)).toEqual(['my.socso-eis']);
    // Borang 8A carries no EIS and is not offered as the combined return under another name.
    expect(MY_REPORTS.find((r) => r.id === 'my.borang-8a')!.label).not.toContain('EIS');
  });

  /**
   * 8ca344bf — BORANG 8A'S DEADLINE IS NOT `dueDayOfNextMonth`, AND THE NULL IS DELIBERATE.
   *
   * `submissionDueFor` models "day N of the month AFTER the period" and nothing else. This form's deadline
   * is the LAST DAY OF THE CONTRIBUTION MONTH ITSELF, two weeks earlier than the ASSIST 15th. Writing 15
   * here to make the shelf card show something would print the wrong statutory date on a screen an
   * operator files against — the exact failure the Form E null exists to prevent. The real deadline is
   * computed by `paymentDueDateFor` and printed ON THE FORM, which is where the specimen carries it.
   */
  it('leaves Borang 8A’s deadline unset here, because its rule is not the one this field models', () => {
    const b8a = byId.get('my.borang-8a')!;
    expect(b8a.submission?.body).toBe('perkeso');
    expect(b8a.submission?.agency).toBe('PERKESO');
    expect(b8a.submission?.dueDayOfNextMonth).toBeNull();
    // …and the SOCSO+EIS listing beside it keeps the ASSIST deadline it always had.
    expect(byId.get('my.socso-eis')!.submission?.dueDayOfNextMonth).toBe(15);
  });
});

describe('the shelves come from the catalog, so a new form needs no screen change', () => {
  it('every submission declares a body, so none can land on no shelf at all', () => {
    const orphans = MY_REPORTS.filter((r) => r.submission && !r.submission.body);
    expect(orphans.map((r) => r.id)).toEqual([]);
  });

  it('the page renders each shelf from submission.body, not from a hardcoded form list', () => {
    expect(PAGE).toContain("r.submission!.body === body");
    // The tell-tale of a page that names its own forms: an id literal in the shelf markup.
    for (const id of MY_REPORTS.map((r) => r.id)) {
      expect(PAGE, `the landing page should not name ${id}`).not.toContain(`'${id}'`);
    }
  });

  /**
   * The exhaustiveness guard. A `Record<StatutoryBodyKey, …>` is what makes adding a body to the union
   * a COMPILE error here rather than a shelf that silently renders nothing — an array of strings would
   * type-check happily while the new authority's forms vanished from the page.
   */
  it('orders the shelves through a Record keyed by the union, so a new body cannot be forgotten', () => {
    expect(PAGE).toMatch(/Record<StatutoryBodyKey, true>/);
    expect(PAGE).toContain('Object.keys(BODY_SHELVES)');
  });

  it('carries the non-generatable entries as catalog data rather than hardcoded rows', () => {
    expect(myPack.statutoryLinks).toBe(MY_STATUTORY_LINKS);
    // 587ee719 — the EA split in two (a language apiece) and Borang E joined as an ALIAS onto the CP8D
    // generator. Still DOORS and still no second generator behind any of them.
    //
    // r224 — `my.tp1` JOINED THEM, and it is the first entry here that arrived from MY_PLANNED_FORMS
    // rather than being born a link. It is a door for the same reason the two EA rows are: a TP1 is one
    // person's declaration for one deduction month, so there is no company-wide table for a ReportDef to
    // generate. The count is asserted as the list rather than as a number, which is what lets this line
    // fail loudly when an entry appears or leaves.
    // 72b100cd (r323) — `my.pcb2ii.en` / `my.pcb2ii.ms` JOINED this list, from MY_PLANNED_FORMS. They are
    // doors for the same reason the two EA rows are: PCB 2(II) is one person's statement for a year, so
    // there is no company-wide table for a ReportDef to generate.
    // df35d60d — `my.tp3` JOINED this list, from MY_PLANNED_FORMS, and it is a door for the SAME reason
    // `my.tp1` is: a TP3 is one person's record of their own previous employment for one assessment
    // year, so there is no company-wide table for a ReportDef to generate.
    // ⚠️ r402 (item f3cf2444) — THE PAIRS BECAME ONE ENTRY EACH. `my.ea.en`/`my.ea.ms` are `my.ea` and
    // `my.pcb2ii.en`/`my.pcb2ii.ms` are `my.pcb2ii`, each with a Version choice; the former ids redirect.
    expect(MY_STATUTORY_LINKS.map((l) => l.id).sort()).toEqual([
      'my.borang-e',
      'my.cp22',
      'my.ea',
      'my.pcb2ii',
      'my.tp1',
      'my.tp3',
    ]);
    for (const l of MY_STATUTORY_LINKS) {
      expect(l.body, `${l.id} needs a shelf`).toBeTruthy();
      expect(l.href, `${l.id} needs a target`).toMatch(/^\/payroll\//);
    }
    // The EA row used to be written into the page's JSX. It must not be again.
    expect(PAGE).not.toContain('eaFormLabel');
  });

  // 587ee719 — the planned forms travel the same way: through the pack contract, as data, so the screen
  // still names no form. If this ever became a literal list inside page.tsx the whole design is gone.
  it('carries the UNBUILT forms as catalog data too, on the reporter’s own shelves', () => {
    expect(myPack.plannedForms).toBe(MY_PLANNED_FORMS);
    // 8ca344bf — `perkeso.borang-8a` LEFT this list because it was BUILT, and joined MY_REPORTS at the
    // same shelfOrder 2 it held here. That migration is what `PlannedFormDef`'s doc-comment describes, and
    // this list shrinking by exactly one entry is what proves it happened rather than being duplicated.
    //
    // 9c8dad7a — `epf.borang-a` LEFT IT THE SAME WAY one round later, to MY_REPORTS at its own shelfOrder
    // 2 on the epf shelf. TWO forms have now made that journey, which is what turns the migration path
    // from a claim in a doc-comment into a thing the catalog demonstrably supports.
    //
    // r224 — `lhdn.tp1` IS THE THIRD, AND THE FIRST TO LAND IN MY_STATUTORY_LINKS RATHER THAN MY_REPORTS.
    // That is the half of the migration path the two Borangs could not demonstrate: a built form joins
    // whichever collection matches its SHAPE — a company-wide table becomes a ReportDef, a per-person
    // document becomes a link — and either way it leaves this list, keeps its shelfOrder, and the screen
    // is not touched. It is pinned by name below, so deleting an entry from here without building it
    // cannot pass as this same migration.
    // df35d60d — `lhdn.tp3` LEFT, the fifth form to take this path. It is pinned by name in the case
    // below, so deleting an entry from here without building it cannot pass as this same migration.
    expect(MY_PLANNED_FORMS.map((p) => p.id)).toEqual([
      'epf.borang-bbcb',
      'perkeso.borang-8b',
      'perkeso.sip',
      'perkeso.employee-registration',
      'lhdn.cp21',
      'lhdn.cp22a',
      'lhdn.cp39a',
    ]);
    for (const p of MY_PLANNED_FORMS) {
      expect(PAGE, `the landing page should not name ${p.id}`).not.toContain(`'${p.id}'`);
    }
    // Nothing was quietly parked on the Other shelf to avoid choosing one.
    expect(MY_PLANNED_FORMS.filter((p) => p.body === 'other')).toEqual([]);
  });

  /**
   * 587ee719 — the shelf is assembled from THREE collections, so the reporter's order can only survive
   * if each entry declares its own rank. A duplicate rank inside one shelf is a coin toss between two
   * cards, which is exactly the kind of thing that looks fine locally and reorders in production.
   */
  it('gives every entry on a shelf a distinct position, so the reporter’s order is reproducible', () => {
    const byShelf = new Map<string, { id: string; order: number | undefined }[]>();
    const add = (body: string, id: string, order: number | undefined) => {
      if (!byShelf.has(body)) byShelf.set(body, []);
      byShelf.get(body)!.push({ id, order });
    };
    for (const r of MY_REPORTS) if (r.submission) add(r.submission.body, r.id, r.shelfOrder);
    for (const l of MY_STATUTORY_LINKS) add(l.body, l.id, l.shelfOrder);
    for (const p of MY_PLANNED_FORMS) add(p.body, p.id, p.shelfOrder);
    for (const [body, entries] of byShelf) {
      const orders = entries.map((e) => e.order);
      expect(orders.filter((o) => o === undefined), `${body}: every entry needs a shelfOrder`).toEqual([]);
      expect(new Set(orders).size, `${body}: duplicate shelfOrder in ${JSON.stringify(entries)}`).toBe(
        entries.length,
      );
    }
    // The reporter listed thirteen Income Tax forms, counting the EA and PCB 2(II) once per language.
    // ⚠️ r402 (item f3cf2444) — at the same reporter's request those two pairs are ONE card each, with the
    // language as a Version choice, so the LHDN shelf holds eleven cards for the same thirteen documents.
    expect(byShelf.get('lhdn')!.length).toBe(11);
    expect(byShelf.get('lhdn')!.map((e) => e.id)).toEqual(expect.arrayContaining(['my.ea', 'my.pcb2ii']));
  });

  it('resolves every label the catalog names against en.json', () => {
    const ns = en.payroll.statutoryForms as Record<string, string>;
    for (const l of MY_STATUTORY_LINKS) {
      expect(ns[l.labelKey], `${l.id} labelKey ${l.labelKey}`).toBeTruthy();
      expect(ns[l.hintKey], `${l.id} hintKey ${l.hintKey}`).toBeTruthy();
      if (l.descriptionKey) expect(ns[l.descriptionKey], `${l.id} descriptionKey`).toBeTruthy();
      // r220 — THE SECOND AND THIRD ACTIONS RESOLVE THEIR WORDS THROUGH A CAST LOOKUP on this screen
      // (`t(labelKey as 'link_cp22_blank')`), so tsc checks nothing about them and a key that is not in
      // the namespace throws MISSING_MESSAGE at RENDER time while the route still answers 200 (AGENTS 6).
      // The individual r220 cases below pin the key NAMES the EA and CP22 rows declare; this is the only
      // guard that says those names resolve, and it covers any row that grows an extra action later.
      for (const [field, key] of [
        ['secondaryLabelKey', l.secondaryLabelKey],
        ['secondaryTitleKey', l.secondaryTitleKey],
        ['tertiaryLabelKey', l.tertiaryLabelKey],
        ['tertiaryTitleKey', l.tertiaryTitleKey],
      ] as const) {
        if (key) expect(ns[key], `${l.id} ${field} ${key}`).toBeTruthy();
      }
    }
    for (const p of MY_PLANNED_FORMS) {
      expect(ns[p.labelKey], `${p.id} labelKey ${p.labelKey}`).toBeTruthy();
      expect(ns[p.hintKey], `${p.id} hintKey ${p.hintKey}`).toBeTruthy();
    }
    for (const r of MY_REPORTS) {
      if (r.descriptionKey) expect(ns[r.descriptionKey], `${r.id} descriptionKey`).toBeTruthy();
    }
    // Dynamic keys the shelves resolve — invisible to test/i18n-coverage.test.ts check C.
    for (const k of ['body_epf', 'body_perkeso', 'body_lhdn', 'body_other']) {
      expect(ns[k], k).toBeTruthy();
      expect(ns[`${k}_hint`], `${k}_hint`).toBeTruthy();
    }
    for (const k of ['cadence_monthly', 'cadence_annual', 'cadence_event']) expect(ns[k], k).toBeTruthy();
    for (const k of ['status_overdue', 'status_due_soon', 'status_upcoming', 'status_unknown']) {
      expect(ns[k], k).toBeTruthy();
    }
    // 587ee719 — the status chips, the legend beside them and the output chips. All resolved through
    // lookup maps, so check C cannot see any of them and this is the only guard they have.
    for (const st of ['official', 'agency_layout', 'figures', 'draft_file', 'planned']) {
      expect(ns[`fidelity_${st}`], `fidelity_${st}`).toBeTruthy();
      expect(ns[`fidelity_${st}_hint`], `fidelity_${st}_hint`).toBeTruthy();
    }
    for (const o of ['pdf', 'xlsx', 'csv', 'print', 'file']) expect(ns[`output_${o}`], `output_${o}`).toBeTruthy();
    // r256 — `chipMonth` / `chipYear` LEFT THIS LIST BECAUSE THEY LEFT THE PRODUCT. They rendered a
    // CONCRETE period on each card ("Month · August 2026"), which the directory no longer has: it lists
    // forms with no period chosen, so a card now carries its cadence and the period is asked for on the
    // form's own criteria step. `dueByShort` went the same way, with the computed deadline it printed.
    // The keys are deleted in all six locales rather than left behind as strings nothing renders.
    for (const k of ['legendTitle', 'noAction', 'shelfReady', 'search', 'searchPlaceholder', 'searchNoMatch', 'searchClear', 'openEmployeeList']) {
      expect(ns[k], k).toBeTruthy();
    }
  });

  /**
   * A message carrying `{placeholders}` rendered through a plain `t('…')` with no arguments throws
   * FORMATTING_ERROR at RENDER time and paints the raw key path on screen — while the route still
   * answers 200 and every static guard stays green. So: only the three keys this screen interpolates
   * may contain braces, and each is called with arguments.
   */
  it('keeps braces out of every key the cards render without arguments', () => {
    const ns = en.payroll.statutoryForms as Record<string, string>;
    const INTERPOLATED = new Set(['shelfReady']);
    const rendered = [
      ...MY_STATUTORY_LINKS.flatMap((l) => [l.labelKey, l.hintKey, l.descriptionKey]),
      // r220 — the extra actions' words and tooltips are rendered with no arguments too.
      ...MY_STATUTORY_LINKS.flatMap((l) => [l.secondaryLabelKey, l.secondaryTitleKey, l.tertiaryLabelKey, l.tertiaryTitleKey]),
      ...MY_PLANNED_FORMS.flatMap((p) => [p.labelKey, p.hintKey]),
      ...MY_REPORTS.map((r) => r.descriptionKey),
      ...['official', 'agency_layout', 'figures', 'draft_file', 'planned'].flatMap((s) => [`fidelity_${s}`, `fidelity_${s}_hint`]),
      ...['pdf', 'xlsx', 'csv', 'print', 'file'].map((o) => `output_${o}`),
      'legendTitle',
      'noAction',
      'searchNoMatch',
    ].filter((k): k is string => Boolean(k) && !INTERPOLATED.has(k as string));
    const braced = rendered.filter((k) => /[{}]/.test(ns[k] ?? ''));
    expect(braced, `these are rendered with no arguments and must not contain {placeholders}`).toEqual([]);
    for (const k of INTERPOLATED) expect(ns[k], k).toMatch(/\{/);
  });
});

describe('the landing page is a directory, not a second generator', () => {
  it('renders only pack entries that are submissions', () => {
    // r256 UPDATED THE EXPRESSION, NOT THE RULE. The filter is unchanged — an entry without `submission`
    // is the internal contributions overview, not a form anybody files — but its source moved: the
    // directory no longer takes a companyId, so it reads `listStatutoryCatalog` (the admin's whole company
    // scope, deduplicated by form id) instead of `listReports` for one chosen company.
    expect(PAGE).toContain('catalog.reports.filter((r) => r.submission != null)');
  });

  it('does not generate anything itself', () => {
    // The tell-tales of a second implementation. None of these belong on a directory page — writing a
    // second generator for figures the pack already produces is the duplication 241817ef spent two
    // rounds undoing. The PER-FORM page legitimately calls reportPreview; this one must not.
    for (const forbidden of ['reportPreview(', 'recordReport(', 'generate(', 'payslip']) {
      expect(PAGE, `the landing page should not itself ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('links each form to its own generation screen, not to the general Reports page', () => {
    /**
     * r256 UPDATED WHERE THE PATH IS BUILT, NOT WHERE IT GOES. Each form still ends on its own
     * `[formId]` screen and never on Reports — but the directory has no company, year or month to put in
     * that link, so the card now opens the form's CRITERIA STEP and the step's GET form posts to the
     * report path. Both halves are asserted, in the two files that own them: a card that linked straight
     * to `[formId]` with nothing chosen would just bounce back to the step it skipped.
     */
    expect(PAGE).toContain('criteriaHref(r.id)');
    expect(read('app/payroll/statutory-forms/criteria.ts')).toContain(
      '/payroll/statutory-forms/${encodeURIComponent(reportId)}',
    );
    // The bounce the 6babf4f6 redesign removed: "Open form" used to land on Reports beside a dropdown of
    // every other report, a warning banner and a generation history.
    expect(PAGE).not.toContain('/payroll/reports?companyId=');
  });

  it('reads "today" in MYT, so a deadline does not flip a day early overnight', () => {
    expect(PAGE).toContain('todayInKualaLumpur()');
    expect(PAGE).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  });

  it('uses the full screen width the reporter asked for', () => {
    // 152fea7f UPDATED THIS CASE rather than deleting it. The requirement is unchanged — this screen must
    // use the width the reporter asked for — but the MEANS changed: the module-wide standard is now
    // `pageWideCls` ('w-full space-y-6'), which is WIDER than the `mx-auto max-w-[100rem]` cap this line
    // used to pin. Asserting the old cap here would fail the very screen it was written to protect.
    expect(PAGE).toContain('pageWideCls');
    expect(PAGE).not.toContain('mx-auto max-w-[100rem]');
  });

  /**
   * A redesign that swaps one query parameter for two turns every existing link — the nav, a bookmark,
   * the CP22 shelf entry — into the default month, silently. `periodKey` stays accepted.
   */
  it('still resolves the old periodKey parameter after the split into year + month', () => {
    expect(PAGE).toContain('sp.periodKey');
    expect(PAGE).toMatch(/name="year"/);
    expect(PAGE).toMatch(/name="month"/);
  });

  /**
   * The year picker, and the defect it exists to prevent: a `<select>` whose `defaultValue` matches no
   * `<option>` silently falls back to its FIRST option. A link carrying an out-of-window year resolves
   * correctly server-side, so the page would show the right figures under the WRONG year label — the
   * worst kind of wrong for a statutory return, because nothing looks broken.
   */
  it('always offers the selected year, however far back the link reaches', () => {
    expect(yearOptions('2026-08-07')).toEqual(['2026', '2025', '2024', '2023', '2022', '2021', '2020']);
    expect(yearOptions('2026-08-07', '2026')[0]).toBe('2026');
    const old = yearOptions('2026-08-07', '2015');
    expect(old).toContain('2015');
    expect(old[old.length - 1]).toBe('2015'); // newest first, like every other year picker here
    // A junk value is NOT injected into the list — the page falls back to a real year for those.
    expect(yearOptions('2026-08-07', 'abcd')).not.toContain('abcd');
    expect(PAGE).toContain('yearOptions(today, year)');
    expect(FORM_PAGE).toContain('yearOptions(today, year)');
  });
});

describe('the per-form generation screen', () => {
  it('is registered on the access matrix, or a guarded screen would be ungrantable', () => {
    expect(REGISTERED_ROUTES.has('/payroll/statutory-forms/[formId]')).toBe(true);
  });

  it('calls the SHARED generator rather than a second copy of the statutory arithmetic', () => {
    expect(FORM_PAGE).toContain('reportPreview(s, {');
    expect(FORM_PAGE).toContain("from '@/core/reporting'");
  });

  // formId comes off the URL. Resolving it against THIS COMPANY's reports is what stops another
  // jurisdiction's report id rendering an empty table under its name.
  it('404s an id the acting company’s jurisdiction does not register', () => {
    expect(FORM_PAGE).toContain('const def = reports.find((r) => r.id === formId)');
    expect(FORM_PAGE).toContain('if (!def) notFound()');
  });

  // A file generated while somebody is missing a tax or SOCSO number is a submission that omits them.
  it('gates the agency upload files on readiness, exactly as Reports does', () => {
    expect(FORM_PAGE).toContain('const ready = result.readiness.length === 0');
    expect(FORM_PAGE).toContain("formId === 'my.cp39' && ready");
    expect(FORM_PAGE).toContain("formId === 'my.socso-eis' && ready");
  });

  it('offers the same output row on every form, and keeps the audit trail', () => {
    for (const fmt of ["exportHref('pdf')", "exportHref('xlsx')", "exportHref('csv')"]) {
      expect(FORM_PAGE).toContain(fmt);
    }
    expect(FORM_PAGE).toContain('<PrintButton />');
    expect(FORM_PAGE).toContain('recordReportAction');
  });

  /**
   * An annual form is filed for a YEAR. Showing it a month filter invites somebody to believe the
   * figures are August's when they are the whole year's — and the period is what gets recorded.
   */
  it('drops the month filter for an annual form', () => {
    expect(FORM_PAGE).toContain('const periodKey = annual ? year : `${year}-${month}`');
    expect(FORM_PAGE).toContain('{!annual && (');
  });

  /**
   * 587ee719 — the banner restates the STATUS the shelf card carried, and nothing else. The request
   * asked for generation to be blocked on missing statutory numbers; that is deliberately not built (it
   * needs each form's own required-field list), so this banner must never imply it has been. The
   * readiness machinery it must NOT have absorbed is asserted alongside, unchanged.
   */
  it('restates the form’s status without claiming it is validated or ready to file', () => {
    expect(FORM_PAGE).toContain('{def.fidelity && (');
    expect(FORM_PAGE).toContain('FIDELITY_HINT_KEY[def.fidelity]');
    const ns = en.payroll.statutoryForms as Record<string, string>;
    for (const st of ['official', 'agency_layout', 'figures', 'draft_file']) {
      expect(ns[`fidelity_${st}_hint`]).not.toMatch(/\bvalidated\b|ready to file|approved by/i);
    }
    // The readiness banner and the two gated agency files are untouched by this round.
    expect(FORM_PAGE).toContain('readinessTitle');
    expect(FORM_PAGE).toContain('const ready = result.readiness.length === 0');
  });

  // The EA language has to survive a re-Show, or picking a different month silently drops back to the
  // viewer's UI locale — the exact behaviour this round removed.
  it('carries an allowlisted EA language through the period form', () => {
    expect(FORM_PAGE).toContain("EA_LANGS = ['en', 'ms']");
    expect(FORM_PAGE).toContain('EA_LANGS.includes(sp.lang as EaLang)');
    expect(FORM_PAGE).toContain('<input type="hidden" name="lang" value={eaLang} />');
    expect(FORM_PAGE).toContain('eaLang={eaLang}');
  });
});

describe('the shelf cards, and the search above them (587ee719)', () => {
  /**
   * Server-side, on the same GET form as company/year/month — for the same reason the body pills are
   * links and not a client filter: the whole view stays in the address, so it survives a refresh and can
   * be sent to somebody. A `useState` filter here would quietly undo that.
   */
  it('filters on a search param rather than in the browser', () => {
    expect(PAGE).not.toContain("'use client'");
    expect(PAGE).not.toContain('useState');
    expect(PAGE).toContain('name="q"');
    expect(PAGE).toContain("const q = (sp.q ?? '').trim()");
    // …and the search rides through the body pills, or choosing a category would silently clear it.
    expect(PAGE).toContain('&q=${encodeURIComponent(q)}');
  });

  it('renders the four statuses in a legend, from the same map the chips use', () => {
    // 8ca344bf — `agency-layout` sits BETWEEN official and figures, and the order is the legend's meaning:
    // it is read as a ladder of how close a form is to the agency's own document.
    expect(PAGE).toContain(
      "STATUS_ORDER: FormStatus[] = ['official', 'agency-layout', 'figures', 'draft-file', 'planned']",
    );
    expect(PAGE).toContain("t('legendTitle')");
    expect(PAGE).toContain('FIDELITY_KEY[c.status]');
    expect(PAGE).toContain('FIDELITY_KEY[st]');
  });

  // The exhaustiveness guard from 6babf4f6 survives the rewrite: adding a body to the union must still
  // be a COMPILE error here rather than a shelf that silently renders nothing.
  it('keeps the Record-keyed shelf order through the card rewrite', () => {
    expect(PAGE).toMatch(/Record<StatutoryBodyKey, true>/);
    expect(PAGE).toContain('Object.keys(BODY_SHELVES)');
    expect(PAGE).toContain("t('shelfEmpty')");
    expect(PAGE).toContain("t('searchNoMatch')");
  });
});

describe('the export route', () => {
  // `isAdmin` is true for an hr_admin grant on ANY company, so it would let a guessed companyId export
  // another company's per-employee names, ICs, tax numbers and contributions.
  it('fails closed twice: admin AND scoped to the company', () => {
    expect(EXPORT_ROUTE).toContain('scopedAdmin()');
    expect(EXPORT_ROUTE).toContain('scopeIds.includes(companyId)');
    expect(EXPORT_ROUTE).not.toContain('isAdmin(');
  });

  // Same answer for a bad company and a bad form id, so the URL cannot enumerate either.
  it('answers 404 — never 403 — for an unscoped company or an unknown form', () => {
    const notFounds = EXPORT_ROUTE.match(/new Response\('Not found', \{ status: 404 \}\)/g) ?? [];
    expect(notFounds.length).toBe(2);
    expect(EXPORT_ROUTE).not.toContain('status: 403');
  });

  // A malformed period is not an empty submission: the generators read it as a literal batch key, so
  // "2026-13" would produce a plausible-looking empty return rather than an error.
  it('validates the period against the form’s own cadence', () => {
    expect(EXPORT_ROUTE).toContain("def.periodKind === 'year' ? /^\\d{4}$/.test(periodKey)");
  });

  it('serialises through the shared report-export module, not a hand-rolled writer', () => {
    expect(EXPORT_ROUTE).toContain("from '@/lib/report-export'");
    expect(EXPORT_ROUTE).toContain('serializeReport(data, format)');
  });

  // Downloading a spreadsheet is not filing. Only the deliberate "Record generation" click should
  // appear in the audit trail; the two Layer-B agency files keep their own recording routes.
  it('records no artefact, because a download is not a submission', () => {
    expect(EXPORT_ROUTE).not.toContain('recordReport');
    expect(EXPORT_ROUTE).not.toContain('recordFileReport');
  });
});

describe('the report table is shared, not copied', () => {
  const PANEL = code('components/statutory-report-panel.tsx');

  it('both screens render the same panel', () => {
    expect(REPORTS_PAGE).toContain('<StatutoryReportPanel');
    expect(FORM_PAGE).toContain('<StatutoryReportPanel');
  });

  // Two namespaces render it, so resolving words inside would make it a multi-namespace file — the
  // exact shape test/i18n-coverage.test.ts check C skips entirely.
  it('takes plain data and pre-translated captions, never a translator or a callback', () => {
    expect(PANEL).not.toContain('getTranslations');
    expect(PANEL).not.toContain('useTranslations');
    expect(PANEL).not.toContain("'use client'");
  });

  /**
   * The EA link used to be built from the raw periodKey, so a MONTHLY report sent `?year=2026-07`. The
   * EA page tests that against /^\d{4}$/ and falls back to the SERVER's current year — so in January
   * you opened December's EPF report and got this year's empty statement. The year of a month is its
   * first four characters.
   */
  it('links an employee name to the EA for a four-digit YEAR, never a YYYY-MM period', () => {
    expect(REPORTS_PAGE).toContain('eaYear={periodKey.slice(0, 4)}');
    expect(FORM_PAGE).toContain('eaYear={year}');
  });
});

describe('CP22 / CP22A live with the statutory forms now', () => {
  it('render on Statutory Forms, under an anchor the catalog entry points at', () => {
    expect(PAGE).toContain('complianceWorklist');
    expect(PAGE).toContain('id="worklist"');
    expect(MY_STATUTORY_LINKS.find((l) => l.id === 'my.cp22')?.href).toContain('#worklist');
  });

  it('are gone from Reports — but the page says where they went', () => {
    expect(REPORTS_PAGE).not.toContain('complianceWorklist');
    expect(REPORTS_PAGE).toContain('/payroll/statutory-forms#worklist');
  });

  /**
   * d3a9383c — the reminder finally hands you the DOCUMENT.
   *
   * The row used to say "Open form" and open no form: the href scrolls to the worklist further down this
   * same page. Both obvious fixes are wrong and are worth naming, because a later tidy-up will reach for
   * one of them. Rewording `link_cp22` changes the row TITLE ("CP22 / CP22A notices"), and rewording
   * `openForm` changes the action on EVERY row on the screen — the EA row above included. So the catalog
   * entry names its own action key, and every other row falls back to the shared label.
   */
  it('says "Open worklist" on the CP22 row only, without touching any other row’s wording', () => {
    const cp22 = MY_STATUTORY_LINKS.find((l) => l.id === 'my.cp22')!;
    expect(cp22.actionLabelKey).toBe('openWorklist');
    expect(en.payroll.statutoryForms.openWorklist).toBe('Open worklist');
    // 587ee719 — each entry still names its OWN action or falls back, which is the mechanism this test
    // exists to protect. "Open worklist" stays CP22's alone; Borang E declares none and renders the
    // shared label.
    //
    // r224 — `my.tp1` REUSES `openEmployeeList` RATHER THAN GROWING A KEY OF ITS OWN, because it is the
    // same act: its href opens a list of people, and the form belongs to one of them. A fourth wording
    // for the third screen that does this is how a shared label stops being shared.
    //
    // ⚠️ r242 (item b36a8a91) — THE TWO EA ROWS MOVED OFF `openEmployeeList`, AND THE CASE MOVES WITH THEM
    // RATHER THAN BEING DELETED (AGENTS 18). They used to be the evidence that a row names the screen its
    // href opens; the reporter then downloaded a blank EA believing it was the completed one, and the row
    // was why — the button named the list it passes THROUGH rather than the form it ends at. So they now
    // say `openForm`, the SHARED label they would have fallen back to, and the mechanism this case protects
    // is untouched: `openEmployeeList` is still `my.tp1`'s (where the list IS the destination), CP22 still
    // owns "Open worklist" alone, and rewording either still leaves the other alone.
    expect(
      MY_STATUTORY_LINKS.map((l) => [l.id, l.actionLabelKey ?? null]),
    ).toEqual([
      // r402 — one EA entry now (was `.en`/`.ms`); it still names `openForm`.
      ['my.ea', 'openForm'],
      // r323 — PCB 2(II) says "Open form" for the same reason the EA does: the button opens the employee
      // picker, and the DESTINATION is what it names. `openEmployeeList` stays TP1's, where the list IS
      // the destination; `openWorklist` stays CP22's alone. (One entry since r402.)
      ['my.pcb2ii', 'openForm'],
      ['my.borang-e', null],
      ['my.tp1', 'openEmployeeList'],
      // df35d60d — TP3 says "Open employee list" for the SAME reason TP1 does and the EA does not: its
      // href opens the screen where a person is chosen, and that screen IS the destination — the record
      // is edited and printed there, not on a further page.
      ['my.tp3', 'openEmployeeList'],
      ['my.cp22', 'openWorklist'],
    ]);
    // …and the shared key is REUSED rather than duplicated: no EA-only "Open form" wording of its own.
    expect(en.payroll.statutoryForms.openEmployeeList).toBe('Open employee list');
    expect(Object.keys(en.payroll.statutoryForms).filter((k) => /^openForm/.test(k))).toEqual(['openForm']);
    expect(PAGE).toContain("t((l.actionLabelKey ?? 'openForm')");
    // The row title is untouched — the fix that was NOT applied.
    expect(en.payroll.statutoryForms.link_cp22).toBe('CP22 / CP22A notices');
    expect(en.payroll.statutoryForms.openForm).toBe('Open form');
  });

  it('offers the blank fillable copy from the shelf row, driven by the catalog and not by this screen', () => {
    const cp22 = MY_STATUTORY_LINKS.find((l) => l.id === 'my.cp22')!;
    expect(cp22.secondaryHref).toBe('/payroll/cp22/blank');
    expect(cp22.secondaryLabelKey).toBe('link_cp22_blank');
    expect(en.payroll.statutoryForms.link_cp22_blank).toBe('Download blank CP22');
    expect(PAGE).toContain('l.secondaryHref');
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/cp22/blank/route.ts'))).toBe(true);
    // The CP22 row's tooltip stays in `payroll.cp22`, beside the form it describes, and the row declares
    // no title key of its own — so r220's `secondaryTitleKey` left this row byte-identical.
    expect(cp22.secondaryTitleKey).toBeUndefined();
    expect(PAGE).toContain("tCp22('blankTitle')");
    // r220 gave the EA rows one too; ⚠️ r402 (item f3cf2444) TOOK IT AWAY again at the reporter's request,
    // so the sweep is back to its original shape: the CP22 row is the ONLY row with a second action, and
    // the merged EA entry is swept with every other row.
    for (const l of MY_STATUTORY_LINKS.filter((x) => x.id !== 'my.cp22')) {
      expect(l.secondaryHref, `${l.id} must have one action`).toBeUndefined();
      expect(l.tertiaryHref, `${l.id} must have one action`).toBeUndefined();
    }
  });

  /**
   * r220 (item 61c2e30f) — THE EA ROWS HAND YOU THE FORM ITSELF, AND THE LIST OF ITS BOXES.
   *
   * Until this round an EA could only be produced for a NAMED employee, for a year that already had
   * payroll behind it, so there was no way to open the form on its own and check the arrangement against
   * the agency's page before trusting a filled one — which is what the reporter asked for first. The blank
   * is per LANGUAGE (each row produces its own, whatever language the screen is set to, which is the whole
   * reason there are two EA rows); the field register is ONE document for both, because it describes the
   * FORM rather than a language.
   */
  /**
   * a294cca5 (r244) — WHAT THE PAGE BEHIND "Open Form" CALLS ITSELF.
   *
   * The reporter pressed Open Form on the EA (Bahasa Malaysia) row and landed on a page headed
   * "Form E / CP8D — annual (LHDN)". They were right, and it was ours: r242 renamed that button from
   * "Open employee list" to "Open Form" and did not move where it goes, so the label began promising the
   * EA while the destination went on announcing a different return.
   *
   * The href stays `my.cp8d` — the EA population IS the CP8D population, and the list was never wrong.
   * These cases pin the two things that were: what the page says it is, and which documents it offers.
   * Both are invisible to types, to the suite as it stood, and to a 200.
   */
  it('an EA arrival is titled as the EA, from the shelf row’s OWN label key', () => {
    // Off the same keys the shelf renders, so the row you pressed and the page you land on cannot drift.
    // r402 — the two per-language rows are one entry (`link_ea`), so a bookmarked CP8D arrival carrying
    // `lang` is titled with that one label; the language still rides through to the statement.
    expect(FORM_PAGE).toContain("const eaTitle = eaLang ? t('link_ea') : null;");
    expect(MY_STATUTORY_LINKS.find((l) => l.id === 'my.ea')!.labelKey).toBe('link_ea');
    expect(FORM_PAGE).toContain('const heading = eaTitle ?? def.label;');
    // …and BOTH headers use it. The print one was the second place the wrong name appeared, and the worse
    // of the two: a printed page naming a return it is not is a document somebody could file wrongly.
    expect(FORM_PAGE, 'the screen header').toContain('title={heading}');
    expect(FORM_PAGE, 'the print-only header').toContain('<h1 className="text-lg font-semibold">{heading}</h1>');
    expect(
      FORM_PAGE.includes('title={def.label}') || FORM_PAGE.includes('{def.label}</h1>'),
      'neither header may render def.label directly any more — that is the defect',
    ).toBe(false);
  });

  it('an EA arrival says it is a PICKER, because there is no single EA for a company', () => {
    expect(FORM_PAGE).toContain("description={eaLang ? t('eaPickPerson', { company: companyName, year }) : companyName}");
  });

  it('an EA arrival offers NO Form E downloads', () => {
    // ⚠️ These three call the CP8D exporter — the annexe to Form E. Under an EA heading they would hand
    // an operator the wrong statutory document, which is worse than offering nothing (AGENTS 28). The
    // reporter has not hit this yet only because their company has no figures for the year.
    const block = FORM_PAGE.slice(FORM_PAGE.indexOf("exportHref('pdf')") - 400, FORM_PAGE.indexOf("exportHref('csv')") + 200);
    expect(block, 'the export trio is gated on the arrival').toContain('{!eaLang && (');
    // …and they are STILL THERE for the Form E row's own arrival. A fix that deleted them would have
    // taken a real capability away from the return that owns it.
    for (const f of ['pdf', 'xlsx', 'csv']) {
      expect(FORM_PAGE, `${f} export must survive for a non-EA arrival`).toContain(`exportHref('${f}')`);
    }
  });

  /**
   * ⚠️ r402 (item f3cf2444) — r220 AND r242 ARE REVERSED: THE EA CARD OFFERS NO BLANK AND NO REGISTER.
   *
   * r220 offered the blank C.P.8A and the field register from both EA rows; r242 folded them under one
   * named control ("Blank form and field register"). The reporter then asked for that control to go, with
   * nothing in its place, and for the underlying data to stay. So the two cases that pinned the offer are
   * UPDATED to pin its removal (AGENTS 18 — a guard pinning a decision being reversed is updated, not
   * deleted), and the routes and the register module are pinned as KEPT.
   */
  it('the merged EA card offers no blank form and no field register, and both routes stay as unlinked endpoints', () => {
    const ea = MY_STATUTORY_LINKS.find((l) => l.id === 'my.ea')!;
    expect(ea.secondaryHref).toBeUndefined();
    expect(ea.secondaryLabelKey).toBeUndefined();
    expect(ea.tertiaryHref).toBeUndefined();
    expect(ea.tertiaryLabelKey).toBeUndefined();
    expect(ea.extrasLabelKey).toBeUndefined();
    // No catalog entry links to either route any more…
    for (const l of MY_STATUTORY_LINKS) {
      for (const href of [l.href, l.secondaryHref, l.tertiaryHref]) {
        expect(href ?? '', `${l.id} must not link the blank EA or the register`).not.toMatch(/\/payroll\/ea\/(blank|field-register)/);
      }
    }
    // …and neither does the screen.
    expect(PAGE).not.toContain('/payroll/ea/blank');
    expect(PAGE).not.toContain('/payroll/ea/field-register');
    // The underlying data stays: both routes and the register module still exist.
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/ea/blank/route.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/ea/field-register/route.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'lib/ea-field-register.ts'))).toBe(true);
    // The keys are RETIRED, never deleted.
    for (const k of ['link_ea_more', 'link_ea_blank_en', 'link_ea_blank_ms', 'link_ea_blank_title', 'link_ea_register', 'link_ea_register_title'] as const) {
      expect(en.payroll.statutoryForms[k], k).toMatch(/^\[retired r402/);
    }
  });

  it('the extras machinery is kept for the CP22 row, and no row names a group of extras any more', () => {
    // The screen still renders extras from the catalog through ONE component, because the CP22's blank
    // still uses `secondary`; a row that declares no name renders them side by side exactly as it did.
    expect(PAGE).toContain('l.extrasLabelKey ?');
    expect(PAGE).toContain('groupLabel={c.extrasLabel}');
    expect(PAGE).toContain('if (!groupLabel) return');
    expect(PAGE).toContain('[c.secondary, c.tertiary]');
    for (const l of MY_STATUTORY_LINKS) {
      expect(l.extrasLabelKey, `${l.id} must not name a group of extras`).toBeUndefined();
    }
  });

  /**
   * ⚠️ AND IT MAY NEVER BE `official`. A blank copy of OUR rendering is still our rendering: `public/forms/`
   * holds exactly one genuine agency artwork and it is the CP22's. The pair of EA rows keeps saying
   * `agency-layout`, and the blank download does not move them.
   */
  it('the blank EA does not promote either EA row’s fidelity', () => {
    for (const id of ['my.ea']) {
      expect(MY_STATUTORY_LINKS.find((l) => l.id === id)!.fidelity, id).toBe('agency-layout');
    }
    expect(fs.readdirSync(path.join(ROOT, 'public/forms')).filter((f) => /(cp\W?8a|\bea\b)/i.test(f))).toEqual([]);
  });

  /**
   * The action hangs off the worklist ROWS, because the document is per employee. CP22A gets no button:
   * the leaver notice is a later round, and a button that produced the joiner form for a leaver would be
   * worse than the dash that sits there now — that half is unchanged.
   *
   * 88076362 REVERSED THE OTHER HALF. This used to assert the row linked straight to `/pdf`, and that WAS
   * the reporter's complaint: "you press Download beside a new joiner and a finished form arrives; there
   * is nowhere to check or correct anything first." The row now opens the REVIEW screen, and the download
   * is one press further on. The `/pdf` route still exists and still works on its own — it is what the
   * review screen's own Download button points at — so its existence stays pinned here.
   */
  it('opens the CP22 review screen from every new-hire row, and nothing on the CP22A rows', () => {
    expect(PAGE).toContain('/payroll/cp22/${w.employmentId}/preview');
    expect(PAGE).toContain("w.form === 'CP22'");
    expect(PAGE).toContain("tCp22('reviewLink')");
    expect(PAGE).toContain("tCp22('cp22aNotYet')");
    // The row must NOT go straight to the document any more — that is the behaviour this round removed.
    expect(PAGE).not.toContain('/payroll/cp22/${w.employmentId}/pdf');
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/cp22/[employmentId]/preview/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/cp22/[employmentId]/pdf/route.ts'))).toBe(true);
    // …and the third output the reporter asked for: the same content as plain text, grouped A-F.
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/cp22/[employmentId]/text/route.ts'))).toBe(true);
  });

  /**
   * The route is NOT under app/payroll/statutory-forms/, which already carries [formId]: a static `cp22`
   * sibling there would shadow a form id of 'cp22'. Harmless today (ids are 'my.cp8d' shaped) and still not
   * a trap worth planting.
   */
  it('keeps the CP22 routes out of the [formId] segment they would shadow', () => {
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/statutory-forms/cp22'))).toBe(false);
    const route = read('app/payroll/cp22/[employmentId]/pdf/route.ts');
    // Same guards as the export route beside it: Node runtime, admin + company scope, and a UUID gate.
    expect(route).toContain("export const runtime = 'nodejs'");
    expect(route).toContain('scopedAdmin');
    expect(route).toContain('scopeIds.includes');
    // A read-only render appends NO domain event — the same deliberate skip the EA and payslip routes make.
    expect(code('app/payroll/cp22/[employmentId]/pdf/route.ts')).not.toContain('appendEvent');
  });

  // A tour step whose target left the route it names points at nothing, silently.
  it('keep their guided-tour step pointing at the page they actually render on', () => {
    const tours = JSON.parse(read('lib/module-tours.json')) as {
      payroll: { steps: { id: string; target: string; route: string }[] };
    };
    const step = tours.payroll.steps.find((s) => s.id === 'worklist')!;
    expect(step.route).toBe('/payroll/statutory-forms');
    expect(PAGE).toContain(step.target.replace('[', '').replace(']', ''));
  });
});

/**
 * 587ee719 — THE FOUR PINS.
 *
 * Everything else in this file protects a screen. These four protect the ONE claim the request turns on:
 * that nothing on this shelf hands you a document under a name it does not deserve. They are worth more
 * than the rest of the suite put together, because each of them fails silently in production — a wrong
 * document downloads exactly like a right one.
 */
describe('the four pins', () => {
  /** (a) "Official form" is a claim about GOVERNMENT ARTWORK. Exactly one entry may make it. */
  it('a — exactly one catalog entry claims fidelity "official", and it is my.cp22', () => {
    const official = [
      ...MY_REPORTS.filter((r) => r.fidelity === 'official').map((r) => r.id),
      ...MY_STATUTORY_LINKS.filter((l) => l.fidelity === 'official').map((l) => l.id),
    ];
    expect(official).toEqual(['my.cp22']);
    // …and the claim is true: the artwork and its field map are both on disk.
    expect(fs.existsSync(path.join(ROOT, 'public/forms/cp22-pin-1-2021.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'lib/cp22-fields.ts'))).toBe(true);
    // Every other entry that declares anything declares one of the three honest statuses.
    //
    // 8ca344bf ADDED `agency-layout` TO THAT LIST AND NOT TO THE LINE ABOVE, WHICH IS THE WHOLE POINT.
    // The Borang 8A specimen we built against is another payroll vendor's DevExpress output, not PERKESO
    // artwork, and PERKESO publishes no blank page — so the form is drawn to the agency's layout on our
    // own paper and says so. `my.cp22` remains the ONLY `official` entry, deliberately: it is the claim
    // that costs the most if it is untrue.
    for (const e of [...MY_REPORTS, ...MY_STATUTORY_LINKS]) {
      if (e.fidelity && e.id !== 'my.cp22') {
        expect(['agency-layout', 'figures', 'draft-file'], `${e.id}`).toContain(e.fidelity);
      }
    }
    // Borang 8A specifically: it is `agency-layout`, and there is no PERKESO artwork on disk for it to
    // have been drawn onto — which is exactly why it may not claim `official`.
    expect(MY_REPORTS.find((r) => r.id === 'my.borang-8a')!.fidelity).toBe('agency-layout');
    expect(fs.readdirSync(path.join(ROOT, 'public/forms')).filter((f) => /8a/i.test(f))).toEqual([]);
    // 9c8dad7a — AND BORANG A, WHICH IS THE SECOND MEMBER OF `agency-layout` AND NOT A THIRD STATUS.
    // Same argument, different agency: the reporter's EPF specimen is the same vendor's DevExpress output
    // and KWSP publishes no blank Borang A either, so there is no artwork on disk for it to have been
    // drawn onto. Forms sharing ONE value is what stops the vocabulary growing a status per form.
    expect(MY_REPORTS.find((r) => r.id === 'my.borang-a')!.fidelity).toBe('agency-layout');
    expect(fs.readdirSync(path.join(ROOT, 'public/forms')).filter((f) => /borang/i.test(f))).toEqual([]);
    // c99e8358 — AND THE CP39, WHICH IS THE THIRD MEMBER. This line used to read
    // `['my.borang-8a', 'my.borang-a']`, and that is the decision this change reverses: page one of the
    // CP39 is now drawn to the Borang CP39 (Pin.2015) arrangement, transcribed from a filled specimen at
    // `docs/forms/cp39-pin-2015-specimen.png`. The specimen is a VENDOR's rendering and is deliberately
    // not in `public/forms/`, which is exactly why the CP39 joins this value and not the line above it.
    expect(MY_REPORTS.find((r) => r.id === 'my.cp39')!.fidelity).toBe('agency-layout');
    expect(fs.readdirSync(path.join(ROOT, 'public/forms')).filter((f) => /cp\W?39/i.test(f))).toEqual([]);
    // r219 — AND THE TWO EA ENTRIES, WHICH ARE THE FOURTH AND FIFTH MEMBERS, for exactly the same reason
    // and off exactly the same kind of source. `lib/ea-pdf.ts` now draws the C.P.8A (Pin. 2024)
    // arrangement traced from `docs/forms/ea-cp8a-pin-2024-specimen.png` — another vendor's DevExpress
    // rendering of the agency's page, deliberately NOT in `public/forms/`. Both entries move together:
    // they are one renderer in two languages, so a split between them would be a claim that the form is
    // more faithful in one language than the other, which is not a thing that can be true here.
    // (r402 — one entry since then, `my.ea`, whose two Versions share that one renderer.)
    for (const id of ['my.ea']) {
      expect(MY_STATUTORY_LINKS.find((l) => l.id === id)!.fidelity, id).toBe('agency-layout');
    }
    expect(fs.readdirSync(path.join(ROOT, 'public/forms')).filter((f) => /(cp\W?8a|\bea\b)/i.test(f))).toEqual([]);
    // r224 — AND THE TP1, WHICH IS THE SIXTH MEMBER AND THE WEAKEST-SOURCED OF THEM, RECORDED AS SUCH.
    // lib/tp1-pdf.ts draws LHDN's own wording, its numbering (Sections A–F, C1–C17, D1), its legal
    // references and its column order — the agency's arrangement on our page, which is what this value
    // means. The specimen it was checked against is the reporter's attachment, whose PDF Producer is
    // Microsoft Word 2019 (r202 measured it) rather than an agency press, and it is NOT on disk in
    // either forms directory: `public/forms/` still holds exactly one genuine artwork and it is the
    // CP22's, so `official` is refused here for the same reason it is refused everywhere else.
    expect(MY_STATUTORY_LINKS.find((l) => l.id === 'my.tp1')!.fidelity).toBe('agency-layout');
    expect(fs.readdirSync(path.join(ROOT, 'public/forms')).filter((f) => /tp\W?1/i.test(f))).toEqual([]);
    expect(read('lib/tp1-pdf.ts')).toContain('described as the official form');
    // r224 — AND THE HRD CORP LEVY IS DELIBERATELY *NOT* A MEMBER. It is `figures`: we hold no HRD Corp
    // form, blank or filled, so there is no arrangement for it to have been drawn to. Understating is
    // safe; the failure this vocabulary exists to prevent runs the other way.
    expect(MY_REPORTS.find((r) => r.id === 'my.hrd-levy')!.fidelity).toBe('figures');
    expect(
      [...MY_REPORTS, ...MY_STATUTORY_LINKS].filter((e) => e.fidelity === 'agency-layout').map((e) => e.id).sort(),
    // r323 — the two PCB 2(II) rows are 'agency-layout' on the same honest reasoning: lib/pcb2ii-pdf.ts is
    // OUR typesetting of LHDN's sheet from the specimens attached to 72b100cd, not a facsimile of their
    // PDF. The assertion above — exactly one 'official' entry, and it is my.cp22 — is what this protects.
    // df35d60d — `my.tp3` is 'agency-layout' on the same honest reasoning: lib/tp3-pdf.ts is OUR
    // typesetting of LHDN's TP3 from the specimen attached to the item, not a facsimile of their PDF.
    ).toEqual([
      'my.borang-8a',
      'my.borang-a',
      'my.cp39',
      // r402 — one entry each (was `.en` / `.ms`).
      'my.ea',
      'my.pcb2ii',
      'my.tp1',
      'my.tp3',
    ]);
  });

  /**
   * (b) A planned form cannot render an action, and the TYPE is what guarantees it — not this screen's
   * discipline, and not a boolean somebody can flip. `PlannedFormDef` has no href and no action key, so
   * there is nothing for a later edit to wire up without changing the contract first.
   */
  it('b — no planned form carries an href or an action key, and the page renders none for them', () => {
    for (const p of MY_PLANNED_FORMS as unknown as Record<string, unknown>[]) {
      expect(p.href, `${p.id} must have no href`).toBeUndefined();
      expect(p.actionLabelKey, `${p.id} must have no action key`).toBeUndefined();
      expect(p.secondaryHref, `${p.id} must have no second action`).toBeUndefined();
      // r220 added a third slot; an unbuilt form must not reach an action through it either.
      expect(p.tertiaryHref, `${p.id} must have no third action`).toBeUndefined();
      expect(p.generate, `${p.id} must not be generatable`).toBeUndefined();
    }
    // The screen's own half of it: a card with no action renders the "no action available" sentence,
    // and a planned entry is the only way `action` can be null.
    expect(PAGE).toContain("action: null");
    expect(PAGE).toContain("t('noAction')");
    // A disabled button is still a button. There must not be one.
    expect(PAGE).not.toContain('disabled');
  });

  /**
   * (c) THE ONE THIS WHOLE ITEM GUARDS AGAINST: a button labelled "Borang A" that emits the EPF
   * contributions spreadsheet. No unbuilt form's NAME may ever be the name of something generatable.
   */
  it('c — no planned form’s label is used as the label of anything that generates', () => {
    const ns = en.payroll.statutoryForms as Record<string, string>;
    const plannedNames = MY_PLANNED_FORMS.map((p) => ns[p.labelKey]);
    const actionableNames = [
      ...MY_REPORTS.map((r) => r.label),
      ...MY_STATUTORY_LINKS.map((l) => ns[l.labelKey]),
    ];
    for (const name of plannedNames) {
      expect(name, 'every planned form needs a resolvable name').toBeTruthy();
      expect(actionableNames, `"${name}" is an UNBUILT form and must not label something that runs`).not.toContain(name);
    }
    // Stricter than equality, because the failure mode is a rename that half-lands: the EPF and PERKESO
    // listings must not have absorbed the unbuilt form's name into their own.
    for (const name of plannedNames) {
      for (const actionable of actionableNames) {
        expect(actionable, `"${actionable}" must not present itself as "${name}"`).not.toContain(name);
      }
    }
  });

  /**
   * (d) Borang E and CP8D are ONE annual return with two names. Forking the generator so each entry gets
   * its own is the tempting "completion" of the reporter's list, and it produces two annual returns that
   * drift apart. The alias resolves to the same report id, and there is exactly one annual LHDN report.
   */
  it('d — the Borang E and CP8D entries resolve to the same generator', () => {
    const borangE = MY_STATUTORY_LINKS.find((l) => l.id === 'my.borang-e')!;
    const annual = MY_REPORTS.filter((r) => r.submission?.body === 'lhdn' && r.periodKind === 'year');
    expect(annual.map((r) => r.id)).toEqual(['my.cp8d']);
    // r409 (item 79f3f64d) — UPDATED, NOT DELETED. The alias used to point at the figures screen for the
    // same id (`/payroll/statutory-forms/my.cp8d?`); both cards now open the Form E / CP8D PREVIEW, so the
    // alias declares the generator it resolves to and opens that generator's own preview.
    expect(borangE.populationReportId).toBe(annual[0].id);
    expect(annual[0].preview?.action).toBe('/payroll/cp8d/preview');
    expect(borangE.href).toContain(`${annual[0].preview!.action}?`);
    // Both cards must say so, or two entries read as two documents and somebody waits for the second.
    expect(borangE.descriptionKey).toBeTruthy();
    expect(MY_REPORTS.find((r) => r.id === 'my.cp8d')!.descriptionKey).toBeTruthy();
    const ns = en.payroll.statutoryForms as Record<string, string>;
    for (const k of [borangE.descriptionKey!, MY_REPORTS.find((r) => r.id === 'my.cp8d')!.descriptionKey!]) {
      expect(ns[k], `${k} must say the annual return comes out in one step`).toMatch(/one step|both/i);
    }
  });
});

describe('what the shelves say about the forms that are not built', () => {
  /**
   * The names still may not appear in the SOURCE of either screen: every one of them arrives through the
   * catalog and the message catalog, which is what makes the next form a data change rather than a
   * screen change. (This is what remains of 6babf4f6's "never drawn" test — the mechanism it protected
   * is unchanged; only the conclusion moved from "absent" to "named without an action".)
   *
   * ── r224: THIS LIST IS UNCHANGED, AND 'HRDF Contribution' STAYING ON IT IS A DECISION ─────────────
   *
   * Not an oversight, now that the Other shelf carries a form. The next reader will want to delete it.
   *
   * 'HRDF Contribution' is the REPORTER'S NAME FOR AN HRD CORP FORM, and no such form was built.
   * `my.hrd-levy` publishes the LEVY FIGURES in our own layout under its own honest name — 'HRD Corp
   * levy (PSMB)', `fidelity: 'figures'` — which is why it does not trip the label sweep below. A label
   * claiming to be the reporter's contribution form is exactly the overstatement the four pins above
   * exist to prevent, and it would still be one on a shelf that is no longer empty.
   *
   * (TP1 was never on this list: its DECLARATION has been captured in payroll for rounds, and what was
   * missing — the printable form — shipped in 7ad37961. r224 only stopped the shelf saying otherwise.)
   */
  const NEVER_BUILT = [
    'BBCB', 'Borang 8B', 'SIP 2', 'SIP 2A', 'TP3', 'PCB 2(II)', 'CP21', 'CP39A',
    'HRDF Contribution', 'PTPTN Deduction', 'Tabung Haji Deduction', 'Union Fee',
  ];

  it('are named by the catalog, never written into either screen', () => {
    for (const name of NEVER_BUILT) {
      expect(PAGE, `the page must not name ${name} itself`).not.toContain(name);
      expect(FORM_PAGE, `the form screen must not name ${name}`).not.toContain(name);
    }
    const labels = MY_REPORTS.map((r) => r.label).join(' | ');
    for (const name of NEVER_BUILT) {
      expect(labels, `${name} is not a registered report`).not.toContain(name);
    }
  });

  /**
   * r224 — THE OTHER SHELF IS NO LONGER EMPTY, AND THIS TEST ASSERTS THE OPPOSITE OF WHAT IT USED TO.
   *
   * It used to pin `MY_REPORTS.filter(body === 'other') === []` and read as a design decision. It was
   * not one: the shelf drew a heading, a hint naming five authorities, and an empty state under zero
   * entries, which is what a broken section looks like. The levy figure has been stamped on every
   * payslip since Wave 2A, so the honest answer was to publish the figures that already existed.
   *
   * The half that IS a design decision is kept and still pinned: no PLANNED form was parked on this
   * shelf to make it look populated, and the empty state is still in the page for the shelves, searches
   * and jurisdictions that are genuinely empty.
   */
  it('fills the Other shelf from the catalog, and keeps the empty state for shelves that are empty', () => {
    const other = MY_REPORTS.filter((r) => r.submission?.body === 'other');
    expect(other.map((r) => r.id)).toEqual(['my.hrd-levy']);
    // A real filing: it names an agency, which is what earns it the shelf and the suspended-tenant
    // override. See test/suspended-statutory-filing.test.ts for the other half.
    expect(other[0].submission!.agency).toBe('HRD Corp');
    // The 15th is still SOURCED and still true of HRD Corp — that half of the original case is kept.
    expect(read('docs/wave2-payroll-design.md')).toContain('due by the **15th of the following month**');
    // ⚠️ BUT THE CATALOG DELIBERATELY CARRIES NULL, and this is a reversal of the assertion that stood
    // here. `dueDayOfNextMonth` is not "when is this due" — it is "compute a deadline for EVERY company
    // on the filter and colour it overdue". The levy is owed only by a company registered with PSMB, and
    // `company_statutory_my.hrdf_status` DEFAULTS to `not_registered`, so a hard 15 printed a red
    // "Overdue" missed-statutory-filing at every tenant that never registered — the majority case. This
    // page's own note on the line above `submissionDueFor` states the principle it breaks: "An invented
    // deadline is worse than an absent one: somebody files against it." The date returns the day the
    // shelf can read registration status per company; until then it is not asserted.
    expect(other[0].submission!.dueDayOfNextMonth).toBeNull();
    // `figures`, and it may not move: HRD Corp publishes no blank levy form and nothing here is drawn to
    // an agency arrangement, so `agency-layout` would claim a page we have never seen.
    expect(other[0].fidelity).toBe('figures');

    // Monthly, on the payroll batch — so the card carries the month chip the two selects at the top of
    // the screen drive, and not a year chip over a month's figures.
    expect(other[0].cadence).toBe('monthly');
    expect(other[0].periodKind).toBe('month');
    expect(other[0].scope).toBe('batch');

    // Nothing was quietly parked here to avoid choosing a shelf — the pin that predates this round.
    expect(MY_PLANNED_FORMS.filter((p) => p.body === 'other')).toEqual([]);
    expect(MY_STATUTORY_LINKS.filter((l) => l.body === 'other')).toEqual([]);
    // The empty state is still what an empty shelf renders; it was never the Other shelf's alone.
    expect(PAGE).toContain("t('shelfEmpty')");
  });

  /**
   * r224 — WHAT THE LEVY REPORT PRINTS, AND THE ONE COLUMN IT REFUSES TO.
   *
   * The obvious second column is the HRDF wage the levy was charged on, and the payslip does stamp it
   * (`st.bases.hrdf`). It is NOT printed, and this is the guard on that decision, because the next
   * reader will see a two-column report and reach for it.
   *
   * The base is stamped for EVERY employee — including the ones `hrdfSubject()` excludes from the levy
   * and every employee of a company whose registration band is `not_registered`, for all of whom the
   * levy is correctly zero. A wage printed beside a zero levy asserts a levied wage that was never
   * levied, on a document an employer reconciles against what they actually pay HRD Corp. The flag that
   * would make the column truthful is a BOOLEAN on the payslip blob, and `loadBatchRows` carries numbers
   * only — so the column cannot be made honest without changing a loader six reports share.
   */
  it('prints the stamped levy and nothing it would have to infer', () => {
    // `code()`, not `read()`: this generator's own doc-comment names the column it refuses to print and
    // says why, so scanning the raw text would fail the test on the explanation the test exists to
    // reinforce — the hazard the `code()` helper at the top of this file was written for.
    const src = code('localization/my/reports.ts');
    const fn = src.slice(src.indexOf('const HRD_LEVY_COLS'), src.indexOf('async function loadYearRows'));
    expect(fn, 'the levy report must exist in this file').toContain('async function hrdLevy');
    // Two columns, and the money one is numeric so the shared panel totals it rather than left-aligning.
    expect(fn).toContain("{ key: 'levy', label: 'HRD Corp levy', numeric: true }");
    expect(fn).not.toMatch(/key: 'base'|hrdfWage|bases\.hrdf/);
    // It reads the figure the payroll run STAMPED. Calling the pack's calculator here would be a second
    // implementation of a statutory amount — the duplication 241817ef spent two rounds undoing.
    expect(fn).toContain('num(r.st.hrdf)');
    expect(fn).not.toContain('hrdfLevy(');
    // Everyone in the month's batch is listed, zeroes included: dropping the zero rows would make
    // "excluded from the levy" and "not on the payroll this month" the same absence.
    expect(fn).toContain('b.rows.map(');
    expect(fn).not.toMatch(/\.filter\(\(r\) => [^)]*hrdf/);
    // No readiness gate, and the comment says why: no employee identifier goes up with the levy, so
    // there is no per-person field whose absence could produce a short file.
    expect(fn).toContain('readiness: []');
  });

  /**
   * r224 — FORM TP1 WAS ON THIS SHELF MARKED "NOT BUILT YET" WHILE IT WAS BUILT, which is the exact
   * failure the shelf exists to prevent, running in the other direction: the four pins below stop an
   * unbuilt form claiming to produce a document, and nothing stopped a built one claiming it could not.
   *
   * The card is now a door onto the screen that already existed. What this pins is the thing that makes
   * it a WORKING door: the href is the TP1 LIST, not the month page. `tp1/[year]/[month]` resolves the
   * employment against the acting admin's own scoped list and `notFound()`s a miss, so it 404s without
   * an `?employmentId=` — a shelf card pointing there would open nothing at all.
   */
  it('opens TP1 on the list that can reach it, not on the month page that 404s without an employee', () => {
    const tp1 = MY_STATUTORY_LINKS.find((l) => l.id === 'my.tp1')!;
    expect(tp1.body).toBe('lhdn');
    expect(tp1.href).toBe('/payroll/transactions/tp1?year={year}');
    // The screen it opens, and the two things behind it that make the promotion true.
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/transactions/tp1/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/transactions/tp1/[year]/[month]/pdf/route.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'lib/tp1-pdf.ts'))).toBe(true);
    // …and the reason the href stops at the list: the month page refuses an employment it cannot resolve.
    expect(read('app/payroll/transactions/tp1/[year]/[month]/page.tsx')).toContain('if (!emp) notFound()');
    /**
     * r256 MOVED WHO FILLS THE PLACEHOLDER IN, AND KEPT WHAT THE PLACEHOLDER MEANS. The landing page used
     * to substitute `{companyId}` and `{year}` out of its own filter bar; it has no filter bar now, so a
     * templated href is handed to the criteria step, which reads the placeholders and draws exactly those
     * boxes. TP1's `{year}` is why its step asks for a year and NOT a company — its screen takes no
     * companyId, and a Company select on it would be a box that goes nowhere.
     */
    expect(PAGE).not.toContain("href.replace('{companyId}'");
    expect(parseDestination(tp1.href).criteria.map((c) => c.kind)).toEqual(['year']);
    expect(tp1.href).not.toContain('{month}');
    // It is no longer marked unbuilt anywhere, and its planned strings went with it.
    expect(MY_PLANNED_FORMS.map((p) => p.id)).not.toContain('lhdn.tp1');
    const ns = en.payroll.statutoryForms as Record<string, string>;
    expect(ns.planned_lhdn_tp1).toBeUndefined();
    expect(ns.planned_lhdn_tp1_hint).toBeUndefined();
    // The hint an operator reads must not still tell them the printable form does not exist.
    expect(ns[tp1.hintKey!]).not.toMatch(/not built/i);
    expect(ns[tp1.descriptionKey!]).not.toMatch(/not built/i);
  });

  /**
   * 587ee719 — THE EA SPLIT IS A LOCALE, NOT A SECOND RENDERER.
   *
   * The previous version of this test pinned the opposite conclusion: one EA entry, because BM was a
   * language switch on the screen. That was true and it was the wrong answer to the request — an
   * employer needs both languages in the same year from the same session, and "change your app language"
   * is not a form. So there are two ENTRIES and still exactly one renderer, one statement read, and one
   * `payroll.ea` dictionary per locale. The route resolves the namespace for the language it was ASKED
   * for; the two entries differ only by the `lang` they carry.
   */
  it('splits the EA into two entries without a second EA renderer', () => {
    // Compared as flattened key PATHS: payroll.ea nests (the amendment panel, the multi-employer
    // block), so a shallow key list would call two dictionaries equal while a whole sub-tree was
    // missing from one of them. This is what makes `lang=ms` produce a genuinely Malay document.
    const paths = (o: Record<string, unknown>, p = '', out: string[] = []): string[] => {
      for (const [k, v] of Object.entries(o)) {
        const key = p ? `${p}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) paths(v as Record<string, unknown>, key, out);
        else out.push(key);
      }
      return out;
    };
    const ms = JSON.parse(read('messages/ms.json')) as { payroll: { ea: Record<string, unknown> } };
    expect(paths(ms.payroll.ea).sort()).toEqual(paths(en.payroll.ea).sort());
    // The dictionaries must actually DIFFER, or "two languages" is two identical documents.
    expect(ms.payroll.ea.title).not.toBe(en.payroll.ea.title);

    // ⚠️ r402 (item f3cf2444) — THE TWO ENTRIES ARE ONE NOW, AND THE TWO LANGUAGES ARE ITS VERSIONS. The
    // href takes `{lang}` and the entry declares exactly the two values the routes allowlist, so the
    // criteria step offers English and Bahasa Malaysia and still nothing else.
    const eas = MY_STATUTORY_LINKS.filter((l) => l.id.startsWith('my.ea'));
    expect(eas.map((l) => l.id)).toEqual(['my.ea']);
    expect(new URL(eas[0].href, 'http://x').searchParams.get('lang')).toBe('{lang}');
    expect(eas[0].versions!.map((v) => v.value)).toEqual(['en', 'ms']);
    expect(eas[0].formerIds).toEqual([
      { id: 'my.ea.en', version: 'en' },
      { id: 'my.ea.ms', version: 'ms' },
    ]);

    // ONE renderer, and the labels are resolved for the language that was ASKED FOR rather than for the
    // viewer. `getTranslations('payroll.ea')` — the bare string form — is the bug this replaced.
    //
    // r220 — THE BUNDLE MOVED AND THE ASSERTION FOLLOWED IT. It used to be built inline in the /me route;
    // a second route now prints the same form (the blank C.P.8A at app/payroll/ea/blank), and two
    // hand-maintained copies of one statutory form's captions is how the blank and the filled version stop
    // being the same page. Both routes call `eaPdfLabels()`, which is where the namespace is resolved.
    const EA_LABELS = read('lib/ea-pdf-labels.ts');
    expect(EA_LABELS).toContain("getTranslations({ locale, namespace: 'payroll.ea' })");
    expect(EA_LABELS).not.toContain("getTranslations('payroll.ea')");
    const EA_ROUTE = read('app/me/ea/[employmentId]/pdf/route.ts');
    expect(EA_ROUTE).toContain("EA_LANGS = ['en', 'ms']");
    // …and the blank copy allowlists the SAME two languages, off the same one renderer.
    expect(read('app/payroll/ea/blank/route.ts')).toContain("EA_LANGS = ['en', 'ms']");

    /**
     * The half that has NOT changed, and is what this case is for: exactly ONE file draws an EA. r220
     * put a LABEL module beside it, which draws nothing — so the check is "which of these files exports
     * a renderer" as well as "which files are named ea-*pdf", and the first is the stronger question.
     *
     * ⚠️ r372 — THE SET GAINS A THIRD NAME AND STAYS EXACT. `ea-pdf-labels-file.ts` resolves the same
     * bundle from `messages/<locale>.json` ON DISK, for the measuring script and the grid guard, which
     * have no request to resolve a locale against. It draws nothing and it must never serve a page: it
     * has no fallback chain, no ICU formatting and no locale negotiation, and it THROWS on a missing
     * key rather than degrading. So the three assertions below are: the set is exactly these three, only
     * one of them renders, and NO ROUTE reaches the file one.
     */
    const eaPdfFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => /^ea-.*pdf/.test(f)).sort();
    expect(eaPdfFiles).toEqual(['ea-pdf-labels-file.ts', 'ea-pdf-labels.ts', 'ea-pdf.ts']);
    expect(eaPdfFiles.filter((f) => read(`lib/${f}`).includes('export async function renderEaPdf'))).toEqual([
      'ea-pdf.ts',
    ]);
    for (const route of ['app/me/ea/[employmentId]/pdf/route.ts', 'app/payroll/ea/blank/route.ts']) {
      expect(read(route), `${route} resolves its captions off disk instead of through next-intl`).not.toContain(
        'ea-pdf-labels-file',
      );
    }

    // …and the override has somewhere to land. i18n/request.ts used to ignore the requested locale and
    // read the cookie unconditionally, which would have made `lang=ms` return a 200 in the wrong language.
    expect(read('i18n/request.ts')).toContain('locale: requested');

    // The shelf hint must no longer state the opposite of what ships. r402 — and it must no longer say the
    // two languages are two entries: the old hint is retired and the entry names a new one.
    expect(eas[0].hintKey).toBe('link_ea_hint_version');
    expect(en.payroll.statutoryForms.link_ea_hint_version).not.toContain('not a second form');
    expect(en.payroll.statutoryForms.link_ea_hint_version).not.toMatch(/two separate entries/);
    expect(en.payroll.statutoryForms.link_ea_hint).toMatch(/^\[retired r402/);
  });
});

describe('the menu row the reporter actually asked for', () => {
  const NODE = payrollPack.navNodes!.find((n) => n.group === 'admin')!;

  it('exists, and sits after Reports — filing is the last thing you do with a month', () => {
    const hrefs = NODE.children.map((c) => c.href);
    expect(hrefs).toContain('/payroll/statutory-forms');
    expect(hrefs.indexOf('/payroll/statutory-forms')).toBeGreaterThan(hrefs.indexOf('/payroll/reports'));
  });

  // r91's design: a row is placed by declaring a rank, never by splicing it into the literal list.
  it('is placed by a declared rank rather than by its position in the source', () => {
    expect(PAYROLL_NAV_PHASE['/payroll/statutory-forms']).toBeGreaterThan(PAYROLL_NAV_PHASE['/payroll/reports']);
  });
});
