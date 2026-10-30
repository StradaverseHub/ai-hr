/**
 * Home, redesigned (Mobile WOW round): a branded hero with the greeting and today's clock status, one grid of quick
 * actions for everything an employee does, what needs them, their leave balances, who is away and the latest payslip.
 *
 * Every card reads the SAME authorized endpoint its full screen reads. The clock card is the one exception to "Home
 * records nothing" (owner request, 30 Oct 2026): its button clocks in or out in one tap through the Clock tab's own
 * journey (ClockPanel, variant 'home'), never a second implementation. The live worked-time figure is the server's
 * `workedSeconds` plus the time since that answer arrived, for display only. Money arrives as text and is shown as text; the payslip amount stays hidden until tapped.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, View, type ColorValue } from 'react-native';
import { ClockPanel, type HomeClockView } from './clock-panel';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DesignText as Text, TenantBrand, TenantSurface, useTenantDesign } from './design';
import { useApi } from './api';
import { fmtCalendarDate } from './attendance-format';
import { cardFigure, homeBalances } from './home-cards';
import { Icon, type IconName } from './icon';
import { homeNeedsView, useHomeSummary } from './inbox';
import { t, type MessageKey } from './i18n';
import { useSession } from './session';
import { LoadState, Muted, fmtDays, fmtMoney } from './ui';

/** `#RRGGBB` plus an alpha byte; anything else (a named or rgba colour) falls back to `fallback`. */
export function tint(color: string, alpha: number, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color + Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0') : fallback;
}
export function initials(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).slice(0, 2).join('') || '·';
}
/** The greeting's part of the day, in Kuala Lumpur time (UTC+8, no daylight saving): the app's stated business zone. */
export function partOfDay(nowMs: number): 'morning' | 'afternoon' | 'evening' {
  const h = new Date(nowMs + 8 * 3600_000).getUTCHours();
  return h < 12 && h >= 4 ? 'morning' : h < 18 && h >= 12 ? 'afternoon' : 'evening';
}
/** Hours and minutes, never seconds, so the figure does not flicker. */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return t('durationHm', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60).toString().padStart(2, '0') });
}

/** A gentle rise-and-fade on first show; nothing moves when the device or the company asks for reduced motion. */
export function Reveal({ children, index = 0 }: { children: ReactNode; index?: number }) {
  const { reduceMotion } = useTenantDesign();
  const v = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion) { v.setValue(1); return; }
    const a = Animated.timing(v, { toValue: 1, duration: 420, delay: 60 * index, useNativeDriver: true });
    a.start(); return () => a.stop();
  }, [reduceMotion, index, v]);
  return <Animated.View style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }}>{children}</Animated.View>;
}

/** A pressable that gives way slightly under the finger: the tactile feel of a native control. */
export function Tactile({ children, onPress, label, hint, style }: { children: ReactNode; onPress: () => void; label: string; hint?: string; style?: object }) {
  const { reduceMotion } = useTenantDesign();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} onPress={onPress}
    style={({ pressed }) => [style, pressed && { opacity: 0.85, transform: reduceMotion ? [] : [{ scale: 0.97 }] }]}>{children}</Pressable>;
}

// ── Hero ──────────────────────────────────────────────────────────────────────────────────────────────────

export function HomeHero({ name, unread, refreshToken }: { name: string | null; unread: number; refreshToken: number }) {
  const { palette, design } = useTenantDesign();
  const insets = useSafeAreaInsets();
  const radius = design.schemaVersion === 2 ? Math.max(design.composition.layout.radius, 12) : design.corners === 'soft' ? 28 : 6;
  const greeting: MessageKey = { morning: 'greetMorning', afternoon: 'greetAfternoon', evening: 'greetEvening' }[partOfDay(Date.now())] as MessageKey;
  const on = palette.onButton;
  const first = name?.trim().split(/\s+/)[0] ?? null;
  return <View style={{ backgroundColor: palette.button, paddingTop: insets.top + 12, paddingHorizontal: 20, paddingBottom: 24, borderBottomLeftRadius: radius, borderBottomRightRadius: radius, gap: 18 }}>
    <TenantSurface band align="start"><TenantBrand /></TenantSurface>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: -6 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: on, opacity: 0.8, fontSize: 15 }}>{t(greeting)}</Text>
        <Text accessibilityRole="header" numberOfLines={1} style={{ color: on, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 }}>{first ?? t('helloNoName')}</Text>
      </View>
      <Tactile label={unread > 0 ? `${t('tabInbox')}, ${t('unreadCount', { n: unread })}` : t('tabInbox')} onPress={() => router.navigate('/inbox' as Href)}
        style={{ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(on as string, 0.12, 'transparent') }}>
        <Icon name="bell" color={on} size={22} />
        {unread > 0 && <View style={{ position: 'absolute', top: 6, right: 6, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: '#E5484D', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: palette.button }}>
          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{unread > 99 ? '99+' : unread}</Text>
        </View>}
      </Tactile>
      <Tactile label={t('profileOpen')} onPress={() => router.push('/profile')}
        style={{ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: on }}>
        <Text style={{ color: palette.button, fontSize: 16, fontWeight: '800' }}>{initials(name)}</Text>
      </Tactile>
    </View>
    <ClockHeroCard refreshToken={refreshToken} />
  </View>;
}

/**
 * Today's status and live worked time inside the hero, and ONE tap to clock in or out (owner request, Mobile WOW round).
 * The tap runs the Clock tab's own journey (ClockPanel, variant 'home'): the same saved attempt, signed-clock checks,
 * location assessment, required photo, receipts and recovery. Home shows its progress and its answer; anything that needs
 * a decision (an unresolved submission, a review left open, device registration, location settings) is finished on the
 * Clock tab, linked from the card. The live figure is the server's `workedSeconds` plus the time since that answer, for
 * display only.
 */
function ClockHeroCard({ refreshToken }: { refreshToken: number }) {
  return <ClockPanel variant="home" refreshToken={refreshToken} renderHome={(view) => <ClockHeroView view={view} />} />;
}
function ClockHeroView({ view }: { view: HomeClockView }) {
  const { palette, reduceMotion } = useTenantDesign();
  const today = view.current;
  const receivedAt = useMemo(() => Date.now(), [today]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!today?.clockedIn) return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [today?.clockedIn]);
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!today?.clockedIn || reduceMotion) { pulse.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.35, duration: 900, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
    ]));
    loop.start(); return () => loop.stop();
  }, [today?.clockedIn, reduceMotion, pulse]);
  const on = palette.onButton as string;
  const worked = today ? today.workedSeconds + (today.clockedIn ? Math.max(0, (now - receivedAt) / 1000) : 0) : 0;
  const since = today?.openSince ? clockTime(today.openSince) : null;
  const label = view.action === 'in' ? t('clockIn') : t('clockOut');
  const done = view.doneAt ? clockTime(view.doneAt) : null;
  return <View style={{ borderRadius: 22, padding: 18, gap: 14, backgroundColor: tint(on, 0.1, 'transparent'), borderWidth: 1, borderColor: tint(on, 0.16, 'transparent') }}>
    {!today && <TenantSurface band align="start"><LoadState loading={view.loading} hasData={false} error={view.error} onRetry={view.reload} /></TenantSurface>}
    {today && <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Animated.View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: today.clockedIn ? '#30D158' : tint(on, 0.45, on), opacity: pulse }} />
        <Text style={{ color: on, fontSize: 14, fontWeight: '600', flex: 1 }}>
          {today.clockedIn ? since ? t('onClockSince', { time: since }) : t('onTheClock') : t('offTheClock')}
        </Text>
        <Text style={{ color: on, opacity: 0.75, fontSize: 13 }}>{fmtCalendarDate(today.date, false)}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ gap: 2, flexShrink: 1 }}>
          <Text accessibilityLabel={`${t('workedToday')}: ${fmtDuration(worked)}`} style={{ color: on, fontSize: 40, fontWeight: '800', letterSpacing: -1, fontVariant: ['tabular-nums'] }}>{fmtDuration(worked)}</Text>
          <Text style={{ color: on, opacity: 0.75, fontSize: 13 }}>{today.shift.code ? t('workedTodayShift', { shift: today.shift.code }) : t('workedToday')}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={t('clockOpensTab')} accessibilityState={{ disabled: view.disabled || view.busy, busy: view.busy }}
          disabled={view.disabled || view.busy} onPress={view.clock}
          style={({ pressed }) => [{ minWidth: 112, minHeight: 52, borderRadius: 26, paddingHorizontal: 20, backgroundColor: on, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
            (pressed || view.disabled) && { opacity: 0.75 }, pressed && !reduceMotion && { transform: [{ scale: 0.97 }] }]}>
          {view.busy ? <ActivityIndicator color={palette.button} /> : <Icon name="clock" color={palette.button} size={18} />}
          <Text style={{ color: palette.button, fontSize: 16, fontWeight: '800' }}>{label}</Text>
        </Pressable>
      </View>
      {view.busy && <Text accessibilityLiveRegion="polite" style={{ color: on, fontSize: 14 }}>{t('preparingClock')}</Text>}
      {done && !view.busy && <Text accessibilityRole="alert" style={{ color: on, fontSize: 15, fontWeight: '700' }}>✓ {t('clockRecorded')} · {done}</Text>}
      {view.message && !view.busy && <Text accessibilityRole="alert" style={{ color: on, fontSize: 14, lineHeight: 20 }}>{view.message}</Text>}
      {view.finishOnClockTab && <Pressable accessibilityRole="button" accessibilityLabel={t('finishOnClockTab')} onPress={() => router.navigate('/clock' as Href)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: on, fontSize: 15, fontWeight: '700', textDecorationLine: 'underline' }}>{t('finishOnClockTab')}</Text><Icon name="chevron" color={on} size={13} />
      </Pressable>}
    </>}
  </View>;
}
/** `HH:MM` of a server instant in Kuala Lumpur time (UTC+8), as the Clock tab words times. */
function clockTime(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 8 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ── Needs you ─────────────────────────────────────────────────────────────────────────────────────────────

/** A bold banner only when something waits for the caller; a quiet line when nothing does; a retry when unknown. */
export function NeedsYouBanner({ summary }: { summary: ReturnType<typeof useHomeSummary> }) {
  const { palette } = useTenantDesign();
  const v = homeNeedsView(summary);
  if (typeof v.tasks === 'number' && v.tasks > 0) {
    return <Tactile label={`${t('approvalsTitle')}, ${t('homeTasksCount', { n: v.tasks })}`} onPress={() => router.push('/approvals')}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 20, backgroundColor: tint(palette.accent, 0.12, palette.card), borderWidth: 1, borderColor: tint(palette.accent, 0.35, palette.border) }}>
      <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: palette.bg, fontSize: 18, fontWeight: '800' }}>{v.tasks > 99 ? '99+' : v.tasks}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '700' }}>{t('needsYouTitle')}</Text>
        <Text style={{ color: palette.muted, fontSize: 14 }}>{t('homeTasksCount', { n: v.tasks })}</Text>
      </View>
      <Icon name="chevron" color={palette.accent} size={16} />
    </Tactile>;
  }
  if (v.tasks === 'failed' && !summary.loading) {
    return <Tactile label={t('homeCheckFailed')} onPress={summary.reload} style={{ padding: 14, borderRadius: 16, borderWidth: 1, borderColor: palette.border }}>
      <Text style={{ color: palette.accent, fontSize: 15 }}>{t('homeCheckFailed')}</Text>
    </Tactile>;
  }
  if (v.allClear) return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
    <Icon name="sparkle" color={palette.accent} size={16} /><Muted>{t('nothingNeedsYou')}</Muted>
  </View>;
  return null;
}

// ── Quick actions ─────────────────────────────────────────────────────────────────────────────────────────

export type QuickAction = { key: string; icon: IconName; label: MessageKey; href: Href; badge?: number };

export function QuickActions({ actions }: { actions: readonly QuickAction[] }) {
  const { palette, design } = useTenantDesign();
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 18 : 6;
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 18 }}>
    {actions.map((a) => <View key={a.key} style={{ width: '25%', alignItems: 'center' }}>
      <Tactile label={a.badge ? `${t(a.label)}, ${a.badge}` : t(a.label)} onPress={() => router.push(a.href)} style={{ alignItems: 'center', gap: 8, minWidth: 72 }}>
        <View style={{ width: 58, height: 58, borderRadius: radius, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(palette.accent, 0.12, palette.card), borderWidth: 1, borderColor: tint(palette.accent, 0.18, palette.border) }}>
          <Icon name={a.icon} color={palette.accent as ColorValue} size={26} />
          {a.badge ? <View style={{ position: 'absolute', top: -5, right: -5, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: '#E5484D', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: palette.bg }}>
            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{a.badge > 99 ? '99+' : a.badge}</Text>
          </View> : null}
        </View>
        <Text numberOfLines={2} style={{ color: palette.text, fontSize: 12, fontWeight: '600', textAlign: 'center', maxWidth: 82 }}>{t(a.label)}</Text>
      </Tactile>
    </View>)}
  </View>;
}

// ── Leave balances ────────────────────────────────────────────────────────────────────────────────────────

/** Up to four balance cards in a horizontal strip (the server's order, entitled types first), then "All balances". */
export function BalanceStrip({ refreshToken }: { refreshToken: number }) {
  const { employmentId, signOut } = useSession();
  const { palette, design } = useTenantDesign();
  const leave = useApi('leave', { employmentId: employmentId ?? undefined }, signOut);
  useEffect(() => { if (refreshToken) leave.reload(); }, [refreshToken, leave.reload]);
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 20 : 6;
  const cards = homeBalances(leave.data?.cards ?? [], 4);
  return <View style={{ gap: 10 }}>
    <SectionHeader title={t('homeYourLeave')} action={leave.data ? t('allBalances') : undefined} onAction={() => router.navigate('/leave' as Href)} />
    <LoadState loading={leave.loading} hasData={leave.data != null} error={leave.error} onRetry={leave.reload} />
    {leave.data && cards.length === 0 && <Muted>{t('noLeaveTypes')}</Muted>}
    {cards.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingRight: 8 }}>
      {cards.map((c) => {
        const caption = c.takenOnly ? t('taken') : c.isCurrentCycle ? t('canApplyFor') : t('balance');
        const figure = cardFigure(c);
        return <Tactile key={c.leaveTypeId} label={`${c.leaveType}. ${fmtDays(figure)}. ${caption}`} onPress={() => router.navigate('/leave' as Href)}
          style={{ width: 148, padding: 16, gap: 10, borderRadius: radius, backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, overflow: 'hidden' }}>
          <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: c.color && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : palette.accent }} />
          <Text numberOfLines={1} style={{ color: palette.muted, fontSize: 13, fontWeight: '600' }}>{c.leaveType}</Text>
          <Text style={{ color: palette.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5, fontVariant: ['tabular-nums'] }}>{figure == null ? '—' : String(Math.round(figure * 100) / 100)}</Text>
          <Text numberOfLines={2} style={{ color: palette.muted, fontSize: 12 }}>{[caption, c.sharedPool ? t('sharedPool') : null].filter(Boolean).join(' · ')}</Text>
        </Tactile>;
      })}
    </ScrollView>}
  </View>;
}

// ── Payslip ───────────────────────────────────────────────────────────────────────────────────────────────

/** The latest released payslip: period and net pay, the amount hidden until the eye is tapped. Absent when payroll is off. */
export function PayslipCard({ refreshToken }: { refreshToken: number }) {
  const { signOut } = useSession();
  const { palette, design } = useTenantDesign();
  const pay = useApi('payslips', {}, signOut);
  const [shown, setShown] = useState(false);
  useEffect(() => { if (refreshToken) pay.reload(); }, [refreshToken, pay.reload]);
  useFocusEffect(useCallback(() => () => setShown(false), []));
  if (pay.data && !pay.data.enabled) return null;
  const latest = pay.data?.items[0];
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 20 : 6;
  return <View style={{ gap: 10 }}>
    <SectionHeader title={t('payslips')} action={latest ? t('seeAll') : undefined} onAction={() => router.push('/pay')} />
    <LoadState loading={pay.loading} hasData={pay.data != null} error={pay.error} onRetry={pay.reload} />
    {pay.data && !latest && <Muted>{t('noPayslips')}</Muted>}
    {latest && <View style={{ padding: 18, borderRadius: radius, backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: tint(palette.accent, 0.12, palette.bg), alignItems: 'center', justifyContent: 'center' }}><Icon name="payslip" color={palette.accent} size={20} /></View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: palette.text, fontSize: 16, fontWeight: '700' }}>{latest.payPeriod}</Text>
          <Text style={{ color: palette.muted, fontSize: 13 }}>{t('netPay')}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Text accessibilityLabel={shown ? fmtMoney(latest.net) : t('amountHidden')} style={{ color: palette.text, fontSize: 28, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: shown ? -0.5 : 2 }}>
          {shown ? fmtMoney(latest.net) : '••••••'}
        </Text>
        <Tactile label={shown ? t('hideAmount') : t('showAmount')} onPress={() => setShown(!shown)} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: palette.border }}>
          <Icon name={shown ? 'eyeOff' : 'eye'} color={palette.accent} size={20} />
        </Tactile>
      </View>
      <Tactile label={t('payViewPayslip')} onPress={() => router.push({ pathname: '/pay/[id]', params: { id: latest.id } })}
        style={{ minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(palette.accent, 0.1, palette.bg) }}>
        <Text style={{ color: palette.accent, fontSize: 15, fontWeight: '700' }}>{t('payViewPayslip')}</Text>
      </Tactile>
    </View>}
  </View>;
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const { palette } = useTenantDesign();
  return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 }}>
    <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.3 }}>{title}</Text>
    {action && onAction ? <Pressable accessibilityRole="button" accessibilityLabel={action} hitSlop={10} onPress={onAction} style={{ minHeight: 44, justifyContent: 'center' }}>
      <Text style={{ color: palette.accent, fontSize: 15, fontWeight: '600' }}>{action}</Text>
    </Pressable> : null}
  </View>;
}

export { useHomeSummary };
