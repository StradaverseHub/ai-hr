/**
 * M07 — the employee's leave history (every request, paged, filtered by status) and one request's detail, with the
 * two commands the web offers on it: Withdraw (a pending request) and Cancel dates (an approved one).
 *
 * The app decides nothing. Every status, per-date outcome, approval level, cancellable date and action offered
 * comes from the server (lib/mobile-api/v2/leave.ts; computed in core/mobile-leave-history.ts from the web's own
 * owners). A command runs only online, only after an explicit confirmation, and carries a client requestId the
 * server's command receipt replays: when the answer is lost, "Try again" resends the SAME reference and the server
 * returns its first answer instead of applying it twice. Nothing is queued or persisted (D10: in memory only).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { DesignText as Text, useTenantDesign } from './design';
import { apiGetV2, apiPostV2, v2Page } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { config, identityNamespace } from './config';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { appLocale, t, type MessageKey, intlLocale } from './i18n';
import { PagedList, usePagedResource } from './paged-list';
import { useSession } from './session';
import { Button, Card, fmtDays, HeaderBack, LoadState, Muted, Row, Screen, Title } from './ui';
import {
  LeaveCancellationResult, LeaveRequestDetailResult, LeaveRequestSummaryV2, LeaveWithdrawResult,
  type LeaveCommandRefusal, type LeaveCommandRefusalCode, type LeaveDisplayStatus, type LeaveRequestDetailV2,
} from '../../lib/mobile-api/v2/leave';

export const LEAVE_REQUESTS = v2Page('v2/leave/requests', LeaveRequestSummaryV2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only path segment the app ever sends: a validated request UUID. */
export function leaveRequestPath(id: string, action?: 'withdraw' | 'cancellation'): `v2/${string}` {
  if (!UUID.test(id)) throw new Error('Invalid leave request reference');
  return `v2/leave/requests/${id.toLowerCase()}${action ? `/${action}` : ''}`;
}

const STATUS_LABEL: Record<LeaveDisplayStatus, MessageKey> = {
  approved: 'approved', pending: 'pending', partial: 'leaveStatusPartly', rejected: 'rejected',
  cancelled: 'leaveStatusWithdrawn', cancellation_pending: 'leaveStatusCancellationPending',
};
const DATE_STATUS: Record<LeaveRequestDetailV2['dates'][number]['status'], MessageKey> = {
  approved: 'approved', pending: 'pending', rejected: 'rejected', cancelled: 'cancelled',
};
const REFUSAL: Record<LeaveCommandRefusalCode, MessageKey> = {
  not_found: 'leaveDetailMissing', request_conflict: 'leaveRefusalConflict', not_yours: 'leaveRefusalNotYours',
  not_approved: 'leaveRefusalNotApproved', not_full_day: 'leaveRefusalNotFullDay', grouped: 'leaveRefusalGrouped',
  type_off: 'leaveRefusalTypeOff', unpaid_days: 'leaveRefusalUnpaidDays', already_pending: 'leaveRefusalAlreadyPending',
  no_longer_cancellable: 'leaveRefusalNoLonger', already_final: 'leaveRefusalAlreadyFinal', already_approved: 'leaveRefusalAlreadyApproved',
  too_close: 'leaveRefusalTooClose', too_late: 'leaveRefusalTooLate', date_invalid: 'leaveRefusalDateInvalid',
  credit_blocked: 'leaveRefusalCreditBlocked', payroll_closed: 'leaveRefusalPayrollClosed', payroll_busy: 'leaveRefusalPayrollBusy',
  cancellation_refused: 'leaveRefusalOther',
};
/** The app's own sentence for a refusal code; the server's English sentence only for the catch-all in English. */
export function leaveRefusalText(r: LeaveCommandRefusal): string {
  return r.code === 'cancellation_refused' && r.message && appLocale() === 'en' ? r.message : t(REFUSAL[r.code]);
}
function fmtInstant(iso: string | null): string {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(intlLocale(), { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  catch { return iso.slice(0, 10); }
}
const span = (from: string, to: string) => (from === to ? from : t('leaveDateSpan', { from, to }));

export function LeaveStatusBadge({ status }: { status: LeaveDisplayStatus }) {
  const { palette } = useTenantDesign();
  return <Text accessibilityLabel={t(STATUS_LABEL[status])} style={{ color: palette.accent, fontWeight: '600' }}>{t(STATUS_LABEL[status])}</Text>;
}

export function LeaveRequestRow({ item, onPress }: { item: LeaveRequestSummaryV2; onPress: () => void }) {
  const { palette } = useTenantDesign();
  return <Pressable accessibilityRole="button" accessibilityLabel={`${item.leaveType}, ${span(item.startDate, item.endDate)}, ${t(STATUS_LABEL[item.displayStatus])}`} onPress={onPress}
    style={{ paddingVertical: 14, borderBottomWidth: 1, borderColor: palette.border, gap: 6 }}>
    <Text style={{ color: palette.text, fontSize: 17, fontWeight: '600' }}>{t('leaveDetailTitle', { type: item.leaveType, days: fmtDays(item.days) })}</Text>
    <Muted>{span(item.startDate, item.endDate)}</Muted>
    <LeaveStatusBadge status={item.displayStatus} />
  </Pressable>;
}

const FILTERS = [undefined, 'pending', 'approved', 'rejected', 'cancelled'] as const;
const FILTER_LABEL: Record<string, MessageKey> = { all: 'leaveFilterAll', pending: 'pending', approved: 'approved', rejected: 'rejected', cancelled: 'leaveStatusWithdrawn' };
const keyOf = (item: LeaveRequestSummaryV2) => item.id;

/** Every request on the selected employment, newest first. Offline: the rows already shown stay, labelled stale. */
export function LeaveHistoryScreen() {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>(undefined);
  const list = usePagedResource(LEAVE_REQUESTS, { employmentId: employmentId ?? undefined, status }, keyOf, signOut);
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }} edges={['top']}>
    <PagedList list={list} keyOf={keyOf} emptyText={t('noRequests')} contentContainerStyle={{ padding: 20, gap: 8 }}
      header={<View style={{ gap: 12 }}>
        <HeaderBack />
        <Title>{t('leaveRequestsTitle')}</Title>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {FILTERS.map((f) => <Button key={f ?? 'all'} title={t(FILTER_LABEL[f ?? 'all'])} kind={f === status ? 'primary' : 'quiet'} onPress={() => setStatus(f)} />)}
        </View>
      </View>}
      renderItem={(item) => <LeaveRequestRow item={item} onPress={() => router.push({ pathname: '/leave/[id]', params: { id: item.id } })} />} />
  </SafeAreaView>;
}

type Detail = { data: LeaveRequestDetailResult | null; error: Error | null; loading: boolean; reload: () => void };
/** One request, scoped like useApi: a change of identity, connection, locale or employment hides the old answer. */
export function useLeaveRequestDetail(id: string, employmentId: string | null, onSignInRequired: () => void): Detail {
  const owner = authGeneration(), namespace = identityNamespace(), origin = config.apiUrl, locale = appLocale();
  const key = JSON.stringify([owner, namespace, origin, locale, id, employmentId]);
  const [state, setState] = useState<{ key: string; data: LeaveRequestDetailResult | null; error: Error | null; loading: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setState((prior) => ({ key, data: prior?.key === key ? prior.data : null, error: null, loading: true }));
    let path: `v2/${string}`;
    try { path = leaveRequestPath(id); } catch (e) { setState({ key, data: null, error: e as Error, loading: false }); return; }
    apiGetV2(path, LeaveRequestDetailResult, { employmentId: employmentId ?? undefined }, controller.signal).then(
      (data) => { if (live && authGeneration() === owner) setState({ key, data, error: null, loading: false }); },
      (error: Error) => {
        if (!live || authGeneration() !== owner) return;
        if (error instanceof SignInRequiredError) onSignInRequired();
        // A refused or signed-out read keeps nothing; an outage keeps what was shown, labelled stale.
        setState((prior) => ({ key, data: error instanceof RequestRejectedError || error instanceof SignInRequiredError ? null : prior?.key === key ? prior.data : null, error, loading: false }));
      });
    return () => { live = false; controller.abort(); };
  }, [key, tick, onSignInRequired]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return state?.key === key ? { ...state, reload } : { data: null, error: null, loading: true, reload };
}

type Command = { kind: 'withdraw'; requestId: string; body: { requestId: string } }
  | { kind: 'cancel'; requestId: string; body: { requestId: string; cancelDates: string[]; reason?: string } };

function approvalLine(a: LeaveRequestDetailV2['approvals'][number]): string {
  const level = a.kindLabel ?? t('leaveLevel', { n: a.level });
  const name = a.names.join(' / '), date = fmtInstant(a.decidedAt);
  if (a.status === 'approved') return name ? t('leaveApprovedBy', { name, level, date }) : t('leaveApprovedAt', { level, date });
  if (a.status === 'rejected') return name ? t('leaveRejectedBy', { name, level, date }) : t('leaveRejectedAt', { level, date });
  if (a.status === 'waiting') return name ? t('leaveWaitingFor', { name, level }) : t('leaveWaitingAt', { level });
  return t('leaveNotReached', { level });
}

/** One request: what was asked, how each date and level was decided, and Withdraw / Cancel dates when offered. */
export function LeaveDetailScreen({ id }: { id: string }) {
  const { palette, design } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const detail = useLeaveRequestDetail(id, employmentId ?? null, signOut);
  const [command, setCommand] = useState<{ value: Command; phase: 'sending' | 'uncertain' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState<{ dates: string[]; reason: string } | null>(null);
  const flight = useRef(false);
  const request = detail.data?.outcome === 'found' ? detail.data.request : null;
  // Online only: an action needs a fresh answer from the server, never a stale copy.
  const online = !!request && !detail.error && !detail.loading;
  const busy = command?.phase === 'sending';

  async function send(value: Command) {
    if (flight.current || !employmentId) return;
    flight.current = true; const owner = authGeneration();
    setCommand({ value, phase: 'sending' }); setNotice(null);
    try {
      const params = { employmentId };
      const result = value.kind === 'withdraw'
        ? await apiPostV2(leaveRequestPath(id, 'withdraw'), LeaveWithdrawResult, value.body, params)
        : await apiPostV2(leaveRequestPath(id, 'cancellation'), LeaveCancellationResult, value.body, params);
      assertAuthGeneration(owner);
      setCommand(null); setPicking(null);
      setNotice(result.outcome === 'refused' ? leaveRefusalText(result)
        : result.outcome === 'withdrawn' ? t('leaveWithdrawnDone') : result.status === 'approved' ? t('leaveCancelApprovedDone') : t('leaveCancelPendingDone'));
      detail.reload();
    } catch (e) {
      if (e instanceof SignInRequiredError) { setCommand(null); void signOut(); }
      // A 4xx was refused before anything was recorded; anything else may or may not have been: keep the reference.
      else if (e instanceof RequestRejectedError) { setCommand(null); setNotice(t('genericError')); detail.reload(); }
      else setCommand({ value, phase: 'uncertain' });
    } finally { flight.current = false; }
  }
  function confirmWithdraw() {
    const requestId = randomUUID();
    Alert.alert(t('withdrawLeaveConfirmTitle'), t('withdrawLeaveConfirm'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('withdrawLeave'), style: 'destructive', onPress: () => void send({ kind: 'withdraw', requestId, body: { requestId } }) },
    ]);
  }
  function confirmCancel() {
    if (!picking || picking.dates.length === 0) return;
    const requestId = randomUUID(), reason = picking.reason.trim();
    const body = { requestId, cancelDates: [...picking.dates].sort(), ...(reason ? { reason } : {}) };
    Alert.alert(t('cancelDatesConfirmTitle', { n: body.cancelDates.length }), t('cancelDatesConfirm', { dates: body.cancelDates.join(', ') }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('cancelLeaveDates'), style: 'destructive', onPress: () => void send({ kind: 'cancel', requestId, body }) },
    ]);
  }
  const toggle = (date: string) => setPicking((p) => p && ({ ...p, dates: p.dates.includes(date) ? p.dates.filter((d) => d !== date) : [...p.dates, date] }));
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 12 : 4;

  return <Screen back onRefresh={detail.reload}>
    <LoadState loading={detail.loading} hasData={detail.data != null} error={detail.error} onRetry={detail.reload} />
    {detail.data?.outcome === 'refused' && <Muted>{t('leaveDetailMissing')}</Muted>}
    {request && <>
      <Title>{t('leaveDetailTitle', { type: request.leaveType, days: fmtDays(request.days) })}</Title>
      <Muted>{span(request.startDate, request.endDate)}{request.fromTime && request.toTime ? ` · ${request.fromTime}–${request.toTime}` : ''}</Muted>
      <LeaveStatusBadge status={request.displayStatus} />
      {notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{notice}</Text>}
      {request.appliedOn && <Row label={t('leaveAppliedOn')} value={request.appliedOn} />}
      {request.reason && <Muted>{request.reason}</Muted>}
      {request.dates.length > 0 && <Card>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t('leaveDatesHeading')}</Text>
        {request.dates.map((d) => <View key={d.date} style={{ gap: 2 }}>
          <Row label={d.date} value={t(DATE_STATUS[d.status])} />{d.reason && <Muted>{d.reason}</Muted>}
        </View>)}
      </Card>}
      {request.approvals.length > 0 && <Card>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t('leaveApprovalsHeading')}</Text>
        {request.approvals.map((a) => <Muted key={a.level}>{approvalLine(a)}</Muted>)}
      </Card>}
      {request.rejection?.reason && <Row label={t('leaveRejectionReason')} value={request.rejection.reason} />}
      {request.cancellation && <Card>
        <Muted>{request.cancellation.automatic ? t('leaveCancelledAuto', { date: fmtInstant(request.cancellation.cancelledAt) })
          : request.cancellation.cancelledByName ? t('leaveCancelledBy', { name: request.cancellation.cancelledByName, date: fmtInstant(request.cancellation.cancelledAt) })
            : t('leaveCancelledOn', { date: fmtInstant(request.cancellation.cancelledAt) })}</Muted>
        {request.cancellation.reason && <Muted>{request.cancellation.reason}</Muted>}
      </Card>}
      {request.pendingCancellation && <Card>
        <Muted>{t('leaveCancellationRequested', { date: fmtInstant(request.pendingCancellation.requestedAt) })}</Muted>
        <Muted>{t('leaveCancellationDates', { dates: request.pendingCancellation.cancelDates.join(', ') })}</Muted>
        {request.pendingCancellation.levels.map((l) => <Muted key={l.level}>{t('leaveCancellationLevel', { n: l.level, state: t(l.status === 'approved' ? 'leaveLevelApproved' : l.status === 'waiting' ? 'leaveLevelWaiting' : 'leaveLevelNotReached') })}</Muted>)}
      </Card>}

      {command?.phase === 'uncertain' && <Card>
        <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('leaveCommandUncertain')}</Text>
        <Button title={t('leaveCommandRetry')} onPress={() => void send(command.value)} />
        <Button title={t('leaveCommandDismiss')} kind="quiet" onPress={() => { setCommand(null); detail.reload(); }} />
      </Card>}
      {!command && (request.actions.withdraw || request.actions.cancelDates) && !online && <Muted>{t('leaveCommandsOnline')}</Muted>}
      {!command && request.actions.withdraw && <Button title={t('withdrawLeave')} disabled={!online || busy} onPress={confirmWithdraw} />}
      {!command && request.actions.cancelDates && !picking && <>
        <Button title={t('cancelLeaveDates')} disabled={!online || busy || request.actions.cancelDates.length === 0} onPress={() => setPicking({ dates: [], reason: '' })} />
        {request.actions.cancelDates.length === 0 && <Muted>{t('cancelDatesNone')}</Muted>}
      </>}
      {!command && request.actions.cancelDates && picking && <Card>
        <Muted>{t('cancelDatesHint')}</Muted>
        {request.actions.cancelDates.map((date) => {
          const checked = picking.dates.includes(date);
          return <Pressable key={date} accessibilityRole="checkbox" accessibilityLabel={date} accessibilityState={{ checked, disabled: busy }} disabled={busy} onPress={() => toggle(date)}
            style={{ minHeight: 48, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <View style={{ width: 24, height: 24, borderWidth: 1, borderColor: checked ? palette.accent : palette.border, borderRadius: 4, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.accent }}>{checked ? '✓' : ''}</Text></View>
            <Text style={{ color: palette.text, flex: 1 }}>{date}</Text>
          </Pressable>;
        })}
        <Text style={{ color: palette.muted, fontSize: 14 }}>{t('cancelReasonOptional')}</Text>
        <TextInput accessibilityLabel={t('cancelReasonOptional')} value={picking.reason} onChangeText={(reason) => setPicking((p) => p && { ...p, reason })} multiline maxLength={2000}
          placeholderTextColor={palette.muted} style={{ color: palette.text, minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: radius, padding: 12, fontSize: 16, textAlignVertical: 'top' }} />
        <Button title={t('cancelDatesReview')} disabled={!online || busy || picking.dates.length === 0} onPress={confirmCancel} />
        <Button title={t('cancel')} kind="quiet" onPress={() => setPicking(null)} />
      </Card>}
      {busy && <Muted>{t('leaveCommandSending')}</Muted>}
    </>}
  </Screen>;
}
