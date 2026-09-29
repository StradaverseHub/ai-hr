import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployments, myPayslips, myTaxRelief, myTaxReliefEmploymentIds, myEmploymentIdsAll, myAttendance, type TaxReliefResult } from '@/core/read';
import { listLoansForEmployment } from '@/core/loans';
import { myProfileChangeRequests } from '@/core/profile';
// r261 stage three — the tenant's field-by-field permission for change requests (ess.profile_change_fields).
// The QUIET reader, and the closed fallback, for the reason spelled out where it is used below.
import { getSettingOrFallback, isModuleEnabledOrFalse } from '@/core/entitlements';
import { resolveAllowedRequestKeys } from '@/lib/profile-requestable-fields';
import { myResignation } from '@/core/offboarding';
import { isChildReliefEligible, childAgeYears } from '@/core/dependents';
// ADR-0080 D9/D11 — through the leave pack's FACADE, never core/leave directly. The Personnel screen
// imports the same function from core/ as audited kernel-contract debt (test/pack-drift-allowlist.json);
// that list only ever shrinks, so a new consumer joins the facade rather than the debt. Same function,
// same arithmetic — which is the point: a service figure on My Profile and the same figure on the
// Personnel record must come from one piece of calendar math.
import { serviceYearsMonthsDaysAt } from '@/packs/leave/service';
import { MeReviewCard } from './review-card';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { AttendanceClockButton, LocationNotice } from '@/components/attendance-clock-button';
import { ClientTabs } from '@/components/personnel-tabs';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myProfileRecord } from './record';
import { ReadCard, ReadField, ReadGroup } from './read-field';
// r260 stage two (9583deac) — the request card and the pending-value projection. One declaration of
// which fields may be asked about (lib/profile-requestable-fields.ts) feeds both.
import { RequestChangeCard, pendingProposedByKey } from './request-change-card';
import { maskAccountNumber } from '@/lib/profile-requestable-fields';
import { ME_TABS, ME_TAB_LABEL_KEY, type MeTabKey } from './visible-fields';

// a7cbd895: the Leave tab (and its dialogs/forms/reads) moved wholesale to /leave — "My Absence" in the
// left nav. ?tab=leave deep-links are forwarded (see the redirect below).
// 0bb0e303 rev2: myRequestCorrection / myRequestOvertime are bound on
// (b833a077, r362: myRequestTravel stood in this list and is gone with the My Travel feature — its
//  screen, its form and its approvals section were removed; the travel_request rows are kept.)
// /attendance/requests now (the actions themselves did not move; the forms did).
import {
  myCheckIn,
  myCheckOut,
  mySubmitResignation,
  myUpdateContact,
  myWithdrawResignation,
} from './actions';

/**
 * ── r259 · MY PROFILE, REBUILT IN THE SHAPE OF THE PERSONNEL RECORD (board item 9583deac, stage one) ──
 *
 * The reporter's complaint, in their words: "My Profile has five tabs — Overview, Profile, Pay,
 * Performance and Documents — while the Personnel record an administrator sees has eleven, with
 * different section names and different fields. An employee and the HR team are looking at two different
 * shapes of the same person."
 *
 * So the six tabs below are Personnel Management's own tab KEYS, labelled from Personnel Management's own
 * catalogue entries (`people.detail.tabs.*`), and every card on them carries Personnel's own section
 * title. Not a copy of the words — the same key, resolved from the same catalogue. Renaming a tab on the
 * Personnel screen renames it here, which is the only arrangement under which the two cannot drift apart
 * again. app/me/visible-fields.ts holds that mapping and test/me-profile-visibility.test.ts asserts every
 * key it names is one the Personnel screen actually renders.
 *
 * ── r260 · STAGE TWO: THE SAME TWO WRITE PATHS, ONE OF THEM WIDENED ─────────────────────────────────
 * ADR-0012's two-paths-by-risk mechanism is live and neither stage may build a second one:
 *   • the direct contact self-edit (`myUpdateContact`) — low-risk fields, saved immediately. UNCHANGED;
 *   • the approval-gated change request — now `<RequestChangeCard>`, mounted once per tab that carries
 *     requestable fields, offering the set declared in `lib/profile-requestable-fields.ts` rather than
 *     the seven names this page used to hard-code. Same store, same approval guard, more fields.
 * Each sits inside the card it belongs to, as a fold-out, so the record reads first and the way to
 * change a value is next to the value.
 *
 * A CHANGE THAT IS WAITING IS DRAWN BESIDE THE MASTER VALUE, NEVER OVER IT — `pendingFor(key)` below
 * feeds every read field's `pending` prop, and the disabled input keeps showing what the record actually
 * says. That is the plan's own sentence: "so nobody is confused about which one is real."
 *
 * Stage three — the per-field permission SETTING and the approver-choice setting — is NOT built here.
 *
 * ── WHAT IS DISPLAYED IS WHAT SAVE CHANGES ──────────────────────────────────────────────────────────
 * Every value on a card that also has a form on it is read from the SAME object that form defaults from
 * and writes to. That sounds like housekeeping and is not: `person` carries two address column families
 * (the employee's own, and HR's Permanent / Correspondence pair), and the first cut of this round showed
 * HR's read-only above a fold-out that writes the employee's — an address an employee could edit, save,
 * and watch not move. Only the family the Save button writes is on this screen; app/me/record.ts carries
 * the full account and docs/me-profile-field-visibility.md carries the reporter's. The same rule is why
 * the emergency-contact register prints the address the fold-out posts.
 *
 * ── SCOPE: THE EMPLOYEE'S OWN RECORD, AND NOTHING ELSE ──────────────────────────────────────────────
 * There is no employee picker, no id in the route, and no id in the query string. `myProfileRecord`
 * (app/me/record.ts) resolves the employment from `ctx.personId` and every read underneath runs under
 * RLS, so the database — not a filter on this page — is what refuses somebody else's record.
 *
 * ── WHAT MOVED, AND WHY IT IS A MOVE AND NOT A DELETION ─────────────────────────────────────────────
 * The old Overview and Performance tabs have no counterpart in the Personnel record, and the six tabs
 * are the reporter's specification. Nothing they held was dropped:
 *   • the geofenced clock in / out is one of only two places a punch can be made, so it stays on this
 *     page — ABOVE the tab strip, where it is not a tab and cannot be pushed off one;
 *   • goals, 360 feedback and 1:1 check-ins moved WHOLE to /me/performance (linked from the header), the
 *     same treatment the Leave tab got at a7cbd895 and the attendance request forms at 0bb0e303. A link,
 *     not a copy;
 *   • the "my positions" list of concurrent employments moved onto the Employment tab, minus the
 *     cost-recharge percentages — see docs/me-profile-field-visibility.md for why those are withheld.
 * Legacy `?tab=` addresses are mapped below rather than 404-ing a bookmark.
 */

const ME_TAB_SET = new Set<string>(ME_TABS);
/** Old /me tab addresses (311ad7ba) → their new home, so a bookmark or a notification link still lands. */
const LEGACY_TAB: Record<string, MeTabKey> = { overview: 'profile', pay: 'payroll' };

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ATT_STATUS: Record<string, string> = {
  present: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  late: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  half_day: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  absent: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};

// Maps tax-category code → translation leaf key (resolved via t() where rendered).
const PCB_LABEL_KEY: Record<number, string> = {
  1: 'pcbSingle',
  2: 'pcbMarriedSpouseNotWorking',
  3: 'pcbMarriedSpouseWorking',
};

function Pill({ status, map, label }: { status: string; map: Record<string, string>; label?: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${map[status] ?? 'bg-muted text-muted-foreground'}`}>
      {label ?? status.replace('_', ' ')}
    </span>
  );
}

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; month?: string; cycle?: string; asOf?: string; tab?: string }>;
}) {
  const t = await getTranslations('me');
  // Personnel Management's own labels. Every tab name, section title and field label on this screen is
  // resolved from here — see the file header for why that is the anti-drift mechanism and not a shortcut.
  const tp = await getTranslations('people.detail');
  const tRun = await getTranslations('payroll.list.runType'); // Wave 2C — shared run-type labels
  const s = await getSession();
  const { error, month: spMonth, cycle: spCycle, asOf: spAsOf, tab: spTab } = await searchParams;

  // My Absence (a7cbd895): the Leave tab lives on /leave. Keep every old /me?tab=leave deep-link working.
  if (spTab === 'leave') {
    const qs = new URLSearchParams();
    if (error) qs.set('error', error);
    if (spAsOf) qs.set('asOf', spAsOf);
    const q = qs.toString();
    redirect(`/leave${q ? `?${q}` : ''}`);
  }
  // r259: the Performance tab moved to a screen of its own, so its address forwards rather than 404s.
  if (spTab === 'performance') redirect('/me/performance');

  const record = await myProfileRecord(s);

  if (!record) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const { employmentId } = record;
  const employments = await myEmployments(s);
  /**
   * r298 (board ceb1c560) — DOES THIS TENANT HOLD PAYROLL? Asked ONCE for the page. My Profile is a CORE
   * screen, and three cards on it are the Payroll pack's, so for a tenant without Payroll each is neither
   * READ nor drawn — gating only the render would leave the reads that core/module-gate.ts names as
   * stopping core/loans.ts from being bound:
   *   • My payslips          ← myPayslips               (payslip + payroll_batch, through core/read.ts)
   *   • Personal tax relief  ← myTaxReliefEmploymentIds + myTaxRelief (payslip.statutory.lp; its
   *                            "manage" link is /me/tax-relief, whose writes core/tax-relief.ts refuses)
   *   • My loans             ← listLoansForEmployment    (core/loans.ts)
   * Basic Salary stays: it is the compensation row (core/comp.ts is spine, packs/payroll/index.ts), so
   * the Payroll tab is never empty and keeps its place, and `?tab=payroll` / `?tab=pay` still land on it.
   *
   * Tenant-wide, no companyId — core/module-gate.ts's COMPANY SCOPE paragraph. The QUIET form, because
   * this is what to draw (core/entitlements.ts): an unreadable snapshot hides the three cards, it does not
   * take the page down. The EA statement is NOT one of them — see where its rows are read.
   */
  const payrollOn = isModuleEnabledOrFalse(s, 'payroll');
  // My Payroll TP1 is leaver-safe: resolve ids by person, including terminated employments, so a resigned
  // employee can still retrieve the relief history they need to file taxes (payslip RLS still gates rows).
  const taxReliefEmploymentIds = payrollOn ? await myTaxReliefEmploymentIds(s) : [];
  const noTaxRelief: TaxReliefResult = { year: Number(todayInKualaLumpur().slice(0, 4)), rows: [], ytd: 0 };
  // NOTE — `myProfile(s)` used to be read here purely to default the contact fold-out's inputs. It is
  // gone on purpose: the fold-out now defaults from `record.contact` / `record.emergencyContacts`, i.e.
  // from the very object the card prints. Two reads of the same person row is exactly how a screen ends
  // up displaying one value and saving another.
  const [payslips, taxRelief, attendance, profileRequests, resignation, myLoans] = await Promise.all([
    payrollOn ? myPayslips(s, employments.map((e) => e.employmentId)) : [],
    payrollOn ? myTaxRelief(s, taxReliefEmploymentIds) : noTaxRelief,
    myAttendance(s, employmentId, 14),
    myProfileChangeRequests(s),
    myResignation(s, employmentId),
    // 1.2.8 (ADR-0060): read-only "My loans" — RLS scopes to the caller's own employment. ESS NEVER calls
    // a loan write service (the loan write methods are admin-only; this is a read helper).
    payrollOn ? listLoansForEmployment(s, employmentId) : [],
  ]);
  /**
   * ── r260 STAGE TWO: A CHANGE THAT IS WAITING IS DRAWN BESIDE THE MASTER VALUE, NEVER OVER IT ──────
   *
   * The plan's promise, in the reporter's words: "A field with a request waiting shows both values —
   * what it is now and what was asked for — so nobody is confused about which one is real."
   *
   * So every read card below keeps printing the MASTER value exactly as it did in stage one, and a
   * pending request adds a second line under the field it would change. The map is keyed by the
   * proposed-field key from lib/profile-requestable-fields.ts — the same key the request form posts and
   * the same key core/profile.ts applies — so a field can never show a pending value under the wrong
   * label. Nothing here reads the request store a second time: `profileRequests` is the employee's own
   * history, already scoped to `ctx.personId` by `myProfileChangeRequests`.
   */
  /**
   * r261 stage three — WHICH fields this tenant lets an employee ask to change. Resolved ONCE for the
   * whole page and handed to both request cards, so the two tabs cannot end up reading two different
   * answers, and read from the same tenant setting `core/profile.ts` enforces on the POST. The screen
   * hiding a control and the service dropping the key are two independent statements of one policy.
   *
   * ⚠️ THE QUIET READER, AND THE CLOSED FALLBACK (r261 fix pass). This first shipped as
   * `profileChangeAllowedKeys(s)` — the THROWING service form — which made /me, the home screen of the
   * entire workforce, return 500 whenever the entitlement snapshot could not be resolved (a pool blip, a
   * statement timeout, a code-ahead-of-migration deploy). There is no app/error.tsx, so the employee got
   * a broken page instead of their payslips because a settings lookup failed. core/entitlements.ts draws
   * the line: a PAGE read is a display decision and degrades; a SERVICE read is an authorization
   * decision and stays loud — which `core/profile.ts` still is on the POST.
   *
   * THE DEGRADED ANSWER IS `[]`, i.e. CLOSED: during an incident this page offers NO field for a change
   * request, rather than offering every field on a permission nobody could read. The employee loses one
   * card for the duration and keeps their own record; the opposite mistake would invite a request
   * against a field their employer may have deliberately shut. `'all'` — the catalog default, which
   * means "this tenant never configured it" — is the right answer only when we actually read the
   * snapshot and found nothing there, which is what `getSetting` returns on its own.
   */
  const allowedRequestKeys = resolveAllowedRequestKeys(
    getSettingOrFallback<readonly string[]>(s, 'ess.profile_change_fields', []),
  );
  const pendingValues = pendingProposedByKey(profileRequests, t);
  const pendingFor = (key: string) => {
    const value = pendingValues.get(key);
    return value === undefined ? null : { value, label: t('requestedPendingLabel') };
  };

  // Group TP1 rows by company — each entity files its own PCB, so a single blended YTD would mislead.
  const taxReliefByCompany = taxRelief.rows.reduce<Record<string, typeof taxRelief.rows>>((acc, r) => {
    (acc[r.company] ??= []).push(r);
    return acc;
  }, {});

  const today = todayInKualaLumpur();
  const todayRow = attendance.find((a) => a.date === today);

  // EA (annual tax statement) rows — derived from the principal's REAL payslips across ALL their
  // employments incl. terminated ones (leavers must reach their prior employer's EA).
  // r298 — deliberately NOT gated on Payroll, unlike the three Payroll-tab cards. The EA is a STATUTORY
  // document built from payslips that already exist: a company that ran payroll and later dropped the module
  // still owes its employees — leavers included — the Borang EA they file their taxes with, and
  // /me/ea/[employmentId]/pdf does not depend on the module. So the reads always run (core/read.ts, which no
  // binding plan touches) and the card below is drawn when Payroll is on OR there is a statement to give.
  const eaEmployments = await myEmploymentIdsAll(s);
  const eaPayslips = await myPayslips(s, eaEmployments.map((e) => e.employmentId));
  const employmentIdByCompany = new Map(eaEmployments.map((e) => [e.company, e.employmentId]));
  const eaRowMap = new Map<string, { employmentId: string; company: string; year: string }>();
  for (const ps of eaPayslips) {
    const year = ps.payPeriod.slice(0, 4); // 'YYYY-MM' → 'YYYY'
    const eaEmploymentId = employmentIdByCompany.get(ps.company);
    if (!eaEmploymentId) continue;
    const key = `${ps.company}::${year}`;
    if (!eaRowMap.has(key)) eaRowMap.set(key, { employmentId: eaEmploymentId, company: ps.company, year });
  }
  const eaRows = [...eaRowMap.values()].sort(
    (a, b) => a.company.localeCompare(b.company) || b.year.localeCompare(a.year),
  );

  // Self Payslip selectors (Feature 1.1.1): pick by payroll month + pay cycle, server-side. Only finalized
  // AND released batches are offered (step 6, f3148da1).
  const finalizedPayslips = payslips.filter((p) => p.status === 'closed' && p.released);
  const payslipMonths = [...new Set(finalizedPayslips.map((p) => p.payPeriod))].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  const selectedMonth = spMonth && payslipMonths.includes(spMonth) ? spMonth : payslipMonths[0] ?? '';
  const monthRows = finalizedPayslips.filter((p) => p.payPeriod === selectedMonth);
  const cycleKeyOf = (p: { runType: string; runSeq: number }) => `${p.runType}#${p.runSeq}`;
  const cycleCountByType = monthRows.reduce<Record<string, number>>((acc, p) => {
    acc[p.runType] = (acc[p.runType] ?? 0) + 1;
    return acc;
  }, {});
  const seenCycleKeys = new Set<string>();
  const payslipCycles: { key: string; runType: string; runSeq: number }[] = [];
  for (const p of monthRows) {
    const key = cycleKeyOf(p);
    if (seenCycleKeys.has(key)) continue;
    seenCycleKeys.add(key);
    payslipCycles.push({ key, runType: p.runType, runSeq: p.runSeq });
  }
  const cycleLabelOf = (c: { runType: string; runSeq: number }) =>
    cycleCountByType[c.runType] > 1
      ? t('cycleLabel', { runType: tRun(c.runType), seq: c.runSeq })
      : t('cycleLabelSingle', { runType: tRun(c.runType) });
  const selectedCycle =
    spCycle && payslipCycles.some((c) => c.key === spCycle) ? spCycle : payslipCycles[0]?.key ?? '';
  const displayedPayslips = monthRows.filter((p) => cycleKeyOf(p) === selectedCycle);

  const activeTab: MeTabKey = spTab && ME_TAB_SET.has(spTab)
    ? (spTab as MeTabKey)
    : (spTab && LEGACY_TAB[spTab]) || 'profile';

  // ── Value labels. Static switches, one branch per value: a computed t(MAP[x]) is invisible to
  //    test/i18n-coverage's static-key check, and these are the SAME keys the Personnel screen renders,
  //    which is the property this screen exists to hold.
  const notSet = tp('optionNotSet');
  const genderLabel = (g: string | null) =>
    g === 'male' ? tp('genderMale') : g === 'female' ? tp('genderFemale') : g === 'undisclosed' ? tp('genderUndisclosed') : null;
  const maritalLabel = (m: string | null) =>
    m === 'single'
      ? tp('maritalSingle')
      : m === 'married'
        ? tp('maritalMarried')
        : m === 'divorced'
          ? tp('maritalDivorced')
          : m === 'widowed'
            ? tp('maritalWidowed')
            : m === 'separated'
              ? tp('maritalSeparated')
              : m === 'other'
                ? tp('maritalOther')
                : null;
  const employmentTypeLabel = (e: string | null) =>
    e === 'full_time'
      ? tp('employmentInfo.employmentType_full_time')
      : e === 'part_time'
        ? tp('employmentInfo.employmentType_part_time')
        : e === 'contract'
          ? tp('employmentInfo.employmentType_contract')
          : e === 'intern'
            ? tp('employmentInfo.employmentType_intern')
            : null;
  const epfCitizenshipLabel = (c: string | null) =>
    c === 'citizen'
      ? tp('epfCitizenshipCitizen')
      : c === 'pr'
        ? tp('epfCitizenshipPr')
        : c === 'non_citizen'
          ? tp('epfCitizenshipNonCitizen')
          : null;
  const socsoCategoryLabel = (c: string | null) =>
    c === 'auto'
      ? tp('socsoCategoryAuto')
      : c === 'first'
        ? tp('socsoCategoryFirst')
        : c === 'second'
          ? tp('socsoCategorySecond')
          : c === 'none'
            ? tp('socsoCategoryNone')
            : null;
  const eisCategoryLabel = (c: string | null) =>
    c === 'auto' ? tp('eisCategoryAuto') : c === 'none' ? tp('eisCategoryNone') : null;
  const paymentMethodLabel = (m: string | null) =>
    m === 'bank_transfer'
      ? tp('paymentMethod_bank_transfer')
      : m === 'cheque'
        ? tp('paymentMethod_cheque')
        : m === 'cash'
          ? tp('paymentMethod_cash')
          : null;
  const relationshipLabel = (r: string) =>
    r === 'spouse'
      ? tp('family.rel.spouse')
      : r === 'child'
        ? tp('family.rel.child')
        : r === 'parent'
          ? tp('family.rel.parent')
          : r === 'sibling'
            ? tp('family.rel.sibling')
            : r === 'other'
              ? tp('family.rel.other')
              : r;
  const priorityLabel = (p: string) =>
    p === 'primary'
      ? tp('emergency.priorityPrimary')
      : p === 'secondary'
        ? tp('emergency.prioritySecondary')
        : tp('emergency.priorityOther');
  const yesNo = (b: boolean | null) => (b == null ? null : b ? tp('prorateYes') : tp('prorateNo'));

  // cc681bd5 — the same "8 Months 15 Days" service format the Personnel Employment tab renders, through
  // the same core/leave calendar math, so the two screens cannot print different lengths of service.
  const fmtServiceYmd = (from: string | null | undefined): string | null => {
    if (!from) return null;
    const sv = serviceYearsMonthsDaysAt(from, today);
    const parts: string[] = [];
    if (sv.years > 0) parts.push(tp('employmentInfo.yearsUnit', { count: sv.years }));
    if (sv.years > 0 || sv.months > 0) parts.push(tp('employmentInfo.monthsUnit', { count: sv.months }));
    parts.push(tp('employmentInfo.daysUnit', { count: sv.days }));
    return parts.join(' ');
  };

  const { profile: p, contact: c, employment: emp, statutory: st, compensation: comp } = record;
  // The contact fold-out edits ONE emergency contact — `core/emergency-contacts.ts` routes those five
  // field names into the highest-priority live record (Primary → Secondary → Other). `listEmergencyContacts`
  // returns the register in that same rank order, so row one of the table below IS the row the fold-out
  // writes: the same "what is displayed is what save changes" rule the address block above follows.
  const primaryEmergencyContact = record.emergencyContacts[0] ?? null;

  // ── PROFILE TAB ───────────────────────────────────────────────────────────────────────────────────
  const profilePanel = (
    <>
      <ReadCard id="section-personal-details" title={tp('personalDetails')}>
        <ReadField label={tp('employeeIdLabel')} value={p.employeeCode} notSet={notSet} />
        <ReadField label={tp('salutation')} value={p.salutation} notSet={notSet} pending={pendingFor('salutation')} />
        <ReadField label={tp('fullNameIc')} value={p.fullName} notSet={notSet} className="lg:col-span-2" pending={pendingFor('fullName')} />
        <ReadField label={tp('firstName')} value={p.firstName} notSet={notSet} pending={pendingFor('firstName')} />
        <ReadField label={tp('lastName')} value={p.lastName} notSet={notSet} pending={pendingFor('lastName')} />
        <ReadField label={tp('preferredName')} value={p.preferredName} notSet={notSet} pending={pendingFor('preferredName')} />
        <ReadField label={tp('nationality')} value={p.nationality} notSet={notSet} pending={pendingFor('nationality')} />
        <ReadField label={tp('religion')} value={p.religion} notSet={notSet} pending={pendingFor('religion')} />
        <ReadField label={tp('race')} value={p.race} notSet={notSet} pending={pendingFor('race')} />
        <ReadField label={tp('gender')} value={genderLabel(p.gender)} notSet={notSet} pending={pendingFor('gender')} />
        <ReadField label={tp('maritalStatus')} value={maritalLabel(p.maritalStatus)} notSet={notSet} pending={pendingFor('maritalStatus')} />
        <ReadField label={tp('birthDate')} value={p.dateOfBirth} notSet={notSet} pending={pendingFor('dateOfBirth')} />
        <ReadField label={tp('age')} value={p.dateOfBirth ? String(childAgeYears(p.dateOfBirth) ?? '') : null} notSet={tp('employmentInfo.notAvailable')} />
        <ReadGroup legend={tp('identityNricTitle')}>
          <ReadField label={tp('icNumber')} value={p.icNumber} notSet={notSet} pending={pendingFor('icNumber')} />
          <ReadField label={tp('oldIcNumber')} value={p.oldIcNumber} notSet={notSet} pending={pendingFor('oldIcNumber')} />
        </ReadGroup>
        <ReadGroup legend={tp('passportInfoTitle')}>
          <ReadField label={tp('passportNumber')} value={p.passportNumber} notSet={notSet} pending={pendingFor('passportNumber')} />
          <ReadField label={tp('passportIssuingCountry')} value={p.passportIssuingCountry} notSet={notSet} pending={pendingFor('passportIssuingCountry')} />
          <ReadField label={tp('passportIssueDate')} value={p.passportIssueDate} notSet={notSet} pending={pendingFor('passportIssueDate')} />
          <ReadField label={tp('passportExpiryDate')} value={p.passportExpiryDate} notSet={notSet} pending={pendingFor('passportExpiryDate')} />
        </ReadGroup>
        <p className="col-span-full text-xs text-muted-foreground">{t('complianceFieldsNeedApproval')}</p>
      </ReadCard>

      <ReadCard id="section-contact-address" title={tp('contactAddressTitle')}>
        <ReadField label={tp('workEmail')} value={c.workEmail} notSet={notSet} />
        <ReadField label={tp('phone')} value={c.mobilePhone} notSet={notSet} />
        <ReadField label={tp('homePhone')} value={c.homePhone} notSet={notSet} />
        <ReadField label={tp('personalEmail')} value={c.personalEmail} notSet={notSet} />
        {/* ── THE HOME ADDRESS, AND IT IS THE ONE THE SAVE BUTTON BELOW CHANGES ─────────────────────
            Read field and input are bound to the SAME `c.homeAddress.<name>`, field by field, with the
            input's `name=` and the object's key spelled identically. That is not a coincidence to be
            tidied away: test/me-profile-visibility.test.ts reads the `name=` list out of the form below
            and requires every address field on it to be displayed from this object, so a value can never
            again be shown from one column family and saved into another. app/me/record.ts explains which
            three families `person` carries and why only this one is on the screen; the reporter's copy of
            that answer is in docs/me-profile-field-visibility.md. */}
        <ReadField label={tp('addressLine1')} value={c.homeAddress.addressLine1} notSet={notSet} className="lg:col-span-2" />
        <ReadField label={tp('addressLine2')} value={c.homeAddress.addressLine2} notSet={notSet} className="lg:col-span-2" />
        <ReadField label={tp('addressLine3')} value={c.homeAddress.addressLine3} notSet={notSet} className="lg:col-span-2" />
        <ReadField label={tp('postcode')} value={c.homeAddress.postcode} notSet={notSet} />
        <ReadField label={tp('city')} value={c.homeAddress.city} notSet={notSet} />
        <ReadField label={tp('stateLabel')} value={c.homeAddress.state} notSet={notSet} />
        <ReadField label={tp('country')} value={c.homeAddress.country} notSet={notSet} />

        {/* ADR-0012 path one — low-risk contact fields, saved straight to the person record under RLS.
            PRESERVED, not rebuilt: this is the same `myUpdateContact` form /me has always carried, moved
            inside the card whose values it changes. It is a fold-out so the record reads first. */}
        <details className="col-span-full border-t border-border pt-3" data-tour="me-contact">
          <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('myDetails')}
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">{t('contactUpdatesImmediately')}</p>
          <form action={myUpdateContact} className="mt-3 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('phoneLabel')}>
              <input name="phone" defaultValue={c.mobilePhone ?? ''} className={inputCls} />
            </Field>
            <Field label={t('personalEmailLabel')}>
              <input name="personalEmail" type="email" defaultValue={c.personalEmail ?? ''} className={inputCls} />
            </Field>
            <Field label={t('addressLine1Label')} className="lg:col-span-2">
              <input name="addressLine1" defaultValue={c.homeAddress.addressLine1 ?? ''} className={inputCls} />
            </Field>
            <Field label={t('addressLine2Label')} className="lg:col-span-2">
              <input name="addressLine2" defaultValue={c.homeAddress.addressLine2 ?? ''} className={inputCls} />
            </Field>
            <Field label={t('addressLine3Label')} className="lg:col-span-2">
              <input name="addressLine3" defaultValue={c.homeAddress.addressLine3 ?? ''} className={inputCls} />
            </Field>
            <Field label={t('postcodeLabel')}>
              <input name="postcode" defaultValue={c.homeAddress.postcode ?? ''} className={inputCls} />
            </Field>
            <Field label={t('cityLabel')}>
              <input name="city" defaultValue={c.homeAddress.city ?? ''} className={inputCls} />
            </Field>
            <Field label={t('stateLabel')}>
              <input name="state" defaultValue={c.homeAddress.state ?? ''} className={inputCls} />
            </Field>
            <Field label={t('countryLabel')}>
              <input name="country" defaultValue={c.homeAddress.country ?? ''} className={inputCls} />
            </Field>
            <Field label={t('emergencyContactLabel')}>
              <input name="emergencyContactName" defaultValue={primaryEmergencyContact?.fullName ?? ''} className={inputCls} />
            </Field>
            <Field label={t('emergencyRelationshipLabel')}>
              <input name="emergencyContactRelationship" defaultValue={primaryEmergencyContact?.relationship ?? ''} className={inputCls} />
            </Field>
            <Field label={t('emergencyPhoneLabel')}>
              <input name="emergencyContactPhone" defaultValue={primaryEmergencyContact?.mobilePhone ?? ''} className={inputCls} />
            </Field>
            <Field label={t('emergencyPhone2Label')}>
              <input name="emergencyContactPhone2" defaultValue={primaryEmergencyContact?.homePhone ?? ''} className={inputCls} />
            </Field>
            <Field label={t('emergencyAddressLabel')} className="lg:col-span-4">
              <input name="emergencyContactAddress" defaultValue={primaryEmergencyContact?.address ?? ''} className={inputCls} />
            </Field>
            <div className="col-span-full">
              <Button type="submit" size="sm">
                {t('saveDetails')}
              </Button>
            </div>
          </form>
        </details>
      </ReadCard>

      <Card id="section-emergency-contact" className="overflow-hidden">
        <SectionHeader title={tp('emergencyTitle')} count={record.emergencyContacts.length} />
        {record.emergencyContacts.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">{tp('emergency.none')}</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4 pt-3">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{tp('emergency.name')}</th>
                  <th className="py-2 pr-3 font-medium">{tp('emergency.relationship')}</th>
                  <th className="py-2 pr-3 font-medium">{tp('emergency.mobilePhone')}</th>
                  <th className="py-2 pr-3 font-medium">{tp('emergency.homePhone')}</th>
                  {/* The self-edit fold-out posts `emergencyContactAddress`; a field that can be saved
                      and cannot be seen is the same defect as an address shown from another column. */}
                  <th className="py-2 pr-3 font-medium">{tp('emergency.address')}</th>
                  <th className="py-2 font-medium">{tp('emergency.priority')}</th>
                </tr>
              </thead>
              <tbody>
                {record.emergencyContacts.map((ec) => (
                  <tr key={ec.id} className="border-b border-border/60">
                    <td className="py-2 pr-3 font-medium">{ec.fullName}</td>
                    <td className="py-2 pr-3">{ec.relationship ?? '—'}</td>
                    <td className="py-2 pr-3">{ec.mobilePhone ?? '—'}</td>
                    <td className="py-2 pr-3">{ec.homePhone ?? '—'}</td>
                    <td className="py-2 pr-3">{ec.address ?? '—'}</td>
                    <td className="py-2">{priorityLabel(ec.priority)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* r260 stage two — asking to correct your name, your particulars or an identity document. The
          Profile tab's own request card: the fields it offers are exactly the ones read on this tab, so
          the control to correct a wrong passport number sits under the wrong passport number rather than
          three tabs away. lib/profile-requestable-fields.ts decides which those are. */}
      <RequestChangeCard tab="profile" title={t('requestChangeProfileHeading')} requests={profileRequests} allowedKeys={allowedRequestKeys} />
    </>
  );

  // ── EMPLOYMENT TAB ────────────────────────────────────────────────────────────────────────────────
  const employmentPanel = (
    <>
      <ReadCard id="section-employment-info" title={tp('employmentInfo.title')}>
        <ReadGroup legend={tp('employmentInfo.assignmentGroup')}>
          <ReadField label={tp('employmentInfo.company')} value={emp.company} notSet={notSet} />
          <ReadField label={tp('employmentInfo.department')} value={emp.department} notSet={notSet} />
          <ReadField label={tp('employmentInfo.position')} value={emp.position} notSet={notSet} />
          <ReadField label={tp('employmentInfo.businessUnit')} value={emp.businessUnit} notSet={notSet} />
          <ReadField label={tp('employmentInfo.jobGrade')} value={emp.gradeName} notSet={notSet} />
          <ReadField label={tp('employmentInfo.employmentType')} value={employmentTypeLabel(emp.employmentType)} notSet={notSet} />
          <ReadField label={tp('employmentInfo.category')} value={emp.employmentCategory} notSet={notSet} />
          <ReadField label={tp('locationSelect')} value={emp.locationName} notSet={notSet} />
          <ReadField label={tp('employmentInfo.division')} value={emp.orgDivision} notSet={notSet} />
          <ReadField label={tp('employmentInfo.branch')} value={emp.orgBranch} notSet={notSet} />
          <ReadField label={tp('employmentInfo.region')} value={emp.orgRegion} notSet={notSet} />
          <ReadField label={tp('employmentInfo.line')} value={emp.orgLine} notSet={notSet} />
          <ReadField label={tp('employmentInfo.section')} value={emp.orgSection} notSet={notSet} />
          <ReadField label={tp('employmentInfo.team')} value={emp.orgTeam} notSet={notSet} />
          <ReadField label={tp('employmentInfo.base')} value={emp.orgBase} notSet={notSet} />
        </ReadGroup>
        <ReadGroup legend={tp('employmentInfo.datesGroup')}>
          <ReadField label={tp('employmentInfo.groupJoinDate')} value={emp.hiredOn} notSet={notSet} />
          <ReadField label={tp('employmentInfo.groupService')} value={fmtServiceYmd(emp.hiredOn)} notSet={tp('employmentInfo.notAvailable')} />
          <ReadField label={tp('employmentInfo.joinDate')} value={emp.joinDate ?? emp.hiredOn} notSet={notSet} />
          <ReadField
            label={tp('employmentInfo.currentCompanyService')}
            value={fmtServiceYmd(emp.joinDate ?? emp.hiredOn)}
            notSet={tp('employmentInfo.notAvailable')}
          />
        </ReadGroup>
        <ReadGroup legend={tp('employmentInfo.probationGroup')}>
          <ReadField label={tp('employmentInfo.confirmationDate')} value={emp.confirmationDate} notSet={notSet} />
        </ReadGroup>
        <ReadGroup legend={tp('employmentInfo.contractGroup')}>
          <ReadField label={tp('employmentInfo.contractStartDate')} value={emp.contractStartDate} notSet={notSet} />
          <ReadField label={tp('employmentInfo.contractEndDate')} value={emp.contractEndDate} notSet={notSet} />
        </ReadGroup>
        <ReadGroup legend={tp('employmentInfo.resignationGroup')}>
          <ReadField label={tp('employmentInfo.tenderResignationDate')} value={emp.tenderResignationDate} notSet={notSet} />
          <ReadField label={tp('employmentInfo.resignationDate')} value={emp.resignationDate} notSet={notSet} />
          <ReadField label={tp('employmentInfo.lastWorkingDate')} value={emp.lastWorkingDate} notSet={notSet} />
        </ReadGroup>
      </ReadCard>

      <ReadCard id="section-direct-superior" title={tp('directSuperiorTitle')}>
        <ReadField
          label={tp('directSuperiorTitle')}
          value={emp.superiorName ? [emp.superiorCode, emp.superiorName].filter(Boolean).join(' – ') : null}
          notSet={notSet}
          className="lg:col-span-2"
        />
      </ReadCard>

      {/* Concurrent multi-company employments (ADR-0009). Relocated here from the retired Overview tab —
          it is employment information.

          THE CONTRACTUAL PAY STAYS ON EVERY ROW. The first cut of this round dropped it, and for an
          employee holding two active employments that deleted something they could previously see about
          themselves: the Payroll tab's Basic Salary card is the CURRENT employment's compensation row and
          nothing else, so the second employment's pay then rendered nowhere on the page. Withholding is a
          decision the reporter gets to read in docs/me-profile-field-visibility.md; losing a figure in a
          layout change is not. The cost-recharge percentages that used to render beside each row ARE
          withheld, and that one is on the list.

          Same arithmetic as the retired Overview card (basic + monthly allowance, from `myEmployments`),
          so a figure an employee learned to recognise did not quietly change meaning under them. */}
      {employments.length > 1 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('myPositions', { count: employments.length })} count={employments.length} />
          <ul className="divide-y divide-border">
            {employments.map((e) => (
              <li key={e.employmentId} className="px-4 py-3">
                <div className="text-sm font-medium">{e.company}</div>
                <div className="text-xs text-muted-foreground">
                  {e.position ?? '—'} · {e.department ?? '—'}
                </div>
                <div className="mt-1.5 flex justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">{t('basicPlusAllowance')}</span>
                  <span className="tabular-nums">{rm(Number(e.basic ?? 0) + Number(e.allowance ?? 0))}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );

  // ── BANK & STATUTORY TAB ──────────────────────────────────────────────────────────────────────────
  const bankStatutoryPanel = (
    <>
      <ReadCard id="section-bank" title={tp('bankCardTitle')}>
        <ReadField label={tp('bank')} value={st.bankName} notSet={notSet} pending={pendingFor('bankName')} />
        {/* Masked, exactly as /me has always masked it: the employee confirms which account is on file
            without the full number rendering into a shared screen or a screenshot. */}
        <ReadField label={tp('bankAccount')} value={maskAccountNumber(st.bankAccountNo)} notSet={notSet} pending={pendingFor('bankAccountNo')} />
      </ReadCard>

      <ReadCard id="section-statutory" title={tp('statutoryMalaysia')}>
        <ReadField label={tp('epfNumber')} value={st.epfNumber} notSet={notSet} pending={pendingFor('epfNumber')} />
        <ReadField label={tp('epfCitizenship')} value={epfCitizenshipLabel(st.epfCitizenship)} notSet={notSet} />
        <ReadField label={tp('socsoEisNumber')} value={st.socsoNumber} notSet={notSet} pending={pendingFor('socsoNumber')} />
        <ReadField label={tp('socsoCategoryLabel')} value={socsoCategoryLabel(st.socsoCategory)} notSet={notSet} />
        <ReadField label={tp('eisCategoryLabel')} value={eisCategoryLabel(st.eisCategory)} notSet={notSet} />
        <ReadField label={tp('taxNumber')} value={st.taxNumber} notSet={notSet} pending={pendingFor('taxNumber')} />
        <ReadField label={tp('incomeTaxResident')} value={yesNo(st.isResident)} notSet={notSet} />
        <ReadField
          label={tp('taxCategoryLabel')}
          value={st.taxCategory ? t(PCB_LABEL_KEY[st.taxCategory] ?? 'pcbSingle') : null}
          notSet={notSet}
          pending={pendingFor('taxCategory')}
        />
        <ReadField label={tp('childrenPhysical')} value={st.numChildren == null ? null : String(st.numChildren)} notSet={notSet} pending={pendingFor('numChildren')} />
        <ReadField label={tp('disabledIndividualLabel')} value={yesNo(st.disabledIndividual)} notSet={notSet} />
        <ReadField label={tp('disabledSpouseLabel')} value={yesNo(st.disabledSpouse)} notSet={notSet} />
      </ReadCard>

      <ReadCard id="section-others-statutory" title={tp('othersStatutoryTitle')}>
        <ReadField label={tp('subjectToHrdf')} value={yesNo(st.subjectToHrdf)} notSet={notSet} />
      </ReadCard>

      {/* ADR-0012 path two — the approval-gated request. WIDENED, not rebuilt: the mechanism already
          exists (core/profile.ts → profile_change_request → an administrator's decision through
          assertCanDecide) and stage two must not build a second one. What changed is WHICH fields it
          offers — lib/profile-requestable-fields.ts, one declaration, read by the form, the action, the
          sanitiser and the applier — and that a rejection now carries a reason the employee is shown.
          The card renders only this tab's fields; the Profile tab has its own. */}
      <RequestChangeCard tab="bankStatutory" title={t('approvalGatedHeading')} requests={profileRequests} allowedKeys={allowedRequestKeys} />
    </>
  );

  // ── PAYROLL TAB ───────────────────────────────────────────────────────────────────────────────────
  const payrollPanel = (
    <>
      {/* The CURRENT salary only. The revision history is withheld — each past row carries HR's remark on
          why the increment was given, which is a conversation and not a field. See
          docs/me-profile-field-visibility.md. */}
      <ReadCard id="section-compensation" title={tp('compensation')}>
        {/* WHOSE PAY, AND FOR WHICH EMPLOYMENT. This card is the compensation row of the employment /me
            resolved from the session; an employee holding two of them (ADR-0009) would otherwise read one
            unlabelled figure and have no way to tell which contract it belongs to. The other positions and
            their pay are on the Employment tab's "My positions" card. */}
        <ReadField label={tp('employmentInfo.company')} value={emp.company} notSet={notSet} />
        <ReadField label={tp('compensation')} value={comp ? Number(comp.basicSalary).toFixed(2) : null} notSet={notSet} />
        <ReadField label={tp('salaryCurrency')} value={comp?.currency ?? null} notSet={notSet} />
        <ReadField label={tp('effectiveDate')} value={comp?.validFrom ?? null} notSet={notSet} />
        <ReadField label={tp('paymentMethod')} value={paymentMethodLabel(record.paymentMethod)} notSet={tp('paymentMethodNotSet')} />
        <ReadField label={tp('payMode')} value={comp?.payMode ?? null} notSet={notSet} />
        <ReadField label={tp('paymentTerm')} value={comp?.paymentTerm ?? null} notSet={notSet} />
        {/* Daily / hourly staff are paid from the rate, not the basic — it was already projected in
            app/me/record.ts and simply never put on screen. Blank for a monthly contract, like any other
            field that is not recorded. */}
        <ReadField label={tp('rateAmount')} value={comp?.rateAmount ?? null} notSet={notSet} />
      </ReadCard>

      {/* r298 — this card, TP1 and My loans are the Payroll pack's; absent (and unread) without Payroll. */}
      {payrollOn && (
      <Card className="overflow-hidden" data-tour="me-payslips">
        <SectionHeader title={t('myPayslips')} count={finalizedPayslips.length} />
        {payslipMonths.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('noPayslipsYet')}</p>}
        {payslipMonths.length > 0 && (
          // Native GET round-trip: `tab=payroll` so the full-document reload lands back on this tab.
          <form method="get" className="grid grid-cols-1 items-end gap-3 border-b border-border p-4 sm:grid-cols-3">
            <input type="hidden" name="tab" value="payroll" />
            <Field label={t('selectMonth')}>
              <select name="month" defaultValue={selectedMonth} className={inputCls}>
                {payslipMonths.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('selectCycle')}>
              <select name="cycle" defaultValue={selectedCycle} className={inputCls}>
                {payslipCycles.map((cy) => (
                  <option key={cy.key} value={cy.key}>
                    {cycleLabelOf(cy)}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" size="sm">
              {t('selectCycle')}
            </Button>
          </form>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
                <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colGross')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colDeductions')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colNet')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {displayedPayslips.map((ps) => (
                <tr key={ps.id}>
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/me/payslip/${ps.id}`} className="text-primary hover:underline">
                      {ps.payPeriod}
                    </Link>
                    {ps.runType !== 'regular' && (
                      <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                        {tRun(ps.runType)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{ps.company}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(ps.gross)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(ps.deductions)}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(ps.net)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{t(`payrollStatus.${ps.status}`)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <a
                      href={`/me/payslip/${ps.id}/pdf`}
                      download
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                    >
                      {t('payslip.downloadPdf')}
                    </a>
                  </td>
                </tr>
              ))}
              {displayedPayslips.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noPayslips')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      )}

      {/* My Payroll — Self Personal Tax Relief (LHDN TP1). Year-scoped, grouped per company. */}
      {payrollOn && (
      <Card className="overflow-hidden">
        <SectionHeader title={t('taxReliefTp1')} count={taxRelief.rows.length} />
        <p className="px-4 pb-2 pt-1 text-xs text-muted-foreground">
          {t('taxReliefDescription', { year: String(taxRelief.year) })}
        </p>
        <p className="px-4 pb-3">
          <Link href="/me/tax-relief" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {t('manageTp1')} →
          </Link>
        </p>
        {taxRelief.rows.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('noTaxRelief')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                  <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colTp1')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Object.entries(taxReliefByCompany).map(([companyName, rows]) => {
                  const subtotal = rows.reduce((sum, r) => sum + r.tp1, 0);
                  return rows
                    .map((r, i) => (
                      <tr key={`${companyName}-${r.payPeriod}-${r.runType}`}>
                        {i === 0 && (
                          <td rowSpan={rows.length} className="px-4 py-2.5 align-top font-medium text-muted-foreground">
                            {companyName}
                          </td>
                        )}
                        <td className="px-4 py-2.5 font-medium">
                          {r.payPeriod}
                          {r.runType !== 'regular' && (
                            <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                              {tRun(r.runType)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{rm(r.tp1)}</td>
                      </tr>
                    ))
                    .concat(
                      <tr key={`${companyName}-subtotal`} className="bg-muted/30">
                        <td className="px-4 py-2 text-right text-xs font-medium text-muted-foreground" colSpan={2}>
                          {companyName}
                        </td>
                        <td className="px-4 py-2 text-right font-medium tabular-nums">{rm(subtotal)}</td>
                      </tr>,
                    );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td className="px-4 py-2.5 text-right font-medium" colSpan={2}>
                    {t('yearTaxRelief', { year: String(taxRelief.year) })}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{rm(taxRelief.ytd)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
      )}

      {/* 1.2.8 My loans (ADR-0060) — read-only: outstanding balance + per-instalment schedule. */}
      {payrollOn && myLoans.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('myLoans')} count={myLoans.length} />
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('loanType')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('loanInstalment')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('loanOutstanding')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('loanProgress')}</th>
                <th className="px-4 py-2 font-medium">{t('loanStatus')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {myLoans.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-2.5">{t(`loanTypeName.${l.loanType}`)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(l.monthlyInstalment)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(l.outstandingBalance)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {l.instalmentsPaid}/{l.durationMonths}
                  </td>
                  <td className="px-4 py-2.5">{t(`loanStatusName.${l.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );

  // ── FAMILY TAB ────────────────────────────────────────────────────────────────────────────────────
  const familyPanel = (
    <Card id="section-family" className="overflow-hidden">
      <SectionHeader title={tp('family.title')} count={record.dependents.length} />
      <p className="mx-4 mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{tp('family.note')}</p>
      {record.dependents.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">{tp('family.none')}</p>
      ) : (
        <div className="overflow-x-auto px-4 pb-4 pt-3">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{tp('family.name')}</th>
                <th className="py-2 pr-3 font-medium">{tp('family.relationship')}</th>
                <th className="py-2 pr-3 font-medium">{tp('family.dateOfBirth')}</th>
                <th className="py-2 pr-3 font-medium">{tp('family.childAge')}</th>
                <th className="py-2 pr-3 font-medium">{tp('family.contactNumber')}</th>
                <th className="py-2 font-medium">{tp('family.countsTowardRelief')}</th>
              </tr>
            </thead>
            <tbody>
              {record.dependents.map((d) => (
                <tr key={d.id} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3 font-medium">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {d.fullName}
                      {d.isBeneficiary && <Badge variant="success">{tp('family.beneficiary')}</Badge>}
                      {d.isDeceased && <Badge variant="default">{tp('family.deceased')}</Badge>}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{relationshipLabel(d.relationship)}</td>
                  <td className="whitespace-nowrap py-2 pr-3">{d.dateOfBirth ?? '—'}</td>
                  <td className="py-2 pr-3">{childAgeYears(d.dateOfBirth) ?? '—'}</td>
                  <td className="py-2 pr-3">{d.phone ?? '—'}</td>
                  {/* The SAME predicate the Personnel table uses, so the two screens cannot disagree
                      about whether a child is counted for relief. */}
                  <td className="py-2">
                    {d.relationship === 'child' ? (isChildReliefEligible(d) ? tp('family.yes') : tp('family.no')) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{tp('family.hint')}</p>
    </Card>
  );

  // ── DOCUMENTS TAB ─────────────────────────────────────────────────────────────────────────────────
  // The HR personnel-file repository is deliberately NOT here — see docs/me-profile-field-visibility.md.
  // What is here is the set of documents produced FOR the employee.
  const documentsPanel = (
    <>
      {/* r298 — without Payroll the card is drawn only when a statement exists (a company that ran payroll
          and then dropped it), and only the PDF link is offered: /payroll/reports/ea sits behind the Payroll
          layout. A company that never ran payroll sees no EA card at all. */}
      {(payrollOn || eaRows.length > 0) && (
      <Card className="p-5">
        <SectionHeader title={t('taxStatementEa')} />
        <p className="px-1 pt-2 text-xs text-muted-foreground">{t('taxStatementDescription')}</p>
        {eaRows.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            {t('noPayslips')}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {eaRows.map((r) => (
              <li
                key={`${r.employmentId}-${r.year}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
              >
                <span>
                  {r.company} · <span className="text-muted-foreground">{t('yearOfAssessment', { year: r.year })}</span>
                </span>
                <span className="flex items-center gap-3">
                  {payrollOn && (
                    <Link href={`/payroll/reports/ea/${r.employmentId}?year=${r.year}`} className="text-primary hover:underline">
                      {t('viewDownload')}
                    </Link>
                  )}
                  <Link href={`/me/ea/${r.employmentId}/pdf?year=${r.year}`} className="text-primary hover:underline">
                    {t('eaDownloadPdf')}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      )}

      {/* Employment review outcome (0110) — info-only; surfaces the employee's own completed review. */}
      <MeReviewCard s={s} employmentId={employmentId} />

      {/* Resignation (ADR-0042, #29) — employee-initiated, HR-approved. */}
      <Card className="p-5">
        <SectionHeader title={t('resignationTitle')} />
        <p className="px-1 pt-2 text-xs text-muted-foreground">{t('resignationDescription')}</p>
        {resignation?.status === 'pending' ? (
          <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="text-sm">
              <div className="font-medium">{t('resignationPendingTitle')}</div>
              <div className="mt-1 text-muted-foreground">
                {t('lastWorkingDayLabel')}: <span className="tabular-nums">{resignation.lastWorkingDay}</span>
              </div>
              {resignation.reason && <div className="mt-0.5 text-muted-foreground">{resignation.reason}</div>}
            </div>
            <form action={myWithdrawResignation}>
              <input type="hidden" name="requestId" value={resignation.id} />
              <Button type="submit" size="sm" variant="outline">
                {t('withdrawResignation')}
              </Button>
            </form>
          </div>
        ) : resignation?.status === 'accepted' ? (
          <p className="mt-3 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            {t('resignationAcceptedNote', { date: resignation.lastWorkingDay })}
          </p>
        ) : (
          <form action={mySubmitResignation} className="mt-3 space-y-3">
            {resignation?.status === 'rejected' && <p className="text-xs text-muted-foreground">{t('resignationWasRejected')}</p>}
            {resignation?.status === 'withdrawn' && <p className="text-xs text-muted-foreground">{t('resignationWasWithdrawn')}</p>}
            <Field label={t('lastWorkingDayLabel')}>
              <input type="date" name="lastWorkingDay" required className={inputCls} />
            </Field>
            <Field label={t('resignationReasonLabel')}>
              <textarea name="reason" rows={3} className={inputCls} placeholder={t('resignationReasonPlaceholder')} />
            </Field>
            {/* #42cff598: supporting documents. `accept` is a client hint only — validateLeaveDocument is
                the real server-side gate. */}
            <Field label={t('resignationDocumentLabel')}>
              <input
                type="file"
                name="document"
                multiple
                accept="image/jpeg,image/png,application/pdf"
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('resignationDocumentHint')}</p>
            </Field>
            <Button type="submit" size="sm" variant="outline">
              {t('submitResignation')}
            </Button>
          </form>
        )}
      </Card>
    </>
  );

  return (
    // c002b3c3's container — the SAME width the Personnel record uses, because "full width, arranged in
    // cards, so a section reads across the screen" is the plan's wording and a narrower cap here would
    // reflow every card the two screens are meant to share.
    <div className="mx-auto max-w-[100rem] space-y-6">
      <div data-tour="me-intro">
        <PageHeader
          title={t('title')}
          description={`${p.employeeCode ? `${p.employeeCode} · ` : ''}${p.fullName} · ${emp.position ?? '—'}, ${emp.department ?? '—'}`}
        />
      </div>

      <ErrorBanner message={error} />

      {/* The geofenced punch. NOT a tab: /me is one of only two places a clock-in can be made, and the six
          tabs below are the Personnel record's shape, which has no clocking card on it. Keeping it above
          the strip is what stops the restructure from quietly removing a capability. */}
      <Card className="p-4" data-tour="me-attendance">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t('todayHeading')}</h2>
            <p className="text-xs text-muted-foreground">{today}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {!todayRow ? (
              <AttendanceClockButton action={myCheckIn} label={t('checkIn')} />
            ) : !todayRow.checkOutAt ? (
              <>
                <span className="text-sm text-muted-foreground">
                  {t.rich('checkedInAt', {
                    time: () => <span className="font-medium text-foreground">{todayRow.checkInAt}</span>,
                  })}{' '}
                  <Pill status={todayRow.status} map={ATT_STATUS} label={t(`attStatus.${todayRow.status}`)} />
                </span>
                <AttendanceClockButton action={myCheckOut} label={t('checkOut')} variant="secondary" />
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                {todayRow.checkInAt} → {todayRow.checkOutAt}{' '}
                <Pill status={todayRow.status} map={ATT_STATUS} label={t(`attStatus.${todayRow.status}`)} />
              </span>
            )}
          </div>
        </div>
        <LocationNotice />
        {/* A link, not a copy — the same rule the request forms moved under at 0bb0e303. */}
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3">
          <Link href="/attendance" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {t('viewAttendanceHistory')} →
          </Link>
          <Link href="/attendance/requests" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {t('fileAttendanceRequest')} →
          </Link>
          <Link href="/me/performance" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {t('myPerformanceLink')} →
          </Link>
        </div>
      </Card>

      <ClientTabs<MeTabKey>
        defaultTab={activeTab}
        emptyLabel={tp('tabs.empty')}
        ariaLabel={t('title')}
        tabs={ME_TABS.map((key) => ({ key, label: tp(ME_TAB_LABEL_KEY[key]) }))}
        panels={{
          profile: profilePanel,
          job: employmentPanel,
          bankStatutory: bankStatutoryPanel,
          payroll: payrollPanel,
          family: familyPanel,
          documents: documentsPanel,
        }}
      />
    </div>
  );
}
