/**
 * r256 (item 858a1128) — WHAT A STATUTORY FORM HAS TO BE TOLD BEFORE IT CAN BE PRODUCED.
 *
 * ONE module, three readers: the directory (which decides whether a card opens a criteria step or goes
 * straight through), the criteria step itself (which draws exactly the boxes named here), and
 * test/statutory-forms-criteria-858a1128.test.ts (which checks the answer for every entry the pack
 * actually registers). The defect this shape exists to prevent lives in the CONTRACT between those files
 * — a directory that sent a form to a step which then asked for the wrong thing would be tsc-clean and
 * green on any test of either half — so the rule is written once and read three times.
 *
 * IT IS DERIVED FROM THE DESTINATION, NEVER FROM THE FORM'S NAME OR ID. A catalog href declares its own
 * placeholders, so Form TP1 (`?year={year}`) asks for a year and not a company, the C.P.8A (EA) asks for a
 * company, a year and a version (`{lang}`, since r402) and NEVER a month, and a monthly report asks for
 * company, year and month. That is the
 * reporter's complaint answered at its root: the EA stopped asking for a Payroll Month because the thing
 * it opens does not take one, not because a screen was taught to special-case it.
 */

import { RUN_PARAM } from '@/lib/payroll-run-selection';

/**
 * The things a destination can ask to have chosen, in the order they are drawn.
 *
 * r402 (item f3cf2444) — `version` JOINED THEM. The C.P.8A (EA) and PCB 2(II) used to be two shelf entries
 * each, one per language; they are one entry each now, and the language is asked for here as "Version".
 * Its OPTIONS are not this module's: they are declared on the catalog entry beside the href
 * (`StatutoryFormLink.versions`), so the step offers exactly what the destination allowlists.
 */
export type CriterionKind = 'company' | 'year' | 'month' | 'version' | 'cycles';

const PLACEHOLDER: Record<string, CriterionKind> = {
  '{companyId}': 'company',
  '{year}': 'year',
  '{month}': 'month',
  '{lang}': 'version',
};

/**
 * Does this href need something chosen before it can be opened at all?
 *
 * The ONE test that decides whether a shelf card goes through the criteria step. An entry with no
 * placeholder (the CP22 worklist anchor) is one press, exactly as it always was.
 */
export const TEMPLATED = /\{(?:companyId|year|month|lang)\}/;

/** The criteria step for one catalog entry, addressed by the entry's own id. */
export const criteriaHref = (formId: string) =>
  `/payroll/statutory-forms/open?form=${encodeURIComponent(formId)}`;

export type ParsedDestination = {
  /** The form's `action` — the path with every parameter stripped off. */
  action: string;
  /** The boxes to draw, in href order. `field` is the DESTINATION's own parameter name. */
  criteria: { kind: CriterionKind; field: string }[];
  /** Everything that is not a placeholder, carried through unchanged. */
  hidden: { name: string; value: string }[];
};

/**
 * Split a catalog href into its action, the criteria it needs, and the parameters that ride along.
 *
 * The FIELD NAME is the destination's, never the placeholder's: `?year={year}` asks for a year and posts
 * it back as `year`, and a destination that later spelled it `taxYear` would keep working without this
 * module being touched.
 */
export function parseDestination(href: string): ParsedDestination {
  const [action, query = ''] = href.split('?');
  const criteria: { kind: CriterionKind; field: string }[] = [];
  const hidden: { name: string; value: string }[] = [];
  for (const pair of query.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    const kind = PLACEHOLDER[value];
    if (kind) criteria.push({ kind, field: name });
    else hidden.push({ name, value: decodeURIComponent(value) });
  }
  return { action, criteria, hidden };
}

/**
 * The criteria a generatable REPORT takes. It has no href — it is addressed by its own id and reads plain
 * search params, the exact shape `[formId]` has read since 6babf4f6 and the shape every existing bookmark
 * carries.
 *
 * `periodKind` is the ONLY input, and it is the same field `[formId]` uses to decide whether to draw a
 * month select beside the figures — so the step and the screen it opens cannot disagree about what the
 * form covers.
 */
export function reportDestination(
  reportId: string,
  periodKind: 'month' | 'year' | 'event',
  runSelection?: { action: string } | null,
  preview?: { action: string } | null,
): ParsedDestination {
  // r407 (item 4f45f9b0) — a MONTHLY form whose pack declares `runSelection` also asks for the payroll
  // cycles, and its Continue opens the form's own preview instead of the generic figures screen. Monthly
  // only: a cycle is a run of ONE month, and an annual form offered one would be a question with no answer.
  const cycles = periodKind === 'month' && runSelection ? runSelection : null;
  // r409 (item 79f3f64d) — an ANNUAL form whose pack declares `preview` continues to that preview, with
  // Company and Year and nothing else. Annual only, for the same reason in reverse.
  // r412 (item e74af58c) — and a MONTHLY form that is NOT filed per payroll cycle (Borang 8B: the employer's
  // header and an under-paid month, drawn from no run) continues to its preview with Company, Year and
  // Month. `runSelection` wins when both are declared: the cycle box is the stronger contract.
  const ownPreview = (periodKind === 'year' || (periodKind === 'month' && !cycles)) && preview ? preview : null;
  return {
    action: cycles
      ? cycles.action
      : ownPreview
        ? ownPreview.action
        : `/payroll/statutory-forms/${encodeURIComponent(reportId)}`,
    criteria: [
      { kind: 'company', field: 'companyId' },
      { kind: 'year', field: 'year' },
      // A month UNLESS the form is filed for a year — the same `periodKind === 'year'` test `[formId]`
      // applies, written the same way round, so a `periodKind` this catalog does not use today cannot make
      // the two disagree by one of them defaulting to "monthly" and the other to "annual".
      ...(periodKind === 'year' ? [] : [{ kind: 'month' as const, field: 'month' }]),
      // The field is the shared run parameter (`lib/payroll-run-selection.ts`), never a per-form spelling:
      // every destination that honours a selection reads it through `parseRunSelection`.
      ...(cycles ? [{ kind: 'cycles' as const, field: RUN_PARAM }] : []),
    ],
    hidden: [],
  };
}

/**
 * r407 (item 4f45f9b0) — THE `cycles` CRITERION, FOR EVERY MONTHLY FORM FILED PER PAYROLL CYCLE.
 *
 * Borang A was the first (r407) and LHDN CP39 joined it (r409, item 79f3f64d); SOCSO Borang 8A is next. The
 * contract, end to end:
 *
 *   1. The pack declares `runSelection: { action }` on the report (only where `generate` honours
 *      `runSeqs`). `reportDestination` above then adds `{ kind: 'cycles', field: 'run' }`.
 *   2. The criteria step (`open/page.tsx`) draws `components/run-picker.tsx` for it, fed from
 *      `CYCLES_ENDPOINT` (which calls `listFilableRunsForPeriod` through `packs/payroll/service`).
 *      SELECT ALL IS TICKED ON ARRIVAL and submits NO `run` parameter; a strict subset submits one
 *      `run=<run_seq>` per ticked cycle. Nothing ticked disables Continue.
 *   3. The destination parses the selection with `parseRunSelection` and runs the CONTINUE GATE on the
 *      server: no processed run for the month, a selection that is invalid, or a selection with nothing to
 *      file → `redirect(cyclesRefusalHref(...))`, which lands back on the step with the criteria kept and
 *      the refusal shown. NO DOCUMENT IS PRODUCED on that path.
 *   4. Everything the destination offers afterwards (preview frame, every download) carries the same
 *      `run` values. `runQueryPairs` is the one spelling of them.
 */
export const CYCLES_ENDPOINT = '/payroll/payment-submission/runs';

/** Why the Continue gate sent the operator back. The step shows the matching sentence, nothing else. */
export const CYCLES_REFUSALS = [
  'cycles_no_runs',
  'cycles_no_data',
  'cycles_invalid',
  // r409 (item 79f3f64d) — CP39: the ticked cycles ran, and nobody on them had PCB or CP38 deducted. A
  // statement of deductions with no deduction on it is not filed; "contributions" would be the wrong word.
  'cycles_no_deductions',
  // r409 — an ANNUAL form (Form E / CP8D): no processed payroll in the year chosen. No month, no cycle.
  'year_no_payroll',
  // r412 verify D1 — Borang 8B: an under-payment is declared only for a month that has ended.
  'month_not_ended',
] as const;
export type CyclesRefusal = (typeof CYCLES_REFUSALS)[number];

/** The refusal named on the URL, allowlisted — an unknown value shows nothing rather than echoing. */
export function cyclesRefusalFrom(raw: string | string[] | undefined): CyclesRefusal | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (CYCLES_REFUSALS as readonly string[]).includes(v ?? '') ? (v as CyclesRefusal) : null;
}

/** `run=…` pairs for a selection; NONE for `undefined` (all cycles), which is the no-change guarantee. */
export function runQueryPairs(runSeqs: readonly number[] | undefined): { name: string; value: string }[] {
  return (runSeqs ?? []).map((seq) => ({ name: RUN_PARAM, value: String(seq) }));
}

/**
 * Back to the criteria step, with the refusal and the criteria the operator chose, so they stay on "the same
 * screen" with their selection intact and fix the one thing that was wrong.
 */
export function cyclesRefusalHref(
  formId: string,
  p: { companyId: string; year: string; month?: string; runSeqs?: readonly number[] },
  reason: CyclesRefusal,
): string {
  // `refusal`, NOT `error`: `?error=` is the house channel for server-action failures, which
  // components/ui/toast-trigger.tsx toasts RAW and then strips from the URL — so the step would show the
  // bare code in a toast and lose its own sentence.
  return `${criteriaReturnHref(formId, p)}&refusal=${encodeURIComponent(reason)}`;
}

/** The criteria step for `formId`, re-opened on criteria already chosen — the preview's "Change selection". */
export function criteriaReturnHref(
  formId: string,
  p: { companyId: string; year: string; month?: string; runSeqs?: readonly number[] },
): string {
  // r409 — `month` is optional: an annual form's step has no Month box, so its way back carries none.
  const q = new URLSearchParams({ form: formId, companyId: p.companyId, year: p.year });
  if (p.month) q.set('month', p.month);
  for (const { name, value } of runQueryPairs(p.runSeqs)) q.append(name, value);
  return `/payroll/statutory-forms/open?${q.toString()}`;
}

/**
 * r256 — THE PERIOD THE STEP ARRIVES SHOWING, and why it is not simply "now".
 *
 * A criteria step opens with its selects already set, and whatever they are set to is what an operator who
 * presses the button without reading gets. The first cut of this page set the year to `today.slice(0, 4)`
 * and rolled only the MONTH back, which is wrong twice a year in ways that only show up in the season when
 * these forms are actually filed:
 *
 *   • On 5 January the month rolled to December and the year did not, so CP39 arrived on `2026-12` —
 *     eleven months in the FUTURE — and generated an empty return for a month that has not happened.
 *   • Through the whole of January, February and March — the C.P.8A / Form E filing season — the annual
 *     rows arrived on the year that had just BEGUN. Pressing Continue on the EA in February 2027 opened the
 *     2027 population: one month of pay, printed under a tax document's name (AGENTS 28). The year being
 *     filed in that window is 2026.
 *
 * THREE RULES, BECAUSE THERE ARE THREE KINDS OF FORM HERE, and the shape of the destination says which:
 *
 *   1. A form that takes a MONTH is filed for the month just ENDED — the submission that is actually open,
 *      the same sentence app/payroll/statutory-forms/page.tsx has carried since it had a period picker. The
 *      year rolls back WITH it, which is the half that was missing.
 *   2. A form with no month whose destination is an annual SUBMISSION (Form E / CP8D, and the two C.P.8A
 *      rows, whose population is that same report) is filed in arrears: through the filing season it is
 *      last year's return that is open, and from April the next one to be prepared is the year in progress.
 *   3. Anything else with a year and no month — Form TP1, whose destination is not one of this pack's
 *      reports at all — is a declaration for the year IN PROGRESS, and `/payroll/transactions/tp1` defaults
 *      to that same current assessment year. Defaulting it into last year would put HR on a closed year's
 *      declarations for a quarter of every year.
 *
 * `today` IS THE TENANT'S, NEVER `new Date()` — between 00:00 and 08:00 MYT the UTC date is still
 * yesterday's, and on 1 January that is a whole year out (lib/hr-date.ts, and the same reason
 * app/payroll/dashboard-logic.ts gives).
 */

/**
 * The last month of the Malaysian annual-filing season: the C.P.8A reaches employees by the last day of
 * February and Form E is filed by 31 March, so up to and including March the year being worked on is the
 * one that closed.
 */
const FILING_SEASON_LAST_MONTH = 3;

/**
 * The report a destination ultimately draws its figures from, by id — `undefined` when it opens something
 * that is not one of this pack's reports.
 *
 * TWO WAYS AN ENTRY CAN NAME ONE, and both are the pack's own words rather than this module's: a link that
 * opens a report directly carries it in its href (`my.borang-e` → `/payroll/statutory-forms/my.cp8d`), and
 * a link that opens the LIST OF PEOPLE in one declares `populationReportId` (the two C.P.8A rows → `my.cp8d`).
 * `my.tp1` opens `/payroll/transactions/tp1` and declares neither, so it resolves to nothing — which is how
 * rule 3 above tells itself apart from rule 2 without any screen naming a form.
 */
export function destinationReportId(action: string, populationReportId?: string): string | undefined {
  if (populationReportId) return populationReportId;
  const m = /^\/payroll\/statutory-forms\/([^/]+)$/.exec(action);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * What the step's selects should arrive showing, for one destination, as of the tenant's `today`.
 *
 * `target` is the destination's own report (see `destinationReportId`) or nothing. Pure, so
 * test/statutory-forms-criteria-858a1128.test.ts can run it over the pack's OWN entries on the two dates
 * the naive default got wrong — 5 January and 5 March — rather than grep for a formula.
 */
export function defaultCriteria(
  today: string,
  criteria: readonly { kind: CriterionKind }[],
  target?: { periodKind: 'month' | 'year' | 'event'; submission?: unknown } | null,
): { year: string; month: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  // Rule 1 — the month just ENDED, year and month together, so January reaches back into last December.
  const ended =
    m === 1
      ? { year: String(y - 1), month: '12' }
      : { year: String(y), month: String(m - 1).padStart(2, '0') };
  if (criteria.some((c) => c.kind === 'month')) return ended;
  // Rule 2 — an annual return, filed after the year it covers has closed. Rule 3 is the fall-through.
  const filedInArrears = target?.periodKind === 'year' && target.submission != null;
  const inSeason = m <= FILING_SEASON_LAST_MONTH;
  return { year: String(filedInArrears && inSeason ? y - 1 : y), month: ended.month };
}

/**
 * r402 (item f3cf2444) — THE VERSION THE STEP ARRIVES SHOWING.
 *
 * A version asked for in the URL (`?lang=ms`, which is what a former `my.ea.ms` bookmark redirects to) is
 * honoured when the entry declares it; anything else — absent, misspelt, a language the entry does not
 * publish — falls to the entry's FIRST declared version. Never the viewer's UI language: which language a
 * statutory form is printed in is the operator's choice, and a Chinese-language screen must not silently
 * pick a form LHDN does not publish.
 */
export function defaultVersion(
  versions: readonly { value: string }[] | undefined,
  asked: string | undefined,
): string {
  if (!versions || versions.length === 0) return '';
  return versions.some((v) => v.value === asked) ? asked! : versions[0].value;
}

/**
 * r402 (item f3cf2444) — WHERE A FORMER ENTRY ID LIVES NOW, or null.
 *
 * `my.ea.en` / `my.ea.ms` / `my.pcb2ii.en` / `my.pcb2ii.ms` are in bookmarks. The catalog entry that
 * replaced them lists them in `formerIds`, each with the version it stood for; this returns the criteria
 * step for the merged entry with that version chosen. The ids are the catalog's, not this module's.
 */
export function formerIdRedirect(
  links: readonly { id: string; formerIds?: { id: string; version: string }[] }[],
  formId: string,
  body?: string,
): string | null {
  for (const l of links) {
    const hit = l.formerIds?.find((f) => f.id === formId);
    if (hit) {
      return `${criteriaHref(l.id)}&lang=${encodeURIComponent(hit.version)}${
        body ? `&body=${encodeURIComponent(body)}` : ''
      }`;
    }
  }
  return null;
}
