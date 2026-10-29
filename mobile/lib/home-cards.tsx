/**
 * Home as a summary (mobile declutter round). Each card reads the SAME authorized endpoint its full screen reads and
 * links there; Home itself performs nothing. In particular Home never clocks: the clock card shows today's status and
 * worked time and its one button opens the Clock tab, where the whole clock journey (location, review, receipts,
 * attempt reports and their assurances) lives.
 */
import { useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect, type Href } from 'expo-router';
import { DesignText as Text, useTenantDesign } from './design';
import { useApi } from './api';
import type { LeaveResponse } from './api';
import { t } from './i18n';
import { useSession } from './session';
import { Button, Card, ListRow, LoadState, Muted, Row, fmtDays, fmtMoney } from './ui';

type LeaveCard = LeaveResponse['cards'][number];
/** The one figure a leave card shows — the web My Leave card front's own rule (taken-only types show taken). */
export const cardFigure = (c: LeaveCard) => (c.takenOnly ? c.taken : c.isCurrentCycle ? c.canApplyFor : c.balance);
/**
 * Home shows at most `max` balances: the server's own order, keeping only types the server says carry an entitlement
 * when there are any (`hasEntitlement`), so a taken-only type does not crowd out a real balance. No rule of the app's own.
 */
export function homeBalances(cards: readonly LeaveCard[], max = 3): LeaveCard[] {
  const entitled = cards.filter((c) => c.hasEntitlement);
  return (entitled.length ? entitled : cards).slice(0, max);
}
/** Worked time as the Clock tab words it, from the server's `workedSeconds`. */
export const fmtWorked = (seconds: number) =>
  t('workedTime', { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60).toString().padStart(2, '0') });

/** Today's status, worked time and a "Clock in"/"Clock out" button that OPENS the Clock tab. Nothing is recorded here. */
export function ClockSummary({ refreshToken = 0 }: { refreshToken?: number }) {
  const { employmentId, signOut } = useSession();
  const { palette } = useTenantDesign();
  const clock = useApi('clock', { employmentId: employmentId ?? undefined }, signOut);
  useFocusEffect(useCallback(() => { clock.reload(); }, [clock.reload]));
  useEffect(() => { if (refreshToken) clock.reload(); }, [refreshToken, clock.reload]);
  if (clock.data && !clock.data.enabled) return null;
  const today = clock.data?.state;
  return <Card>
    <LoadState loading={clock.loading} hasData={today != null} error={clock.error} onRetry={clock.reload} />
    {today && <>
      <Muted>{today.shift.code ? `${today.date} · ${today.shift.code}` : today.date}</Muted>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <Text style={{ color: palette.text, fontSize: 20, fontWeight: '700', flexShrink: 1 }}>{today.clockedIn ? t('onTheClock') : t('offTheClock')}</Text>
        <Text style={{ color: palette.accent, fontVariant: ['tabular-nums'] }}>{fmtWorked(today.workedSeconds)}</Text>
      </View>
      <Button title={today.clockedIn ? t('clockOut') : t('clockIn')} onPress={() => router.navigate('/clock' as Href)} />
    </>}
  </Card>;
}

/** At most three balances and "All balances" (the Leave tab). */
export function LeaveSummary({ refreshToken = 0 }: { refreshToken?: number }) {
  const { employmentId, signOut } = useSession();
  const leave = useApi('leave', { employmentId: employmentId ?? undefined }, signOut);
  useEffect(() => { if (refreshToken) leave.reload(); }, [refreshToken, leave.reload]);
  const cards = leave.data?.cards ?? [];
  return <View style={{ gap: 6 }}>
    <LoadState loading={leave.loading} hasData={leave.data != null} error={leave.error} onRetry={leave.reload} />
    {homeBalances(cards).map((c) => <View key={c.leaveTypeId} style={{ gap: 2 }}>
      <Row label={c.leaveType} value={fmtDays(cardFigure(c))} strong />
      {c.sharedPool && <Muted>{t('sharedPool')}</Muted>}
    </View>)}
    {leave.data && cards.length === 0 && <Muted>{t('noLeaveTypes')}</Muted>}
    {leave.data && <ListRow label={t('allBalances')} onPress={() => router.navigate('/leave' as Href)} />}
  </View>;
}

/** The latest payslip as one row (period and net pay), opening Payslips. Absent when payroll is off. */
export function PayslipRow({ refreshToken = 0 }: { refreshToken?: number }) {
  const { signOut } = useSession();
  const pay = useApi('payslips', {}, signOut);
  useEffect(() => { if (refreshToken) pay.reload(); }, [refreshToken, pay.reload]);
  if (pay.data && !pay.data.enabled) return null;
  const latest = pay.data?.items[0];
  return <View>
    <LoadState loading={pay.loading} hasData={pay.data != null} error={pay.error} onRetry={pay.reload} />
    {latest ? <ListRow label={t('latestPayslipRow', { period: latest.payPeriod })} value={fmtMoney(latest.net)} onPress={() => router.push('/pay')} />
      : pay.data ? <Muted>{t('noPayslips')}</Muted> : null}
  </View>;
}
