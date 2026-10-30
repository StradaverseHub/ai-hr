/**
 * M12 (D13) — the employee's own attendance applications (every one filed, paged, filtered by status) and one
 * application's detail, with the one command the web offers on it: Withdraw (a pending, non-overtime application).
 *
 * The app decides nothing. The status words, what was asked, the routing recorded with the application (the
 * snapshot taken at submission — a later template change does not rewrite it), the decision and whether it may be
 * withdrawn all come from the server (lib/mobile-api/v2/attendance.ts). Withdraw runs only online, only after an
 * explicit confirmation, and carries a client requestId the server's command receipt replays: when the answer is
 * lost, "Try again" resends the SAME reference. Nothing is queued or persisted (D10).
 */
import { useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { DesignText as Text, useTenantDesign } from './design';
import { apiPostV2, useApiV2, v2Page } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { appLocale, t, type MessageKey } from './i18n';
import { PagedList, usePagedResource } from './paged-list';
import { useSession } from './session';
import { Button, Card, HeaderBack, LoadState, Muted, Row, Screen, Title } from './ui';
import { APPLICATION_STATUS, applicationKindText, askedText, attendanceApplicationPath, fmtCalendarDate, fmtInstant } from './attendance-format';
import { ApplicationRow, TimeZoneNote } from './attendance-records';
import {
  AttendanceApplicationResult, AttendanceApplicationsPageV2, AttendanceApplicationSummaryV2, AttendanceWithdrawResult,
  type AttendanceApplicationLevelV2, type AttendanceCommandRefusal, type AttendanceCommandRefusalCode,
} from '../../lib/mobile-api/v2/attendance';

export const ATTENDANCE_APPLICATIONS = v2Page('v2/attendance/applications', AttendanceApplicationSummaryV2);

const REFUSAL: Record<AttendanceCommandRefusalCode, MessageKey> = {
  not_found: 'attNotFound', module_off: 'attModuleOff', request_conflict: 'attRefusalConflict', future: 'attRefusalFuture',
  pending_exists: 'attRefusalPending', payroll_closed: 'attRefusalPayrollClosed', workflow_unavailable: 'attRefusalWorkflow',
  invalid: 'attRefusalInvalid', not_withdrawable: 'attRefusalNotWithdrawable',
};
/** The app's own sentence for a refusal code; the kernel's English sentence beside the catch-all, in English only. */
export function attendanceRefusalText(r: AttendanceCommandRefusal): string {
  return r.code === 'invalid' && r.message && appLocale() === 'en' ? `${t(REFUSAL.invalid)} ${r.message}` : t(REFUSAL[r.code]);
}

const FILTERS = [undefined, 'pending', 'approved', 'rejected', 'cancelled'] as const;
const FILTER_LABEL: Record<string, MessageKey> = { all: 'attFilterAll', pending: 'attDisplayPending', approved: 'attDisplayApproved', rejected: 'attDisplayRejected', cancelled: 'attFilterCancelled' };
const keyOf = (item: AttendanceApplicationSummaryV2) => item.id;

/** Every application on the selected employment, in the kernel's order. Offline: the rows already shown stay, labelled stale. */
export function AttendanceApplicationsScreen() {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>(undefined);
  const list = usePagedResource(ATTENDANCE_APPLICATIONS, { employmentId: employmentId ?? undefined, status }, keyOf, signOut);
  // The chips' counts: the first page's own counts, read once per employment (one row, no filter).
  const counts = useApiV2('v2/attendance/applications', AttendanceApplicationsPageV2, { employmentId: employmentId ?? undefined, limit: '1' }, signOut).data?.counts;
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }} edges={['top']}>
    <PagedList list={list} keyOf={keyOf} emptyText={t('attNoApplications')} contentContainerStyle={{ padding: 20, gap: 8 }}
      header={<View style={{ gap: 12 }}>
        <HeaderBack />
        <Title>{t('attApplicationsTitle')}</Title>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {FILTERS.map((f) => {
            const n = f && counts ? counts[f] : null;
            return <Button key={f ?? 'all'} title={n == null ? t(FILTER_LABEL[f ?? 'all']) : t('attFilterCount', { label: t(FILTER_LABEL[f!]), n })}
              kind={f === status ? 'primary' : 'quiet'} onPress={() => setStatus(f)} />;
          })}
        </View>
        <Muted>{t('attOvertimeOnWeb')}</Muted>
      </View>}
      renderItem={(item) => <ApplicationRow item={item} onPress={() => router.push({ pathname: '/attendance/request/[id]', params: { id: item.id } })} />} />
  </SafeAreaView>;
}

function levelLine(l: AttendanceApplicationLevelV2, zone: string): string {
  const name = l.name || t('attLevel', { n: l.level });
  const who = l.approvers.map((a) => (a.kind === 'hr' ? t('attHr') : a.name)).join(' / ');
  const actor = l.decision ? `${l.decision.actorName}${l.decision.actingMode === 'delegate' ? t('attActingDelegate') : l.decision.actingMode === 'administrator' ? t('attActingAdmin') : ''}` : '';
  const date = l.decision ? fmtInstant(l.decision.decidedAt, zone) : '';
  switch (l.status) {
    case 'approved': return t('attLevelApproved', { n: l.level, name, actor, date });
    case 'rejected': return t('attLevelRejected', { n: l.level, name, actor, date });
    case 'waiting': return t('attLevelWaiting', { n: l.level, name, who });
    case 'not_reached': return t('attLevelNotReached', { n: l.level, name });
    default: return t('attLevelNotRequired', { n: l.level, name });
  }
}

type Command = { requestId: string; body: { requestId: string } };

/** One application: what was asked, the clock pair on record then, the recorded route and decision, and Withdraw when offered. */
export function AttendanceApplicationScreen({ id }: { id: string }) {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  let path: `v2/${string}` | null = null;
  try { path = attendanceApplicationPath(id); } catch { path = null; }
  const detail = useApiV2(path ?? 'v2/attendance/applications/invalid', AttendanceApplicationResult, { employmentId: employmentId ?? undefined }, signOut);
  const [command, setCommand] = useState<{ value: Command; phase: 'sending' | 'uncertain' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const flight = useRef(false);
  const found = path && detail.data?.outcome === 'found' ? detail.data : null;
  const a = found?.application ?? null;
  // Online only: a command needs a fresh answer from the server, never a stale copy.
  const online = !!a && !detail.error && !detail.loading;
  const busy = command?.phase === 'sending';

  async function send(value: Command) {
    if (flight.current || !employmentId || !a) return;
    flight.current = true; const owner = authGeneration();
    setCommand({ value, phase: 'sending' }); setNotice(null);
    try {
      const result = await apiPostV2(attendanceApplicationPath(a.id, 'withdraw'), AttendanceWithdrawResult, value.body, { employmentId });
      assertAuthGeneration(owner);
      setCommand(null);
      setNotice(result.outcome === 'refused' ? attendanceRefusalText(result) : t('attWithdrawn'));
      detail.reload();
    } catch (e) {
      if (e instanceof SignInRequiredError) { setCommand(null); void signOut(); }
      // A 4xx was refused before anything was recorded; anything else may or may not have been: keep the reference.
      else if (e instanceof RequestRejectedError) { setCommand(null); setNotice(t('genericError')); detail.reload(); }
      else setCommand({ value, phase: 'uncertain' });
    } finally { flight.current = false; }
  }
  function confirmWithdraw() {
    if (!a) return;
    const requestId = randomUUID();
    Alert.alert(t('attWithdrawConfirmTitle'), t('attWithdrawConfirm', { date: fmtCalendarDate(a.date) }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('attWithdraw'), style: 'destructive', onPress: () => void send({ requestId, body: { requestId } }) },
    ]);
  }

  return <Screen back onRefresh={detail.reload}>
    <LoadState loading={!!path && detail.loading} hasData={detail.data != null} error={path ? detail.error : null} onRetry={detail.reload} />
    {(!path || detail.data?.outcome === 'refused') && <Muted>{t(detail.data?.outcome === 'refused' && detail.data.code === 'module_off' ? 'attModuleOff' : 'attNotFound')}</Muted>}
    {found && a && <>
      <Title>{fmtCalendarDate(a.date)} · {applicationKindText(a)}</Title>
      <Text style={{ color: palette.accent, fontWeight: '600' }}>{t(APPLICATION_STATUS[a.displayStatus])}</Text>
      <TimeZoneNote zone={found.timeZone} />
      {notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{notice}</Text>}
      <Card>
        <Row label={t('attAsked')} value={askedText(a)} />
        {a.asked.plannedStart && a.asked.plannedEnd && <Row label={t('attPlanned')} value={`${a.asked.plannedStart}–${a.asked.plannedEnd}`} />}
        <Row label={t('attSubmitted')} value={fmtCalendarDate(a.submittedOn)} />
        {a.original && <Muted>{t('attOriginal', { in: a.original.checkIn ?? '—', out: a.original.checkOut ?? '—' })}</Muted>}
        {a.reason && <Row label={t('attReason')} value={a.reason} />}
        {a.remark && <Row label={t('attRemark')} value={a.remark} />}
        {a.hasAttachment && <Muted>{t('attAttachmentWeb')}</Muted>}
      </Card>
      {a.rejectReason && <Row label={t('attRejectReason')} value={a.rejectReason} />}
      {a.decidedAt && <Muted>{t('attDecidedOn', { date: fmtInstant(a.decidedAt, found.timeZone) })}</Muted>}
      <Card>
        {a.routing ? <>
          <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t('attRoute', { name: a.routing.templateName, n: a.routing.templateVersion })}</Text>
          {a.routing.levels.map((l) => <View key={l.level} style={{ gap: 2 }}>
            <Muted>{levelLine(l, found.timeZone)}</Muted>
            {l.decision?.remarks ? <Muted>{t('attRemarks', { text: l.decision.remarks })}</Muted> : null}
          </View>)}
        </> : <Muted>{t('attNoRoute')}</Muted>}
      </Card>

      {command?.phase === 'uncertain' && <Card>
        <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('leaveCommandUncertain')}</Text>
        <Button title={t('leaveCommandRetry')} onPress={() => void send(command.value)} />
        <Button title={t('leaveCommandDismiss')} kind="quiet" onPress={() => { setCommand(null); detail.reload(); }} />
      </Card>}
      {!command && a.actions.withdraw && !online && <Muted>{t('attCommandsOnline')}</Muted>}
      {!command && a.actions.withdraw && <Button title={t('attWithdraw')} disabled={!online || busy} onPress={confirmWithdraw} />}
      {!a.actions.withdraw && a.application === 'overtime' && a.status === 'pending' && <Muted>{t('attOvertimeOnWeb')}</Muted>}
      {busy && <Muted>{t('leaveCommandSending')}</Muted>}
    </>}
  </Screen>;
}
