/**
 * M12 (D13) — the employee's own attendance, read only: a month of records (schedule, the clockings on record, the
 * engine's result and any exception, kept apart), the personal roster for the same month, and one day in full with
 * its applications and the way to request a correction.
 *
 * The app decides nothing. Every status, figure, exception, shift time and "crosses midnight" comes from the server
 * (lib/mobile-api/v2/attendance.ts; core/mobile-attendance.ts says which owner). Times are the kernel's business-day
 * zone, which the server names and the screen says. Held in memory only; offline, rows already shown stay labelled
 * stale (LoadState) and a cold start says the connection is needed — never an old copy presented as current.
 */
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { DesignText as Text, useTenantDesign } from './design';
import { useApiV2 } from './api';
import { t } from './i18n';
import { useSession } from './session';
import { requestShiftReminderRefresh } from './shift-reminder-signal';
import { Button, Card, LoadState, Muted, Row, Screen, SectionLabel, Title } from './ui';
import {
  APPLICATION_STATUS, DAY_STATUS, EXCEPTION, addMonths, applicationKindText, askedText, fmtCalendarDate, fmtMinutes,
  fmtMonth, fmtShiftTimes, fmtZoneName, monthWindow,
} from './attendance-format';
import {
  AttendanceDayResult, AttendanceRecordsV2, AttendanceRosterV2,
  type AttendanceApplicationSummaryV2, type AttendanceDayV2, type AttendanceRosterDayV2,
} from '../../lib/mobile-api/v2/attendance';

export function TimeZoneNote({ zone }: { zone: string }) {
  return <Muted>{t('attTimeZone', { zone: fmtZoneName(zone) })}</Muted>;
}

/** The schedule half of a day, in one line. */
export function scheduleText(s: AttendanceDayV2['schedule']): string {
  const times = fmtShiftTimes(s.start, s.end, s.crossesMidnight);
  if (s.shiftCode || times) return [s.shiftCode, times].filter(Boolean).join(' ');
  if (s.context === 'on_leave') return t('attOnLeave');
  if (s.context === 'holiday' || s.dayType === 'holiday') return t('attHoliday');
  if (s.rosteredRest || s.context === 'rest_day' || s.dayType === 'rest_day') return t('attRestDay');
  return t('attNoShift');
}

function MonthStepper({ month, onMonth }: { month: string | null; onMonth: (m: string | null) => void }) {
  const { palette } = useTenantDesign();
  return <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Button title="‹" accessibilityLabel={t('attPrevMonth')} kind="quiet" disabled={!month} onPress={() => month && onMonth(addMonths(month, -1))} />
    <Text style={{ color: palette.text, fontSize: 17, fontWeight: '600', flexGrow: 1, textAlign: 'center' }}>{month ? fmtMonth(month) : ''}</Text>
    <Button title="›" accessibilityLabel={t('attNextMonth')} kind="quiet" disabled={!month} onPress={() => month && onMonth(addMonths(month, 1))} />
    <Button title={t('attThisMonth')} kind="quiet" onPress={() => onMonth(null)} />
  </View>;
}

export function DayRow({ day, today, onPress }: { day: AttendanceDayV2; today: string | null; onPress: () => void }) {
  const { palette } = useTenantDesign();
  const status = day.outcome.status ? t(DAY_STATUS[day.outcome.status]) : '';
  const exception = day.exception ? t(EXCEPTION[day.exception]) : null;
  const label = [fmtCalendarDate(day.date), scheduleText(day.schedule), status, exception].filter(Boolean).join(', ');
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={{ paddingVertical: 12, borderBottomWidth: 1, borderColor: palette.border, gap: 4 }}>
    <Text style={{ color: palette.text, fontSize: 16, fontWeight: day.date === today ? '700' : '600' }}>{fmtCalendarDate(day.date)}</Text>
    <Muted>{scheduleText(day.schedule)}</Muted>
    {day.outcome.recorded && <Muted>{t('attInOut', { in: day.outcome.checkIn ?? '—', out: day.outcome.checkOut ?? '—' })}</Muted>}
    {status ? <Text style={{ color: palette.text }}>{status}</Text> : null}
    {exception && <Text style={{ color: palette.accent, fontWeight: '600' }}>{t('attException', { what: exception })}</Text>}
  </Pressable>;
}

function rosterText(d: AttendanceRosterDayV2): string {
  if ((d.kind === 'shift' || d.kind === 'usual') && d.shift) {
    const times = fmtShiftTimes(d.shift.start, d.shift.end, d.shift.crossesMidnight);
    return [d.shift.code, times, t(d.kind === 'shift' ? 'attRosterRostered' : 'attRosterUsual')].filter(Boolean).join(' · ');
  }
  return t(d.kind === 'rest' ? 'attRosterRest' : d.kind === 'off' ? 'attRosterOff' : 'attRosterNone');
}

function RecordsTab({ month, onMonth }: { month: string | null; onMonth: (m: string | null) => void }) {
  const { signOut, employmentId } = useSession();
  const records = useApiV2('v2/attendance/records', AttendanceRecordsV2, { employmentId: employmentId ?? undefined, ...(month ? monthWindow(month) : {}) }, signOut);
  const data = records.data;
  const shown = month ?? data?.from.slice(0, 7) ?? null;
  return <>
    <MonthStepper month={shown} onMonth={onMonth} />
    <LoadState loading={records.loading} hasData={data != null} error={records.error} onRetry={records.reload} />
    {data && !data.enabled && <Muted>{t('attModuleOff')}</Muted>}
    {data && data.enabled && !data.employmentId && <Muted>{t('attNoEmployment')}</Muted>}
    {data && data.enabled && data.employmentId && <>
      <TimeZoneNote zone={data.timeZone} />
      {data.days.length === 0 && <Muted>{t('attNoDays')}</Muted>}
      {data.days.map((day) => <DayRow key={day.date} day={day} today={data.today}
        onPress={() => router.push({ pathname: '/attendance/[date]', params: { date: day.date } })} />)}
    </>}
  </>;
}

function RosterTab({ month, onMonth }: { month: string | null; onMonth: (m: string | null) => void }) {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const roster = useApiV2('v2/attendance/roster', AttendanceRosterV2, { employmentId: employmentId ?? undefined, ...(month ? monthWindow(month) : {}) }, signOut);
  const data = roster.data;
  // D8: a fresh roster answer re-plans the shift reminders (they read their own 7-day window).
  useEffect(() => { if (data) requestShiftReminderRefresh(); }, [data]);
  const shown = month ?? data?.from.slice(0, 7) ?? null;
  return <>
    <MonthStepper month={shown} onMonth={onMonth} />
    <LoadState loading={roster.loading} hasData={data != null} error={roster.error} onRetry={roster.reload} />
    {data && !data.enabled && <Muted>{t('attModuleOff')}</Muted>}
    {data && data.enabled && !data.employmentId && <Muted>{t('attNoEmployment')}</Muted>}
    {data && data.enabled && data.employmentId && <>
      <TimeZoneNote zone={data.timeZone} />
      <Muted>{t('attRosterTotals', { work: data.totals.workDays, rest: data.totals.restDays, hours: fmtMinutes(data.totals.plannedMinutes) })}</Muted>
      {data.days.map((d) => <View key={d.date} accessibilityLabel={`${fmtCalendarDate(d.date)}, ${rosterText(d)}`}
        style={{ paddingVertical: 10, borderBottomWidth: 1, borderColor: palette.border, gap: 2 }}>
        <Text style={{ color: palette.text, fontWeight: '600' }}>{fmtCalendarDate(d.date)}</Text>
        <Muted>{rosterText(d)}</Muted>
        {d.note ? <Muted>{d.note}</Muted> : null}
      </View>)}
    </>}
  </>;
}

/** My attendance: this month's records or roster, a month at a time, and the ways into applications and requests. */
export function AttendanceHomeScreen() {
  const [tab, setTab] = useState<'records' | 'roster'>('records');
  const [month, setMonth] = useState<string | null>(null);
  return <Screen back>
    <Title>{t('attTitle')}</Title>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Button title={t('attTabRecords')} kind={tab === 'records' ? 'primary' : 'quiet'} onPress={() => setTab('records')} />
      <Button title={t('attTabRoster')} kind={tab === 'roster' ? 'primary' : 'quiet'} onPress={() => setTab('roster')} />
    </View>
    {tab === 'records' ? <RecordsTab month={month} onMonth={setMonth} /> : <RosterTab month={month} onMonth={setMonth} />}
    <SectionLabel>{t('attMore')}</SectionLabel>
    <Button title={t('attApplications')} kind="quiet" onPress={() => router.push('/attendance/requests')} />
    <Button title={t('attReplacementOpen')} kind="quiet" onPress={() => router.push('/attendance/replacement')} />
  </Screen>;
}

export function ApplicationRow({ item, onPress }: { item: AttendanceApplicationSummaryV2; onPress: () => void }) {
  const { palette } = useTenantDesign();
  const status = t(APPLICATION_STATUS[item.displayStatus]);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${fmtCalendarDate(item.date)}, ${applicationKindText(item)}, ${status}`} onPress={onPress}
    style={{ paddingVertical: 12, borderBottomWidth: 1, borderColor: palette.border, gap: 4 }}>
    <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{fmtCalendarDate(item.date)} · {applicationKindText(item)}</Text>
    <Muted>{askedText(item)}</Muted>
    <Text style={{ color: palette.accent, fontWeight: '600' }}>{status}</Text>
  </Pressable>;
}

/** One of the caller's own days, in full: schedule, clockings on record, result, exception, applications, correction. */
export function AttendanceDayScreen({ date }: { date: string }) {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const day = useApiV2('v2/attendance/day', AttendanceDayResult, { employmentId: employmentId ?? undefined, date: valid ? date : undefined }, signOut);
  const found = day.data?.outcome === 'found' ? day.data : null;
  const online = !!found && !day.error && !day.loading;
  const d = found?.day;
  return <Screen back onRefresh={day.reload}>
    <Title>{t('attDayTitle', { date: valid ? fmtCalendarDate(date) : date })}</Title>
    <LoadState loading={day.loading} hasData={day.data != null} error={day.error} onRetry={day.reload} />
    {day.data?.outcome === 'refused' && <Muted>{t(day.data.code === 'module_off' ? 'attModuleOff' : 'attNotFound')}</Muted>}
    {found && d && <>
      <TimeZoneNote zone={found.timeZone} />
      <Card>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t('attSchedule')}</Text>
        <Muted>{scheduleText(d.schedule)}</Muted>
        {d.schedule.scheduledMinutes != null && <Row label={t('attScheduled')} value={fmtMinutes(d.schedule.scheduledMinutes)} />}
        {d.schedule.crossesMidnight && <Muted>{t('attOvernightNote')}</Muted>}
      </Card>
      <Card>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t('attPunches')}</Text>
        {d.punches.length === 0 ? <Muted>{t('attNoPunches')}</Muted>
          : d.punches.map((p, i) => <Row key={`${p.at}-${p.direction}-${i}`} label={t(p.direction === 'in' ? 'attPunchIn' : 'attPunchOut')} value={p.at} />)}
      </Card>
      <Card>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t('attOutcome')}</Text>
        {!d.outcome.recorded ? <Muted>{t('attNoRecord')}</Muted> : <>
          <Row label={t('attCheckIn')} value={d.outcome.checkIn ?? '—'} />
          <Row label={t('attCheckOut')} value={d.outcome.checkOut ?? '—'} />
          <Row label={t('attWorked')} value={fmtMinutes(d.outcome.workedMinutes)} />
          {!!d.outcome.lateMinutes && <Row label={t('attLate')} value={fmtMinutes(d.outcome.lateMinutes)} />}
          {!!d.outcome.earlyOutMinutes && <Row label={t('attEarlyOut')} value={fmtMinutes(d.outcome.earlyOutMinutes)} />}
        </>}
        {d.outcome.status && <Row label={t('attStatus')} value={t(DAY_STATUS[d.outcome.status])} />}
      </Card>
      {d.exception && <Card><Text accessibilityRole="alert" style={{ color: palette.text, fontWeight: '600' }}>{t('attException', { what: t(EXCEPTION[d.exception]) })}</Text></Card>}
      {found.applications.length > 0 && <>
        <SectionLabel>{t('attDayApplications')}</SectionLabel>
        {found.applications.map((a) => <ApplicationRow key={a.id} item={a} onPress={() => router.push({ pathname: '/attendance/request/[id]', params: { id: a.id } })} />)}
      </>}
      {found.correction.offered
        ? <>
          {!online && <Muted>{t('attCommandsOnline')}</Muted>}
          <Button title={t('attRequestCorrection')} disabled={!online} onPress={() => router.push({ pathname: '/attendance/correction', params: { date: d.date } })} />
        </>
        : <Muted>{t(found.correction.blockedBy === 'future' ? 'attCorrectionFuture' : 'attCorrectionPending')}</Muted>}
    </>}
  </Screen>;
}
