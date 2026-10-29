/**
 * M12 (D13) — the two requests an employee files from the app: a missed-punch / correction request for one of their
 * own days, and a replacement-leave (Leave Credit) request. Overtime plans have their own screen since the Mobile WOW
 * round (mobile/lib/ot-plan.tsx); withdrawing one and attaching files stay on the web.
 *
 * The app decides nothing. The day's clockings on record are shown read only as context; the request PROPOSES times
 * and a reason, and the kernel validates it (requestAttendanceCorrection / submitLeaveCreditRequest), snapshots the
 * routing and answers a typed refusal. The Leave Credit day type, the shift, the clock times and the credit a window
 * earns are the kernel's own reads (extendedHoursDayForEmployment, leaveCreditClaimReview); the app never computes a
 * credit, a limit or eligibility. A request runs only online, only after an explicit confirmation, and carries a
 * client requestId the server's command receipt replays: when the answer is lost, "Try again" resends the SAME
 * reference. The draft is held in memory only (D10) and is gone when the screen closes.
 */
import { useRef, useState } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { DesignText as Text, useTenantDesign } from './design';
import { apiPostV2, useApiV2 } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { appLocale, t, type MessageKey } from './i18n';
import { PickerField } from './leave-request-form';
import { useSession } from './session';
import { Button, Card, LoadState, Muted, Row, Screen, Title, fmtDays } from './ui';
import { fmtCalendarDate, fmtMinutes } from './attendance-format';
import { TimeZoneNote, scheduleText } from './attendance-records';
import { attendanceRefusalText } from './attendance-applications';
import {
  AttendanceCorrectionResult, AttendanceDayResult, ReplacementLeaveDayResult, ReplacementLeaveOfferV2, ReplacementLeaveResult,
  type LeaveCreditDayType, type ReplacementLeaveDayV2, type ReplacementLeaveRefusal, type ReplacementLeaveRefusalCode, type ReplacementUnavailable,
} from '../../lib/mobile-api/v2/attendance';

type Phase<C> = { value: C; phase: 'sending' | 'uncertain' } | null;

function useInput() {
  const { palette, design } = useTenantDesign();
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 12 : 4;
  return (label: string, value: string, change: (v: string) => void, disabled: boolean, maxLength: number) => <View style={{ gap: 6 }}>
    <Text style={{ color: palette.muted, fontSize: 14 }}>{label}</Text>
    <TextInput accessibilityLabel={label} editable={!disabled} value={value} onChangeText={change} multiline maxLength={maxLength} placeholderTextColor={palette.muted}
      style={{ color: palette.text, minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: radius, padding: 12, fontSize: 16, textAlignVertical: 'top' }} />
  </View>;
}

// ── Correction (missed punch) ──────────────────────────────────────────────────────────────────────────────

type CorrectionBody = { requestId: string; date: string; checkIn?: string; checkOut?: string; reason: string; remark?: string };

/** A correction request for one own day: the clockings on record shown read only, proposed times, a reason. */
export function AttendanceCorrectionScreen({ date }: { date: string }) {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const field = useInput();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const day = useApiV2('v2/attendance/day', AttendanceDayResult, { employmentId: employmentId ?? undefined, date: valid ? date : undefined }, signOut);
  const found = day.data?.outcome === 'found' ? day.data : null;
  // undefined = untouched (the web's form opens on the day's own pair); null = cleared.
  const [times, setTimes] = useState<{ checkIn?: string | null; checkOut?: string | null }>({});
  const [reason, setReason] = useState('');
  const [remark, setRemark] = useState('');
  const [command, setCommand] = useState<Phase<CorrectionBody>>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const flight = useRef(false);
  const online = !!found && !day.error && !day.loading;
  const busy = command?.phase === 'sending';
  const locked = !!command || !!sent;
  const checkIn = times.checkIn === undefined ? found?.day.outcome.checkIn ?? null : times.checkIn;
  const checkOut = times.checkOut === undefined ? found?.day.outcome.checkOut ?? null : times.checkOut;

  async function send(body: CorrectionBody) {
    if (flight.current || !employmentId) return;
    flight.current = true; const owner = authGeneration();
    setCommand({ value: body, phase: 'sending' }); setNotice(null);
    try {
      const result = await apiPostV2('v2/attendance/corrections', AttendanceCorrectionResult, body, { employmentId });
      assertAuthGeneration(owner);
      setCommand(null);
      if (result.outcome === 'refused') setNotice(attendanceRefusalText(result));
      else { setSent(result.id); setNotice(t('attCorrectionSent')); }
      day.reload();
    } catch (e) {
      if (e instanceof SignInRequiredError) { setCommand(null); void signOut(); }
      else if (e instanceof RequestRejectedError) { setCommand(null); setNotice(t('genericError')); }
      else setCommand({ value: body, phase: 'uncertain' });
    } finally { flight.current = false; }
  }
  function review() {
    if (!found || !online) return;
    if (!checkIn && !checkOut) { setNotice(t('attCorrectionNothing')); return; }
    if (!reason.trim()) { setNotice(t('attReasonMissing')); return; }
    const body: CorrectionBody = { requestId: randomUUID(), date: found.day.date, ...(checkIn ? { checkIn } : {}), ...(checkOut ? { checkOut } : {}), reason: reason.trim(), ...(remark.trim() ? { remark: remark.trim() } : {}) };
    Alert.alert(t('attCorrectionConfirmTitle'), t('attCorrectionConfirm', { date: fmtCalendarDate(body.date), in: body.checkIn ?? '—', out: body.checkOut ?? '—', reason: body.reason }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('attSend'), onPress: () => void send(body) },
    ]);
  }

  return <Screen back onRefresh={day.reload}>
    <Title>{t('attCorrectionTitle', { date: valid ? fmtCalendarDate(date) : date })}</Title>
    <LoadState loading={day.loading} hasData={day.data != null} error={day.error} onRetry={day.reload} />
    {day.data?.outcome === 'refused' && <Muted>{t(day.data.code === 'module_off' ? 'attModuleOff' : 'attNotFound')}</Muted>}
    {found && <>
      <TimeZoneNote zone={found.timeZone} />
      <Card>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t('attOnRecord')}</Text>
        <Muted>{scheduleText(found.day.schedule)}</Muted>
        {found.day.punches.length === 0 ? <Muted>{t('attNoPunches')}</Muted>
          : found.day.punches.map((p, i) => <Row key={`${p.at}-${p.direction}-${i}`} label={t(p.direction === 'in' ? 'attPunchIn' : 'attPunchOut')} value={p.at} />)}
      </Card>
      {notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{notice}</Text>}
      {sent && <Button title={t('attViewApplication')} onPress={() => router.replace({ pathname: '/attendance/request/[id]', params: { id: sent } })} />}
      {!sent && !found.correction.offered && <Muted>{t(found.correction.blockedBy === 'future' ? 'attCorrectionFuture' : 'attCorrectionPending')}</Muted>}
      {!sent && found.correction.offered && <>
        <Muted>{t('attCorrectionHint')}</Muted>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <PickerField label={t('attProposedIn')} mode="time" value={checkIn ?? undefined} today={found.today} disabled={locked} onChange={(v) => setTimes((s) => ({ ...s, checkIn: v }))} />
          <PickerField label={t('attProposedOut')} mode="time" value={checkOut ?? undefined} today={found.today} disabled={locked} onChange={(v) => setTimes((s) => ({ ...s, checkOut: v }))} />
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Button title={t('attClearIn')} kind="quiet" disabled={locked || !checkIn} onPress={() => setTimes((s) => ({ ...s, checkIn: null }))} />
          <Button title={t('attClearOut')} kind="quiet" disabled={locked || !checkOut} onPress={() => setTimes((s) => ({ ...s, checkOut: null }))} />
        </View>
        {field(t('attReasonRequired'), reason, setReason, locked, 500)}
        {field(t('attRemarkOptional'), remark, setRemark, locked, 2000)}
        {!online && <Muted>{t('attCommandsOnline')}</Muted>}
        {command?.phase === 'uncertain' ? <Card>
          <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('leaveCommandUncertain')}</Text>
          <Button title={t('leaveCommandRetry')} onPress={() => void send(command.value)} />
          <Button title={t('leaveCommandDismiss')} kind="quiet" onPress={() => { setCommand(null); day.reload(); }} />
        </Card> : <Button title={t('attReview')} disabled={!online || locked} onPress={review} />}
        {busy && <Muted>{t('leaveCommandSending')}</Muted>}
      </>}
    </>}
  </Screen>;
}

// ── Replacement leave (Leave Credit) ───────────────────────────────────────────────────────────────────────

const UNAVAILABLE: Record<ReplacementUnavailable, MessageKey> = {
  module_off: 'attRlOffModule', no_employment: 'attNoEmployment', not_enabled: 'attRlOffCompany', employee_requests_off: 'attRlOffRequests',
  not_eligible: 'attRlOffEligible', first_schedule_protected: 'attRlOffFirstSchedule', no_leave_type: 'attRlOffType',
};
const DAY_TYPE: Record<LeaveCreditDayType, MessageKey> = { rest_day: 'attRestDay', off_day: 'attOffDay', holiday: 'attHoliday', workday: 'attWorkingDay' };
const RL_REFUSAL: Record<ReplacementLeaveRefusalCode, MessageKey> = {
  module_off: 'attRlOffModule', request_conflict: 'attRefusalConflict', no_employment: 'attNoEmployment', no_leave_type: 'attRlOffType',
  disabled: 'attRlOffRequests', not_eligible: 'attRlOffEligible', consent_required: 'attRlConsentRequired', day_type_mismatch: 'attRlDayChanged',
  below_threshold: 'attRlBelow', already_credited: 'attRlAlreadyCredited', overtime_claimed: 'attRlOvertimeClaimed', invalid: 'attRefusalInvalid',
};
export function replacementRefusalText(r: ReplacementLeaveRefusal): string {
  return (r.code === 'invalid' || r.code === 'not_eligible') && r.message && appLocale() === 'en' ? `${t(RL_REFUSAL[r.code])} ${r.message}` : t(RL_REFUSAL[r.code]);
}
const REVIEW_REASON: Record<string, MessageKey> = { belowThreshold: 'attRlBelow', ordinaryDisabled: 'attRlOrdinaryOff', exceedsBound: 'attRlExceeds' };
function reviewText(r: NonNullable<ReplacementLeaveDayV2['review']>): string {
  if (r.state === 'ready') return t('attRlCredit', { days: fmtDays(r.creditDays) });
  if (r.state === 'legacy') return t('attRlLegacy');
  if (r.state === 'incomplete') return t('attRlIncomplete');
  if (r.state === 'unavailable') return t('attRlUnavailableDay');
  return t(REVIEW_REASON[r.reason ?? ''] ?? 'attRlRefused');
}

type ReplacementBody = { requestId: string; rows: { workedDate: string; dayType: LeaveCreditDayType; claimStart: string; claimEnd: string }[]; reason: string; firstScheduleConsent: boolean };

/** One worked date: the kernel's facts and review for the window, the reason, consent when asked, and Send. */
function ReplacementClaim({ offer, date, onSent }: { offer: ReplacementLeaveOfferV2; date: string; onSent: (id: string) => void }) {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const field = useInput();
  const [claim, setClaim] = useState<{ start?: string; end?: string }>({});
  const [reason, setReason] = useState('');
  const [consent, setConsent] = useState(false);
  const [command, setCommand] = useState<Phase<ReplacementBody>>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const flight = useRef(false);
  const both = !!claim.start && !!claim.end;
  const facts = useApiV2('v2/attendance/replacement-leave/day', ReplacementLeaveDayResult,
    { employmentId: employmentId ?? undefined, date, start: both ? claim.start : undefined, end: both ? claim.end : undefined }, signOut);
  const found = facts.data?.outcome === 'found' ? facts.data.day : null;
  const online = !!found && !facts.error && !facts.loading;
  const locked = !!command;
  const reviewOk = !!found?.review && (found.review.state === 'ready' || found.review.state === 'legacy');
  const ready = online && both && claim.start !== claim.end && reviewOk && !!reason.trim() && (!offer.requiresFirstScheduleConsent || consent);

  async function send(body: ReplacementBody) {
    if (flight.current || !employmentId) return;
    flight.current = true; const owner = authGeneration();
    setCommand({ value: body, phase: 'sending' }); setNotice(null);
    try {
      const result = await apiPostV2('v2/attendance/replacement-leave', ReplacementLeaveResult, body, { employmentId });
      assertAuthGeneration(owner);
      setCommand(null);
      if (result.outcome === 'refused') { setNotice(replacementRefusalText(result)); facts.reload(); }
      else onSent(result.id);
    } catch (e) {
      if (e instanceof SignInRequiredError) { setCommand(null); void signOut(); }
      else if (e instanceof RequestRejectedError) { setCommand(null); setNotice(t('genericError')); }
      else setCommand({ value: body, phase: 'uncertain' });
    } finally { flight.current = false; }
  }
  function review() {
    if (!ready || !found || !claim.start || !claim.end) return;
    const body: ReplacementBody = {
      requestId: randomUUID(), rows: [{ workedDate: date, dayType: found.dayType, claimStart: claim.start, claimEnd: claim.end }],
      reason: reason.trim(), firstScheduleConsent: offer.requiresFirstScheduleConsent ? consent : false,
    };
    Alert.alert(t('attRlConfirmTitle'), t('attRlConfirm', { date: fmtCalendarDate(date), start: claim.start, end: claim.end, reason: body.reason }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('attSend'), onPress: () => void send(body) },
    ]);
  }

  return <>
    <LoadState loading={facts.loading} hasData={facts.data != null} error={facts.error} onRetry={facts.reload} />
    {facts.data?.outcome === 'refused' && <Muted>{t('attRlUnavailableDay')}</Muted>}
    {found && <Card>
      <Row label={t('attDayType')} value={t(DAY_TYPE[found.dayType])} />
      {(found.shiftCode || found.shiftStart) && <Row label={t('attShift')} value={[found.shiftCode, found.shiftStart && found.shiftEnd ? `${found.shiftStart}–${found.shiftEnd}` : null].filter(Boolean).join(' ')} />}
      <Row label={t('attClocked')} value={t('attInOut', { in: found.actualClockIn ?? '—', out: found.actualClockOut ?? '—' })} />
      {found.approvedOvertime && <Muted>{t('attRlApprovedOt', { hours: fmtMinutes(found.approvedOvertime.minutes) })}</Muted>}
    </Card>}
    {found && <>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <PickerField label={t('attClaimStart')} mode="time" value={claim.start} today={offer.today} disabled={locked} onChange={(v) => setClaim((c) => ({ ...c, start: v }))} />
        <PickerField label={t('attClaimEnd')} mode="time" value={claim.end} today={offer.today} disabled={locked} onChange={(v) => setClaim((c) => ({ ...c, end: v }))} />
      </View>
      {found.review && <Card>
        <Text style={{ color: palette.text, fontWeight: '600' }}>{reviewText(found.review)}</Text>
        {found.review.crossesMidnight && <Muted>{t('attRlNextDay')}</Muted>}
      </Card>}
      {field(t('attReasonRequired'), reason, setReason, locked, 2000)}
      {offer.requiresFirstScheduleConsent && <Pressable accessibilityRole="checkbox" accessibilityLabel={t('attRlConsent')} accessibilityState={{ checked: consent, disabled: locked }} disabled={locked}
        onPress={() => setConsent((c) => !c)} style={{ minHeight: 48, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <View style={{ width: 24, height: 24, borderWidth: 1, borderColor: consent ? palette.accent : palette.border, borderRadius: 4, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.accent }}>{consent ? '✓' : ''}</Text></View>
        <Text style={{ color: palette.text, flex: 1, lineHeight: 21 }}>{t('attRlConsent')}</Text>
      </Pressable>}
      {notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{notice}</Text>}
      {!online && <Muted>{t('attCommandsOnline')}</Muted>}
      {command?.phase === 'uncertain' ? <Card>
        <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('leaveCommandUncertain')}</Text>
        <Button title={t('leaveCommandRetry')} onPress={() => void send(command.value)} />
        <Button title={t('leaveCommandDismiss')} kind="quiet" onPress={() => { setCommand(null); facts.reload(); }} />
      </Card> : <Button title={t('attReview')} disabled={!ready || locked} onPress={review} />}
      {command?.phase === 'sending' && <Muted>{t('leaveCommandSending')}</Muted>}
    </>}
  </>;
}

/** May I ask (the kernel's answer, with its reason when not), and the request for one worked date when I may. */
export function ReplacementLeaveScreen() {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const offer = useApiV2('v2/attendance/replacement-leave', ReplacementLeaveOfferV2, { employmentId: employmentId ?? undefined }, signOut);
  const [date, setDate] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState<string | null>(null);
  const o = offer.data;
  return <Screen back onRefresh={offer.reload}>
    <Title>{t('attRlTitle')}</Title>
    <LoadState loading={offer.loading} hasData={o != null} error={offer.error} onRetry={offer.reload} />
    {o && !o.allowed && <Muted>{t(UNAVAILABLE[o.reason ?? 'not_eligible'])}</Muted>}
    {o && o.allowed && <>
      <TimeZoneNote zone={o.timeZone} />
      <Muted>{t('attRlHint')}</Muted>
      {o.leaveType && <Row label={t('attLeaveType')} value={o.leaveType.name} />}
      {o.tiers && <Muted>{t('attRlTiers', { half: fmtMinutes(o.tiers.halfDayMinutes), full: fmtMinutes(o.tiers.fullDayMinutes) })}</Muted>}
      {sent ? <Card>
        <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('attRlSent')}</Text>
        <Button title={t('back')} kind="quiet" onPress={() => router.back()} />
      </Card> : <>
        <PickerField label={t('attWorkedDate')} mode="date" value={date} today={o.today} disabled={false} onChange={setDate} />
        {date && <ReplacementClaim key={date} offer={o} date={date} onSent={setSent} />}
      </>}
    </>}
  </Screen>;
}
