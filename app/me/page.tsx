import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  leaveBalances,
  leaveRequestsFor,
  listLeaveTypes,
  myAttendance,
  myEmployment,
  myEmployments,
  myPayslips,
} from '@/core/read';
import { myAttendanceCorrections } from '@/core/attendance';
import { myProfile, myProfileChangeRequests } from '@/core/profile';
import { myCheckIns, myFeedbackRequests, myGoals, myReviews } from '@/core/performance';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { SectionJumpNav } from '@/components/section-jump-nav';
import {
  myCheckIn,
  myCheckOut,
  myCreateGoal,
  myDeclinePeerFeedback,
  myRequestCorrection,
  myRequestLeave,
  myRequestProfileChange,
  mySubmitPeerFeedback,
  myUpdateContact,
  myUpdateGoalProgress,
} from './actions';

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
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getTranslations('me');
  const tRun = await getTranslations('payroll.list.runType'); // Wave 2C — shared run-type labels
  const s = await getSession();
  const { error } = await searchParams;
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
  const locale = await getLocale(); // R37: render leave-type names in the employee's language
  const [balances, requests, leaveTypes, payslips, attendance, corrections, profile, profileRequests, reviews, goals, checkins, feedbackRequests] =
    await Promise.all([
      leaveBalances(s, me.employmentId, locale),
      leaveRequestsFor(s, me.employmentId, locale),
      listLeaveTypes(s, { locale }),
      myPayslips(s, employments.map((e) => e.employmentId)),
      myAttendance(s, me.employmentId, 14),
      myAttendanceCorrections(s, me.employmentId),
      myProfile(s),
      myProfileChangeRequests(s, me.employmentId),
      myReviews(s),
      myGoals(s),
      myCheckIns(s),
      myFeedbackRequests(s),
    ]);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const today = new Date().toISOString().slice(0, 10);
  const todayRow = attendance.find((a) => a.date === today);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div data-tour="me-intro">
        <PageHeader
          title={t('title')}
          description={`${me.name}${me.employeeCode ? ` · ${me.employeeCode}` : ''} · ${me.position ?? '—'}, ${me.department ?? '—'}`}
        />
      </div>

      <ErrorBanner message={error} />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
        <SectionJumpNav
          sections={[
            { id: 'overview', label: t('secOverview') },
            { id: 'profile', label: t('secProfile') },
            { id: 'pay', label: t('secPay') },
            { id: 'performance', label: t('secPerformance') },
            { id: 'documents', label: t('secDocuments') },
          ]}
        />
        <div className="min-w-0 flex-1 space-y-6">
          <section id="overview" className="scroll-mt-4">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Attendance */}
        <Card className="p-5" data-tour="me-attendance">
          <h2 className="text-sm font-semibold">{t('todayHeading')}</h2>
          <p className="text-xs text-muted-foreground">{today}</p>
          <div className="mt-4">
            {!todayRow ? (
              <form action={myCheckIn}>
                <Button type="submit" className="w-full">
                  {t('checkIn')}
                </Button>
              </form>
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
                <form action={myCheckOut}>
                  <Button type="submit" variant="secondary" className="w-full">
                    {t('checkOut')}
                  </Button>
                </form>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {todayRow.checkInAt} → {todayRow.checkOutAt} <Pill status={todayRow.status} map={ATT_STATUS} label={t(`attStatus.${todayRow.status}`)} />
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('recent')}
            </div>
            <ul className="space-y-1.5 text-sm">
              {attendance.slice(0, 6).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="tabular-nums text-muted-foreground">{a.date}</span>
                  {a.workedMinutes != null && (
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {Math.floor(a.workedMinutes / 60)}h {String(a.workedMinutes % 60).padStart(2, '0')}m
                      {(a.otMinutes ?? 0) > 0 && (
                        <span className="text-amber-600 dark:text-amber-400"> {t('overtimeBadge')}</span>
                      )}
                    </span>
                  )}
                  <Pill status={a.status} map={ATT_STATUS} label={t(`attStatus.${a.status}`)} />
                </li>
              ))}
              {attendance.length === 0 && <li className="text-muted-foreground">{t('noRecords')}</li>}
            </ul>
          </div>

          {/* Missed-punch correction (manager/admin approves — ADR-0011 Phase B) */}
          <details className="mt-4 border-t border-border pt-4">
            <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('fixMissedPunch')}
            </summary>
            <form action={myRequestCorrection} className="mt-3 space-y-2.5">
              <Field label={t('dateLabel')}>
                <input type="date" name="date" required defaultValue={yesterday} className={inputCls} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('checkInLabel')}>
                  <input type="time" name="checkIn" required defaultValue="09:00" className={inputCls} />
                </Field>
                <Field label={t('checkOutLabel')}>
                  <input type="time" name="checkOut" defaultValue="18:00" className={inputCls} />
                </Field>
              </div>
              <Field label={t('reasonOptional')}>
                <input name="reason" placeholder={t('reasonPlaceholder')} className={inputCls} />
              </Field>
              <Button type="submit" size="sm">
                {t('requestCorrection')}
              </Button>
            </form>
            {corrections.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-xs">
                {corrections.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <span className="tabular-nums text-muted-foreground">
                      {c.attendanceDate} · {c.proposedCheckIn.slice(0, 5)}
                      {c.proposedCheckOut ? `–${c.proposedCheckOut.slice(0, 5)}` : ''}
                    </span>
                    <Pill status={c.status} map={LEAVE_STATUS} label={t(`leaveStatus.${c.status}`)} />
                  </li>
                ))}
              </ul>
            )}
          </details>
        </Card>

        {/* Leave */}
        <Card className="p-5" data-tour="me-leave">
          <h2 className="text-sm font-semibold">{t('leaveHeading')}</h2>
          <div className="mt-3 space-y-3">
            {balances.map((b) => {
              const pctUsed = b.accrued > 0 ? Math.min(100, (b.taken / b.accrued) * 100) : 0;
              const pctPending = b.accrued > 0 ? Math.min(100 - pctUsed, (b.pending / b.accrued) * 100) : 0;
              const tracked = b.accrued > 0 || b.balance > 0;
              return (
                <div key={b.leaveTypeId}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-muted-foreground">{b.leaveType}</span>
                    <span className="font-semibold tabular-nums">
                      {tracked ? (
                        <>
                          {b.available}
                          <span className="font-normal text-muted-foreground"> / {b.accrued}</span>
                        </>
                      ) : (
                        <span className="font-normal text-muted-foreground">—</span>
                      )}
                    </span>
                  </div>
                  {tracked && (
                    /* Usage bar: solid = used, translucent = pending approval. */
                    <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-l-full bg-primary" style={{ width: `${pctUsed}%` }} />
                      <div className="h-full bg-primary/40" style={{ width: `${pctPending}%` }} />
                    </div>
                  )}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('leaveUsed', { count: b.taken })}
                    {b.pending > 0 ? ` · ${t('leavePending', { count: b.pending })}` : ''}
                    {tracked ? ` · ${t('leaveAvailable', { count: b.available })}` : ''}
                  </div>
                </div>
              );
            })}
            {balances.length === 0 && <p className="text-sm text-muted-foreground">{t('noBalances')}</p>}
          </div>

          <form action={myRequestLeave} className="mt-4 space-y-3 border-t border-border pt-4">
            <Field label={t('typeLabel')}>
              <select name="leaveTypeId" required className={inputCls}>
                {leaveTypes.map((lt) => (
                  <option key={lt.id} value={lt.id}>
                    {lt.name}
                    {lt.requiresDocument ? ` · ${t('documentRequired')}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('fromLabel')}>
                <input type="date" name="startDate" required className={inputCls} />
              </Field>
              <Field label={t('toLabel')}>
                <input type="date" name="endDate" required className={inputCls} />
              </Field>
            </div>
            <Field label={t('documentLabel')}>
              <input
                type="file"
                name="document"
                accept="image/*,application/pdf"
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('documentHint')}</p>
            </Field>
            <Button type="submit" size="sm">
              {t('requestLeave')}
            </Button>
          </form>

          <div className="mt-4 border-t border-border pt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('requests')}
            </div>
            <ul className="space-y-1.5 text-sm">
              {requests.slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="block truncate text-muted-foreground">
                      {r.leaveType} · {r.startDate}
                    </span>
                    {r.status === 'pending' && r.stepCount > 0 && (
                      <span className="text-xs text-muted-foreground/80">
                        {r.currentStepKind === 'hr_admin' ? t('stageHr') : t('stageManager')}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {r.hasDocument && (
                      <a
                        href={`/me/leave/attachment/${r.id}?inline=1`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary underline-offset-2 hover:underline"
                      >
                        {t('viewDocument')}
                      </a>
                    )}
                    <Pill status={r.status} map={LEAVE_STATUS} label={t(`leaveStatus.${r.status}`)} />
                  </div>
                </li>
              ))}
              {requests.length === 0 && <li className="text-muted-foreground">{t('noRequests')}</li>}
            </ul>
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
          </section>

          <section id="profile" className="scroll-mt-4">
      {/* My details — contact self-edit (direct) + pay-affecting changes (approval-gated, ADR-0012) */}
      <Card className="p-5">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div data-tour="me-contact">
            <h2 className="text-sm font-semibold">{t('myDetails')}</h2>
            <p className="text-xs text-muted-foreground">{t('contactUpdatesImmediately')}</p>
            <form action={myUpdateContact} className="mt-3 space-y-3">
              <Field label={t('phoneLabel')}>
                <input name="phone" defaultValue={profile?.person?.phone ?? ''} className={inputCls} />
              </Field>
              <Field label={t('addressLabel')}>
                <input name="address" defaultValue={profile?.person?.address ?? ''} className={inputCls} />
              </Field>
              <Field label={t('dateOfBirthLabel')}>
                <input
                  type="date"
                  name="dateOfBirth"
                  defaultValue={profile?.person?.dateOfBirth ?? ''}
                  className={inputCls}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('genderLabel')}>
                  <select name="gender" defaultValue={profile?.person?.gender ?? ''} className={inputCls}>
                    <option value="">{t('notSet')}</option>
                    <option value="male">{t('gender_male')}</option>
                    <option value="female">{t('gender_female')}</option>
                    <option value="undisclosed">{t('gender_undisclosed')}</option>
                  </select>
                </Field>
                <Field label={t('maritalLabel')}>
                  <select name="maritalStatus" defaultValue={profile?.person?.maritalStatus ?? ''} className={inputCls}>
                    <option value="">{t('notSet')}</option>
                    <option value="single">{t('marital_single')}</option>
                    <option value="married">{t('marital_married')}</option>
                    <option value="other">{t('marital_other')}</option>
                  </select>
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
                <Field label={t('emergencyPhoneLabel')}>
                  <input
                    name="emergencyContactPhone"
                    defaultValue={profile?.person?.emergencyContactPhone ?? ''}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Button type="submit" size="sm">
                {t('saveDetails')}
              </Button>
            </form>
          </div>

          <div className="lg:border-l lg:border-border lg:pl-6" data-tour="me-bank">
            <h2 className="text-sm font-semibold">{t('bankAndTax')}</h2>
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
          </section>

          <section id="pay" className="scroll-mt-4">
      {/* Payslips */}
      <Card className="overflow-hidden" data-tour="me-payslips">
        <SectionHeader title={t('myPayslips')} count={payslips.length} />
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
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {payslips.map((p) => (
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
                </tr>
              ))}
              {payslips.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noPayslips')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
          </section>

          <section id="performance" className="scroll-mt-4 space-y-6">
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
          </section>

          <section id="documents" className="scroll-mt-4">
      {/* Annual tax statement (EA / C.P.8A) — self-serve for personal tax filing */}
      <Card className="p-5">
        <SectionHeader title={t('taxStatementEa')} />
        <p className="px-1 pt-2 text-xs text-muted-foreground">{t('taxStatementDescription')}</p>
        <ul className="mt-3 space-y-2">
          {employments.map((e) => (
            <li
              key={e.employmentId}
              className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
            >
              <span>
                {e.company} · <span className="text-muted-foreground">{t('yearOfAssessment', { year: '2026' })}</span>
              </span>
              <Link
                href={`/payroll/reports/ea/${e.employmentId}?year=2026`}
                className="text-primary hover:underline"
              >
                {t('viewDownload')}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
