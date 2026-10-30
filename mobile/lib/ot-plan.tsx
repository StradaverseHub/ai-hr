/**
 * Plan overtime (Mobile WOW round) — the web's "Apply OT Plan" (app/attendance/plan-ot/apply) on the phone, through
 * POST /api/mobile/v2/attendance/overtime-plans, which files it with the SAME kernel service and approval route as the
 * web form (requestAttendanceCorrection with planned times).
 *
 * The app decides nothing: whether this employee may plan overtime is the server's offer; the chosen date's roster is
 * the kernel's own day read (the web form's roster card); the minutes, the validation, duplicates and limits are the
 * kernel's. The plan runs only online, after an explicit confirmation, under a client requestId the server's command
 * receipt replays: when the answer is lost, "Try again" resends the SAME reference. The draft is held in memory only
 * and is gone when the screen closes. Attachments stay on the web.
 */
import { useRef, useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { DesignText as Text, useTenantDesign } from './design';
import { apiPostV2, useApiV2 } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { t } from './i18n';
import { PickerField } from './leave-request-form';
import { useSession } from './session';
import { fmtCalendarDate, fmtMinutes } from './attendance-format';
import { TimeZoneNote, scheduleText } from './attendance-records';
import { attendanceRefusalText } from './attendance-applications';
import { Icon } from './icon';
import { tint } from './home-hero';
import { Button, Card, LoadState, Muted, Screen, Title } from './ui';
import { AttendanceDayResult, OvertimePlanOfferV2, OvertimePlanResult } from '../../lib/mobile-api/v2/attendance';

type PlanBody = { requestId: string; date: string; plannedStart: string; plannedEnd: string; reason: string; remark?: string };
type Phase = { value: PlanBody; phase: 'sending' | 'uncertain' } | null;

export function OvertimePlanScreen() {
  const { palette, design } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 12 : 4;
  const offer = useApiV2('v2/attendance/overtime-plans/offer', OvertimePlanOfferV2, { employmentId: employmentId ?? undefined }, signOut);
  const [date, setDate] = useState<string | undefined>(undefined);
  // Until a date is chosen the roster read is today's (never an empty date); its card shows only for a chosen date.
  const day = useApiV2('v2/attendance/day', AttendanceDayResult, { employmentId: employmentId ?? undefined, date: date ?? offer.data?.today }, signOut);
  const [start, setStart] = useState<string | undefined>(undefined);
  const [end, setEnd] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [remark, setRemark] = useState('');
  const [command, setCommand] = useState<Phase>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; minutes: number; date: string } | null>(null);
  const flight = useRef(false);
  const o = offer.data;
  const found = date && day.data?.outcome === 'found' ? day.data : null;
  const locked = !!command || !!sent;
  const online = !!o && !offer.error && !offer.loading;

  async function send(body: PlanBody) {
    if (flight.current || !employmentId) return;
    flight.current = true; const owner = authGeneration();
    setCommand({ value: body, phase: 'sending' }); setNotice(null);
    try {
      const result = await apiPostV2('v2/attendance/overtime-plans', OvertimePlanResult, body, { employmentId });
      assertAuthGeneration(owner);
      setCommand(null);
      if (result.outcome === 'refused') setNotice(attendanceRefusalText(result));
      else setSent({ id: result.id, minutes: result.minutes, date: result.date });
    } catch (e) {
      if (e instanceof SignInRequiredError) { setCommand(null); void signOut(); }
      else if (e instanceof RequestRejectedError) { setCommand(null); setNotice(t('genericError')); }
      else setCommand({ value: body, phase: 'uncertain' });
    } finally { flight.current = false; }
  }
  function review() {
    if (!online || !date) { setNotice(t('otPickDate')); return; }
    if (!start || !end) { setNotice(t('otPickTimes')); return; }
    if (!reason.trim()) { setNotice(t('attReasonMissing')); return; }
    const body: PlanBody = { requestId: randomUUID(), date, plannedStart: start, plannedEnd: end, reason: reason.trim(), ...(remark.trim() ? { remark: remark.trim() } : {}) };
    Alert.alert(t('otConfirmTitle'), t('otConfirm', { date: fmtCalendarDate(date), start, end, reason: body.reason }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('attSend'), onPress: () => void send(body) },
    ]);
  }
  const field = (label: string, value: string, change: (v: string) => void, max: number) => <View style={{ gap: 6 }}>
    <Text style={{ color: palette.muted, fontSize: 14 }}>{label}</Text>
    <TextInput accessibilityLabel={label} editable={!locked} value={value} onChangeText={change} multiline maxLength={max} placeholderTextColor={palette.muted}
      style={{ color: palette.text, minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: radius, padding: 12, fontSize: 16, textAlignVertical: 'top' }} />
  </View>;

  if (sent) return <Screen back>
    <View style={{ alignItems: 'center', gap: 14, paddingVertical: 32 }}>
      <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: tint(palette.accent, 0.14, palette.card), alignItems: 'center', justifyContent: 'center' }}><Icon name="overtime" color={palette.accent} size={40} /></View>
      <Text accessibilityRole="alert" style={{ color: palette.text, fontSize: 22, fontWeight: '800', textAlign: 'center' }}>{t('otSentTitle')}</Text>
      <Muted>{t('otSentBody', { date: fmtCalendarDate(sent.date), duration: fmtMinutes(sent.minutes) })}</Muted>
    </View>
    <Button title={t('attViewApplication')} onPress={() => router.replace({ pathname: '/attendance/request/[id]', params: { id: sent.id } })} />
    <Button title={t('otPlanAnother')} kind="quiet" onPress={() => { setSent(null); setDate(undefined); setStart(undefined); setEnd(undefined); setReason(''); setRemark(''); }} />
  </Screen>;

  return <Screen back onRefresh={() => { offer.reload(); if (date) day.reload(); }}>
    <Title>{t('qaOtPlan')}</Title>
    <LoadState loading={offer.loading} hasData={o != null} error={offer.error} onRetry={offer.reload} />
    {o && !o.enabled && <Muted>{t('attModuleOff')}</Muted>}
    {o && o.enabled && !o.allowed && <Card><Text style={{ color: palette.text, lineHeight: 22 }}>{t(o.reason === 'no_employment' ? 'attNoEmployment' : 'otNotAllowed')}</Text></Card>}
    {o && o.enabled && o.allowed && <>
      <TimeZoneNote zone={o.timeZone} />
      <Muted>{t('otHint')}</Muted>
      <PickerField label={t('otDate')} mode="date" value={date} today={o.today} disabled={locked} onChange={(v) => { setDate(v); setNotice(null); }} />
      {date && <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Icon name="teamCalendar" color={palette.accent} size={18} /><Text style={{ color: palette.text, fontSize: 16, fontWeight: '700' }}>{t('otRosterOn', { date: fmtCalendarDate(date) })}</Text></View>
        <LoadState loading={day.loading} hasData={day.data != null} error={day.error} onRetry={day.reload} />
        {found && <Text style={{ color: palette.text, fontSize: 15 }}>{scheduleText(found.day.schedule)}</Text>}
        {day.data?.outcome === 'refused' && <Muted>{t('otRosterUnavailable')}</Muted>}
      </Card>}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <PickerField label={t('otStart')} mode="time" value={start} today={o.today} disabled={locked} onChange={setStart} />
        <PickerField label={t('otEnd')} mode="time" value={end} today={o.today} disabled={locked} onChange={setEnd} />
      </View>
      {field(t('attReasonRequired'), reason, setReason, 500)}
      {field(t('attRemarkOptional'), remark, setRemark, 2000)}
      {notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{notice}</Text>}
      {command?.phase === 'uncertain' ? <Card>
        <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('leaveCommandUncertain')}</Text>
        <Button title={t('leaveCommandRetry')} onPress={() => void send(command.value)} />
        <Button title={t('leaveCommandDismiss')} kind="quiet" onPress={() => setCommand(null)} />
      </Card> : <Button title={t('otReview')} disabled={!online || locked} onPress={review} />}
      {command?.phase === 'sending' && <Muted>{t('leaveCommandSending')}</Muted>}
      <Muted>{t('otAttachmentsOnWeb')}</Muted>
    </>}
  </Screen>;
}
