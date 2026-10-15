import { getFormatter, getTranslations } from 'next-intl/server';
import type { AllowanceDay } from '@/lib/attendance-allowance-rules';
import type { RecordedAllowanceAttendanceFacts } from '@/packs/attendance/service';

/** Server-rendered, read-only evidence; all choices/measurements arrive from authorised owners. */
export async function AttendanceAllowanceDayEvidence({ day, leaveTypes }: {
  day: AllowanceDay;
  leaveTypes: { id: string; label: string }[];
}) {
  const [t, format] = await Promise.all([getTranslations('allowanceV3.evidence'), getFormatter()]);
  const facts = day.v3Facts as (NonNullable<AllowanceDay['v3Facts']> & {
    attendanceEvidence?: RecordedAllowanceAttendanceFacts;
  }) | undefined;
  const recorded = facts?.attendanceEvidence;
  const number = (value: number) => format.number(value, { maximumFractionDigits: 2 });
  const minutes = (value: number | null | undefined) => value == null ? t('unknown') : t('minutes', { value: number(value) });
  const bool = (value: boolean | null | undefined) => value == null ? t('unknown') : t(value ? 'yes' : 'no');
  const typeLabel = (id: string) => leaveTypes.find(type => type.id === id)?.label ?? t('unavailableType');
  const kindLabels = { full: t('kind.full'), half: t('kind.half'), rest: t('kind.rest'), off: t('kind.off'), holiday: t('kind.holiday') };
  const sourceLabels: Record<string, string> = {
    'recorded-attendance': t('source.recordedAttendance'),
    'recorded-attendance-trace': t('source.recordedTrace'),
    'recorded-attendance-and-approved-leave': t('source.attendanceAndLeave'),
    'unavailable': t('unknown'),
    'canonical-scheduled-absence': t('source.scheduledAbsence'),
    'canonical-approved-leave-empty': t('source.noApprovedLeave'),
    'recorded-approved-dates': t('source.approvedDates'),
    'recorded-legacy-approved-amount': t('source.legacyAmount'),
    'legacy-approved-date-allocation-unknown': t('source.unknownAllocation'),
    'approved-leave-overlap-duration-unknown': t('source.overlappingLeave'),
  };
  const reasonLabels: Record<RecordedAllowanceAttendanceFacts['reasons']['shortfall'], string> = {
    'recorded-fixed-clock-applicability': t('reason.recordedApplicability'),
    'fixed-clock-applicability-not-recorded': t('reason.missingApplicability'),
    'attendance-not-recorded': t('reason.missingAttendance'),
    'incomplete-clocks': t('reason.incompleteClocks'),
    'shortfall-not-recorded': t('reason.missingShortfall'),
    'recorded-zero-shortfall': t('reason.zeroShortfall'),
    'no-approved-leave': t('reason.noApprovedLeave'),
    'approved-leave-allocation-unknown': t('reason.unknownLeaveAllocation'),
    'recorded-normal-target-unavailable': t('reason.missingTarget'),
    'recorded-full-day-basis-unavailable': t('reason.missingFullDayBasis'),
    'approved-leave-minutes-unavailable': t('reason.missingLeaveMinutes'),
    'approved-full-day-leave': t('reason.fullDayLeave'),
    'approved-partial-leave-adjustment': t('reason.partialLeave'),
    'recorded-non-workday': t('reason.nonWorkday'),
  };
  const source = (value: string | undefined) => [...new Set((value ?? 'unavailable').split(';'))]
    .map(key => sourceLabels[key] ?? t('unknown')).join(' · ');
  const measurements = [
    [t('recordedLate'), minutes(recorded?.recordedLateMinutes)],
    [t('recordedEarly'), minutes(recorded?.recordedEarlyOutMinutes)],
    [t('shortfall'), minutes(facts?.shortMinutes)],
    [t('incomplete'), bool(facts?.incomplete)],
    [t('absence'), facts?.absenceKnown === false || !facts ? t('unknown') : t('days', { value: number(day.absentDays) })],
    [t('fixedClock'), bool(recorded ? recorded.fixedClockApplicable : facts?.fixedClockApplicable)],
  ];
  const basis = [
    [t('rawUnder'), minutes(recorded?.recordedUnderMinutes)],
    [t('normalTarget'), minutes(recorded?.recordedNormalMinutes)],
    [t('fullDayBasis'), minutes(recorded?.fullDayNormalMinutes)],
    [t('leaveCredit'), minutes(recorded?.leaveMinutes)],
  ];
  return <section className="min-w-0 rounded-lg border border-border bg-background p-3 text-sm" aria-label={t('dateEvidence', { date: day.date })}>
    <h4 className="flex flex-wrap gap-x-2 gap-y-1 font-medium"><time dateTime={day.date}>{day.date}</time><span className="text-muted-foreground">{kindLabels[day.kind]}</span></h4>
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 lg:grid-cols-3">
      {measurements.map(([label, value]) => <div className="min-w-0" key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words tabular-nums">{value}</dd></div>)}
    </dl>
    {recorded && <div className="mt-3 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
      <p>{t('shortfallReason')}: {reasonLabels[recorded.reasons.shortfall]}</p>
      <p>{t('applicabilityReason')}: {reasonLabels[recorded.reasons.applicability]}</p>
    </div>}
    <details className="mt-3">
      <summary className="cursor-pointer rounded-sm text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('recordedBasis')}</summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 lg:grid-cols-4">
        {basis.map(([label, value]) => <div className="min-w-0" key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words tabular-nums">{value}</dd></div>)}
      </dl>
      <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
        <div><dt className="inline font-medium">{t('measurementSource')}: </dt><dd className="inline">{source(day.factSources?.measurements)}</dd></div>
        <div><dt className="inline font-medium">{t('shortfallSource')}: </dt><dd className="inline">{source(recorded?.sources.shortfall)}</dd></div>
        <div><dt className="inline font-medium">{t('applicabilitySource')}: </dt><dd className="inline">{source(recorded?.sources.applicability)}</dd></div>
        <div><dt className="inline font-medium">{t('dayShiftSource')}: </dt><dd className="inline">{day.factSources ? t('source.datedResolver') : t('unknown')}</dd></div>
      </dl>
    </details>
    <div className="mt-3 space-y-1 border-t border-border pt-2 text-xs">
      <p className="font-medium">{t('approvedLeave')}</p>
      {!facts || facts.leave == null ? <p>{t('unknownLeaveDuration')} {t('paidUnknown')}</p> : facts.leave.length ? <ul className="space-y-1">
        {facts.leave.map((leave, index) => <li key={`${leave.typeId}-${index}`} className="break-words">
          {typeLabel(leave.typeId)} · {t('days', { value: number(leave.days) })}
          {'session' in leave && leave.session === 'hourly' ? <> · {minutes('minutes' in leave && typeof leave.minutes === 'number' ? leave.minutes : null)}</> : null}
          {' · '}{leave.paid == null ? t('paidUnknown') : t(leave.paid ? 'paid' : 'unpaid')}
        </li>)}
      </ul> : <p>{t('noLeave')}</p>}
      {!!facts?.leaveTypesPresent.length && facts.leave == null && <p>{t('knownLeaveTypes')}: {facts.leaveTypesPresent.map(typeLabel).join(', ')}</p>}
      {!!facts?.leaveUnknownTypeIds?.length && <p>{t('unknownLeaveTypes')}: {facts.leaveUnknownTypeIds.map(typeLabel).join(', ')}</p>}
      <p className="text-muted-foreground">{t('leaveSource')}: {source(facts?.source)}</p>
    </div>
  </section>;
}
