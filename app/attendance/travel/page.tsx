import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { myTravelRequests } from '@/core/travel-request';
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  inputCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myRequestTravel } from '@/app/me/actions';
import { Pill, statusLabel } from '../request-ui';

/**
 * My Attendance > My Travel — the employee's off-site work window: ask for one, and see the ones already
 * asked for.
 *
 * WHAT IS NEW HERE IS THE MENU ROW, NOT THE FEATURE. Travel Request has been complete end to end since
 * ADR-0069 — form, service, RLS, domain events, an approvals-inbox section with the self-approval ban, and
 * the employee's own history. What it never had was a home: it sat at the bottom of the shared My
 * Attendance screen, under four tabs about something else, reachable only by scrolling past them. c6bb5f5a
 * gives it its own row and its own page. The form, the action and the approval route are untouched.
 *
 * ⚠️ ADR-0071 §E — AN APPROVED TRAVEL REQUEST IS AN AUDIT MARKER AND NOTHING MORE. It is deliberately NOT
 * wired into DayContext / attendanceForDate: someone travelling who does not clock in still shows as an
 * attendance exception. That is the decision, not an oversight, and giving travel a screen of its own is
 * exactly the change that would tempt the next reader to "finish the wiring". Do not. The note the page
 * renders (`travelAuditNote`) exists so the employee is told the same thing in words, because a screen
 * called My Travel implies more than the record does.
 *
 * TRUST MODEL: self-service, so NO page guard. The viewer's own employment is resolved from the session,
 * `myTravelRequests` is RLS-scoped to it, and `myRequestTravel` re-resolves the caller server-side.
 */
export default async function MyTravelPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getTranslations('me');
  const sp = await searchParams;
  const s = await getSession();
  const me = await myEmployment(s);

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('myTravel')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  // TODAY, from the MYT day key. The form used to default both boxes to YESTERDAY — not a decision about
  // travel, but the tail of the shared screen's 30-day correction window, which does not exist here. A
  // travel window is asked for today or ahead of it far more often than for yesterday.
  const today = todayInKualaLumpur();
  const requests = await myTravelRequests(s, me.employmentId, 25);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t('myTravel')}
        description={
          <>
            <span>{[me.name, me.employeeCode, me.position, me.company].filter(Boolean).join(' · ')}</span>
            <span className="mt-0.5 block">{t('myTravelHelp')}</span>
          </>
        }
      />

      <ErrorBanner message={sp.error} />

      {/* The form, carried across unchanged — same fields, same names, same server action, same approvals
          inbox on the other side. (Replacement-leave requests live on My Absence.) */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">{t('travelRequest')}</h2>
        <form action={myRequestTravel} className="mt-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('travelFromLabel')}>
              <input type="date" name="travelFrom" required defaultValue={today} className={inputCls} />
            </Field>
            <Field label={t('travelToLabel')}>
              <input type="date" name="travelTo" required defaultValue={today} className={inputCls} />
            </Field>
          </div>
          <Field label={t('reasonRequired')}>
            <input name="remarks" required placeholder={t('travelRemarksPlaceholder')} className={inputCls} />
          </Field>
          <Button type="submit" size="sm">
            {t('requestTravelButton')}
          </Button>
        </form>
        <p className="mt-3 text-[11px] text-muted-foreground">{t('travelAuditNote')}</p>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">{t('myTravelHistory')}</div>
        {requests.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('myTravelNone')}</p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('travelFromLabel')}</th>
                  <th className={thCls}>{t('travelToLabel')}</th>
                  <th className={thCls}>{t('reasonRequired')}</th>
                  <th className={thCls}>{t('maColSubmitted')}</th>
                  <th className={thCls}>{t('otStatusColumn')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2.5 tabular-nums">{r.travelFrom}</td>
                    <td className="px-3 py-2.5 tabular-nums">{r.travelTo}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{r.remarks ?? ''}</td>
                    <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                      {r.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Pill status={r.status} label={statusLabel(r.status, t, false)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
