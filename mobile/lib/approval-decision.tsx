/**
 * M08 — the approver's tasks (every pending kind, paged) and one task's decision screen.
 *
 * The app decides nothing. Which tasks exist, which the app may decide (D2), the facts shown, the step/stage the
 * decision must echo, whether a rejection needs a reason, and the outcome all come from the server
 * (lib/mobile-api/v2/tasks.ts; composed in core/mobile-approvals.ts from the web inbox's owners). Kinds the app does
 * not decide carry an "Open on web" chip. No bulk (D3). A decision runs only online, only after an explicit
 * confirmation that repeats what is being decided, and carries a client requestId the server's receipt replays:
 * when the answer is lost, "Try again" resends the SAME reference, so it is never applied twice. A refusal reloads
 * the task and says why (a moved step/stage is `stale_step`). Nothing is queued or persisted.
 *
 * Expense claims left the app (mobile declutter round): a claim approval is still LISTED, with its server summary
 * line, but behaves like every other web-only kind — an "Open on web" chip, no native detail and no receipt download.
 * The server still marks claims `nativeDecision` (older installed apps decide them natively); this build decides
 * natively only the kinds in NATIVE below.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { DesignText as Text, useTenantDesign } from './design';
import { apiGetV2, apiPostV2, v2Page } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { config, identityNamespace } from './config';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { appLocale, t, type MessageKey } from './i18n';
import { PagedList, usePagedResource } from './paged-list';
import { useSession } from './session';
import { Button, Card, HeaderBack, LoadState, Muted, Screen, Title, fmtDays, fmtMoney } from './ui';
import {
  TaskDecisionResult, TaskDetailResult, TaskItemV2,
  type TaskDecisionRefusal, type TaskDecisionRefusalCode, type TaskDetailV2, type TaskKind,
} from '../../lib/mobile-api/v2/tasks';

export const TASKS = v2Page('v2/tasks', TaskItemV2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE = ['leave', 'leaveCancellation', 'attendance'] as const;
/** Decided in this app: the server says it may be, AND this build has the screen for it (claims no longer do). */
export const decidesNatively = (item: Pick<TaskItemV2, 'kind' | 'nativeDecision'>) => item.nativeDecision && (NATIVE as readonly string[]).includes(item.kind);
/** Where a web-only row opens: the server's path, or — for a kind the server still marks native (a claim) and so sends
 * no path for — the web approvals inbox, which lists it. */
const webPathOf = (item: TaskItemV2) => item.webPath ?? (item.nativeDecision ? '/approvals' : null);
/** The only path the app builds: a natively decided kind and a validated UUID. */
export function taskPath(kind: string, id: string, action?: 'decision' | 'document'): `v2/${string}` {
  if (!(NATIVE as readonly string[]).includes(kind) || !UUID.test(id)) throw new Error('Invalid task reference');
  return `v2/tasks/${kind}/${id.toLowerCase()}${action ? `/${action}` : ''}`;
}
/** A server-given relative web path, opened on the connected company's own origin only. */
export function webUrl(path: string): string | null {
  return config.apiUrl && /^\/(?!\/)[^\s\\]*$/.test(path) ? config.apiUrl + path : null;
}

const KIND_LABEL: Record<TaskKind, MessageKey> = {
  leave: 'task_leave', leaveCancellation: 'task_leaveCancellation', replacementLeave: 'task_replacementLeave', attendance: 'task_attendance',
  profile: 'task_profile', claim: 'task_claim', resignation: 'task_resignation', managerReview: 'task_managerReview', hrReview: 'task_hrReview',
  noticeAcknowledgement: 'task_noticeAcknowledgement', performanceReview: 'task_performanceReview', assessmentWork: 'task_assessmentWork',
  careerPlan: 'task_careerPlan', calibration: 'task_calibration', rewardReview: 'task_rewardReview',
};
const REFUSAL: Record<TaskDecisionRefusalCode, MessageKey> = {
  not_assigned: 'approvalRefusalNotAssigned', self_approval: 'approvalRefusalSelf', already_decided: 'approvalRefusalDecided',
  reason_required: 'approvalRefusalReason', stale_step: 'approvalRefusalStale', request_conflict: 'approvalRefusalConflict',
  employment_required: 'approvalRefusalEmployment', decision_refused: 'approvalRefusalOther',
};
/** The app's own sentence for a refusal; the server's English sentence only for the catch-all, in English. */
export function approvalRefusalText(r: TaskDecisionRefusal): string {
  return r.code === 'decision_refused' && r.message && appLocale() === 'en' ? r.message : t(REFUSAL[r.code]);
}
const DAY_TYPE: Record<'workday' | 'rest_day' | 'holiday', MessageKey> = { workday: 'approvalWorkday', rest_day: 'approvalRestDay', holiday: 'approvalHoliday' };
/** The web approver's duration label for a half day (lib/leave-duration.ts durationLabel), in the app's own words. */
const HALF_DAY: Record<'half_day_am' | 'half_day_pm', MessageKey> = { half_day_am: 'halfAM', half_day_pm: 'halfPM' };
const span = (from: string, to: string) => (from === to ? from : t('leaveDateSpan', { from, to }));
const hours = (minutes: number) => String(Math.round((minutes / 60) * 100) / 100);
const keyOf = (item: TaskItemV2) => `${item.kind}:${item.id}`;

function openOnWeb(path: string | null) {
  const url = path ? webUrl(path) : null;
  if (url) void Linking.openURL(url).catch(() => {});
}

/**
 * The row's one-line summary: what the web approvals page prints on this row for this caller (the server sends only
 * that — TaskItemV2.summary). Null when the server sent none.
 */
export function taskSummaryLine(item: TaskItemV2): string | null {
  const s = item.summary;
  if (!s) return null;
  const parts = [
    s.label,
    s.from && s.to ? span(s.from, s.to) : s.from,
    s.days != null ? fmtDays(s.days) : null,
    s.amount != null ? (s.currency ? `${s.currency} ${fmtMoney(s.amount)}` : fmtMoney(s.amount)) : null,
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(' · ') : null;
}

export function TaskRow({ item }: { item: TaskItemV2 }) {
  const { palette } = useTenantDesign();
  const summary = taskSummaryLine(item);
  const label = [t(KIND_LABEL[item.kind]), item.subject.name, summary].filter(Boolean).join(' · ');
  const body = <><Text style={{ color: palette.text, fontSize: 17, fontWeight: '600' }}>{t(KIND_LABEL[item.kind])}</Text>{item.subject.name ? <Muted>{item.subject.name}</Muted> : null}{summary ? <Muted>{summary}</Muted> : null}</>;
  if (decidesNatively(item)) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => router.push({ pathname: '/approvals/[kind]/[id]', params: { kind: item.kind, id: item.id } })}
      style={{ paddingVertical: 14, borderBottomWidth: 1, borderColor: palette.border, gap: 6 }}>{body}</Pressable>;
  }
  return <View style={{ paddingVertical: 14, borderBottomWidth: 1, borderColor: palette.border, gap: 6 }}>
    {body}
    <Pressable accessibilityRole="link" accessibilityLabel={`${t('openOnWeb')}: ${label}`} onPress={() => openOnWeb(webPathOf(item))}
      style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: palette.border, borderRadius: 999 }}>
      <Text style={{ color: palette.accent }}>{t('openOnWeb')}</Text>
    </Pressable>
  </View>;
}

/** Every pending task, the web inbox's order. Offline: the rows already shown stay, labelled stale. */
export function ApprovalsScreen() {
  const { palette } = useTenantDesign();
  const { signOut } = useSession();
  const list = usePagedResource(TASKS, {}, keyOf, signOut);
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }} edges={['top']}>
    <PagedList list={list} keyOf={keyOf} emptyText={t('approvalsEmpty')} contentContainerStyle={{ padding: 20, gap: 8 }}
      header={<View style={{ gap: 12 }}>
        <HeaderBack />
        <Title>{t('approvalsTitle')}</Title>
      </View>}
      renderItem={(item) => <TaskRow item={item} />} />
  </SafeAreaView>;
}

type Detail = { data: TaskDetailResult | null; error: Error | null; loading: boolean; reload: () => void };
/** One task, scoped like useApi: a change of identity, connection or locale hides the old answer. */
export function useTaskDetail(kind: string, id: string, onSignInRequired: () => void): Detail {
  const owner = authGeneration(), namespace = identityNamespace(), origin = config.apiUrl, locale = appLocale();
  const key = JSON.stringify([owner, namespace, origin, locale, kind, id]);
  const [state, setState] = useState<{ key: string; data: TaskDetailResult | null; error: Error | null; loading: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setState((prior) => ({ key, data: prior?.key === key ? prior.data : null, error: null, loading: true }));
    let path: `v2/${string}`;
    try { path = taskPath(kind, id); } catch (e) { setState({ key, data: null, error: e as Error, loading: false }); return; }
    apiGetV2(path, TaskDetailResult, {}, controller.signal).then(
      (data) => { if (live && authGeneration() === owner) setState({ key, data, error: null, loading: false }); },
      (error: Error) => {
        if (!live || authGeneration() !== owner) return;
        if (error instanceof SignInRequiredError) onSignInRequired();
        setState((prior) => ({ key, data: error instanceof RequestRejectedError || error instanceof SignInRequiredError ? null : prior?.key === key ? prior.data : null, error, loading: false }));
      });
    return () => { live = false; controller.abort(); };
  }, [key, tick, onSignInRequired]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return state?.key === key ? { ...state, reload } : { data: null, error: null, loading: true, reload };
}

type Body = { requestId: string; decision: 'approve' | 'reject'; reason?: string; dates?: string[]; expected: TaskDetailV2['expected'] };
type Sent = { body: Body; phase: 'sending' | 'uncertain' };

/** What the task asks, in one line: type · dates · days, or the attendance application's own facts. */
export function taskLine(task: TaskDetailV2): string {
  // Never loaded here (taskPath refuses a claim); kept so the server's union stays exhaustively handled.
  if (task.kind === 'claim') return t('task_claim');
  // fmtDays already carries its unit ("5 days"); the summary templates add none (a "{days} days" template doubled it).
  if (task.kind === 'leave') return t('approvalLeaveSummary', { type: task.leaveType, dates: span(task.startDate, task.endDate), days: fmtDays(task.days) })
    + (task.durationType === 'half_day_am' || task.durationType === 'half_day_pm' ? ` · ${t(HALF_DAY[task.durationType])}` : '')
    + (task.fromTime && task.toTime ? ` · ${task.fromTime}–${task.toTime}` : '');
  if (task.kind === 'leaveCancellation') return t('approvalCancellationSummary', { type: task.leaveType, dates: task.cancelDates.join(', '), days: fmtDays(task.requestedDays) });
  if (task.application === 'overtime') return t('approvalOvertimeLine', { date: task.date, hours: task.requestedOtMinutes == null ? '—' : hours(task.requestedOtMinutes) })
    + (task.plannedStart && task.plannedEnd ? ` · ${task.plannedStart}–${task.plannedEnd}` : '') + (task.dayType ? ` · ${t(DAY_TYPE[task.dayType])}` : '');
  return t('approvalCorrectionLine', { date: task.date }) + (task.proposedCheckIn || task.proposedCheckOut ? ` · ${task.proposedCheckIn ?? '—'}–${task.proposedCheckOut ?? '—'}` : '');
}
const titleOf = (task: TaskDetailV2) => [task.subject.name ?? '—', task.subject.code].filter(Boolean).join(' · ');

/** One task: who and what, team cover when present, per-date choice for leave, the reason, then Reject / Approve. */
export function ApprovalDetailScreen({ kind, id }: { kind: string; id: string }) {
  const { palette, design } = useTenantDesign();
  const { signOut } = useSession();
  const detail = useTaskDetail(kind, id, signOut);
  const [sent, setSent] = useState<Sent | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<'approved' | 'rejected' | 'pending_next_step' | null>(null);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState<string[] | null>(null);
  const flight = useRef(false);
  const task = detail.data?.outcome === 'found' ? detail.data.task : null;
  // Online only: a decision needs a fresh answer from the server, never a stale copy.
  const online = !!task && !detail.error && !detail.loading;
  const busy = sent?.phase === 'sending';
  const pendingDates = task?.kind === 'leave' ? task.dates.filter((d) => d.status === 'pending').map((d) => d.date) : [];
  const perDate = pendingDates.length > 0;
  const dayOf = new Map(task?.kind === 'leave' ? task.dates.map((d) => [d.date, d.days] as const) : []);
  const approving = checked ?? pendingDates;
  const partial = perDate && approving.length < pendingDates.length;
  const trimmed = reason.trim();
  const needsReasonToReject = !!task?.reasonRequiredToReject;

  async function send(body: Body) {
    if (flight.current) return;
    flight.current = true; const owner = authGeneration();
    setSent({ body, phase: 'sending' }); setNotice(null);
    try {
      const result = await apiPostV2(taskPath(kind, id, 'decision'), TaskDecisionResult, body);
      assertAuthGeneration(owner);
      setSent(null);
      if (result.outcome === 'accepted') { setDone(result.status); return; }
      setNotice(approvalRefusalText(result)); setChecked(null); detail.reload();
    } catch (e) {
      if (e instanceof SignInRequiredError) { setSent(null); void signOut(); }
      // A 4xx was refused before anything was recorded; anything else may or may not have been: keep the reference.
      else if (e instanceof RequestRejectedError) { setSent(null); setNotice(t('genericError')); detail.reload(); }
      else setSent({ body, phase: 'uncertain' });
    } finally { flight.current = false; }
  }
  function confirm(decision: 'approve' | 'reject') {
    if (!task) return;
    const name = task.subject.name ?? '—', what = taskLine(task);
    const body: Body = { requestId: randomUUID(), decision, expected: task.expected };
    let message: string;
    if (decision === 'reject') { body.reason = trimmed; message = t('approvalConfirmReject', { name, what, reason: trimmed || '—' }); }
    else if (perDate) {
      body.dates = [...approving].sort();
      if (partial) { body.reason = trimmed; message = t('approvalConfirmPartial', { name, approve: body.dates.join(', '), reject: pendingDates.filter((d) => !approving.includes(d)).join(', '), reason: trimmed }); }
      else message = t('approvalConfirmApprove', { name, what });
    } else message = t('approvalConfirmApprove', { name, what });
    Alert.alert(t('approvalConfirmTitle'), message, [
      { text: t('cancel'), style: 'cancel' },
      { text: decision === 'approve' ? t('approvalApprove') : t('approvalReject'), style: decision === 'reject' ? 'destructive' : 'default', onPress: () => void send(body) },
    ]);
  }
  const toggle = (date: string) => setChecked((prior) => { const now = prior ?? pendingDates; return now.includes(date) ? now.filter((d) => d !== date) : [...now, date]; });
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 12 : 4;
  const heading = (text: string) => <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{text}</Text>;

  if (done) return <Screen>
    <Text accessibilityRole="alert" style={{ color: palette.text, fontSize: 18, lineHeight: 26 }}>{t(done === 'approved' ? 'approvalDoneApproved' : done === 'rejected' ? 'approvalDoneRejected' : 'approvalDoneNext')}</Text>
    <Button title={t('approvalsBack')} onPress={() => router.back()} />
  </Screen>;

  return <Screen back onRefresh={detail.reload}>
    <LoadState loading={detail.loading} hasData={detail.data != null} error={detail.error} onRetry={detail.reload} />
    {notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{notice}</Text>}
    {detail.data?.outcome === 'refused' && <Muted>{approvalRefusalText(detail.data)}</Muted>}
    {task && <>
      <Title>{titleOf(task)}</Title>
      <Text style={{ color: palette.text, fontSize: 17, lineHeight: 24 }}>{taskLine(task)}</Text>
      {task.employeeReason && <Muted>{t('approvalEmployeeNote', { note: task.employeeReason })}</Muted>}
      {((task.kind === 'leave' && task.hasDocument) || (task.kind === 'attendance' && task.hasAttachment)) && <Muted>{t('approvalDocumentOnWeb')}</Muted>}
      {task.kind === 'attendance' && task.original && <Card>
        {heading(t('approvalOriginalHeading'))}
        <Muted>{task.original.state === 'not_captured' ? t('approvalOriginalNotCaptured') : task.original.state === 'no_record' ? t('approvalOriginalNoRecord')
          : t('approvalOriginalTimes', { checkIn: task.original.checkIn ?? '—', checkOut: task.original.checkOut ?? '—' })}</Muted>
      </Card>}
      {task.kind === 'attendance' && task.proposedPunches && <Card>
        {heading(t('approvalProposedHeading'))}
        {task.proposedPunches.length === 0 ? <Muted>{t('approvalProposedNone')}</Muted>
          : task.proposedPunches.map((p, i) => <Muted key={`${i}:${p.at}:${p.direction}`}>{t('approvalPunchLine', { at: p.at, direction: t(p.direction === 'in' ? 'approvalPunchIn' : 'approvalPunchOut') })}</Muted>)}
      </Card>}
      {task.kind === 'leave' && task.teamCover && task.teamCover.length > 0 && <Card>
        {heading(t('approvalTeamCover'))}
        {task.teamCover.map((m) => <Muted key={m.name + m.dates.map((d) => d.date).join()}>{t('approvalTeamCoverLine', { name: m.name, dates: m.dates.map((d) => d.status === 'pending' ? t('approvalTeamPendingDate', { date: d.date }) : d.date).join(', ') })}</Muted>)}
      </Card>}
      {perDate && <Card>
        {heading(t('approvalDatesHeading'))}
        {pendingDates.map((date) => {
          const on = approving.includes(date);
          return <Pressable key={date} accessibilityRole="checkbox" accessibilityLabel={date} accessibilityState={{ checked: on, disabled: busy || !!sent }} disabled={busy || !!sent} onPress={() => toggle(date)}
            style={{ minHeight: 48, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <View style={{ width: 24, height: 24, borderWidth: 1, borderColor: on ? palette.accent : palette.border, borderRadius: 4, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.accent }}>{on ? '✓' : ''}</Text></View>
            <Text style={{ color: palette.text, flex: 1 }}>{dayOf.has(date) ? t('approvalDateDays', { date, days: fmtDays(dayOf.get(date)!) }) : date}</Text>
          </Pressable>;
        })}
      </Card>}
      {(needsReasonToReject || partial) && <>
        <Text style={{ color: palette.muted, fontSize: 14 }}>{t('approvalReason')}</Text>
        <TextInput accessibilityLabel={t('approvalReason')} value={reason} onChangeText={setReason} multiline maxLength={1000} editable={!sent}
          placeholderTextColor={palette.muted} style={{ color: palette.text, minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: radius, padding: 12, fontSize: 16, textAlignVertical: 'top' }} />
      </>}

      {sent?.phase === 'uncertain' && <Card>
        <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('approvalUncertain')}</Text>
        <Button title={t('approvalRetry')} onPress={() => void send(sent.body)} />
        <Button title={t('approvalRecheck')} kind="quiet" onPress={() => { setSent(null); detail.reload(); }} />
      </Card>}
      {!sent && !online && <Muted>{t('approvalOnline')}</Muted>}
      {!sent && <>
        <Button title={t('approvalReject')} kind="quiet" disabled={!online || (needsReasonToReject && !trimmed)} onPress={() => confirm('reject')} />
        <Button title={t('approvalApprove')} disabled={!online || (perDate && approving.length === 0) || (partial && !trimmed)} onPress={() => confirm('approve')} />
        <Muted>{t('approvalConfirmHint')}</Muted>
      </>}
      {busy && <Muted>{t('approvalSending')}</Muted>}
    </>}
  </Screen>;
}

