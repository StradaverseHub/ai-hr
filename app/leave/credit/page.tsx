import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { scopedSession } from '@/lib/scope';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { DAY_DASH, formatDays } from '@/lib/day-format';
import { listLeaveTypes, myEmployment } from '@/core/read';
import { pickReplacementLeaveType } from '@/core/ess-view';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import {
  extendedHoursOfferForEmployment,
  listReplacementLeaveRequests,
  replacementRequestAvailability,
  type LeaveCreditDayType,
} from '@/packs/leave/service';
import { Card, ErrorBanner, PageHeader, btnGhost, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { ReplacementAvailabilityNotice } from '@/components/leave/replacement-availability-notice';
import { LeaveCreditRequestTable } from '@/components/leave/leave-credit-request-table';
import { leaveCreditDayFactsAction, submitLeaveCreditRequestAction } from './actions';

/**
 * r343 cbfa8b0b · MY ABSENCE › LEAVE CREDIT REQUEST (`/leave/credit`).
 *
 * ── WHY THIS IS A SCREEN AND NOT THE r336 MODAL ─────────────────────────────────────────────────────────
 * The reporter's contest asks for ONE screen holding all four day types in ONE request table — "Do not
 * create separate sections/screens for these day types" — and for the requests already submitted to be
 * displayed in that same table. r336's modal is two sections inside a dialog, and a nine-column table with
 * a per-row conditional and a submitted-requests list beneath it does not belong in a dialog at 95vw. So
 * the single table gets a route of its own, off My Absence.
 *
 * ⚠️ WHAT THIS PAGE DOES NOT DO, RECORDED RATHER THAN LEFT TO BE DISCOVERED: it does not remove the r336
 * two-section modal from app/leave/page.tsx, which is still mounted there. Both surfaces write through the
 * same service and the same tables, so neither can corrupt the other — but the product currently offers two
 * ways to ask for one thing, and the modal is the one the reporter reversed. Retiring it is an edit to
 * app/leave/page.tsx and components/leave/replacement-leave-request-dialog.tsx.
 *
 * ── GATED ON THE `toil` MODULE ENTITLEMENT, NOT ON TOIL_ENABLED ─────────────────────────────────────────
 * ADR-0077 slice 3; core/toil.ts's header records that `TOIL_ENABLED` is set in no tracked env file and is
 * not the gate. `isModuleEnabledOrFalse` is the page-level form (core/entitlements.ts). Without the module
 * this page shows the reason rather than a form, and `submitLeaveCreditRequest` refuses the POST regardless
 * — the notice is the courtesy, the refusal is the control.
 *
 * SERVER COMPONENT. The table is a client island fed plain data and two server actions only — no translator
 * and no closure crosses the boundary (test/server-client-boundary.test.ts).
 */
export default async function LeaveCreditRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const { s: session } = await scopedSession();
  const t = await getTranslations('replacementRequest');
  const tLeave = await getTranslations('leave');
  const tNav = await getTranslations('nav');
  const locale = await getLocale();
  const today = todayInKualaLumpur();
  const sp = await searchParams;

  const me = await myEmployment(session);
  const moduleOn = isModuleEnabledOrFalse(session, 'toil');
  const leaveTypes = moduleOn && me ? await listLeaveTypes(session, { locale, includeArchived: false }) : [];
  // 2a237f5f — ONE resolved type, never a list: a Leave Credit is always Replacement Leave. The in-memory
  // twin of core/toil.ts's findReplacementLeaveTypeIdTx, matched BY ROLE with the seeded code as fallback.
  const replacementType = pickReplacementLeaveType(leaveTypes);
  const availability = moduleOn && me ? await replacementRequestAvailability(session, me.employmentId, today) : { allowed: false as const };
  // r334's switch, false on every company at release. Null ⇒ the Ordinary Day option is not offered; the
  // service refuses such a row for the same company anyway.
  const tiers = availability.allowed && me ? await extendedHoursOfferForEmployment(session, me.employmentId) : null;
  const requests = me && moduleOn ? await listReplacementLeaveRequests(session, me.employmentId) : [];

  const dayTypeLabel = (d: LeaveCreditDayType | null) =>
    d === 'rest_day'
      ? t('dayKind.restDay')
      : d === 'off_day'
        ? t('dayKind.offDay')
        : d === 'holiday'
          ? t('dayKind.holiday')
          : d === 'workday'
            ? t('dayKind.workday')
            : DAY_DASH;
  /** `18:30:00` → `18:30`. A time column comes back with seconds. */
  const hhmm = (v: string | null) => (v ? v.slice(0, 5) : DAY_DASH);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        actions={
          <Link href="/leave" className={btnGhost}>
            {tNav('myAbsence')}
          </Link>
        }
      />

      {sp.error && <ErrorBanner message={sp.error} />}
      {sp.toast && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {sp.toast}
        </div>
      )}

      {/* r219's notice, reused verbatim: the module, the two company switches, the eligibility criteria and
          the First Schedule floor are four different things to go and change, and this is the one place in
          the product that puts them into words. */}
      {(!availability.allowed || replacementType == null) && (
        <ReplacementAvailabilityNotice availability={availability} audience="self" />
      )}

      {availability.allowed && replacementType != null && (
        <Card>
          <LeaveCreditRequestTable
            replacementType={{ id: replacementType.id, name: replacementType.name }}
            submitAction={submitLeaveCreditRequestAction}
            today={today}
            requiresFirstScheduleConsent={availability.requiresFirstScheduleConsent}
            dayFactsAction={leaveCreditDayFactsAction}
            extendedHoursTiers={tiers}
          />
        </Card>
      )}

      {/* ── THE SAME REQUEST TABLE, FOR WHAT HAS ALREADY BEEN SUBMITTED ───────────────────────────────────
          "All four types must be submitted from the same screen and displayed in the same request table."
          One row per claim line, with its Day Type beside it — so a rest day, an off day, a public holiday
          and an ordinary day appear in one list, ordered by the request and then the date the read returns
          them in (newest request first; `listReplacementLeaveRequests` orders both levels). */}
      <Card title={t('table.myRequests')}>
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="leave-credit-no-requests">
            {t('table.noRequests')}
          </p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full min-w-[52rem] text-sm" data-testid="leave-credit-requests-table">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('table.submittedOn')}</th>
                  <th className={thCls}>{t('workedDate')}</th>
                  <th className={thCls}>{t('sectionA.dayType')}</th>
                  <th className={thCls}>{t('sectionB.shiftEnd')}</th>
                  <th className={thCls}>{t('sectionB.actualClockOut')}</th>
                  <th className={thCls}>{t('sectionB.extendedStart')}</th>
                  <th className={thCls}>{t('sectionB.extendedEnd')}</th>
                  <th className={thCls}>{t('sectionB.eligibleMinutes')}</th>
                  <th className={thCls}>{t('sectionB.credit')}</th>
                  <th className={thCls}>{t('table.statusHeading')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {requests.flatMap((r) =>
                  r.dates.map((d) => {
                    // An ordinary-day line is the only one with a claimed window, a shift end or eligible
                    // minutes — the same per-row conditional the form draws, read back off the stored line.
                    const ordinary = d.workedDayKind === 'workday';
                    return (
                      <tr key={`${r.id}-${d.workedDate}`} data-testid="leave-credit-request-row">
                        <td className="px-3 py-2 tabular-nums">{r.submittedOn}</td>
                        <td className="px-3 py-2 tabular-nums">{d.workedDate}</td>
                        <td className="px-3 py-2" data-testid="leave-credit-request-day-type">
                          {dayTypeLabel(d.workedDayKind)}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{ordinary ? hhmm(d.shiftEnd) : DAY_DASH}</td>
                        <td className="px-3 py-2 tabular-nums">{ordinary ? hhmm(d.actualClockOut) : DAY_DASH}</td>
                        <td className="px-3 py-2 tabular-nums">{ordinary ? hhmm(d.fromTime) : DAY_DASH}</td>
                        <td className="px-3 py-2 tabular-nums">{ordinary ? hhmm(d.toTime) : DAY_DASH}</td>
                        <td className="px-3 py-2 tabular-nums">{d.eligibleMinutes ?? DAY_DASH}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {d.days != null ? t('totalDays', { days: formatDays(d.days) }) : DAY_DASH}
                        </td>
                        <td className="px-3 py-2">{tLeave(`status.${r.status}`)}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
