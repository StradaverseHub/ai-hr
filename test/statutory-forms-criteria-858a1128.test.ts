/**
 * r256 (item 858a1128) — Statutory Forms becomes a form DIRECTORY, and the period is asked for per form.
 *
 * WHAT THE REPORTER ASKED FOR. The screen opened with Company, Payroll Year and Payroll Month and would
 * not name a single form until all three were answered — the period chosen before the form, which is the
 * reverse of the order an HR operator works in. And it asked for a Payroll Month even on the annual
 * C.P.8A (EA), where a month means nothing.
 *
 * WHAT WAS MEASURED FIRST, AND HELD. `app/payroll/statutory-forms/page.tsx` really did take companyId /
 * year / month as search params and gate the whole list on them, so the premise was true. Two things the
 * plan named as ALREADY BUILT are carried across unchanged and are pinned as such below: the pack's eight
 * registered reports, and the `official` / `agency-layout` / `figures` / `draft-file` / `planned` fidelity
 * vocabulary each entry carries.
 *
 * ⚠️ AGENTS 28b IS WHY THE FIDELITY CASES ARE HERE. The chips are now rendered on THREE surfaces (the
 * shelf card, the criteria step, the form screen) where they were rendered on two. A shared caption may
 * only say what is true of every form that carries it, and r218 shipped an unsourced claim about an agency
 * by re-rendering one in a new place — so this file pins that no form MOVED status in this round and that
 * the new surface resolves the same keys, rather than re-checking the claims themselves (which
 * test/statutory-forms-page.test.ts already owns).
 *
 * WHY SO MUCH OF THIS IS PURE RATHER THAN SOURCE-SCANNING. The defect this round can produce is a card
 * that opens a criteria step which then asks for the wrong thing — a mismatch BETWEEN files, invisible to
 * a test of either half. `app/payroll/statutory-forms/criteria.ts` is the one rule both read, so running
 * it over the pack's OWN entries answers "does the EA ask for a month" as a fact rather than as a grep.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MY_PLANNED_FORMS, MY_REPORTS, MY_STATUTORY_LINKS } from '../localization/my/reports';
import { REGISTERED_ROUTES } from '../lib/permissions';
import {
  TEMPLATED,
  criteriaHref,
  parseDestination,
  reportDestination,
} from '../app/payroll/statutory-forms/criteria';
import { filterEaRows } from '../app/payroll/statutory-forms/ea/filter';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const ROOT = path.resolve(__dirname, '..');
/**
 * Source with its PROSE removed, for the assertions that say "this file must not do X". These files
 * document exactly what they refuse to do, so scanning raw text would make an honest comment fail the
 * test the comment reinforces. Block comments go (JSDoc and braced JSX comments alike) and only
 * WHOLE-LINE double-slash comments go, so a URL inside a string survives. Same helper, same reason, as
 * test/statutory-forms-page.test.ts.
 */
const code = (p: string) =>
  fs
    .readFileSync(path.join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const DIRECTORY = code('app/payroll/statutory-forms/page.tsx');
const CRITERIA = code('app/payroll/statutory-forms/open/page.tsx');
const FORM_PAGE = code('app/payroll/statutory-forms/[formId]/page.tsx');
const EA_PAGE = code('app/payroll/statutory-forms/ea/page.tsx');
const EA_PICKER = code('app/payroll/statutory-forms/ea/employee-picker.tsx');
const EA_DOWNLOAD = code('app/payroll/statutory-forms/ea/download/route.ts');

const linkById = new Map(MY_STATUTORY_LINKS.map((l) => [l.id, l]));
const kinds = (href: string) => parseDestination(href).criteria.map((c) => c.kind);
/** The two C.P.8A rows, found the way the screen finds them — by destination, never by id. */
const EA_LINKS = MY_STATUTORY_LINKS.filter((l) => l.href.startsWith('/payroll/statutory-forms/ea'));

describe('the main screen is a directory: no company, year or month gates the form list', () => {
  it('reads the catalog from the admin’s company SCOPE, not from one chosen company', () => {
    // The seam that makes a company-less directory possible: it resolves the distinct jurisdictions of the
    // admin's scope and unions their packs. `listReports(` takes a single companyId and is what the old
    // screen called — its absence here IS the redesign.
    expect(DIRECTORY).toContain('listStatutoryCatalog(s, scopeIds)');
    expect(DIRECTORY).not.toContain('listReports(');
  });

  it('never puts a concrete period on a card, because no period has been chosen', () => {
    // `chipMonth` / `chipYear` printed "Month · August 2026" on every card. On a directory with no period
    // that is a month the operator has not picked, offered as though they had — so the cards carry their
    // CADENCE and the keys are gone from all six locales.
    for (const dict of [en, ms, ta, th, vi, zh]) {
      const ns = dict.payroll.statutoryForms as Record<string, string>;
      for (const k of ['chipMonth', 'chipYear', 'dueByShort']) expect(ns[k], k).toBeUndefined();
    }
    expect(DIRECTORY).not.toContain('chipMonth');
    expect(DIRECTORY).not.toContain('chipYear');
    expect(DIRECTORY).toContain('cadenceChip(r.cadence)');
  });

  /**
   * The deadline a card shows is now the pack's RULE, and never a computed date — because a date needs a
   * period, and a red "Overdue" against a month nobody chose is a claim that a statutory filing was missed
   * (AGENTS 28). `submissionDueFor` still runs one screen on, where a period exists.
   */
  it('shows the filing rule rather than computing a deadline for an unchosen month', () => {
    expect(DIRECTORY).not.toContain('submissionDueFor');
    expect(DIRECTORY).toContain("t('dueRule', { day })");
    // Only a MONTHLY submission can carry that sentence: `dueDayOfNextMonth` describes "day N of the month
    // after the period" and nothing else, so an annual form with a day set must not print it.
    expect(DIRECTORY).toContain("day != null && r.periodKind === 'month'");
  });

  it('still generates nothing itself', () => {
    for (const forbidden of ['reportPreview(', 'recordReport(', 'payslip']) {
      expect(DIRECTORY, `the directory should not itself ${forbidden}`).not.toContain(forbidden);
    }
  });

  /**
   * The CP22 row's destination is the worklist at the FOOT of the directory, and that worklist keeps its
   * own company and month because `complianceWorklist` and `cp22MonthCohort` genuinely need them. The
   * bookmark people hold is `?companyId=…#worklist`, so the anchor and the parameter both have to survive
   * a round whose whole point is removing the filter bar above them.
   */
  it('keeps the CP22 worklist reachable at its own anchor', () => {
    expect(linkById.get('my.cp22')?.href).toBe('/payroll/statutory-forms#worklist');
    expect(TEMPLATED.test(linkById.get('my.cp22')!.href)).toBe(false);
    expect(DIRECTORY).toContain('id="worklist"');
    expect(DIRECTORY).toContain('complianceWorklist');
    expect(DIRECTORY).toContain('cp22MonthCohort');
  });
});

describe('every registered form reaches the directory, with the status it already had', () => {
  /**
   * The plan's first test: the directory lists every registered report with its status chip. It is checked
   * against the CATALOG rather than against rendered HTML because that is where the failure would be —
   * an entry whose fidelity resolves to no key draws a chip with no words in it.
   */
  it('gives every generatable submission and every link a fidelity key that resolves', () => {
    const ns = en.payroll.statutoryForms as Record<string, string>;
    const keyFor = (f: string) => `fidelity_${f.replace('-', '_')}`;
    const entries = [
      ...MY_REPORTS.filter((r) => r.submission).map((r) => [r.id, r.fidelity ?? 'figures'] as const),
      ...MY_STATUTORY_LINKS.map((l) => [l.id, l.fidelity ?? 'figures'] as const),
    ];
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, fidelity] of entries) {
      expect(ns[keyFor(fidelity)], `${id} → ${fidelity}`).toBeTruthy();
      expect(ns[`${keyFor(fidelity)}_hint`], `${id} → ${fidelity} hint`).toBeTruthy();
    }
    // And a planned form still renders the fifth status and no action — the type is what guarantees it,
    // and this is the reminder that the directory did not gain a way round that type.
    expect(MY_PLANNED_FORMS.length).toBeGreaterThan(0);
    expect(DIRECTORY).toContain("status: 'planned'");
    expect(DIRECTORY).toContain('action: null');
  });

  /**
   * ⚠️ AGENTS 28b. No form moved between statuses in this round, and this is the case that fails if one
   * quietly does — a shared caption acquires a new subject the moment a new member joins the set.
   * `my.cp22` remains the ONLY `official` row, which is the claim that costs the most if it is untrue.
   */
  it('moves no form between fidelity statuses', () => {
    const official = [...MY_REPORTS, ...MY_STATUTORY_LINKS].filter((e) => e.fidelity === 'official');
    expect(official.map((e) => e.id)).toEqual(['my.cp22']);
    expect(EA_LINKS.map((l) => l.fidelity)).toEqual(['agency-layout', 'agency-layout']);
  });

  it('renders the same status keys on the criteria step as on the shelf', () => {
    for (const f of ['official', 'agency_layout', 'figures', 'draft_file']) {
      expect(CRITERIA, `fidelity_${f}`).toContain(`fidelity_${f}`);
      expect(CRITERIA, `fidelity_${f}_hint`).toContain(`fidelity_${f}_hint`);
    }
    expect(CRITERIA).toContain('FIDELITY_KEY[fidelity]');
    expect(CRITERIA).toContain('FIDELITY_HINT_KEY[fidelity]');
  });
});

describe('each form’s criteria step asks for what THAT form needs, and nothing else', () => {
  /**
   * The plan's second test: a monthly form's step demands company + year + month before it will generate.
   * Run over the pack's own reports rather than a hand-written list, so a form added later is covered the
   * day it is registered.
   */
  it('asks a monthly report for company, year and month', () => {
    const monthly = MY_REPORTS.filter((r) => r.submission && r.periodKind === 'month');
    expect(monthly.length).toBeGreaterThan(0);
    for (const r of monthly) {
      const d = reportDestination(r.id, r.periodKind);
      expect(d.criteria.map((c) => c.kind), r.id).toEqual(['company', 'year', 'month']);
      expect(d.action, r.id).toBe(`/payroll/statutory-forms/${r.id}`);
    }
  });

  it('asks an ANNUAL report for company and year, and never a month', () => {
    const annual = MY_REPORTS.filter((r) => r.submission && r.periodKind === 'year');
    expect(annual.length).toBeGreaterThan(0);
    for (const r of annual) {
      expect(reportDestination(r.id, r.periodKind).criteria.map((c) => c.kind), r.id).toEqual([
        'company',
        'year',
      ]);
    }
  });

  /**
   * The plan's third test, and the reporter's own words: the EA asks for Company and Payroll Year, and
   * there is NO Payroll Month box on it. Both language rows are checked — they are two entries, and a
   * change to one that missed the other is exactly the shape of defect this catches.
   */
  it('asks the C.P.8A (EA) for company and year, and NEVER for a month', () => {
    expect(EA_LINKS.map((l) => l.id).sort()).toEqual(['my.ea.en', 'my.ea.ms']);
    for (const l of EA_LINKS) {
      const d = parseDestination(l.href);
      expect(d.criteria.map((c) => c.kind), l.id).toEqual(['company', 'year']);
      expect(d.criteria.map((c) => c.kind), l.id).not.toContain('month');
      expect(d.action, l.id).toBe('/payroll/statutory-forms/ea');
      // The language the row promises rides through the step untouched — it is not a criterion, it is
      // part of which form was chosen.
      expect(d.hidden, l.id).toEqual([{ name: 'lang', value: l.id.endsWith('.ms') ? 'ms' : 'en' }]);
    }
  });

  it('says CONTINUE on the EA’s step, because company + year is the first of two steps', () => {
    for (const l of EA_LINKS) expect(l.criteriaLabelKey, l.id).toBe('criteria_continue');
    // Every other templated entry falls back to the shared "Generate form" — the button that IS the
    // moment of generation.
    for (const l of MY_STATUTORY_LINKS.filter((x) => !EA_LINKS.includes(x))) {
      expect(l.criteriaLabelKey, l.id).toBeUndefined();
    }
    expect(CRITERIA).toContain("link?.criteriaLabelKey ?? 'criteria_generate'");
  });

  it('asks Form TP1 for a year only, because that is all its destination takes', () => {
    // The case that proves the step reads the DESTINATION and not a fixed three-box prompt: TP1's screen
    // takes `?year=` and no company, so a Company select on its step would be a box that goes nowhere.
    expect(kinds(linkById.get('my.tp1')!.href)).toEqual(['year']);
  });

  it('sends a templated entry to the criteria step and an un-templated one straight through', () => {
    for (const l of MY_STATUTORY_LINKS) {
      const templated = TEMPLATED.test(l.href);
      expect(templated, `${l.id} ${l.href}`).toBe(l.id !== 'my.cp22');
    }
    expect(criteriaHref('my.cp39')).toBe('/payroll/statutory-forms/open?form=my.cp39');
    expect(DIRECTORY).toContain('TEMPLATED.test(l.href) ? criteriaHref(l.id) : l.href');
  });

  /**
   * The directory has no company and no year, so an extra action whose href carries a placeholder would
   * render `{companyId}` into the markup and open a 404. No entry declares one today; this is what fails
   * the day somebody adds one, rather than the operator finding it.
   */
  it('declares no placeholder in any row’s EXTRA action', () => {
    for (const l of MY_STATUTORY_LINKS) {
      for (const href of [l.secondaryHref, l.tertiaryHref]) {
        if (href) expect(TEMPLATED.test(href), `${l.id} ${href}`).toBe(false);
      }
    }
  });

  it('produces nothing on the criteria step itself', () => {
    // The step's whole promise is that pressing the button is the moment of generation. A generator call
    // here would break it while every other assertion in this file stayed green.
    for (const forbidden of ['reportPreview(', 'recordReport(', 'renderEaPdf', 'employeeEaStatement']) {
      expect(CRITERIA, `the criteria step should not ${forbidden}`).not.toContain(forbidden);
    }
    // A plain GET form whose action is the destination: no server action, no client state, so the criteria
    // land in the address bar of the screen that uses them.
    expect(CRITERIA).toContain('<form method="get" action={parsed.action}');
    expect(CRITERIA).not.toContain("'use client'");
  });
});

describe('the form screen no longer generates for a period nobody chose', () => {
  /**
   * The fallbacks are the defect: a bare `/payroll/statutory-forms/my.epf` used to pick the admin's first
   * company and the month just ended and produce a statutory return for both. It is a redirect to the
   * form's own criteria step now.
   */
  it('redirects to the criteria step when company, year or month is missing', () => {
    expect(FORM_PAGE).toContain('if (!companyId) redirect(criteriaHref)');
    expect(FORM_PAGE).toContain('if (!namedYear && !legacy) redirect(criteriaHref)');
    expect(FORM_PAGE).toContain('if (!annual && !namedMonth && !legacy) redirect(criteriaHref)');
    // The fallbacks themselves are gone, not merely bypassed.
    expect(FORM_PAGE).not.toContain('companies[0]?.id');
    expect(FORM_PAGE).not.toContain('previousMonth(');
  });

  /**
   * Every bookmark of this screen carries companyId + year + month (or the legacy periodKey), because that
   * is what the shelf has always put in them — so they are fully specified and still land on the figures.
   * The redirect is on ABSENCE for exactly that reason: a `?generate=1` flag would have broken all of them.
   */
  it('still accepts the legacy periodKey as a named period', () => {
    expect(FORM_PAGE).toContain('sp.periodKey');
    expect(FORM_PAGE).toContain('const year = namedYear || legacy.slice(0, 4)');
    expect(FORM_PAGE).toContain('const month = namedMonth || legacy.slice(5, 7)');
  });
});

describe('the C.P.8A (EA) picks people, and can pick many', () => {
  /**
   * The population fact lives in the CATALOG, not in the screen: the EA population is the CP8D population,
   * one row per employee for the tax year. It used to be encoded as a destination (the rows pointed at
   * `…/my.cp8d`); the picker is its own screen now, so the fact is declared.
   */
  it('declares where the year’s people come from, and it resolves to a real report', () => {
    for (const l of EA_LINKS) {
      expect(l.populationReportId, l.id).toBe('my.cp8d');
      expect(MY_REPORTS.some((r) => r.id === l.populationReportId), l.id).toBe(true);
    }
    expect(EA_PAGE).toContain('entry.populationReportId');
    expect(EA_PAGE).not.toContain("'my.cp8d'");
  });

  /**
   * The plan's fourth test, first half: the selection filters by both name AND employee code. Run over
   * rows, because "does the employee-ID box match on the employee ID" is not a question a grep answers.
   */
  const rows = [
    { name: 'Lim Wei Sheng', code: 'A0001' },
    { name: 'Tan Mei Ling', code: 'A0002' },
    { name: 'Nur Aisyah binti Rahman', code: 'B0100' },
  ];

  it('matches on employee name', () => {
    expect(filterEaRows(rows, { name: 'tan' }).map((r) => r.code)).toEqual(['A0002']);
    expect(filterEaRows(rows, { name: 'AISYAH' }).map((r) => r.code)).toEqual(['B0100']);
  });

  it('matches on employee ID, and the ID box does not match names', () => {
    expect(filterEaRows(rows, { code: 'a000' }).map((r) => r.code)).toEqual(['A0001', 'A0002']);
    expect(filterEaRows(rows, { code: 'B0100' }).map((r) => r.name)).toEqual([
      'Nur Aisyah binti Rahman',
    ]);
    // "Lim" is a NAME, and the employee-ID box must not find it — a combined search would return a person
    // the operator did not ask for.
    expect(filterEaRows(rows, { code: 'Lim' })).toEqual([]);
  });

  it('narrows on both boxes together, and returns everybody when both are empty', () => {
    expect(filterEaRows(rows, { name: 'lim', code: 'A0002' })).toEqual([]);
    expect(filterEaRows(rows, { name: 'lim', code: 'A0001' }).map((r) => r.code)).toEqual(['A0001']);
    expect(filterEaRows(rows, {})).toHaveLength(3);
    expect(filterEaRows(rows, { name: '  ', code: '  ' })).toHaveLength(3);
  });

  /**
   * ⚠️ The plan's fourth test, second half: a MULTI-employee selection generates. The failure mode this
   * pins is specific and silent — the two search boxes remove rows from the DOM, and a ticked checkbox
   * that is no longer rendered is one the browser does not submit. So the selection is carried as hidden
   * inputs driven by state, and the route reads ALL of them.
   */
  it('submits every ticked person, including ones the search has scrolled out of view', () => {
    expect(EA_PICKER).toContain('selected.map((id) => (');
    expect(EA_PICKER).toContain('<input key={id} type="hidden" name="id" value={id} />');
    expect(EA_PICKER).toContain('selectAllVisible');
    expect(EA_PICKER).toContain('setSelected([])');
    expect(EA_DOWNLOAD).toContain("q.getAll('id')");
    expect(EA_DOWNLOAD).toContain('for (const employmentId of unique)');
  });

  /**
   * A merged tax document that is silently short of two of the ten people asked for is worse than no
   * document — nothing on the page it produces says who is missing (AGENTS 28). The picker only offers the
   * year's actual population, so this is the hand-edited-URL path.
   */
  it('refuses a partial answer rather than shipping one', () => {
    expect(EA_DOWNLOAD).toContain('if (!ea) return notFound()');
    expect(EA_DOWNLOAD).toContain('ids.length === 0');
    expect(EA_DOWNLOAD).toContain('MAX_SELECTION');
    // Gated like the CP22 batch beside it, and pinned to THIS employer: after an Entity Transfer a year
    // can span two, and handing over the wrong employer's statement is the failure the per-employee route
    // refuses too.
    expect(EA_DOWNLOAD).toContain('scopedAdmin()');
    expect(EA_DOWNLOAD).toContain('if (!scopeIds.includes(companyId)) return notFound()');
    expect(EA_DOWNLOAD).toContain('{ employmentId, year, companyId }');
    // ONE renderer. A second EA implementation is two versions of one statutory form that drift.
    expect(EA_DOWNLOAD).toContain('renderEaPdf');
    expect(EA_DOWNLOAD).toContain('eaPdfLabels');
  });

  it('allowlists the document language on the way in, exactly as the per-employee route does', () => {
    expect(EA_DOWNLOAD).toContain("EA_LANGS = ['en', 'ms']");
    expect(EA_DOWNLOAD).toContain('EA_LANGS.includes(langParam as EaLang)');
    expect(EA_PAGE).toContain("EA_LANGS = ['en', 'ms']");
  });
});

describe('the new screens can be granted and revoked like the ones they sit between', () => {
  /**
   * A guarded page.tsx with no column in the function-access matrix is a screen nobody can grant or
   * revoke, and test/function-access.test.ts fails the whole suite for it. Both new pages are attached to
   * the EXISTING statutory-forms routes' screen key rather than to new keys of their own: access is
   * UNCHANGED by this item, and a separate column would let an administrator grant Statutory Forms while
   * revoking the only way into a form on it.
   */
  it('registers the criteria step and the EA selection beside the screens they connect', () => {
    for (const r of [
      '/payroll/statutory-forms',
      '/payroll/statutory-forms/[formId]',
      '/payroll/statutory-forms/open',
      '/payroll/statutory-forms/ea',
    ]) {
      expect(REGISTERED_ROUTES.has(r), r).toBe(true);
    }
    // The download sibling is a route handler, not a guarded page — the reverse-completeness check walks
    // page.tsx files, and a registered route with no page on disk fails the other way.
    expect(REGISTERED_ROUTES.has('/payroll/statutory-forms/ea/download')).toBe(false);
  });
});

describe('the new words exist in every locale, and only the interpolated ones carry braces', () => {
  type Dict = { payroll: { statutoryForms: Record<string, string> } };
  const LOCALES: [string, Dict][] = [
    ['en', en as Dict],
    ['ms', ms as Dict],
    ['ta', ta as Dict],
    ['th', th as Dict],
    ['vi', vi as Dict],
    ['zh', zh as Dict],
  ];
  const enNs = (en as Dict).payroll.statutoryForms;
  const NEW_KEYS = [
    'directoryHint',
    'dueRule',
    'criteriaTitle',
    'criteriaHint',
    'criteria_generate',
    'criteria_continue',
    'criteria_cancel',
    'criteria_back',
    'eaSelectTitle',
    'eaSelectHint',
    'eaPickPeople',
    'eaSearchName',
    'eaSearchNamePlaceholder',
    'eaSearchCode',
    'eaSearchCodePlaceholder',
    'eaSelectAll',
    'eaClear',
    'eaSelectedCount',
    'eaGenerate',
    'eaColSelect',
    'eaColCode',
    'eaColDepartment',
    'eaNoMatch',
    'eaNoneForYear',
  ];
  /** Interpolated at render, so a missing `{…}` in a locale would print the wrong sentence, not throw. */
  const INTERPOLATED: Record<string, string[]> = {
    dueRule: ['{day}'],
    criteriaTitle: ['{form}'],
    eaPickPeople: ['{company}', '{year}'],
    eaSelectedCount: ['{count}'],
    eaNoneForYear: ['{company}', '{year}'],
  };

  it.each(LOCALES)('%s carries every new key with a real translation', (loc, dict) => {
    const ns = dict.payroll.statutoryForms;
    for (const k of NEW_KEYS) {
      expect(ns[k], `${loc}.${k}`).toBeTruthy();
      // English copied through is not a translation. The one label excluded by hand is the EA's own
      // button, which names a Malaysian form number that is not translated in any language.
      if (loc !== 'en' && k !== 'eaGenerate') {
        expect(ns[k], `${loc}.${k} is the English string`).not.toBe(enNs[k]);
      }
    }
  });

  it.each(LOCALES)('%s puts braces only where the screen passes arguments', (loc, dict) => {
    const ns = dict.payroll.statutoryForms;
    for (const k of NEW_KEYS) {
      const expected = INTERPOLATED[k] ?? [];
      for (const token of expected) expect(ns[k], `${loc}.${k} needs ${token}`).toContain(token);
      // A message carrying `{placeholders}` rendered through a plain `t('…')` with no arguments throws
      // FORMATTING_ERROR at RENDER time and paints the raw key on screen, while every static guard stays
      // green — so the ones called without arguments must have no braces at all.
      if (expected.length === 0) expect(ns[k], `${loc}.${k}`).not.toMatch(/[{}]/);
    }
  });
});
