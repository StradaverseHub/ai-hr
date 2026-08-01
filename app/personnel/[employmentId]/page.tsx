import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { employeeDetail, assignmentHistory, subordinateLeaveSummary } from '@/core/read';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { buildCalendarFocusHref } from '@/lib/calendar-focus';
import { formatDate } from '@/lib/utils';
import { Avatar, Card, EmployeeName, PageHeader, StatusBadge } from '@/components/ui';

/**
 * Read-only staff-directory profile (People→Personnel split). Shows only directory-safe fields —
 * name, role (department / position / grade), work contact, status. No pay, statutory, or personal
 * data, and no edit affordances; all management lives behind /admin/personnel. RLS scopes the read,
 * so a viewer who cannot see this employment gets a 404 rather than a leak. Admins get a shortcut to
 * the full management record.
 */
export default async function PersonnelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const s = await getSession();
  const t = await getTranslations('people.detail');
  const { employmentId } = await params;
  const { from } = await searchParams;
  const admin = isAdmin(s);
  const back =
    from === 'org'
      ? { href: '/org', label: t('backToOrg') }
      : { href: '/personnel', label: t('backToPeople') };

  const emp = await employeeDetail(s, employmentId);
  if (!emp) notFound();
  // Manager Leave Summary (item 726ac8c2). The read returns null unless the viewer administratively
  // manages this employment (direct or indirect) — the gate lives in the read, not here, so editing the
  // employment id in the address bar cannot expose another manager's reports' balances.
  const [leaveSummary, history] = await Promise.all([
    subordinateLeaveSummary(s, employmentId, todayInKualaLumpur(), await getLocale()),
    assignmentHistory(s, employmentId),
  ]);
  const current = history.find((h) => h.validTo == null) ?? history[0] ?? null;

  // Employee Status sync (5afcda91): same system-derived status as every other Personnel screen —
  // deriveEmploymentStatus over the lifecycle dates (employeeDetail already projects them all), so the
  // same employee reads the same status here, on the directory, and on the admin record.
  const tStatus = await getTranslations('people.employeeStatus');
  const today = todayInKualaLumpur();
  const derivedStatus = deriveEmploymentStatus(emp, today);

  // "12–14 Aug 2026" for a same-month span, "12 Aug 2026" for a single day, both ends in full otherwise.
  // formatDate (en-GB, "12 Aug 2026") is the app's existing date rendering — reused so this table reads
  // like every other date on the profile.
  const spanLabel = (start: string, end: string) => {
    if (start === end) return formatDate(start);
    if (start.slice(0, 7) === end.slice(0, 7)) return `${start.slice(8, 10)}–${formatDate(end)}`;
    return `${formatDate(start)} – ${formatDate(end)}`;
  };

  const rows: { label: string; value: string | null }[] = [
    { label: t('department'), value: current?.department ?? null },
    { label: t('position'), value: current?.position ?? null },
    { label: t('grade'), value: emp.gradeName ?? null },
    { label: t('email'), value: emp.email },
    { label: t('phone'), value: emp.phone },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={emp.name}
        description={t('directorySubtitle')}
        back={back}
        actions={
          admin ? (
            <Link
              href={`/admin/personnel/${employmentId}`}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {t('viewFullRecord')}
            </Link>
          ) : undefined
        }
      />

      <Card className="p-6">
        <div className="flex items-center gap-4">
          <Avatar name={emp.name} className="size-12 text-base" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Employee ID left-of-name (feedback 38668d9b) */}
              <EmployeeName code={emp.employeeCode} name={emp.name} className="text-lg font-semibold" codeClassName="text-sm" />
              <StatusBadge status={derivedStatus} label={tStatus(derivedStatus)} />
            </div>
            <div className="text-sm text-muted-foreground">{emp.company}</div>
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-col">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">{r.label}</dt>
              <dd className="text-sm text-foreground">{r.value ?? '—'}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {/* Manager Leave Summary (item 726ac8c2) — read-only. Absent entirely for anyone the read did not
          authorise (self, plain HR admin, an unrelated manager), so there is no empty shell to explain. */}
      {leaveSummary && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <h2 className="text-base font-semibold tracking-tight">{t('leaveSummary.title')}</h2>
            {/* Lands on the dashboard calendar's team view with this employee highlighted for 3s. */}
            <Link
              href={buildCalendarFocusHref(emp.personId)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {t('leaveSummary.viewCalendar')}
            </Link>
          </div>
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-5 py-2 font-medium">{t('leaveSummary.colType')}</th>
                  <th scope="col" className="px-5 py-2 font-medium">{t('leaveSummary.colBalance')}</th>
                  <th scope="col" className="px-5 py-2 font-medium">{t('leaveSummary.colPending')}</th>
                  <th scope="col" className="px-5 py-2 font-medium">{t('leaveSummary.colUpcoming')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leaveSummary.map((r) => (
                  <tr key={r.leaveTypeId}>
                    <th scope="row" className="px-5 py-2.5 text-left font-medium text-foreground">
                      {r.leaveType}
                    </th>
                    <td className="px-5 py-2.5 tabular-nums">{t('leaveSummary.days', { days: r.balance })}</td>
                    {/* An em dash, not a 0: "nothing waiting on you" is the point, and a column of zeroes
                        buries the one row that does need a decision. */}
                    <td className="px-5 py-2.5 tabular-nums">{r.pendingCount > 0 ? r.pendingCount : '—'}</td>
                    <td className="px-5 py-2.5">
                      {r.upcomingFrom && r.upcomingTo ? spanLabel(r.upcomingFrom, r.upcomingTo) : '—'}
                    </td>
                  </tr>
                ))}
                {leaveSummary.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-4 text-sm text-muted-foreground">
                      {t('noLeaveRecords')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
