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
import { ActivityIndicator, Animated, Image, Pressable, ScrollView, View, useWindowDimensions, type ColorValue } from 'react-native';
import { ClockPanel, type HomeClockView } from './clock-panel';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Atmosphere, DesignText as Text, TenantBrand, TenantSurface, useTenantDesign } from './design';
import { useApi } from './api';
import { fmtCalendarDate } from './attendance-format';
import { cardFigure, homeBalances } from './home-cards';
import { Icon, type IconName } from './icon';
import { homeNeedsView, useHomeSummary } from './inbox';
import { t, type MessageKey } from './i18n';
import { Material, TimeDisplay, alpha } from './visual';
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
  const on = palette.text;
  const first = name?.trim().split(/\s+/)[0] ?? null;
  return <View style={{ backgroundColor: palette.bg, paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 10, borderBottomLeftRadius: radius, borderBottomRightRadius: radius, gap: 14 }}>
    <Atmosphere strong />
    <TenantBrand />
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: -6 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: on, opacity: 0.8, fontSize: 15 }}>{t(greeting)}</Text>
        <Text accessibilityRole="header" numberOfLines={1} style={{ color: on, fontSize: 25, fontWeight: '600', letterSpacing: -0.6 }}>{first ?? t('helloNoName')}</Text>
      </View>
      <Tactile label={unread > 0 ? `${t('tabInbox')}, ${t('unreadCount', { n: unread })}` : t('tabInbox')} onPress={() => router.navigate('/inbox' as Href)}
        style={{ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(on as string, 0.12, 'transparent') }}>
        <Icon name="bell" color={on} size={22} />
        {unread > 0 && <View style={{ position: 'absolute', top: 6, right: 6, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: '#E5484D', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: palette.button }}>
          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{unread > 99 ? '99+' : unread}</Text>
        </View>}
      </Tactile>
      <Tactile label={t('profileOpen')} onPress={() => router.push('/profile')}
        style={{ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(on, .12, palette.card), borderWidth: 1, borderColor: tint(on, .18, palette.border) }}>
        <Text style={{ color: on, fontSize: 16, fontWeight: '500' }}>{initials(name)}</Text>
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
  const on = palette.text as string;
  const worked = today ? today.workedSeconds + (today.clockedIn ? Math.max(0, (now - receivedAt) / 1000) : 0) : 0;
  const since = today?.openSince ? clockTime(today.openSince) : null;
  const label = view.action === 'in' ? t('clockIn') : t('clockOut');
  const done = view.doneAt ? clockTime(view.doneAt) : null;
  return <View style={{ gap: 12, paddingTop: 6 }}>
    {!today && <TenantSurface band={false} align="start"><LoadState loading={view.loading} hasData={false} error={view.error} onRetry={view.reload} /></TenantSurface>}
    {today && <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Animated.View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: today.clockedIn ? '#30D158' : tint(on, 0.45, on), opacity: pulse }} />
        <Text style={{ color: on, fontSize: 14, fontWeight: '600', flex: 1 }}>
          {today.clockedIn ? since ? t('onClockSince', { time: since }) : t('onTheClock') : t('offTheClock')}
        </Text>
        <Text style={{ color: on, opacity: 0.75, fontSize: 13 }}>{fmtCalendarDate(today.date, false)}</Text>
      </View>
      <View style={{ gap: 20 }}>
        <View style={{ gap: 10 }}>
          <TimeDisplay compact seconds={worked} label={`${t('workedToday')}: ${fmtDuration(worked)}`} />
          <Text style={{ color: palette.muted, fontSize: 12, textAlign: 'center' }}>{today.shift.code ? t('workedTodayShift', { shift: today.shift.code }) : t('workedToday')}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={t('clockOpensTab')} accessibilityState={{ disabled: view.disabled || view.busy, busy: view.busy }}
          disabled={view.disabled || view.busy} onPress={view.clock}
          style={({ pressed }) => [{ minWidth: 112, minHeight: 46, borderRadius: 24, paddingHorizontal: 20, backgroundColor: palette.card, borderWidth: 1, borderColor: tint(palette.text, .2, palette.border), experimental_backgroundImage: `linear-gradient(135deg, ${tint(palette.accent, .32, palette.card)} 0%, ${palette.card} 48%, ${tint(palette.accent, .45, palette.card)} 100%)`, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
            (pressed || view.disabled) && { opacity: 0.75 }, pressed && !reduceMotion && { transform: [{ scale: 0.97 }] }]}>
          {view.busy ? <ActivityIndicator color={palette.text} /> : <Icon name="clock" color={palette.text} size={18} />}
          <Text style={{ color: palette.text, fontSize: 15, fontWeight: '600' }}>{label}</Text>
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
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 24, backgroundColor: tint(palette.card, .9, palette.card), borderWidth: 1, borderColor: tint(palette.text, .12, palette.border), experimental_backgroundImage: `linear-gradient(135deg, transparent 30%, ${tint(palette.accent, .15, palette.card)} 100%)` }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: tint(palette.accent, .15, palette.card), alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: palette.accent, fontSize: 16, fontWeight: '600' }}>{v.tasks > 99 ? '99+' : v.tasks}</Text>
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
  const { palette } = useTenantDesign();
  const { width } = useWindowDimensions();
  const tileWidth = Math.min(200, Math.max(156, width * .47));
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" snapToInterval={tileWidth + 12} snapToAlignment="start" contentContainerStyle={{ gap: 12, paddingRight: 20, paddingBottom: 4 }}>
    {actions.map((a) => <Tactile key={a.key} label={a.badge ? `${t(a.label)}, ${a.badge}` : t(a.label)} onPress={() => router.push(a.href)} style={{ width: tileWidth, minHeight: 200, borderRadius: 26, overflow: 'hidden', backgroundColor: palette.card, borderWidth: 1, borderColor: alpha(palette.text, .12) }}>
      <Image accessible={false} source={a.key === 'leave' || a.key === 'calendar' ? require('../assets/cards/time-away.png') : a.key === 'pay' || a.key === 'approvals' ? require('../assets/cards/intelligence.png') : require('../assets/cards/workplace.png')} resizeMode="cover" style={{ position: 'absolute', width: '100%', height: '100%', opacity: 1 }} />
      <View pointerEvents="none" style={{ position: 'absolute', inset: 0, experimental_backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0.10) 15%, rgba(0,0,0,0.80) 100%)' }} />
      <View style={{ flex: 1, minHeight: 200, padding: 16, justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Icon name={a.icon} color="#ffffff" size={25} />{a.badge ? <View style={{ borderRadius: 16, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: '#d9f5c9' }}><Text style={{ color: '#17251a', fontSize: 12, fontWeight: '600' }}>{a.badge > 99 ? '99+' : a.badge}</Text></View> : null}</View>
        <View style={{ gap: 10 }}><Text style={{ color: '#ffffff', fontSize: 19, fontWeight: '600', letterSpacing: -.4 }}>{t(a.label)}</Text><View style={{ alignSelf: 'flex-start', flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 15, backgroundColor: '#ffffff25' }}><Icon name="chevron" color="#ffffff" size={13} /><Text style={{ color: '#ffffff', fontSize: 12 }}>{t(a.label)}</Text></View></View>
      </View>
    </Tactile>)}
  </ScrollView>;
}

// ── Leave balances ────────────────────────────────────────────────────────────────────────────────────────

/** Up to four balance cards in a horizontal strip (the server's order, entitled types first), then "All balances". */
export function BalanceStrip({ refreshToken }: { refreshToken: number }) {
  const { employmentId, signOut } = useSession();
  const { palette, design } = useTenantDesign();
  const leave = useApi('leave', { employmentId: employmentId ?? undefined }, signOut);
  useEffect(() => { if (refreshToken) leave.reload(); }, [refreshToken, leave.reload]);
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 24 : 6;
  const cards = homeBalances(leave.data?.cards ?? [], 4);
  return <View style={{ gap: 10 }}>
    <SectionHeader title={t('homeYourLeave')} action={leave.data ? t('allBalances') : undefined} onAction={() => router.navigate('/leave' as Href)} />
    <LoadState loading={leave.loading} hasData={leave.data != null} error={leave.error} onRetry={leave.reload} />
    {leave.data && cards.length === 0 && <Muted>{t('noLeaveTypes')}</Muted>}
    {cards.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" snapToInterval={180} contentContainerStyle={{ gap: 12, paddingRight: 8 }}>
      {cards.map((c) => {
        const caption = c.takenOnly ? t('taken') : c.isCurrentCycle ? t('canApplyFor') : t('balance');
        const figure = cardFigure(c);
        return <Tactile key={c.leaveTypeId} label={`${c.leaveType}. ${fmtDays(figure)}. ${caption}`} onPress={() => router.navigate('/leave' as Href)}
          style={{ width: 168, minHeight: 172, padding: 18, gap: 14, borderRadius: radius, backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, overflow: 'hidden' }}>
          <View pointerEvents="none" style={{ position: 'absolute', inset: 0, experimental_backgroundImage: `linear-gradient(145deg, ${tint(c.color || palette.accent, .18, palette.card)} 0%, transparent 65%)` }} />
          <Text numberOfLines={1} style={{ color: palette.muted, fontSize: 13, fontWeight: '600' }}>{c.leaveType}</Text>
          <Text style={{ color: palette.text, fontSize: 25, fontWeight: '600', letterSpacing: -0.6, fontVariant: ['tabular-nums'] }}>{figure == null ? '—' : String(Math.round(figure * 100) / 100)}</Text>
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
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 24 : 6;
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
    <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 19, fontWeight: '600', letterSpacing: -0.4 }}>{title}</Text>
    {action && onAction ? <Pressable accessibilityRole="button" accessibilityLabel={action} hitSlop={10} onPress={onAction} style={{ minHeight: 44, justifyContent: 'center' }}>
      <Text style={{ color: palette.accent, fontSize: 15, fontWeight: '600' }}>{action}</Text>
    </Pressable> : null}
  </View>;
}

export { useHomeSummary };
