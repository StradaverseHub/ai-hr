import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listLeaveRequests } from '@/core/read';
import { listAttendanceCorrections } from '@/core/attendance';
import { listProfileChangeRequests } from '@/core/profile';
import { listPendingClaims } from '@/core/claims';
import { listResignationRequests } from '@/core/offboarding';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import {
  approveClaimAction,
  approveCorrectionAction,
  approveLeaveAction,
  approveProfileChangeAction,
  decideResignationAction,
} from './actions';

function DecideButtons({
  action,
  id,
  disabled,
  labels,
}: {
  action: (fd: FormData) => void | Promise<void>;
  id: string;
  disabled?: boolean;
  labels: { yourRequest: string; approve: string; reject: string };
}) {
  if (disabled) {
    return <span className="text-xs text-muted-foreground">{labels.yourRequest}</span>;
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="approved" />
        <Button type="submit" size="sm">
          {labels.approve}
        </Button>
      </form>
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="rejected" />
        <Button type="submit" size="sm" variant="outline">
          {labels.reject}
        </Button>
      </form>
    </div>
  );
}

/** One inbox for everything awaiting a decision: leave, attendance corrections and (admin-only)
 *  profile changes. The decide authz lives in the services — this page only assembles the
 *  queues; RLS already trims each list to what the viewer may see. */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const admin = isAdmin(s);
  const manager = (s.roles ?? []).includes('manager');
  if (!admin && !manager) redirect('/');
  const { error } = await searchParams;
  const t = await getTranslations('approvals');
  const tLeave = await getTranslations('leave'); // Emergency Leave (0106) — group label for EL child rows
  const decideLabels = {
    yourRequest: t('yourRequest'),
    approve: t('approve'),
    reject: t('reject'),
  };

  const [leave, corrections, profileChanges, claims, resignations] = await Promise.all([
    listLeaveRequests(s, scopeIds),
    listAttendanceCorrections(s, { companyIds: scopeIds, status: 'pending' }),
    admin ? listProfileChangeRequests(s, { companyIds: scopeIds, status: 'pending' }) : Promise.resolve([]),
    listPendingClaims(s),
    admin ? listResignationRequests(s, { status: 'pending' }) : Promise.resolve([]),
  ]);
  const pendingLeave = leave.filter((r) => r.status === 'pending');
  const mine = (personId: string | null) => s.personId != null && personId === s.personId;
  // 2B-1: a request may sit at a manager step or an HR step. A manager step is decidable by the
  // viewer the list already scoped to (manager/admin); an HR step only by an admin.
  const stageLabel = (kind: string | null) =>
    kind === 'hr_admin' ? t('stageHr') : kind === 'direct_manager' ? t('stageManager') : '';
  const total =
    pendingLeave.length + corrections.length + profileChanges.length + claims.length + resignations.length;
  const rm = (n: number) => `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div data-tour="approvals-intro">
        <PageHeader
          title={t('title')}
          description={total === 0 ? t('emptyDescription') : t('pendingDescription', { total })}
        />
      </div>
      <ErrorBanner message={error} />

      <Card className="overflow-hidden" data-tour="approvals-leave">
        <SectionHeader title={t('leaveRequests')} count={pendingLeave.length} />
        {pendingLeave.length > 0 && (
          // R23: quick path to the team's planned absences, so an approver can check for clashes.
          <div className="flex justify-end border-b border-border px-4 py-1.5">
            <Link href="/leave" className="text-xs text-primary underline-offset-2 hover:underline">
              {t('teamCalendar')}
            </Link>
          </div>
        )}
        {pendingLeave.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingLeave')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('employee')}</th>
                <th className="px-4 py-2 font-medium">{t('type')}</th>
                <th className="px-4 py-2 font-medium">{t('dates')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('days')}</th>
                <th className="px-4 py-2 text-right font-medium" data-tour="approvals-decide">
                  {t('action')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pendingLeave.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5 font-medium">
                    <Link
                      href={`/people/${r.employmentId}`}
                      className="underline-offset-2 hover:text-primary hover:underline"
                      title={t('viewHistory')}
                    >
                      {r.employee}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {r.leaveType}
                    {/* Emergency Leave (0106): EL children are ordinary ANNUAL/UNPAID requests sharing a
                        parent_group_id — tag both so the approver sees they are halves of one EL. */}
                    {r.parentGroupId && (
                      <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {tLeave('emergency.groupLabel')}
                      </span>
                    )}
                    {r.hasDocument && (
                      <a
                        href={`/me/leave/attachment/${r.id}?inline=1`}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-2 text-xs text-primary underline-offset-2 hover:underline"
                      >
                        {t('viewDocument')}
                      </a>
                    )}
                    {r.stepCount > 0 && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {stageLabel(r.currentStepKind)} ·{' '}
                        {t('stepOfN', { n: (r.currentStepIndex ?? 0) + 1, total: r.stepCount })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {r.startDate} → {r.endDate}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {Number(r.days)}
                    <div className="text-xs font-normal text-muted-foreground">
                      {t('applicantBalance', { n: Number(r.applicantBalance) })}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {mine(r.personId) ? (
                      <span className="flex justify-end text-xs text-muted-foreground">{decideLabels.yourRequest}</span>
                    ) : r.currentStepKind === 'hr_admin' && !admin ? (
                      <span className="flex justify-end text-xs text-muted-foreground">{stageLabel(r.currentStepKind)}</span>
                    ) : (
                      <DecideButtons action={approveLeaveAction} id={r.id} labels={decideLabels} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('claims')} count={claims.length} />
        {claims.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingClaims')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('employee')}</th>
                <th className="px-4 py-2 font-medium">{t('type')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('amount')}</th>
                <th className="px-4 py-2 font-medium">{t('dates')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {claims.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2.5 font-medium">{c.claimantName}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {c.typeName}
                    {c.attachments.map((a) => (
                      <a key={a.id} href={`/claims/attachment/${a.id}?inline=1`} target="_blank" rel="noopener noreferrer" className="ml-2 text-xs text-primary underline-offset-2 hover:underline">
                        ↗ {t('receipt')}
                      </a>
                    ))}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(c.amount)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{c.incurredOn}</td>
                  <td className="px-4 py-2.5">
                    <DecideButtons action={approveClaimAction} id={c.id} disabled={mine(c.personId)} labels={decideLabels} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="overflow-hidden" data-tour="approvals-corrections">
        <SectionHeader title={t('attendanceCorrections')} count={corrections.length} />
        {corrections.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingCorrections')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('employee')}</th>
                <th className="px-4 py-2 font-medium">{t('date')}</th>
                <th className="px-4 py-2 font-medium">{t('proposed')}</th>
                <th className="px-4 py-2 font-medium">{t('reason')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {corrections.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2.5 font-medium">{c.employee}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{c.attendanceDate}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {c.proposedCheckIn.slice(0, 5)}
                    {c.proposedCheckOut ? ` → ${c.proposedCheckOut.slice(0, 5)}` : ''}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{c.reason ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <DecideButtons
                      action={approveCorrectionAction}
                      id={c.id}
                      disabled={mine(c.personId)}
                      labels={decideLabels}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {admin && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('profileChanges')} count={profileChanges.length} />
          {profileChanges.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingChanges')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {profileChanges.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{r.employee}</div>
                    <div className="text-xs text-muted-foreground">
                      {Object.entries((r.proposed ?? {}) as Record<string, unknown>)
                        .map(([k, v]) => `${k} → ${v}`)
                        .join(' · ')}
                    </div>
                  </div>
                  <DecideButtons
                    action={approveProfileChangeAction}
                    id={r.id}
                    disabled={mine(r.personId)}
                    labels={decideLabels}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {admin && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('resignations')} count={resignations.length} />
          {resignations.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('noPendingResignations')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('employee')}</th>
                  <th className="px-4 py-2 font-medium">{t('lastWorkingDay')}</th>
                  <th className="px-4 py-2 font-medium">{t('reason')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('action')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {resignations.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5 font-medium">
                      <Link
                        href={`/people/${r.employmentId}`}
                        className="underline-offset-2 hover:text-primary hover:underline"
                        title={t('viewHistory')}
                      >
                        {r.employee}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.lastWorkingDay}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.reason ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <DecideButtons
                        action={decideResignationAction}
                        id={r.id}
                        disabled={mine(r.personId)}
                        labels={decideLabels}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
