import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  myAttendance,
  myEmployment,
  myEmploymentIdsAll,
  myEmployments,
  myPayslips,
  myTaxRelief,
  myTaxReliefEmploymentIds,
} from '@/core/read';
import { listLoansForEmployment } from '@/core/loans';
import { myProfile, myProfileChangeRequests } from '@/core/profile';
import { myResignation } from '@/core/offboarding';
import { MeReviewCard } from './review-card';
import { myCheckIns, myFeedbackRequests, myGoals, myReviews } from '@/packs/performance/service';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { AttendanceClockButton, LocationNotice } from '@/components/attendance-clock-button';
import { ClientTabs } from '@/components/personnel-tabs';
import { todayInKualaLumpur } from '@/lib/hr-date';

// a7cbd895: the Leave tab (and its dialogs/forms/reads) moved wholesale to /leave — "My Absence" in the
// left nav. /me is purely profile now; ?tab=leave deep-links are forwarded (see the redirect below).
// 0bb0e303 rev2: myRequestCorrection / myRequestOvertime / myRequestTravel left this list the same way —
// they are bound on /attendance/requests now (the actions themselves did not move; the forms did).
import {
  myCheckIn,
  myCheckOut,
  myCreateGoal,
  myDeclinePeerFeedback,
  myRequestProfileChange,
  mySubmitPeerFeedback,
  mySubmitResignation,
  myUpdateContact,
  myUpdateGoalProgress,
  myWithdrawResignation,
} from './actions';

// 311ad7ba: the ESS tabs, ordered per the reporter's expected_function enumeration. A `?tab=` query
// param deep-links / survives the native GET reloads (payslip month selector). a7cbd895 removed the
// Leave tab — leave self-service lives on /leave ("My Absence"); ?tab=leave now redirects there.
type MeTabKey = 'overview' | 'profile' | 'pay' | 'performance' | 'documents';
const ME_TAB_KEYS: readonly MeTabKey[] = ['overview', 'profile', 'pay', 'performance', 'documents'];

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LEAVE_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
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
// Maps proposed-change field → translation leaf key (resolved via t() where rendered).
const PROPOSED_LABEL_KEY: Record<string, string> = {
  bankName: 'proposedBankName',
  bankAccountNo: 'proposedAccountNo',
  taxCategory: 'proposedPcbCategory',
  numChildren: 'proposedChildren',
  dateOfBirth: 'dateOfBirthLabel',
  gender: 'genderLabel',
  maritalStatus: 'maritalLabel',
};
const maskAcct = (no?: string | null) =>
  no ? `•••• ${no.slice(-4)}` : '—';
function summarizeProposed(p: unknown, t: (key: string) => string): string {
  const o = (p ?? {}) as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => k in PROPOSED_LABEL_KEY);
  return keys.length ? keys.map((k) => t(PROPOSED_LABEL_KEY[k])).join(', ') : t('proposedChange');
}

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
  const tRun = await getTranslations('payroll.list.runType'); // Wave 2C — shared run-type labels
  const s = await getSession();
  const { error, month: spMonth, cycle: spCycle, asOf: spAsOf, tab: spTab } = await searchParams;

  // My Absence (a7cbd895): the Leave tab moved to the first-level /leave page. Keep every old
  // /me?tab=leave deep-link (bookmarks, notification links, stale forms) working by forwarding it —
  // with its leave-relevant params — to the new home.
  if (spTab === 'leave') {
    const qs = new URLSearchParams();
    if (error) qs.set('error', error);
    if (spAsOf) qs.set('asOf', spAsOf);
    const q = qs.toString();
    redirect(`/leave${q ? `?${q}` : ''}`);
  }

  const me = await myEmployment(s);

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const employments = await myEmployments(s);
  // My Payroll TP1 is leaver-safe: resolve ids by person, including terminated employments, so a resigned
  // employee can still retrieve the relief history they need to file taxes (payslip RLS still gates rows).
  const taxReliefEmploymentIds = await myTaxReliefEmploymentIds(s);
  // 0bb0e303 rev2 — the correction and travel-request reads left with their forms; this page no longer
  // lists either, so fetching them here would be work nothing renders.
  const [payslips, taxRelief, attendance, profile, profileRequests, reviews, goals, checkins, feedbackRequests, resignation, myLoans] =
    await Promise.all([
      myPayslips(s, employments.map((e) => e.employmentId)),
      myTaxRelief(s, taxReliefEmploymentIds),
      myAttendance(s, me.employmentId, 14),
      myProfile(s),
      myProfileChangeRequests(s, me.employmentId),
      myReviews(s),
      myGoals(s),
      myCheckIns(s),
      myFeedbackRequests(s),
      myResignation(s, me.employmentId),
      // 1.2.8 (ADR-0060): read-only "My loans" — RLS scopes to the caller's own employment. ESS NEVER calls
      // a loan write service (the loan write methods are admin-only; this is a read helper).
      listLoansForEmployment(s, me.employmentId),
    ]);
  // Group TP1 rows by company — each entity files its own PCB, so a single blended YTD would mislead.
  const taxReliefByCompany = taxRelief.rows.reduce<Record<string, typeof taxRelief.rows>>((acc, r) => {
    (acc[r.company] ??= []).push(r);
    return acc;
  }, {});

  const today = todayInKualaLumpur();
  const todayRow = attendance.find((a) => a.date === today);

  // Leave balances / entitlement breakdowns / request history / apply form: all relocated to /leave
  // ("My Absence", a7cbd895) — /me carries no leave reads or leave UI anymore.

  // EA (annual tax statement) rows — derived from the principal's REAL payslips across ALL their
  // employments incl. terminated ones (leavers must reach their prior employer's EA). `myEmploymentIdsAll`
  // is RLS-scoped to own employments; `myPayslips` is RLS-gated, so no foreign data leaks. We build one
  // row per distinct (company, year) pair the user actually has payslips for — no synthetic year window,
  // so a principal with zero payslips simply sees no EA rows (empty state below). Each payslip carries the
  // batch's company name; we map that back to its employmentId for the EA link.
  const eaEmployments = await myEmploymentIdsAll(s);
  const eaPayslips = await myPayslips(s, eaEmployments.map((e) => e.employmentId));
  const employmentIdByCompany = new Map(eaEmployments.map((e) => [e.company, e.employmentId]));
  const eaRowMap = new Map<string, { employmentId: string; company: string; year: string }>();
  for (const ps of eaPayslips) {
    const year = ps.payPeriod.slice(0, 4); // 'YYYY-MM' → 'YYYY' (a string, matching EaStatement.year)
    const employmentId = employmentIdByCompany.get(ps.company);
    if (!employmentId) continue;
    const key = `${ps.company}::${year}`;
    if (!eaRowMap.has(key)) eaRowMap.set(key, { employmentId, company: ps.company, year });
  }
  const eaRows = [...eaRowMap.values()].sort(
    (a, b) => a.company.localeCompare(b.company) || b.year.localeCompare(a.year),
  );

  // Self Payslip selectors (Feature 1.1.1): pick by payroll month + pay cycle, server-side.
  // Only finalized batches (status 'closed') are offered; draft/processed never surface in the
  // month/cycle options or the default selection. Month = payPeriod ('YYYY-MM'); cycle key =
  // `${runType}#${runSeq}` so a multi-company month with the same cycle keeps all its rows.
  // Step 6 (f3148da1) — only RELEASED payslips are offered in ESS. `released` is computed in myPayslips from
  // the batch close instant + the company's payslip-release config (immediate / fixed date / relative to payday).
  const finalizedPayslips = payslips.filter((p) => p.status === 'closed' && p.released);
  const payslipMonths = [...new Set(finalizedPayslips.map((p) => p.payPeriod))].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  const selectedMonth = spMonth && payslipMonths.includes(spMonth) ? spMonth : payslipMonths[0] ?? '';
  // Distinct cycles for the selected month, preserving the read's (payPeriod desc, runSeq) order.
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

  const activeTab: MeTabKey = ME_TAB_KEYS.includes(spTab as MeTabKey) ? (spTab as MeTabKey) : 'overview';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div data-tour="me-intro">
        <PageHeader
          title={t('title')}
          description={`${me.employeeCode ? `${me.employeeCode} · ` : ''}${me.name} · ${me.position ?? '—'}, ${me.department ?? '—'}`}
        />
      </div>

      <ErrorBanner message={error} />

      <ClientTabs<MeTabKey>
        defaultTab={activeTab}
        emptyLabel={t('tabsEmpty')}
        ariaLabel={t('title')}
        tabs={[
          { key: 'overview', label: t('secOverview') },
          { key: 'profile', label: t('secProfile') },
          { key: 'pay', label: t('secPay') },
          { key: 'performance', label: t('secPerformance') },
          { key: 'documents', label: t('secDocuments') },
        ]}
        panels={{
          overview: (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Attendance */}
        <Card className="p-5" data-tour="me-attendance">
          <h2 className="text-sm font-semibold">{t('todayHeading')}</h2>
          <p className="text-xs text-muted-foreground">{today}</p>
          <div className="mt-4">
            {!todayRow ? (
              <AttendanceClockButton action={myCheckIn} label={t('checkIn')} />
            ) : !todayRow.checkOutAt ? (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  {t.rich('checkedInAt', {
                    time: () => (
                      <span className="font-medium text-foreground">{todayRow.checkInAt}</span>
                    ),
                  })}{' '}
                  <Pill status={todayRow.status} map={ATT_STATUS} label={t(`attStatus.${todayRow.status}`)} />
                </div>
                <AttendanceClockButton action={myCheckOut} label={t('checkOut')} variant="secondary" />
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {todayRow.checkInAt} → {todayRow.checkOutAt} <Pill status={todayRow.status} map={ATT_STATUS} label={t(`attStatus.${todayRow.status}`)} />
              </div>
            )}
            <LocationNotice />
          </div>

          {/* 311ad7ba: the recent-days list moved out — Attendance has its own dedicated page. The clock
              in/out control above STAYS: /me and the clock portal are the only places a geofenced punch can
              be made.
              0bb0e303 rev2: the three request forms that used to sit below moved to My Attendance >
              Attendance Request, because burying them in a fold-out on the profile page was the very
              complaint the item was raised about. A link, not a copy — two sets of the same form on two
              screens is how they drift apart.
              c6bb5f5a: that ONE screen became four, so this link's WORDS changed while its target did not.
              It used to promise "an attendance, overtime or travel request"; overtime and travel now have
              menu rows and screens of their own, and a link that still promised all three would land the
              employee on a screen carrying only the first. The key is unchanged — the string names what
              this link actually opens. */}
          <div className="mt-5 space-y-2 border-t border-border pt-4">
            <Link
              href="/attendance"
              className="block text-sm font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('viewAttendanceHistory')} →
            </Link>
            <Link
              href="/attendance/requests"
              className="block text-sm font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('fileAttendanceRequest')} →
            </Link>
          </div>
        </Card>

        {/* My positions (concurrent multi-company, ADR-0009) */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold">
            {t('myPositions', { count: employments.length })}
          </h2>
          <p className="text-xs text-muted-foreground">{t('joinedOn', { date: me.hiredOn })}</p>
          <ul className="mt-3 space-y-3">
            {employments.map((e) => {
              const alloc = (e.costAllocation as { companyId: string; percent: number }[] | null) ?? [];
              return (
                <li key={e.employmentId} className="rounded-lg border border-border p-3">
                  <div className="text-sm font-medium">{e.company}</div>
                  <div className="text-xs text-muted-foreground">
                    {e.position ?? '—'} · {e.department ?? '—'}
                  </div>
                  <div className="mt-1.5 flex justify-between text-xs">
                    <span className="text-muted-foreground">{t('basicPlusAllowance')}</span>
                    <span className="tabular-nums">
                      {rm(Number(e.basic ?? 0) + Number(e.allowance ?? 0))}
                    </span>
                  </div>
                  {alloc.length > 0 && (
                    <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      {t('costRecharged', { percents: alloc.map((a) => `${a.percent}%`).join(' / ') })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
            </div>
          ),
          profile: (
      /* My details — contact self-edit (direct) + pay-affecting changes (approval-gated, ADR-0012) */
      <Card className="p-5">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div data-tour="me-contact">
            <h2 className="text-sm font-semibold">{t('myDetails')}</h2>
            <p className="text-xs text-muted-foreground">{t('contactUpdatesImmediately')}</p>
            <form action={myUpdateContact} className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('phoneLabel')}>
                  <input name="phone" defaultValue={profile?.person?.phone ?? ''} className={inputCls} />
                </Field>
                <Field label={t('personalEmailLabel')}>
                  <input
                    name="personalEmail"
                    type="email"
                    defaultValue={profile?.person?.personalEmail ?? ''}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label={t('addressLine1Label')}>
                <input name="addressLine1" defaultValue={profile?.person?.addressLine1 ?? ''} className={inputCls} />
              </Field>
              <Field label={t('addressLine2Label')}>
                <input name="addressLine2" defaultValue={profile?.person?.addressLine2 ?? ''} className={inputCls} />
              </Field>
              <Field label={t('addressLine3Label')}>
                <input name="addressLine3" defaultValue={profile?.person?.addressLine3 ?? ''} className={inputCls} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('postcodeLabel')}>
                  <input name="postcode" defaultValue={profile?.person?.postcode ?? ''} className={inputCls} />
                </Field>
                <Field label={t('cityLabel')}>
                  <input name="city" defaultValue={profile?.person?.city ?? ''} className={inputCls} />
                </Field>
                <Field label={t('stateLabel')}>
                  <input name="state" defaultValue={profile?.person?.state ?? ''} className={inputCls} />
                </Field>
                <Field label={t('countryLabel')}>
                  <input name="country" defaultValue={profile?.person?.country ?? ''} className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('emergencyContactLabel')}>
                  <input
                    name="emergencyContactName"
                    defaultValue={profile?.person?.emergencyContactName ?? ''}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('emergencyRelationshipLabel')}>
                  <input
                    name="emergencyContactRelationship"
                    defaultValue={profile?.person?.emergencyContactRelationship ?? ''}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('emergencyPhoneLabel')}>
                  <input
                    name="emergencyContactPhone"
                    defaultValue={profile?.person?.emergencyContactPhone ?? ''}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('emergencyPhone2Label')}>
                  <input
                    name="emergencyContactPhone2"
                    defaultValue={profile?.person?.emergencyContactPhone2 ?? ''}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label={t('emergencyAddressLabel')}>
                <input
                  name="emergencyContactAddress"
                  defaultValue={profile?.person?.emergencyContactAddress ?? ''}
                  className={inputCls}
                />
              </Field>
              <Button type="submit" size="sm">
                {t('saveDetails')}
              </Button>
            </form>
          </div>

          <div className="lg:border-l lg:border-border lg:pl-6" data-tour="me-bank">
            <h2 className="text-sm font-semibold">{t('approvalGatedHeading')}</h2>
            <p className="text-xs text-muted-foreground">{t('changesNeedApproval')}</p>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('bank')}</dt>
                <dd>{profile?.statutory?.bankName ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('account')}</dt>
                <dd className="tabular-nums">{maskAcct(profile?.statutory?.bankAccountNo)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('pcbCategory')}</dt>
                <dd>{t(PCB_LABEL_KEY[profile?.statutory?.taxCategory ?? 1])}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('dependentChildren')}</dt>
                <dd className="tabular-nums">{profile?.statutory?.numChildren ?? 0}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('dateOfBirthLabel')}</dt>
                <dd className="tabular-nums">{profile?.person?.dateOfBirth ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('genderLabel')}</dt>
                <dd>{profile?.person?.gender ? t(`gender_${profile.person.gender}`) : '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('maritalLabel')}</dt>
                <dd>{profile?.person?.maritalStatus ? t(`marital_${profile.person.maritalStatus}`) : '—'}</dd>
              </div>
            </dl>

            <details className="mt-4 border-t border-border pt-3">
              <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('requestAChange')}
              </summary>
              <form action={myRequestProfileChange} className="mt-3 space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('bankNameLabel')}>
                    <input name="bankName" placeholder="Maybank" className={inputCls} />
                  </Field>
                  <Field label={t('accountNoLabel')}>
                    <input name="bankAccountNo" placeholder="1234567890" className={inputCls} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('pcbCategory')}>
                    <select name="taxCategory" defaultValue="" className={inputCls}>
                      <option value="">{t('noChangeOption')}</option>
                      <option value="1">{t('pcbOption1')}</option>
                      <option value="2">{t('pcbOption2')}</option>
                      <option value="3">{t('pcbOption3')}</option>
                    </select>
                  </Field>
                  <Field label={t('dependentChildren')}>
                    <input type="number" name="numChildren" min="0" placeholder="—" className={inputCls} />
                  </Field>
                </div>
                <Field label={t('dateOfBirthLabel')}>
                  <input type="date" name="dateOfBirth" defaultValue="" className={inputCls} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('genderLabel')}>
                    <select name="gender" defaultValue="" className={inputCls}>
                      <option value="">{t('noChangeOption')}</option>
                      <option value="male">{t('gender_male')}</option>
                      <option value="female">{t('gender_female')}</option>
                      <option value="undisclosed">{t('gender_undisclosed')}</option>
                    </select>
                  </Field>
                  <Field label={t('maritalLabel')}>
                    <select name="maritalStatus" defaultValue="" className={inputCls}>
                      <option value="">{t('noChangeOption')}</option>
                      <option value="single">{t('marital_single')}</option>
                      <option value="married">{t('marital_married')}</option>
                      <option value="divorced">{t('marital_divorced')}</option>
                      <option value="widowed">{t('marital_widowed')}</option>
                      <option value="separated">{t('marital_separated')}</option>
                      <option value="other">{t('marital_other')}</option>
                    </select>
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">{t('leaveBlankToKeep')}</p>
                <Button type="submit" size="sm">
                  {t('submitForApproval')}
                </Button>
              </form>
              {profileRequests.length > 0 && (
                <ul className="mt-3 space-y-1.5 text-xs">
                  {profileRequests.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-muted-foreground">{summarizeProposed(r.proposed, t)}</span>
                      <Pill status={r.status} map={LEAVE_STATUS} label={t(`leaveStatus.${r.status}`)} />
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </div>
        </div>
      </Card>
          ),
          pay: (
            <>
      {/* Payslips */}
      <Card className="overflow-hidden" data-tour="me-payslips">
        {/* Counted from the SAME list that renders below (feedback 9b25b094). It used to count
            `payslips.length` — every payslip the employee has — while the list only ever shows
            `finalizedPayslips` (status closed AND released). An employee whose payslips were not yet
            released therefore saw a header reading 3 above an empty space, with nothing to explain the
            gap.

            The count follows the list rather than the list following the count, deliberately: an
            unreleased payslip is not something the employee is entitled to open yet, so the answer is
            to stop promising it, not to start showing it. No payslip is being withheld from anyone who
            should have it — this was the header over-counting, not the list under-returning. */}
        <SectionHeader title={t('myPayslips')} count={finalizedPayslips.length} />
        {payslipMonths.length === 0 && (
          // Said rather than implied. Previously nothing at all rendered here, so "no payslips yet" and
          // "something failed to load" looked identical.
          <p className="p-4 text-sm text-muted-foreground">{t('noPayslipsYet')}</p>
        )}
        {payslipMonths.length > 0 && (
          // Select by payroll month + pay cycle (server component, GET round-trip — no client JS).
          // Mirrors app/payroll/reports/page.tsx: <form method="get"> + native <select> + submit.
          // 311ad7ba: `tab=pay` so the full-document GET reload lands back on this tab.
          <form method="get" className="grid grid-cols-1 items-end gap-3 border-b border-border p-4 sm:grid-cols-3">
            <input type="hidden" name="tab" value="pay" />
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
                {payslipCycles.map((c) => (
                  <option key={c.key} value={c.key}>
                    {cycleLabelOf(c)}
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
              {displayedPayslips.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/me/payslip/${p.id}`} className="text-primary hover:underline">
                      {p.payPeriod}
                    </Link>
                    {p.runType !== 'regular' && (
                      <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                        {tRun(p.runType)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{p.company}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(p.gross)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(p.deductions)}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(p.net)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{t(`payrollStatus.${p.status}`)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <a
                      href={`/me/payslip/${p.id}/pdf`}
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

      {/* My Payroll — Self Personal Tax Relief (LHDN TP1). Year-scoped, grouped per company. */}
      <Card className="mt-6 overflow-hidden">
        <SectionHeader title={t('taxReliefTp1')} count={taxRelief.rows.length} />
        <p className="px-4 pb-2 pt-1 text-xs text-muted-foreground">
          {t('taxReliefDescription', { year: String(taxRelief.year) })}
        </p>
        <p className="px-4 pb-3">
          <Link
            href="/me/tax-relief"
            className="text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
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
                          <td
                            rowSpan={rows.length}
                            className="px-4 py-2.5 align-top font-medium text-muted-foreground"
                          >
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

      {/* 1.2.8 My loans (ADR-0060) — read-only: outstanding balance + per-instalment schedule. */}
      {myLoans.length > 0 && (
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
          ),
          performance: (
            <>
      {/* Performance reviews */}
      {reviews.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('myReviews')} count={reviews.length} />
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCycle')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colOverall')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {reviews.map((r) => {
                // Employee-facing status: their own perspective, not the raw enum.
                const label =
                  r.status === 'self_review'
                    ? t('reviewLabelSelfReview')
                    : r.status === 'manager_review'
                      ? t('reviewLabelWithManager')
                      : r.status === 'submitted'
                        ? r.released
                          ? t('reviewLabelReadyToAcknowledge')
                          : t('reviewLabelAwaitingRelease')
                        : t('reviewLabelAcknowledged');
                const action =
                  r.status === 'self_review'
                    ? t('reviewActionSelfReview')
                    : r.status === 'submitted' && r.released
                      ? t('reviewActionAcknowledge')
                      : r.released || r.status === 'acknowledged'
                        ? t('reviewActionView')
                        : null; // nothing to do yet (with manager / awaiting release)
                return (
                  <tr key={r.reviewId}>
                    <td className="px-4 py-2.5 font-medium">{r.cycleName}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{label}</td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      {r.released && r.overallRating != null ? r.overallRating : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {action ? (
                        <Link href={`/performance/review/${r.reviewId}`} className="text-xs text-primary hover:underline">
                          {action}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('noActionNeeded')}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* My goals (ADR-0022) — continuous, employee-owned objectives */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('goalsTitle')} count={goals.length} />
        {goals.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('goalsEmpty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {goals.map((g) => {
              const statusTone =
                g.status === 'achieved'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                  : g.status === 'missed'
                    ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400'
                    : g.status === 'dropped'
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400';
              return (
                <li key={g.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{g.title}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone}`}>
                          {t(`goalStatus_${g.status}`)}
                        </span>
                        {g.cycleName && (
                          <span className="text-[10px] text-muted-foreground">· {g.cycleName}</span>
                        )}
                      </div>
                      {g.description && <p className="mt-0.5 text-xs text-muted-foreground">{g.description}</p>}
                      {(g.metric || g.target) && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {[g.metric, g.target].filter(Boolean).join(' · ')}
                          {g.dueOn ? ` · ${t('goalDueShort', { date: g.dueOn })}` : ''}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${g.progress}%` }} />
                    </div>
                    <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{g.progress}%</span>
                  </div>
                  <form action={myUpdateGoalProgress} className="mt-2 flex flex-wrap items-center justify-end gap-2">
                    <input type="hidden" name="goalId" value={g.id} />
                    <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {t('goalProgressLabel')}
                      <input
                        name="progress"
                        type="number"
                        min="0"
                        max="100"
                        defaultValue={g.progress}
                        className={`${inputCls} w-20 text-right`}
                      />
                    </label>
                    <select name="status" defaultValue={g.status} className={`${inputCls} w-32`}>
                      <option value="active">{t('goalStatus_active')}</option>
                      <option value="achieved">{t('goalStatus_achieved')}</option>
                      <option value="missed">{t('goalStatus_missed')}</option>
                      <option value="dropped">{t('goalStatus_dropped')}</option>
                    </select>
                    <Button type="submit" size="sm" variant="secondary">
                      {t('goalSave')}
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
        <form action={myCreateGoal} className="space-y-3 border-t border-border bg-muted/20 px-4 py-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('goalNewTitle')}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('goalTitleLabel')}>
              <input name="title" required placeholder={t('goalTitlePlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('goalDueLabel')}>
              <input name="dueOn" type="date" className={inputCls} />
            </Field>
            <Field label={t('goalMetricLabel')}>
              <input name="metric" placeholder={t('goalMetricPlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('goalTargetLabel')}>
              <input name="target" placeholder={t('goalTargetPlaceholder')} className={inputCls} />
            </Field>
          </div>
          <Field label={t('goalDescriptionLabel')}>
            <textarea name="description" rows={2} className={inputCls} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit">{t('goalAdd')}</Button>
          </div>
        </form>
      </Card>

      {/* 360 feedback requests (ADR-0022) — the peer responds; their identity stays with HR/manager */}
      {feedbackRequests.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('feedbackTitle')} count={feedbackRequests.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">{t('feedbackIntro')}</p>
          <ul className="divide-y divide-border">
            {feedbackRequests.map((fr) => (
              <li key={fr.requestId} className="px-4 py-4">
                <div className="text-sm font-medium">
                  {t('feedbackOn', { name: fr.subject })}
                  {fr.cycleName && <span className="ml-2 text-xs text-muted-foreground">{fr.cycleName}</span>}
                </div>
                <form action={mySubmitPeerFeedback} className="mt-3 space-y-3">
                  <input type="hidden" name="requestId" value={fr.requestId} />
                  <Field label={t('feedbackStrengths')}>
                    <textarea name="strengths" rows={2} className={inputCls} placeholder={t('feedbackStrengthsPlaceholder')} />
                  </Field>
                  <Field label={t('feedbackImprovements')}>
                    <textarea name="improvements" rows={2} className={inputCls} placeholder={t('feedbackImprovementsPlaceholder')} />
                  </Field>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" name="named" className="size-4" />
                    {t('feedbackNamed')}
                  </label>
                  <div className="flex items-center justify-end gap-2">
                    <Button type="submit" size="sm">
                      {t('feedbackSubmit')}
                    </Button>
                  </div>
                </form>
                <form action={myDeclinePeerFeedback} className="mt-1 flex justify-end">
                  <input type="hidden" name="requestId" value={fr.requestId} />
                  <Button type="submit" size="sm" variant="ghost">
                    {t('feedbackDecline')}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* My 1:1 check-ins (ADR-0022) — read-only; the manager schedules from /performance */}
      {checkins.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('checkinsTitle')} count={checkins.length} />
          <ul className="divide-y divide-border">
            {checkins.map((c) => (
              <li key={c.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium tabular-nums">{c.scheduledOn}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      c.status === 'completed'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                        : c.status === 'cancelled'
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400'
                    }`}
                  >
                    {t(`checkinStatus_${c.status}`)}
                  </span>
                </div>
                {c.notes && <p className="mt-1 text-xs text-muted-foreground">{c.notes}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
            </>
          ),
          documents: (
            <>
      {/* Annual tax statement (EA / C.P.8A) — self-serve for personal tax filing */}
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
                  <Link
                    href={`/payroll/reports/ea/${r.employmentId}?year=${r.year}`}
                    className="text-primary hover:underline"
                  >
                    {t('viewDownload')}
                  </Link>
                  <Link
                    href={`/me/ea/${r.employmentId}/pdf?year=${r.year}`}
                    className="text-primary hover:underline"
                  >
                    {t('eaDownloadPdf')}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Employment review outcome (0110) — info-only; surfaces the employee's own completed review. */}
      {me?.employmentId && <MeReviewCard s={s} employmentId={me.employmentId} />}

      {/* Resignation (ADR-0042, #29) — employee-initiated, HR-approved. A serious action: it does not end
          employment on its own; HR must accept it. Kept at the foot of the page. */}
      <Card className="mt-6 p-5">
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
            {resignation?.status === 'rejected' && (
              <p className="text-xs text-muted-foreground">{t('resignationWasRejected')}</p>
            )}
            {resignation?.status === 'withdrawn' && (
              <p className="text-xs text-muted-foreground">{t('resignationWasWithdrawn')}</p>
            )}
            <Field label={t('lastWorkingDayLabel')}>
              <input type="date" name="lastWorkingDay" required className={inputCls} />
            </Field>
            <Field label={t('resignationReasonLabel')}>
              <textarea name="reason" rows={3} className={inputCls} placeholder={t('resignationReasonPlaceholder')} />
            </Field>
            {/* #42cff598: supporting documents (e.g. a signed resignation letter). Multiple files; the
                `accept` attribute is a client hint only — validateLeaveDocument is the real server-side gate. */}
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
          ),
        }}
      />
    </div>
  );
}
