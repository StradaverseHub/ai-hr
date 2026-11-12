/**
 * Native Today (owner decisions, 12 November 2026): the Home tab's own sections, read from GET /api/mobile/v2/today
 * (lib/mobile-api/v2/today.ts), which answers with the web Employee Today's own facts for the person's own employment.
 *
 * THE APP DECIDES NOTHING. A reminder is a loop's proposal ("Prepared by AI Centre · you decide"):
 *   • a missed clock-out is sent only on the person's explicit Confirm, with the reason they picked or typed; the server
 *     re-reads the case and sends an ordinary attendance correction for the usual approval;
 *   • a clock-out the loop already set may be undone by the person while its window is open;
 *   • record and passport reminders only open the person's own profile, where HR decides the change request.
 * Every other row opens a fixed app screen, which reads afresh; a step with no native screen says so.
 *
 * EACH SECTION FAILS ON ITS OWN. `unavailable` reads "could not be checked" with a retry, never "nothing to do"; a
 * module that is off draws nothing. Dates are the server's HR dates, formatted only. No figure is computed here.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { DesignText as Text, useTenantDesign } from './design';
import { apiPostV2, useApiV2, type Loadable } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { InAppAlert as Alert } from './in-app-alert';
import { fmtCalendarDate, fmtMinutes } from './attendance-format';
import { Icon } from './icon';
import { intlLocale, t } from './i18n';
import { useSession } from './session';
import { Button, Chip, Muted } from './ui';
import { tt, type TodayKey } from './today-copy';
import {
  CLOCK_OUT_OTHER_MAX_V2, ClockOutConfirmResultV2, LoopUndoResultV2, TodayV2,
  type ClockOutConfirmCommandV2, type ClockOutReasonV2, type TodayComingUp, type TodayDestination, type TodayReminder,
  type TodayStep, type TodayWeekHours,
} from '../../lib/mobile-api/v2/today';

export type TodayRead = Loadable<TodayV2>;
type Section<K extends keyof TodayV2> = TodayV2[K];

// ── Pure rules (pinned by test/mobile-today.dom.test.tsx) ───────────────────────────────────────────────────────────

/** The fixed app screen a Today destination opens. */
export function todayHref(d: TodayDestination): Href {
  switch (d.screen) {
    case 'attendanceDay': return { pathname: '/attendance/[date]', params: { date: d.date } } as Href;
    case 'attendanceCorrection': return { pathname: '/attendance/correction', params: { date: d.date } } as Href;
    case 'profile': return '/profile' as Href;
    case 'profileEdit': return '/profile/edit' as Href;
    case 'leave': return '/leave' as Href;
    case 'leaveHistory': return '/leave/history' as Href;
    case 'approvals': return '/approvals' as Href;
    case 'pay': return '/pay' as Href;
  }
}

/** The Confirm the person built, or null when it is not ready (no reason, or an empty or overlong "Other"). */
export function clockOutCommand(caseId: string, reason: ClockOutReasonV2 | null, other: string): ClockOutConfirmCommandV2 | null {
  if (reason === 'forgot' || reason === 'device') return { caseId, reason, confirm: true };
  if (reason !== 'other') return null;
  const typed = other.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return typed.length > 0 && typed.length <= CLOCK_OUT_OTHER_MAX_V2 ? { caseId, reason, other: typed, confirm: true } : null;
}

const CLOCK_OUT_REFUSAL: Record<string, TodayKey> = { changed: 'refusedChanged', retired: 'refusedRetired', expired: 'refusedExpired', access: 'refusedAccess' };
export const clockOutRefusalText = (code: string) => tt(CLOCK_OUT_REFUSAL[code] ?? 'refusedOther');
const UNDO_REFUSAL: Record<string, TodayKey> = { ask_hr: 'undoRefusedAskHr', human_review_required: 'undoRefusedAskHr', expired: 'undoRefusedExpired' };
export const undoRefusalText = (code: string) => tt(UNDO_REFUSAL[code] ?? 'undoRefusedOther');

/** "Today", "Tomorrow" or "In n days" for a server-counted distance. */
export const daysAwayText = (n: number) => (n <= 0 ? tt('dayToday') : n === 1 ? tt('dayTomorrow') : tt('daysAway', { n }));

/** A date range as the app words dates, one date when it is a single day. */
export function dateRange(from: string, to: string): string {
  return from === to ? fmtCalendarDate(from, false) : `${fmtCalendarDate(from, false)} – ${fmtCalendarDate(to, false)}`;
}

/** An instant as a local date and time for "undo by …", in the HR zone the server works in. */
export function untilText(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try { return new Intl.DateTimeFormat(intlLocale(), { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)); }
  catch { return iso.slice(0, 16).replace('T', ' '); }
}

export const reminderKey = (r: TodayReminder) => (r.kind === 'autoFixed' ? `autoFixed:${r.actionId}` : `${r.kind}:${r.caseId}`);

// ── The read ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Today for the selected employment: read on mount, again on returning to Home, and on pull-to-refresh. */
export function useToday(refreshToken = 0): TodayRead {
  const { employmentId, signOut } = useSession();
  const today = useApiV2('v2/today', TodayV2, { employmentId: employmentId ?? undefined }, signOut);
  const visited = useRef(false);
  useFocusEffect(useCallback(() => { if (visited.current) today.reload(); visited.current = true; }, [today.reload]));
  useEffect(() => { if (refreshToken) today.reload(); }, [refreshToken, today.reload]);
  return today;
}

// ── Shared pieces ───────────────────────────────────────────────────────────────────────────────────────────────────

function Ruled({ children, gap = 6 }: { children: ReactNode; gap?: number }) {
  const { palette } = useTenantDesign();
  return <View style={{ borderTopWidth: 1, borderColor: palette.border, paddingVertical: 14, gap }}>{children}</View>;
}

/** "Could not be checked", with a retry that reads Today again. Never "all clear". */
function SectionUnavailable({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { palette } = useTenantDesign();
  return <Ruled>
    <Text accessibilityRole="alert" style={{ color: palette.text, fontSize: 15 }}>{text}</Text>
    <View style={{ alignSelf: 'flex-start' }}><Button title={tt('sectionRetry')} kind="quiet" onPress={onRetry} /></View>
  </Ruled>;
}

function Status({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'text' }) {
  const { palette } = useTenantDesign();
  return <Text accessibilityLiveRegion="polite" style={{ color: tone === 'text' ? palette.text : palette.muted, fontSize: 14, lineHeight: 20 }}>{text}</Text>;
}

// ── Reminders ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function TodayReminders({ section, onReload }: { section: Section<'reminders'>; onReload: () => void }) {
  const { palette } = useTenantDesign();
  if (section.status === 'unavailable') return <SectionUnavailable text={tt('remindersUnavailable')} onRetry={onReload} />;
  if (section.items.length === 0) return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
    <Icon name="check" color={palette.muted} size={16} /><Muted>{tt('remindersEmpty')}</Muted>
  </View>;
  return <View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 8 }}>
      <Icon name="sparkle" color={palette.accent} size={14} />
      <Text style={{ color: palette.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.4 }}>{tt('preparedBy')}</Text>
    </View>
    {section.items.map((r) => <ReminderCard key={reminderKey(r)} reminder={r} onReload={onReload} />)}
  </View>;
}

function ReminderCard({ reminder, onReload }: { reminder: TodayReminder; onReload: () => void }) {
  const router = useRouter();
  const { palette } = useTenantDesign();
  switch (reminder.kind) {
    case 'clockOut': return <ClockOutCard reminder={reminder} onReload={onReload} />;
    case 'autoFixed': return <AutoFixedCard reminder={reminder} onReload={onReload} />;
    case 'record': return <Ruled gap={8}>
      <Text style={{ color: palette.text, fontSize: 17, fontWeight: '700' }}>{tt('recordTitle')}</Text>
      {reminder.gaps.map((gap) => <Text key={gap.key} style={{ color: palette.text, fontSize: 15 }}>{`·  ${gap.label}`}</Text>)}
      <Muted>{tt('recordNote')}</Muted>
      <View style={{ alignSelf: 'flex-start' }}><Button title={tt('recordCta')} onPress={() => router.push(todayHref(reminder.destination))} /></View>
    </Ruled>;
    case 'passport': return <Ruled gap={8}>
      <Text style={{ color: palette.text, fontSize: 17, fontWeight: '700' }}>{tt('passportTitle', { date: fmtCalendarDate(reminder.expiresOn) })}</Text>
      <Muted>{tt('passportNote')}</Muted>
      <View style={{ alignSelf: 'flex-start' }}><Button title={tt('passportCta')} onPress={() => router.push(todayHref(reminder.destination))} /></View>
    </Ruled>;
  }
}

type Phase = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done' } | { kind: 'uncertain' } | { kind: 'refused'; text: string };

/** One in-flight command at a time; a result for a signed-out or replaced session is dropped. */
function useCommand() {
  const { signOut } = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const flight = useRef(false), live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const run = useCallback(async (send: () => Promise<{ outcome: string; code?: string }>, refusal: (code: string) => string) => {
    if (flight.current) return;
    flight.current = true; const owner = authGeneration();
    setPhase({ kind: 'sending' });
    try {
      const result = await send();
      assertAuthGeneration(owner);
      if (!live.current) return;
      setPhase(result.outcome === 'refused' ? { kind: 'refused', text: refusal(result.code ?? '') } : { kind: 'done' });
    } catch (e) {
      if (!live.current) return;
      if (e instanceof SignInRequiredError) { setPhase({ kind: 'idle' }); void signOut(); }
      // A 4xx was refused before anything was recorded; anything else may or may not have been.
      else if (e instanceof RequestRejectedError) setPhase({ kind: 'refused', text: refusal('') });
      else setPhase({ kind: 'uncertain' });
    } finally { flight.current = false; }
  }, [signOut]);
  return { phase, run, reset: () => setPhase({ kind: 'idle' }) };
}

const REASONS: readonly { key: ClockOutReasonV2; label: TodayKey }[] = [
  { key: 'forgot', label: 'reasonForgot' }, { key: 'device', label: 'reasonDevice' }, { key: 'other', label: 'reasonOther' },
];

function ClockOutCard({ reminder, onReload }: { reminder: Extract<TodayReminder, { kind: 'clockOut' }>; onReload: () => void }) {
  const router = useRouter();
  const { palette, design } = useTenantDesign();
  const [reason, setReason] = useState<ClockOutReasonV2 | null>(null);
  const [other, setOther] = useState('');
  const { phase, run } = useCommand();
  const command = clockOutCommand(reminder.caseId, reason, other);
  const date = fmtCalendarDate(reminder.date);
  const busy = phase.kind === 'sending', done = phase.kind === 'done';

  function confirm() {
    if (!command || busy) return;
    const reasonText = command.reason === 'other' ? command.other : tt(command.reason === 'forgot' ? 'reasonForgot' : 'reasonDevice');
    const generation = authGeneration();
    Alert.approval(tt('clockOutConfirmTitle'), tt('clockOutConfirmBody', { time: reminder.proposedCheckOut, date, reason: reasonText }), [
      { text: t('cancel'), style: 'cancel' },
      { text: tt('clockOutSend'), onPress: () => { if (authGeneration() === generation) void run(() => apiPostV2('v2/today/clock-out', ClockOutConfirmResultV2, command), clockOutRefusalText); } },
    ]);
  }

  return <Ruled gap={10}>
    <Text style={{ color: palette.text, fontSize: 19, lineHeight: 24, fontWeight: '700' }}>{tt('clockOutTitle', { time: reminder.proposedCheckOut, date })}</Text>
    <Text style={{ color: palette.muted, fontSize: 14 }}>{tt('clockOutCheckIn', { time: reminder.checkIn })}</Text>
    {done ? <Status tone="text" text={tt('clockOutSent')} /> : <>
      <Text style={{ color: palette.text, fontSize: 14, fontWeight: '600' }}>{tt('clockOutLegend')}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={tt('clockOutLegend')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {REASONS.map((r) => <Chip key={r.key} title={tt(r.label)} selected={reason === r.key} disabled={busy} onPress={() => setReason(r.key)} />)}
      </View>
      {reason === 'other' && <TextInput accessibilityLabel={tt('reasonOtherLabel')} placeholder={tt('reasonOtherLabel')} editable={!busy} value={other} onChangeText={setOther}
        maxLength={CLOCK_OUT_OTHER_MAX_V2} multiline autoFocus placeholderTextColor={palette.muted}
        style={{ fontFamily: 'FieldRegular', color: palette.text, minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: design.schemaVersion === 2 ? design.composition.layout.radius : 0, padding: 12, fontSize: 16, textAlignVertical: 'top' }} />}
      <Muted>{tt('clockOutNote')}</Muted>
      {phase.kind === 'refused' && <Status tone="text" text={phase.text} />}
      {phase.kind === 'uncertain' && <><Status tone="text" text={tt('clockOutUncertain')} /><View style={{ alignSelf: 'flex-start' }}><Button title={tt('sectionRetry')} kind="quiet" onPress={onReload} /></View></>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Button title={busy ? tt('clockOutSending') : tt('clockOutSend')} disabled={!command || busy || phase.kind === 'uncertain'} onPress={confirm} />
        <Button title={tt('clockOutEdit')} kind="quiet" disabled={busy} onPress={() => router.push(todayHref({ screen: 'attendanceCorrection', date: reminder.date }))} />
      </View>
    </>}
  </Ruled>;
}

function AutoFixedCard({ reminder, onReload }: { reminder: Extract<TodayReminder, { kind: 'autoFixed' }>; onReload: () => void }) {
  const { palette } = useTenantDesign();
  const { phase, run } = useCommand();
  const busy = phase.kind === 'sending';
  function undo() {
    if (busy) return;
    const generation = authGeneration();
    Alert.approval(tt('undoConfirmTitle'), tt('undoConfirmBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: tt('undo'), style: 'destructive', onPress: () => { if (authGeneration() === generation) void run(() => apiPostV2('v2/today/undo', LoopUndoResultV2, { actionId: reminder.actionId, confirm: true }), undoRefusalText); } },
    ]);
  }
  return <Ruled gap={10}>
    <Text style={{ color: palette.text, fontSize: 19, lineHeight: 24, fontWeight: '700' }}>{tt('autoFixedTitle', { time: reminder.checkOut, date: fmtCalendarDate(reminder.date) })}</Text>
    {phase.kind === 'done' ? <Status tone="text" text={tt('undone')} /> : <>
      <Muted>{tt('autoFixedNote', { until: untilText(reminder.undoUntil) })}</Muted>
      {phase.kind === 'refused' && <Status tone="text" text={phase.text} />}
      {phase.kind === 'uncertain' && <><Status tone="text" text={tt('undoUncertain')} /><View style={{ alignSelf: 'flex-start' }}><Button title={tt('sectionRetry')} kind="quiet" onPress={onReload} /></View></>}
      <View style={{ alignSelf: 'flex-start' }}><Button title={busy ? tt('undoing') : tt('undo')} kind="quiet" disabled={busy || phase.kind === 'uncertain'} onPress={undo} /></View>
    </>}
  </Ruled>;
}

// ── Next steps ──────────────────────────────────────────────────────────────────────────────────────────────────────

const DECIDER: Record<TodayStep['decider'], TodayKey> = { hr: 'deciderHr', manager: 'deciderManager', you: 'deciderYou' };

export function stepTitle(step: TodayStep): string {
  const title = tt(`step_${step.kind}` as TodayKey);
  return step.label ? `${title} · ${step.label}` : title;
}
export function stepMeta(step: TodayStep): string {
  return [step.date ? dateRange(step.date, step.endDate ?? step.date) : null, step.due ? tt('stepDue', { date: fmtCalendarDate(step.due, false) }) : null, tt(DECIDER[step.decider])]
    .filter(Boolean).join(' · ');
}

export function TodaySteps({ section, onReload }: { section: Section<'steps'>; onReload: () => void }) {
  const router = useRouter();
  const { palette } = useTenantDesign();
  if (section.status === 'unavailable') return <SectionUnavailable text={tt('stepsUnavailable')} onRetry={onReload} />;
  return <View>
    {section.partial && <Ruled><Status tone="text" text={tt('stepsPartial')} /></Ruled>}
    {section.items.length === 0 && !section.partial && <Ruled><Muted>{tt('stepsEmpty')}</Muted></Ruled>}
    {section.items.map((step) => {
      const destination = step.destination;
      const body = <>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{stepTitle(step)}</Text>
          <Text style={{ color: palette.muted, fontSize: 13 }}>{stepMeta(step)}</Text>
          {!destination && <Text style={{ color: palette.muted, fontSize: 13, fontStyle: 'italic' }}>{tt('stepWebOnly')}</Text>}
        </View>
        {destination && <Icon name="chevron" color={palette.muted} size={15} />}
      </>;
      const style = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, minHeight: 48, paddingVertical: 12, borderTopWidth: 1, borderColor: palette.border };
      return destination
        ? <PressRow key={step.key} label={`${stepTitle(step)}. ${stepMeta(step)}`} onPress={() => router.push(todayHref(destination))} style={style}>{body}</PressRow>
        : <View key={step.key} accessible accessibilityLabel={`${stepTitle(step)}. ${stepMeta(step)}. ${tt('stepWebOnly')}`} style={style}>{body}</View>;
    })}
    {section.more > 0 && <Ruled><Muted>{tt('stepsMore', { n: section.more })}</Muted></Ruled>}
  </View>;
}

function PressRow({ children, label, onPress, style }: { children: ReactNode; label: string; onPress: () => void; style: object }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [style, pressed && { opacity: 0.7 }]}>{children}</Pressable>;
}

// ── This week's hours ───────────────────────────────────────────────────────────────────────────────────────────────

const BAR_HEIGHT = 72;
/** The tallest a bar may be: the longest shift, scheduled day or worked day, at least an hour. Scale only, never a figure. */
export function barScale(week: TodayWeekHours): number {
  return Math.max(60, week.shiftMinutes ?? 0, ...week.bars.map((b) => Math.max(b.workedMinutes ?? 0, b.scheduledMinutes ?? 0)));
}
const weekday = (date: string) => {
  try { return new Intl.DateTimeFormat(intlLocale(), { timeZone: 'UTC', weekday: 'narrow' }).format(new Date(`${date}T00:00:00Z`)); } catch { return date.slice(8); }
};

export function TodayHours({ section, today, onReload }: { section: Section<'hours'>; today: string; onReload: () => void }) {
  const { palette } = useTenantDesign();
  if (section.status === 'off') return null;
  if (section.status === 'unavailable') return <SectionUnavailable text={tt('weekUnavailable')} onRetry={onReload} />;
  const { week } = section, scale = barScale(week);
  if (week.bars.length === 0) return <Ruled><Muted>{tt('weekEmpty')}</Muted></Ruled>;
  return <Ruled gap={12}>
    <Text style={{ color: palette.text, fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{tt('weekWorked', { worked: fmtMinutes(week.workedMinutes) })}</Text>
    {week.shiftMinutes != null && <Muted>{tt('weekShift', { shift: fmtMinutes(week.shiftMinutes) })}</Muted>}
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: BAR_HEIGHT + 22 }}>
      {week.bars.map((bar) => {
        const isToday = bar.date === today;
        const worked = bar.state === 'worked' ? Math.max(4, Math.round(((bar.workedMinutes ?? 0) / scale) * BAR_HEIGHT)) : 0;
        const planned = Math.max(4, Math.round(((bar.scheduledMinutes ?? 0) / scale) * BAR_HEIGHT));
        const said = bar.state === 'worked' ? fmtMinutes(bar.workedMinutes) : bar.state === 'running' ? tt('weekRunning') : bar.state === 'none' ? tt('weekNone') : fmtMinutes(bar.scheduledMinutes);
        return <View key={bar.date} accessible accessibilityLabel={`${fmtCalendarDate(bar.date, false)}, ${said}`} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
          <View style={{ width: '100%', height: BAR_HEIGHT, justifyContent: 'flex-end' }}>
            {bar.state === 'worked'
              ? <View style={{ height: worked, backgroundColor: palette.button }} />
              : <View style={{ height: planned, borderWidth: 1, borderStyle: bar.state === 'running' ? 'solid' : 'dashed', borderColor: bar.state === 'running' ? palette.button : palette.border }} />}
          </View>
          <Text style={{ color: isToday ? palette.text : palette.muted, fontSize: 12, fontWeight: isToday ? '800' : '500' }}>{weekday(bar.date)}</Text>
        </View>;
      })}
    </View>
  </Ruled>;
}

// ── Payday ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function TodayPayday({ section, onReload }: { section: Section<'payday'>; onReload: () => void }) {
  const { palette } = useTenantDesign();
  if (section.status === 'off') return null;
  if (section.status === 'unavailable') return <SectionUnavailable text={tt('paydayUnavailable')} onRetry={onReload} />;
  const next = section.next;
  if (!next) return <Ruled><Muted>{tt('paydayNone')}</Muted></Ruled>;
  return <View accessible accessibilityLabel={`${tt(next.kind === 'payday' ? 'paydayTitle' : 'cutoffTitle')}, ${fmtCalendarDate(next.date)}, ${daysAwayText(next.daysAway)}`}
    style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: palette.border, paddingVertical: 14 }}>
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={{ color: palette.muted, fontSize: 13, fontWeight: '600' }}>{tt(next.kind === 'payday' ? 'paydayTitle' : 'cutoffTitle')}</Text>
      <Text style={{ color: palette.text, fontSize: 20, fontWeight: '800' }}>{fmtCalendarDate(next.date)}</Text>
    </View>
    <Text style={{ color: palette.accent, fontSize: 15, fontWeight: '700' }}>{daysAwayText(next.daysAway)}</Text>
  </View>;
}

// ── Coming up ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function comingUpLabel(item: TodayComingUp): string {
  if (item.kind === 'managerAway') return item.name ? tt('coming_managerAway', { name: item.name }) : tt('comingManagerAwayUnnamed');
  if (item.kind === 'holiday' && item.name) return item.name;
  return tt(`coming_${item.kind}` as TodayKey);
}

export function TodayComingUpList({ section, onReload }: { section: Section<'comingUp'>; onReload: () => void }) {
  const { palette } = useTenantDesign();
  if (section.status === 'unavailable') return <SectionUnavailable text={tt('comingUpUnavailable')} onRetry={onReload} />;
  if (section.items.length === 0) return <Ruled><Muted>{tt('comingUpEmpty')}</Muted></Ruled>;
  return <View>{section.items.map((item) => <View key={`${item.kind}:${item.date}:${item.endDate}:${item.name ?? ''}`} accessible
    accessibilityLabel={`${comingUpLabel(item)}, ${dateRange(item.date, item.endDate)}`}
    style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingVertical: 12, borderTopWidth: 1, borderColor: palette.border }}>
    <Text style={{ color: palette.text, fontSize: 14, fontWeight: '700', minWidth: 96, fontVariant: ['tabular-nums'] }}>{dateRange(item.date, item.endDate)}</Text>
    <Text style={{ color: palette.text, fontSize: 15, flex: 1 }}>{comingUpLabel(item)}</Text>
  </View>)}</View>;
}

export { tt };
