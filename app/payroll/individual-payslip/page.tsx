/**
 * Feedback 169e3c24 — Individual Payslip: one named place to review, verify, print and download an
 * employee's payslip BEFORE it is released.
 *
 * REPRODUCED FIRST, AND THE FINDING WAS "adjacent screen". Most of what the ticket asks for already
 * shipped — the itemised admin breakdown lives on Transaction View → History, deliberately without the
 * ESS release gate so a processed-but-unreleased run can be inspected. What was genuinely missing:
 *   1. an entry point. Nothing in the menu said "payslip", so almost nobody found it.
 *   2. print / PDF BEFORE release. The existing PDF route reads through payslipDetail, whose release gate
 *      returns null until the batch is closed AND released — exactly backwards for a reviewer.
 *   3. year-to-date beside the current month.
 *   4. any explanation of the PCB figure, whose every input has been persisted (`pcbMeta`) and displayed
 *      nowhere since it was introduced.
 *
 * SO THIS SCREEN BORROWS RATHER THAN REBUILDS. The earnings / deductions / employer-contribution
 * derivation is `deriveHistoryBreakdown`, the same function History renders, so the two screens cannot
 * drift apart about one payslip's figures.
 *
 * THE RELEASE GATE IS NOT TOUCHED. `payslipDetail` keeps its gate for ESS; this screen and its PDF read
 * through `payslipForReview`, an admin read fenced on the caller's authorised companyIds. Different read,
 * different fence — the gate is not weakened, parameterised or bypassed.
 *
 * READ-ONLY END TO END. No row is inserted, updated, deleted or recomputed, and no employee-visible
 * figure changes.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────────────
 * r168a (feedback da4af51f) CHANGED THE EMPLOYEE CONTROL AND THE LETTERHEAD. Nothing else.
 *
 * FOUR OF THE SIX POINTS THAT REQUEST RAISED WERE ALREADY BUILT, and rebuilding them would have risked
 * working screens for nothing, so they were reproduced first and left alone:
 *   - the Year / Month / Cycle hierarchy is the GET form below, and `listProcessedPayslipsAcross` already
 *     takes all three. The "otherRuns" card renders only when matches.length > 1 — it is deliberate
 *     disambiguation between a regular and a bonus run in one month, not a history list, and it does not
 *     grow with the years.
 *     [r210 CORRECTION — this reading was wrong, twice. See the r210 section at the foot of this header:
 *     the four boxes defaulted to "All", so every run matched and the card WAS the history list it kept
 *     being reported as. It is gone, and the run number now rides in the cycle option instead.]
 *   - Earnings / Deductions / employer contributions / YTD are already separate sections.
 *   - the PCB drill-down already reads the payslip's OWN persisted `pcbMeta`, so an old slip explains
 *     itself with the numbers that were true when it ran. (r197 / 45df860a: that drill-down now LIVES at
 *     app/payroll/pcb-detail — same principle, whole working, one display shared with Transaction
 *     Detail. This screen links to it and no longer reads `pcbMeta` at all.)
 *   - Print and Download PDF are already wired.
 *
 * THE LOGO — AND A CORRECTION. The comment that used to sit on the letterhead below stated "There is NO
 * company logo anywhere in this product — no column, no upload, no storage". THAT WAS WRONG, and it was
 * wrong when 169e3c24 shipped this screen without a logo on the strength of it. `company_logo`
 * (db/schema.ts) is a 1:1 bytea side table with an upload on the Organization screen, a serve route at
 * /admin/organization/logo/[id], and `listCompanies` already returns `hasLogo` for exactly this kind of
 * caller. So the letterhead now renders it when the company has one and degrades to the legal name when it
 * does not — which is why `hasLogo` is checked rather than the <img> being left to 404.
 *
 * EMAIL PAYSLIP IS NOT BUILT, and the reason is recorded here rather than left as a silent gap: this
 * product has NO outbound mail transport. The single email path in the codebase is the auth provider's own
 * invitation call (core/auth.ts `sendInvitation`), which cannot carry an attachment. Adding one is a
 * transport, a credential, a bounce/delivery-audit story and a PDPA decision about mailing net pay — its
 * own piece of work, not a button on this screen.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────────────
 * r179 (feedback f35f758a) — THE SCREEN HALF, and f35f758a rev 2 which the reporter raised after seeing
 * it live. What r179 changed, and what survived the second look:
 *
 *   1. THE EMPLOYEE CONTROL. r179 moved it into the filter row as the shared search field and deleted the
 *      left-hand panel. The reporter asked for the panel back, so it is back — the same
 *      CollapsibleEmployeePanel / EmployeeScopePanel five other Payroll and Admin screens use, with its
 *      own search by employee ID or name and its Company / Business unit / Department / Status
 *      narrowers. It is fed the SAME scope-guarded set either way, so the guard below is untouched by
 *      both moves: the control that EXPRESSES the selection changed twice, the place it is DECIDED never
 *      did.
 *   2. THE FILTER BUTTON READS "View Payslip" — the reader is not applying a filter, they are asking for
 *      one person's payslip. KEPT.
 *   3. THE ONE LONG CARD IS NOW SEPARATE CARDS. Same sections, same order, same figures. KEPT.
 *   4. PRINT BECAME PREVIEW, AND PREVIEW IS NOW REVIEW IN A NEW TAB. Printing the WEB PAGE produced a
 *      document that was not the payslip the employee receives, which was the original complaint; r179's
 *      answer was an iframe at the foot of this screen. The reporter wants the file on its own, so the
 *      button now opens the SAME route with `?inline=1` in a new tab, where the browser's own PDF viewer
 *      prints and saves it. Preview and download still cannot disagree — they are one route — and there
 *      is no second Print control competing with the viewer's.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────────────
 * r210 (feedback 5a29686c) — THE SELECTION ROW, AND WHY THE "Payroll runs in this selection" CARD IS
 * GONE AFTER THREE ROUNDS DEFENDED IT. READ THIS BEFORE ADDING A RUN LIST BACK.
 *
 * THREE ROUNDS LOOKED AT THIS SECTION AND TWICE CONCLUDED "already works": da4af51f (r168a) and r207,
 * both reading the request as "the Year / Month / Cycle selector is missing" and both finding the
 * selector already built. r209 then narrowed Year and Month to the employee's own periods and stopped.
 * The reporter's marked-up screenshot is what settled it, and the earlier readings were wrong about the
 * SAME thing each time:
 *
 *   ALL FOUR DROPDOWNS DEFAULTED TO "All", so they never described the payslip on screen — and because
 *   they were on "All", every run the employee had matched, so the card below them listed the employee's
 *   whole history and was the only control that actually moved between payslips. The boxes were
 *   decoration. The card was the navigation. That is why it kept being reported as a payslip history
 *   that ought to be a selector: it WAS one.
 *
 * The old comment on that card was nevertheless right on its own terms — it was the only control that
 * could separate two runs sharing company, year, month and cycle. So it is not simply deleted. THE CYCLE
 * OPTION NOW CARRIES THE RUN NUMBER (`regular:1`, `bonus:2`), and `payroll_batch_period_run_uq` makes
 * run_seq unique within a pay period, so company + year + month + cycle-option names exactly ONE payslip.
 * The card became redundant only at that point; removing it before that would have taken away the sole
 * way to reach a bonus run sitting beside a regular one.
 *
 * SO: A FOURTH ROUND MUST NOT RE-ADD IT AS A "missing history list". Everything it did is now in the
 * Payroll-cycle dropdown, and every option in all four dropdowns leads to a payslip.
 *
 * The rules — the hierarchy, the dropping of a stale lower choice, and the run-number fold — live in
 * ./period-options.ts with the reasoning for each. This screen also stopped reading
 * `listProcessedPayslipsAcross` for the run list: resolving the selection against the index yields one
 * payslip id, which `payslipForReview` already reads, so it no longer pulls twenty-five payslips and
 * their `statutory` blobs in order to choose one of them.
 */
import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees, listCompanies } from '@/core/read';
// 417d4937 — today's Pay Item catalogue, for the read-time repair of record-line labels. Kept: r199
// shipped it on this screen and 45df860a does not touch it.
import { listPayComponents } from '@/core/pay-components';
// 45df860a — `currentPcbReliefs` / `explainPcb` moved WITH the PCB working to app/payroll/pcb-detail.
// This screen links to that screen; it no longer reads the tax working itself, which is the point (one
// display, not two). `listPayslipSourceTxns` stays — that is r199's ledger panel, a different feature.
// 5a29686c — `listPayslipRunsFor` is the index behind ALL FOUR selection dropdowns and behind which
// payslip they describe: every run this employee holds a payslip in, as (payslipId, companyId, period,
// runType, runSeq). r209 read only the distinct period from it; see the derivation below for why the
// other three columns had to join them.
import {
  listPayslipRunsFor,
  listPayslipSourceTxns,
  listProcessedPayslipsAcross,
  payslipForReview,
  sumPayslipYtd,
} from '@/core/payroll-view';
import { absenceDaysLabel, payslipAbsenceLines } from '@/core/payslip-absence-lines';
import { payslipEmployerBorne, type EmployerBorneKey } from '@/core/payslip-employer-borne';
import { payslipSkbbkLineShown, payslipSkbbkSubject } from '@/core/payslip-skbbk-line';
// 3c88d593 — the part of the month THIS employer employed the person for, when a mid-month entity
// transfer split it. Null on every other payslip ⇒ this screen renders exactly as it did before.
import { payslipSegmentOf } from '@/core/payslip-segment';
// r360 — the ONE rule that decides whether a payslip's cycle reads "Monthly" or "Regular", shared with
// lib/payslip-pdf-strings.ts so the screen, the preview and the downloaded file all print one answer.
import { payslipCycleLabel } from '@/core/payslip-cycle-label';
import { payrollPublicationState, PAYROLL_PUBLICATION_PILL } from '@/lib/payroll-publication';
import { payslipProvenance } from '@/core/payslip-recompute';
import { payrollProcessBack } from '../back';
import { formatMoney } from '@/lib/money';
import { packFor } from '@/localization/registry';
import { Button, Card, EmployeeName, Field, PageHeader, inputCls, pageWideCls } from '@/components/ui';
import {
  CollapsibleEmployeePanel,
  EmployeeScopePanel,
  type ScopeEmployee,
} from '@/components/collapsible-employee-panel';
import { deriveHistoryBreakdown } from '../transaction-view/history-breakdown';
// 5a29686c — the selection rules, pure so they can be asserted without a browser: which payslip the four
// dropdowns describe, and what each of them may offer.
import {
  parseRunOption,
  payslipCompanyIds,
  payslipPeriodOptionsFor,
  payslipRunChoices,
  resolvePayslipSelection,
  runOptionValue,
} from './period-options';
// 417d4937 request 10 — the shared provenance block, so this screen and Transaction View → History
// cannot drift the way the four record-line renderers already did.
import { SourceTxnBlock } from '../transaction-view/source-txn-block';
// 6b134681 / 417d4937 — one label format for a pay item across every payroll result surface: the item's
// own code and description, never the category it was classified into.
// 417d4937 — and the read-time repair for RECORD lines, whose stored name was a free-text remark until
// r196 and stays wrong on every run calculated before that deploy unless the screen reads the catalogue.
import { earningRowShown, payItemLabel, recordLineIdentity } from '@/core/payslip-earning-lines';

/** One cookie per screen — each collapses independently (the convention f3ae3245 set for Fixed). */
export const PAYSLIP_PANEL_COOKIE = 'payslip_panel';

// 5a29686c — the twelve-month literal that used to sit here now lives in ./period-options.ts as the
// no-periods FALLBACK. Keeping a second copy on this screen is how the dropdown and the rule behind it
// would drift.
// r210 — and it is now ONLY a validator. The Payroll-cycle dropdown is built from the employee's own
// runs (`payslipRunChoices`), so this list no longer decides what is offered; it decides what a `?cycle=`
// in the URL is allowed to mean, which is the `payroll_run_type` enum and nothing else.
const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;

/** Parse an optional positive-int query param within [min, max]; anything else ⇒ undefined. */
function intParam(v: string | undefined, min: number, max: number): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * f35f758a — "August 2026", not the stored "2026-08".
 *
 * The idiom this repo already uses for a month name on four screens (statutory forms, the roster,
 * scheduled actions, the EA report): `Intl.DateTimeFormat`, month long, `timeZone: 'UTC'` so a month can
 * never shift by one in a negative-offset render. No new message keys — twelve month names across six
 * locales is a translation set to keep in step for something the platform already knows.
 *
 * A SCREEN formats in the reader's own language. The downloaded document deliberately does not: its
 * embedded font is Latin-1 and a Chinese, Thai or Tamil month name would print as question marks
 * (lib/payslip-pdf-strings.ts says so at the point it pins English).
 */
function monthYear(payPeriod: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(payPeriod ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return payPeriod ?? '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}

/** The label key for each employer-borne component, exhaustive over EmployerBorneKey. */
const EMPLOYER_BORNE_LABEL: Record<EmployerBorneKey, 'epf' | 'socso' | 'skbbk' | 'eis' | 'pcb'> = {
  epf: 'epf', socso: 'socso', skbbk: 'skbbk', eis: 'eis', tax: 'pcb',
};

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value || '—'}</dd>
    </div>
  );
}

/** One card in the payslip stack. The screen used to be a single tall card with <section>s inside it. */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </Card>
  );
}

export default async function IndividualPayslipPage({
  searchParams,
}: {
  searchParams: Promise<{
    companyId?: string;
    employmentId?: string;
    year?: string;
    month?: string;
    cycle?: string;
    payslipId?: string;
    from?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.individualPayslip');
  const tSlip = await getTranslations('me.payslip');
  const tTxn = await getTranslations('payroll.transactions');
  // 6b4ca488 — the Statutory Explanation's own namespace, shared with /payroll/statutory-detail, its
  // export route and Transaction View's ?tab=statutory. One catalogue block per display.
  const tStat = await getTranslations('payroll.statutoryDetail');
  // r360 — the "Reg. no." caption for the letterhead, from the namespace that OWNS the company
  // registration number (Organization → General). The same key `lib/payslip-pdf-strings.ts` resolves for
  // the document, so the screen and the file cannot label one number two different ways.
  const tOrg = await getTranslations('admin.organization');
  const locale = await getLocale();
  const sp = await searchParams;
  // 9066bd6c — Back to the Payroll Process list, as it was left (year, months, company, cycle, status
  // ride the `from` query the list hands its row links). This screen had no back link of any kind. The
  // label and its `payroll.list` lookup live in the shared helper — see app/payroll/back.ts.
  const back = await payrollProcessBack(sp.from);

  // 417d4937 — the tenant's live Pay Items, keyed by CODE, for the record-line label repair below.
  // `includeArchived` on purpose: an archived item can still be the code on an already-calculated run,
  // and its real description is a better answer than a remark that was never that item's.
  const [employees, companies, payItems] = await Promise.all([
    listEmployees(s, scopeIds),
    listCompanies(s),
    listPayComponents(s, { includeArchived: true }),
  ]);
  const payItemNames: Record<string, string> = Object.fromEntries(payItems.map((c) => [c.code, c.name]));
  const scopedCompanies = companies.filter((c) => scopeIds.includes(c.id));

  // SCOPE-GUARD every ?param, exactly as Transaction View does: an out-of-scope companyId/employmentId is
  // treated as "no selection", so URL tampering can only ever narrow, never widen. This guard is UNCHANGED
  // by r179 — the control that expresses the selection moved, the place it is DECIDED did not.
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : undefined;
  const companyIds = companyId ? [companyId] : scopeIds;
  const employmentId =
    sp.employmentId && employees.some((e) => e.employmentId === sp.employmentId) ? sp.employmentId : undefined;
  const year = intParam(sp.year, 2000, 2100);
  const month = intParam(sp.month, 1, 12);
  // r210 — `?cycle=` now carries the run NUMBER as well ('bonus:2'), because the run type alone does not
  // name a run. Guarded in two halves: the type against the enum above, exactly as before, and the
  // sequence by shape. A bare 'bonus' still parses — every link made before r210 carries one — and means
  // "any run of that type". Neither half can widen anything: both only ever narrow the index below.
  const parsedCycle = parseRunOption(sp.cycle);
  const cycle = CYCLES.includes(parsedCycle?.runType as (typeof CYCLES)[number]) ? parsedCycle!.runType : undefined;
  const cycleRunSeq = cycle ? parsedCycle!.runSeq : undefined;

  // Resolved on the SERVER from the cookie so first paint is already correct; absent ⇒ expanded.
  const panelDefaultOpen = (await cookies()).get(PAYSLIP_PANEL_COOKIE)?.value !== '0';
  // Fed the SAME set the scope guard above accepts, so the panel cannot offer a row the server refuses.
  const panelEmployees: ScopeEmployee[] = employees.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    company: e.company,
    companyId: e.companyId,
    department: e.department,
    departmentId: e.departmentId,
    businessUnit: e.businessUnit,
    businessUnitId: e.businessUnitId,
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));
  // 009c8a37 — who the header row names. Read off the SAME already-fenced list the scope guard accepted,
  // so it can never name somebody the page refused.
  const selectedEmp = employmentId ? (employees.find((e) => e.employmentId === employmentId) ?? null) : null;
  // The period filters ride along when the employee changes — these are the GUARDED values, not the raw
  // params. `payslipId` deliberately does NOT: it names a run belonging to the person being navigated away
  // from, and carrying it would ask the next employee's list for someone else's payslip.
  //
  // r210 — `companyId` and `cycle` join `payslipId` in NOT riding along, and for the same reason. Now that
  // the boxes describe the payslip instead of sitting on "All", they are always filled in, so carrying
  // them would hand the next person the previous person's employer — and company is the one choice this
  // screen never relaxes, so a colleague at another entity would open on "no payroll has been calculated"
  // rather than on their own latest payslip. Year and month DO ride along: comparing one month across
  // people is a real reason to switch employee, and a month the next person has no run in is dropped by
  // the resolution below rather than dead-ending.
  const panelPreserve: Record<string, string> = {
    ...(year != null ? { year: String(year) } : {}),
    ...(month != null ? { month: String(month).padStart(2, '0') } : {}),
  };

  // A payslip only loads once an EMPLOYEE is chosen — the ticket's flow (period → employee → payslip),
  // and also what keeps this screen from becoming a second, slower copy of History.
  //
  // 5a29686c / r210 — ONE indexed read backs all four dropdowns AND the choice of payslip: every run this
  // employee holds a payslip in, as (payslipId, companyId, period, runType, runSeq). It replaces the
  // twenty-five-payslip `listProcessedPayslipsAcross` this screen used to issue for the same purpose, so
  // it is a round trip fewer and a great deal less payload, not more.
  //
  // FENCED ON THE WHOLE AUTHORISED SCOPE, NOT ON `companyIds`, and that is deliberate: `companyIds`
  // narrows to the chosen company, and a Company dropdown built from a company-narrowed index could only
  // ever offer the company already chosen. The company narrowing happens in the pure rule instead, which
  // is a filter over rows the reader is already entitled to see. `scopeIds` is the same fence
  // `listEmployees` above ran under, so this cannot reach a company the reader does not hold.
  const runs = employmentId ? await listPayslipRunsFor(s, { companyIds: scopeIds, employmentId }) : [];

  // ── r210: WHICH PAYSLIP THE FOUR BOXES DESCRIBE ──
  // The rules (and why each one is a rule) live in ./period-options.ts, pure and asserted directly — a
  // selection that resolves to the wrong payslip, or a dropdown that quietly empties, still renders and
  // still returns 200, so none of this is safe to leave unpinned here. In short: company is honoured
  // strictly, an explicit `payslipId` wins outright, and a stale year / month / run posted by the GET
  // form is dropped rather than answered with an empty screen.
  const sel = resolvePayslipSelection(runs, {
    companyId,
    payslipId: sp.payslipId,
    year,
    month,
    runType: cycle,
    runSeq: cycleRunSeq,
  });
  const selRun = sel.runType != null && sel.runSeq != null ? runOptionValue(sel.runType, sel.runSeq) : '';

  // WHAT EACH BOX DISPLAYS: the resolved payslip's own value, falling back to the guarded query when
  // nothing resolved (a company this employee was never paid by, or an employee who has never been paid).
  // r209's rule 2 in both directions — the control and what was applied always agree, and the value on
  // show is always one of the options, so no <select> can silently display a different one.
  const showCompanyId = sel.companyId ?? companyId ?? '';
  const showYear = sel.year ?? year;
  const showMonth = sel.month ?? month;
  const showRun = selRun || (cycle ? (cycleRunSeq != null ? runOptionValue(cycle, cycleRunSeq) : cycle) : '');

  // …AND WHAT EACH BOX OFFERS. Every list is narrowed by the levels ABOVE it and by nothing below —
  // Company by nothing, Year by the company showing, Month by that year, the run by that month. Narrowing
  // every list by the other three reads as the tighter rule and strands whole companies behind it;
  // ./period-options.ts note 1 has the worked example. All four are fed the SHOWN values, so the box and
  // its own options can never be derived from different selections.
  const shown = { companyId: showCompanyId || undefined, year: showYear, month: showMonth };
  const companyChoices = new Set(payslipCompanyIds(runs, shown.companyId));
  const companyOptions = scopedCompanies.filter((c) => companyChoices.has(c.id));
  const { years, months } = payslipPeriodOptionsFor(
    employmentId != null,
    runs.filter((r) => shown.companyId == null || r.companyId === shown.companyId).map((r) => r.payPeriod),
    shown,
    new Date().getFullYear(),
  );
  const runOptions = payslipRunChoices(runs, shown, showRun);

  // One payslip id, one read. `companyIds` is unchanged from what the guard above produced, so the fence
  // this row is read through is exactly the fence it was read through before r210.
  const row = sel.payslipId ? await payslipForReview(s, { companyIds, payslipId: sel.payslipId }) : null;
  // 417d4937 (request 10) — the one-off transactions recorded against THIS employee on THIS run, so the
  // screen can answer "where did this recorded item come from?" without a report. One indexed query,
  // fenced on the same `companyIds` as the payslip itself, and only once a payslip has been chosen.
  const sourceTxns =
    row?.batchId != null
      ? await listPayslipSourceTxns(s, {
          companyIds,
          batchIds: [row.batchId],
          // Narrowed IN THE QUERY rather than by a `.filter` on the result: this screen shows one payslip,
          // so fetching the whole run's ledger and discarding all but one employee's rows was work and
          // payload nobody could see.
          employmentIds: [row.employmentId],
        })
      : [];

  // Year-to-date: the same read for the whole year, no month. No new query shape is needed — the totals
  // are summed from the rows it already returns, so YTD can never disagree with the months it lists.
  // ⚠️ `scopeIds`, NOT `companyIds`, AND THAT IS THE WHOLE OF r210's BLOCKER. The Company box now always
  // displays the resolved payslip's company, so pressing "View payslip" posts a `?companyId=` where
  // arriving from the employee panel or a back-link posts none. Both render the same four boxes. If YTD
  // narrowed with the selection, those two identical-looking screens would print DIFFERENT year figures
  // for a transferred employee — measured: gross 13,200.00 on arrival, 6,600.00 after a no-op submit —
  // and the second would disagree with the PDF of the very payslip beside it, which sums the year over
  // `scopeIds` unconditionally (see [payslipId]/pdf/route.ts and its "cannot disagree about the year"
  // note). The company selection chooses WHICH PAYSLIP you are looking at; it does not change what a
  // year-to-date figure means. Selecting a company must never silently redefine the column.
  const ytdRows =
    row && employmentId
      ? await listProcessedPayslipsAcross(s, {
          companyIds: scopeIds,
          year: Number(row.payPeriod.slice(0, 4)),
          employmentId,
        })
      : [];
  // 5c198931 — the summation moved to core/payroll-view.ts `sumPayslipYtd` (unchanged arithmetic) because
  // the downloaded document now prints this column too. A screen and a document each running their own
  // reduce over the same rows is how the two start disagreeing about someone's year.
  const ytd = sumPayslipYtd(ytdRows);

  const b = row ? deriveHistoryBreakdown(row) : null;
  const eb = row ? payslipEmployerBorne(row.statutory) : null;
  // e2632276 — split "Other deductions" into its named unpaid-leave / absence lines plus the residual.
  // Derived from the PAYSLIP'S OWN stamp, never from today's policy: a slip run before this shipped has no
  // stamp and renders the single lumped row exactly as it always has.
  const absence = payslipAbsenceLines(row?.statutory, row?.otherDeductions);
  // 45df860a — the PCB working (and the relief fallback it needs) is read by app/payroll/pcb-detail, the
  // ONE screen that shows it. This screen links there.
  const prov = row ? payslipProvenance(row.statutory) : null;
  // 3c88d593 — the entity segment this slip covers, from the slip's OWN record. Null for every payslip
  // whose month was not split by a transfer.
  // 1b0943d5 — "its own record" is now the coverage window: the 0446 columns, falling back to the r194
  // jsonb stamp and then to the whole period. Segmented means narrower than the period, so this screen,
  // both PDF routes and the completeness control all read ONE fact.
  const segment = row ? payslipSegmentOf(row, row.payPeriod) : null;
  // 3c88d593's `matchesSpanCompanies` retired with the run chips it labelled. The case it existed for —
  // two August regular runs, same month, same cycle, different employer after a mid-month transfer — is
  // now told apart by the Company dropdown, which is where the reader picks the employer anyway.
  const cur = row?.currency ?? null;
  const rm = (n: unknown) => formatMoney(n, cur);
  const hrdfRegistered = row
    ? ((await packFor('MY')?.companyStatutory.list(s)) ?? [])
        .filter((r) => r.hrdfStatus !== 'not_registered')
        .some((r) => r.companyId === row.companyId)
    : false;

  const pubState = row ? payrollPublicationState({ status: row.batchStatus, releasedAt: row.releasedAt }) : null;
  // `listCompanies` already returns hasLogo (an EXISTS against company_logo — the bytea itself lives in a
  // side table and is never pulled by this read), and it is already loaded above. No new query.
  const companyHasLogo = row ? companies.some((c) => c.id === row.companyId && c.hasLogo) : false;
  const pdfHref = row ? `/payroll/individual-payslip/${row.id}/pdf` : '';

  return (
    // 152fea7f — the SCREEN is full width like every other Payroll screen; PRINT keeps the centred 4xl
    // measure it has always had. `pageWideCls` drops the `mx-auto` the old cap carried, so the print
    // variant has to restate it or a printed payslip would sit hard against the left edge.
    <div className={`${pageWideCls} print:mx-auto print:max-w-4xl`}>
      <div className="print:hidden">
        <PageHeader back={back} title={t('title')} description={t('subtitle')} />
      </div>

      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={PAYSLIP_PANEL_COOKIE}
        // 009c8a37 — the header row, on the same horizontal line as the Hide/Show control. `print:hidden`
        // because on THIS screen the output is a printed payslip: the letterhead below carries the
        // employee, and this row is chrome that must not land above it. Same reason the toggle itself has
        // carried that class since r168 (a stray "Hide employee list" line once printed there).
        headerClassName="print:hidden"
        title={t('title')}
        detailHeader={
          selectedEmp ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
              <EmployeeName
                code={selectedEmp.employeeCode}
                name={selectedEmp.name}
                className="text-sm font-semibold text-foreground"
              />
              <span className="text-xs text-muted-foreground">{selectedEmp.company}</span>
            </div>
          ) : undefined
        }
        panel={
          /* The employee control (da4af51f, removed by r179 and RESTORED at the reporter's request). It
             is the shared searchable panel five other Payroll and Admin screens carry, so this screen
             behaves like the rest of Payroll rather than like a one-off. */
          <Card className="p-4 print:hidden">
            <h2 className="text-sm font-semibold">{t('filterEmployee')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('chooseEmployeeHint')}</p>
            <div className="mt-3">
              <EmployeeScopePanel
                employees={panelEmployees}
                selectedId={employmentId ?? null}
                basePath="/payroll/individual-payslip"
                preserve={panelPreserve}
              />
            </div>
          </Card>
        }
      >
        <div className="space-y-6">
      {/* ── Period selection (GET form — pure navigation, no mutation) ──
          The EMPLOYEE has left this form for the panel; it carries the current one as a hidden input so
          changing the year does not silently deselect the person you were looking at. `payslipId`
          deliberately does NOT ride along: it names a run belonging to whoever was selected before, and
          carrying it would ask the next employee's list for someone else's payslip.

          r210 — THESE FOUR BOXES NOW DESCRIBE THE PAYSLIP BELOW THEM instead of sitting on "All", and each
          list holds only what this employee actually has. That is the whole of feedback 5a29686c: while
          they read "All" they described nothing, every run matched, and the card that used to sit under
          this one was the only thing that moved between payslips — which is why it kept being reported as
          an over-long payslip history. "All" survives as the first option in each box because it is still
          the honest way to say "no opinion, show me the latest"; it is no longer the DEFAULT. */}
      <Card className="p-4 print:hidden">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          {employmentId && <input type="hidden" name="employmentId" value={employmentId} />}
          <Field label={t('filterCompany')}>
            {/* Not `scopedCompanies` — the reader's whole scope offered companies this employee has never
                been paid by. Company is the top of the hierarchy and is narrowed by nothing below it, so a
                transferred employee keeps both employers here and neither becomes unreachable. */}
            <select name="companyId" defaultValue={showCompanyId} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {companyOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterYear')}>
            <select name="year" defaultValue={showYear != null ? String(showYear) : ''} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterMonth')}>
            <select
              name="month"
              defaultValue={showMonth != null ? String(showMonth).padStart(2, '0') : ''}
              className={inputCls}
            >
              <option value="">{tTxn('view.filters.all')}</option>
              {months.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterCycle')}>
            {/* THE OPTION VALUE CARRIES THE RUN NUMBER, and that is what retired the run-picker card.
                A run number is unique within a pay period, so company + year + month + this value names
                exactly one payslip. The number is shown only when it is above 1 — "Bonus run 2" beside
                "Regular", never "Regular run 1" on the ordinary month that has only one run. */}
            <select name="cycle" defaultValue={showRun} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {runOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.runSeq > 1
                    ? t('cycleRun', { cycle: tTxn(`individual.cycle.${o.runType}`), n: o.runSeq })
                    : tTxn(`individual.cycle.${o.runType}`)}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary">
            {t('viewPayslip')}
          </Button>
        </form>
      </Card>

      {!employmentId && <p className="text-sm text-muted-foreground">{t('chooseEmployeeHint')}</p>}
      {employmentId && !row && <p className="text-sm text-muted-foreground">{t('noPayslip')}</p>}

      {row && b && eb && (
        <>
          {/* ── Letterhead ──
              The logo is the company's OWN uploaded file, served by the existing
              /admin/organization/logo/[id] route — the same bytes the Organization screen shows, so the
              payslip cannot display a different mark from the rest of the product. It is rendered only when
              `hasLogo` says one exists (from `listCompanies`, an EXISTS against the side table — never the
              blob), because an <img> pointed at a 404 shows a broken-image icon on a payslip, which is
              worse than a clean text letterhead. No placeholder is invented when there is none. */}
          <Card className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                {companyHasLogo && (
                  /* eslint-disable-next-line @next/next/no-img-element -- a bytea served by our own route,
                     not a build-time asset; next/image would need a loader for an authenticated endpoint. */
                  <img
                    src={`/admin/organization/logo/${row.companyId}`}
                    alt={row.company}
                    className="mb-2 max-h-14 w-auto max-w-[14rem] object-contain"
                  />
                )}
                <h1 className="text-lg font-semibold tracking-tight">{row.company}</h1>
                {/* r360 (1fe55a23) — THE REGISTRATION NUMBER NOW SAYS WHAT IT IS.
                    It has always been drawn here, directly under the legal name, but with no caption at
                    all: the reader met a bare "201901024512" under a company name, which is how an
                    unidentified number on a payroll document gets read as an amount. (The DOCUMENT had the
                    same line and a96d320c rev 3 removed it rather than label it; r360 labels both, so the
                    screen and the file it downloads now agree.) `admin.organization.regNo` is the caption
                    the screen that owns the field already uses — not a new key.
                    ABSENT ⇒ NO LINE, not an empty caption and not a dash: `company.registration_no` is
                    nullable and most companies on production carry none, and a printed "Reg. no. —" would
                    assert that we looked and there is none. */}
                {row.companyReg && (
                  <p className="text-xs text-muted-foreground">
                    {tOrg('regNo')} {row.companyReg}
                  </p>
                )}
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('payPeriodLine', { period: monthYear(row.payPeriod, locale) })}
                  {row.payDate ? ` · ${t('payDateLine', { date: row.payDate })}` : ''}
                </p>
                {/* 3c88d593 — WHAT THIS SLIP ACTUALLY COVERS. "August 2026" is not what a slip for
                    1–10 August says, and an employee who transferred mid-month holds TWO documents for
                    one month, each naming a different employer. Without this line the two are
                    indistinguishable on the page they are read on. Rendered ONLY when the payslip carries
                    the stamp, so every unsegmented slip — which is all of them until somebody transfers —
                    is byte-identical to before. */}
                {segment && (
                  <p className="text-sm font-medium text-foreground">
                    {t('segmentPeriodLine', { from: segment.from, to: segment.to })}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PAYROLL_PUBLICATION_PILL[pubState!]}`}>
                  {t(`state_${pubState}`)}
                </span>
                {row.version > 1 && (
                  <span className="text-xs text-muted-foreground">{t('revision', { n: row.version })}</span>
                )}
                {/* Download stays; Print became Preview (r179) and Preview became REVIEW IN A NEW TAB
                    (rev 2). Printing the WEB PAGE produced something that was not the document the
                    employee receives, which was the complaint; r179's answer framed the real file in an
                    iframe at the foot of this screen, and the reporter would rather have it on its own.
                    So this opens the SAME route the Download button uses with `?inline=1`, which the
                    route already honours with an inline Content-Disposition and nosniff — preview and
                    download still cannot disagree, and the browser's own PDF viewer supplies Print and
                    Save. `rel="noopener noreferrer"` because `target="_blank"` otherwise hands the new
                    document a live `window.opener` handle back to this screen. */}
                <div className="flex items-center gap-2 print:hidden">
                  <a
                    href={pdfHref}
                    download
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    {tSlip('downloadPdf')}
                  </a>
                  <a
                    href={`${pdfHref}?inline=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    {t('previewDocument')}
                  </a>
                </div>
              </div>
            </div>
          </Card>

          {/* ── Employee information ── */}
          <Block title={t('employeeHeading')}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Info label={t('fieldEmployeeCode')} value={row.employeeCode} />
              <Info label={t('fieldEmployeeName')} value={row.employeeName} />
              <Info
                label={row.identityIsPassport ? t('fieldPassport') : t('fieldIc')}
                value={row.identityNumber}
              />
              {/* 5c198931 — the statutory registration numbers the downloaded document prints. Added here
                  so the preview and the download show the same employee record, which was the whole
                  complaint: the two had drifted. SOCSO and EIS share ONE number — there is no separate EIS
                  column on employee_statutory_my, and the attached design prints them as one field. */}
              <Info label={t('fieldEpfNumber')} value={row.epfNumber} />
              <Info label={t('fieldSocsoNumber')} value={row.socsoNumber} />
              <Info label={t('fieldTaxNumber')} value={row.taxNumber} />
              <Info label={t('fieldDepartment')} value={row.department} />
              <Info label={t('fieldPosition')} value={row.position} />
              <Info label={t('fieldGrade')} value={row.jobGrade} />
              <Info
                label={t('fieldEmploymentType')}
                value={row.employmentType ? t(`employmentType_${row.employmentType}`) : null}
              />
              <Info
                label={t('fieldPaymentMethod')}
                value={row.paymentMethod ? t(`paymentMethod_${row.paymentMethod}`) : null}
              />
              {/* Masked in the READ, not here: the full account number never reaches the client. */}
              <Info
                label={t('fieldBankAccount')}
                value={row.bankAccountMasked ? `${row.bankName ?? ''} ${row.bankAccountMasked}`.trim() : null}
              />
              <Info label={t('fieldCurrency')} value={row.currency} />
              <Info label={t('fieldDaysWorked')} value={row.daysWorked ?? '—'} />
              {/* r360 (1fe55a23) — THE COMPANY'S OWN PAY CYCLE NAME, not the kernel's run-type word.
                  "Regular" is `payroll_batch.run_type`, one of four fixed behavioural types the kernel
                  gates on and nobody in the company chose; "Monthly" is `payroll_cycle.name`, the label the
                  Payroll Process wizard offered when this run was opened (ADR-0069). The reporter asked for
                  the second one on the payslip.
                  RESOLVED THROUGH THE SHARED RULE, not inline: `payslipCycleLabel` is the same function
                  lib/payslip-pdf-strings.ts calls for the letterhead subtitle, so the downloaded file and
                  this screen can never disagree about which word a payslip's cycle is called.
                  NO CYCLE ⇒ the run-type word, exactly as this field printed before r360. */}
              <Info
                label={t('fieldCycle')}
                value={payslipCycleLabel({
                  cycleName: row.cycleName,
                  runTypeLabel: tTxn(`individual.cycle.${row.runType}`),
                })}
              />
            </dl>
          </Block>

          {/* ── Earnings ── */}
          <Block title={tSlip('earnings')}>
            <Row label={tSlip('basicSalary')} value={rm(b.basic)} />
            {/* a96d320c rev 2 — AN EARNING LINE WITH NOTHING ON IT IS NOT SHOWN. This screen is the admin
                REVIEW COPY of the payslip and it is where the PDF is downloaded from, so it follows the
                document: lib/payslip-pdf.ts stops printing a zero Allowance / Overtime / Bonus in the same
                round, and a screen that kept them would contradict the file it just produced. The test is
                the STORED figure (`deriveHistoryBreakdown` off this payslip's own snapshot), never today's
                pay-item setup. Basic salary is deliberately exempt, as are the statutory deduction lines
                below — see core/payslip-earning-lines.ts and lib/payslip-pdf.ts `earningsRowsOf`.

                `|| <list>.length > 0`: a sub-line list belongs TO its row. A figure that is zero because
                its named items cancel out keeps its row, prints 0.00, and shows the items under it —
                hiding the heading and leaving the detail would be an orphan. */}
            {(earningRowShown(b.allowanceNet) || b.allowanceLines.length > 0) && (
              <Row label={tSlip('allowances')} value={rm(b.allowanceNet)} />
            )}
            {/* 417d4937 — wage AND reimburse (a PCB-exempt allowance is stamped into `reimburse`, is
                paid, and is inside this figure), and 6b134681 — labelled by CODE · DESCRIPTION, the same
                identification the Recorded items rows and the printed payslip use. This screen reads the
                identical derivation the History grid does, so the two cannot name one item differently. */}
            {b.allowanceLines.map((l, i) => (
              <p key={`w${i}`} className="flex justify-between ps-3 text-xs text-muted-foreground">
                <span>{payItemLabel(l)}</span>
                <span className="tabular-nums">{rm(l.amount)}</span>
              </p>
            ))}
            {(earningRowShown(b.overtime) || b.overtimeLines.length > 0) && (
              <Row label={tSlip('overtime')} value={rm(b.overtime)} />
            )}
            {/* 6b134681 — `overtimeLines` / `bonusLines`, not `componentsByBucket.*`: the derivation has
                already checked that these rows add up to the figure above them, the same reconciliation
                the printed payslip and the ESS payslip apply. The two lists are NOT interchangeable —
                the figure is the DISPLAY box (3c473773) while the bucket is the KERNEL's statutory
                routing, and an item declared into the Overtime box but bucketed as `bonus` would
                otherwise print an itemised row under a zero Bonus total. */}
            {b.overtimeLines.map((l, i) => (
              <p key={`o${i}`} className="flex justify-between ps-3 text-xs text-muted-foreground">
                <span>{payItemLabel(l)}</span>
                <span className="tabular-nums">{rm(l.amount)}</span>
              </p>
            ))}
            {b.otConvertAmount > 0 && (
              <Row
                label={tSlip('otConverted', { item: (b.st.otConvert?.name ?? '') })}
                value={rm(b.otConvertAmount)}
              />
            )}
            {(earningRowShown(b.bonus) || b.bonusLines.length > 0) && (
              <Row label={tSlip('bonus')} value={rm(b.bonus)} />
            )}
            {/* 6b134681 — "B0001 · ANGPOW" under Bonus. The bonus box is a statutory classification
                (additional remuneration for EPF/PCB); it never gets to replace the pay item's own name.
                Reconciled in the derivation, as above. */}
            {b.bonusLines.map((l, i) => (
              <p key={`b${i}`} className="flex justify-between ps-3 text-xs text-muted-foreground">
                <span>{payItemLabel(l)}</span>
                <span className="tabular-nums">{rm(l.amount)}</span>
              </p>
            ))}
            {earningRowShown(b.claim) && <Row label={tSlip('claim')} value={rm(b.claim)} />}
            {b.detailNotRecorded && (
              <p className="pt-1 text-[11px] text-muted-foreground">{tTxn('view.history.detailNotRecorded')}</p>
            )}
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
              <span>{tSlip('grossPay')}</span>
              <span className="tabular-nums">{rm(b.gross)}</span>
            </div>
          </Block>

          {/* ── Deductions, with the PCB drill-down beneath ── */}
          <Block title={tSlip('deductionsHeading')}>
            <Row label={tSlip('epf')} value={rm(eb.employee.epf)} />
            <Row label={tSlip('socso')} value={rm(eb.employee.socso)} />
            {/* a96d320c rev 2 — the ELECTION, not the amount. One predicate, shared with the printed
                document and the other two payslip surfaces: core/payslip-skbbk-line.ts. */}
            {payslipSkbbkLineShown(payslipSkbbkSubject(b.st), eb.employee.skbbk) && (
              <Row label={tSlip('skbbk')} value={rm(eb.employee.skbbk)} />
            )}
            <Row label={tSlip('eis')} value={rm(eb.employee.eis)} />
            {/* 45df860a — the PCB amount is a LINK to the shared calculation screen, exactly as it now is
                on Transaction Detail. Same href, same screen, so the two entry points cannot show one
                employee two different workings. */}
            <Row
              label={tSlip('pcb')}
              value={
                <a
                  href={`/payroll/pcb-detail?payslipId=${encodeURIComponent(row.id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 hover:no-underline print:no-underline"
                >
                  {rm(eb.employee.pcb)}
                </a>
              }
            />
            {Number(b.st.cp38) > 0 && <Row label={tSlip('cp38')} value={rm(b.st.cp38)} />}
            {/* 3a092cf0 — a real deduction line now, un-muted, with the amount alone in the figure column
                and the offset note on the label. See app/me/payslip/[payslipId]/page.tsx for the full
                note; the two surfaces render one payslip and must not print it differently. */}
            {Number(b.st.zakat) > 0 && (
              <Row label={`${tSlip('zakat')} · ${tSlip('zakatOffsetNote')}`} value={rm(b.st.zakat)} />
            )}
            {/* e2632276 — the unpaid-leave and absence halves of the old unnamed lump, each with its own
                day count. `residual` is what is left of Other deductions once they come out of it, so
                the section still sums to Total deductions; a payslip with no stamp takes the `any:false`
                path and prints the single lumped row exactly as before. */}
            {absence.unpaidLeave && (
              <Row
                label={`${tSlip('unpaidLeaveLine')} · ${absenceDaysLabel(absence.unpaidLeave.days, tSlip('dayUnit'), tSlip('daysUnit'))}`}
                value={rm(absence.unpaidLeave.amount)}
              />
            )}
            {absence.absent && (
              <Row
                label={`${tSlip('absentLine')} · ${absenceDaysLabel(absence.absent.days, tSlip('dayUnit'), tSlip('daysUnit'))}`}
                value={rm(absence.absent.amount)}
              />
            )}
            {absence.showResidual && <Row label={tSlip('otherDeductions')} value={rm(absence.residual)} />}
            {/* 6b4ca488 — NO minus sign. `deriveHistoryBreakdown` returns `totalDeductions` as a POSITIVE
                magnitude (it always has), so the U+2212 that used to sit here was a literal character
                glued onto an already-positive figure, not a negative value. It read as "minus RM1,234"
                under a heading that already says Deductions, i.e. a double negative, and it made the
                printed slip disagree with the PDF and with every export, none of which carry it. Removing
                it touches display only — nothing downstream reads this string. Pinned by a source-shape
                assertion in test/individual-payslip.test.ts so it cannot creep back on any of the three
                surfaces that render this line. */}
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
              <span>{tSlip('totalDeductions')}</span>
              <span className="tabular-nums">{rm(b.totalDeductions)}</span>
            </div>

            {/* ── PCB working: ONE screen, not a second copy of it (45df860a) ──
                169e3c24 put a short drill-down here, reading this payslip's own `pcbMeta`. It was right
                about the principle — never recompute — and short of what a payroll checker needs: it
                stopped before the tax bracket, the EPF legs and the formula itself, so the working could
                not be closed. The reporter asked for the full working AND for Transaction Detail to reach
                it, and said why in one line: "This avoids having two different PCB calculation engines or
                two different calculation displays."
                So the disclosure is REPLACED by a link rather than joined by one. Growing this panel to
                the full working would have produced exactly the second display the request rules out —
                two screens, one calculation, free to drift. The keys the disclosure used are deliberately
                LEFT in all six catalogs: re-adding a deleted key later is the MISSING_MESSAGE trap. */}
            <div className="mt-4 rounded-lg border border-border p-3">
              <p className="text-sm font-medium">{t('pcbHeading')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('pcbDetailHint')}</p>
              <a
                href={`/payroll/pcb-detail?payslipId=${encodeURIComponent(row.id)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted print:hidden"
              >
                {t('pcbViewCalculation')}
              </a>
            </div>

            {/* ── Statutory working: the other five, and the same refusal (6b4ca488) ──
                PCB has had a drill-down since 45df860a; EPF, SOCSO, EIS, SKBBK and HRDF had the amount
                and nothing else — no wage the contribution was charged on, no rule, no split between
                what came off take-home and what the employer funded. This is a LINK for the identical
                reason the PCB disclosure above is: growing this panel into the working would be a second
                display of one calculation, free to drift from the screen Transaction View's
                ?tab=statutory renders. Both render app/payroll/statutory-detail/statutory-detail-view.
                Addressed by THIS payslip's id, so the explanation is of the slip on screen and of no
                other — and read off that slip's own stamp, never recomputed from today's rates. */}
            <div className="mt-3 rounded-lg border border-border p-3">
              <p className="text-sm font-medium">{tStat('title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{tStat('payslipHint')}</p>
              <a
                href={`/payroll/statutory-detail?payslipId=${encodeURIComponent(row.id)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted print:hidden"
              >
                {tStat('viewExplanation')}
              </a>
            </div>
          </Block>

          {/* ── Employer contributions, with the employer-borne disclosure folded in (3c473773) ── */}
          <Block title={tSlip('employerContributionsHeading')}>
            <Row label={tSlip('epf')} value={rm(b.employerContributions.epf)} muted />
            <Row label={tSlip('socso')} value={rm(b.employerContributions.socso)} muted />
            <Row label={tSlip('eis')} value={rm(b.employerContributions.eis)} muted />
            <Row
              label={tSlip('hrdf')}
              value={hrdfRegistered ? rm(b.employerContributions.hrdf) : tTxn('view.history.hrdfNotRegistered')}
              muted
            />
            <Row label={tSlip('totalEmployerCost')} value={rm(row.employerCost)} muted />

            {eb.any && (
              <div className="mt-4 border-t border-border pt-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {tSlip('employerBorneHeading')}
                </h3>
                {eb.keys.map((k) => (
                  <Row key={k} label={tSlip(EMPLOYER_BORNE_LABEL[k])} value={rm(eb.borne[k])} />
                ))}
                <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                  <span>{tSlip('employerBorneTotal')}</span>
                  <span className="tabular-nums">{rm(eb.total)}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{tSlip('employerBorneNote')}</p>
              </div>
            )}
          </Block>

          {/* ── Net pay ──
              The one figure the reader looks for first, so it gets the strongest treatment on the screen
              exactly as it does on the document. Presentation only: the figure and its source are
              untouched. */}
          <Card className="flex items-baseline justify-between bg-primary px-6 py-5 text-primary-foreground">
            <span className="text-sm font-semibold uppercase tracking-wide">{tSlip('netPay')}</span>
            <span className="text-2xl font-bold tabular-nums">{rm(b.net)}</span>
          </Card>

          {/* ── Year to date ──
              Summed from the SAME read that lists this employee's months, so the column beside the
              current month can never disagree with the months it is made of. */}
          <Block title={t('ytdHeading', { year: row.payPeriod.slice(0, 4) })}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">{t('ytdItem')}</th>
                    <th className="py-1 text-right font-medium">{t('ytdCurrent')}</th>
                    <th className="py-1 text-right font-medium">{t('ytdToDate')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {(
                    [
                      [tSlip('grossPay'), b.gross, ytd.gross],
                      [tSlip('epf'), b.st.epfEmployee ?? 0, ytd.epf],
                      [tSlip('socso'), b.st.socsoEmployee ?? 0, ytd.socso],
                      [tSlip('eis'), b.st.eisEmployee ?? 0, ytd.eis],
                      [tSlip('pcb'), b.st.pcb ?? 0, ytd.pcb],
                      [tSlip('netPay'), b.net, ytd.net],
                    ] as [string, unknown, number][]
                  ).map(([label, current, total]) => (
                    <tr key={label}>
                      <td className="py-1.5">{label}</td>
                      <td className="py-1.5 text-right tabular-nums">{rm(current)}</td>
                      <td className="py-1.5 text-right tabular-nums">{rm(total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* The YTD column is the FULL employee share as computed and filed, which is why it can differ
                from the deduction lines above when the employer bore part of them. Said, not hidden. */}
            <p className="mt-2 text-xs text-muted-foreground">{t('ytdNote')}</p>

            {b.recordLines.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {tTxn('view.history.itemsHeading')}
                </h3>
                {/* 417d4937 — the pay item's own code and description, with the words that were typed
                    kept beside them as the remark. Nothing is rewritten and nothing is hidden; the code
                    and the amount are exactly as stored. */}
                {b.recordLines.map((l, i) => {
                  const id = recordLineIdentity(l, payItemNames);
                  return (
                    <div
                      key={`${l.code}-${i}`}
                      className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0"
                    >
                      <span className="text-muted-foreground">
                        {id.label}
                        {id.remark && (
                          <span className="ms-2 text-xs italic">
                            {tTxn('view.history.itemRemark', { remark: id.remark })}
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums text-muted-foreground">{rm(l.amount)}</span>
                    </div>
                  );
                })}
                <p className="mt-2 text-xs text-muted-foreground">{tTxn('view.history.itemsNote')}</p>
              </div>
            )}

            {/* 417d4937 request 10 — WHERE THE RECORDED ITEMS CAME FROM. A second population beside the
                list above, never a join onto it: two entries can share a pay item and an amount, and
                nothing links a record line back to the ledger row that produced it. Renders nothing when
                the run has no one-off rows for this employee. */}
            <div className="mt-4">
              <SourceTxnBlock rows={sourceTxns} />
            </div>
          </Block>

          {/* THE IN-PAGE DOCUMENT VIEWER IS GONE (rev 2). r179 framed the real file in an iframe here so
              preview and download could not disagree; the reporter would rather open it on its own, so
              the Review button in the letterhead above is now a new-tab link to that same `?inline=1`
              route. Nothing about which bytes are shown changed — only where they are shown. */}

          {/* THE PROVENANCE LINE STAYS ON THIS SCREEN (f35f758a). It came off the document and off the
              employee's own copy, because the reporter reads it as internal. It is kept here, on the
              HR-facing review screen, because it is the answer to "why did my tax change when my pay did
              not?" and whoever is checking a figure needs it. That split is the plan's, deliberately. */}
          {prov?.rulesetVersion && (
            <p className="text-xs text-muted-foreground">
              {tSlip('provenanceFooter', { ruleset: prov.rulesetVersion })}
            </p>
          )}
        </>
      )}
        </div>
      </CollapsibleEmployeePanel>
    </div>
  );
}
