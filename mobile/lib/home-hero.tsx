/** Daily Switch presentation with authorized data and the shared ClockPanel journey.
 * Elapsed time extends the last server answer for display only, never for payroll.
 */
import { DailySwitch } from './daily-switch';
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
  const { palette } = useTenantDesign();
  const insets = useSafeAreaInsets();
  const greeting = {morning:'greetMorning',afternoon:'greetAfternoon',evening:'greetEvening'}[partOfDay(Date.now())] as MessageKey;
  const first = name?.trim().split(/\s+/)[0] ?? null;
  return <View style={{ backgroundColor: palette.bg, paddingTop: insets.top + 12, paddingHorizontal: 20, gap: 16 }}>
    <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}>
      <TenantBrand />
      <Tactile label={t('tabInbox')} onPress={() => router.navigate('/inbox' as Href)} style={{minWidth:48,minHeight:48,alignItems:'center',justifyContent:'center'}}>
        <Icon name="bell" color={palette.text} size={24}/>
        {unread>0&&<View style={{position:'absolute',right:6,top:6,width:8,height:8,borderRadius:4,backgroundColor:palette.accent}}/>}
      </Tactile>
    </View>
    <Text style={{color:palette.muted,fontSize:16}}>{first ? `${t(greeting).replace(/[,，]$/, '')}, ${first}` : t('helloNoName')}</Text>
    <ClockHeroCard refreshToken={refreshToken} />
  </View>;
}

/**
 * Today's status and live worked time inside the hero, and ONE tap to clock in or out (owner request, Mobile WOW round).
 * The tap runs the Clock tab's own journey (ClockPanel, variant 'home'): the same saved attempt, signed-clock checks,
 * location assessment, required photo, receipts and recovery. Home shows its progress and its answer; anything that needs
 * a decision remains in the shared controls directly on Home. The live figure is the server's `workedSeconds` plus the time since that answer, for
 * display only.
 */
function ClockHeroCard({ refreshToken }: { refreshToken: number }) {
  return <ClockPanel variant="home" refreshToken={refreshToken} renderHome={(view) => <ClockHeroView view={view} />} />;
}
function ClockHeroView({ view }: { view: HomeClockView }) {
  const { palette } = useTenantDesign();
  const today = view.current;
  const receivedAt = useMemo(() => Date.now(), [today]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!today?.clockedIn) return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [today?.clockedIn]);
  const worked = today ? today.workedSeconds + (today.clockedIn ? Math.max(0, (now - receivedAt) / 1000) : 0) : 0;
  const uncertain=view.phase==='uncertain';
  const reviewing=view.phase==='review';
  const status=uncertain?t('clockUncertain'):view.busy?t('preparingClock'):today?.clockedIn?t('onTheClock'):t('offTheClock');
  return <View style={{gap:16}}>
    {!today&&<LoadState loading={view.loading} hasData={false} error={view.error} onRetry={view.reload}/>}
    {today&&<>
      <Text style={{color:palette.text,fontSize:15}}>{fmtCalendarDate(today.date,false)}</Text>
      <View style={{flexDirection:'row',gap:10,alignItems:'center'}}>
        <View style={{width:10,height:10,borderRadius:5,backgroundColor:uncertain?'#e7a335':today.clockedIn?'#65b800':palette.muted}}/>
        <Text accessibilityLiveRegion="polite" style={{color:palette.text,fontSize:22,fontWeight:'700',flex:1}}>{status}</Text>
      </View>
      <DailySwitch working={today.clockedIn} seconds={worked} busy={view.busy} disabled={view.disabled||uncertain||reviewing} onPress={view.clock}/>
      {view.doneAt&&<Text accessibilityRole="alert" style={{color:palette.text,fontSize:15,textAlign:'center'}}>{t('clockRecorded')} · {clockTime(view.doneAt)}</Text>}
      {!view.doneAt&&!view.busy&&!reviewing&&!uncertain&&<Text style={{color:palette.muted,fontSize:14,textAlign:'center'}}>{today.clockedIn&&today.openSince?t('onClockSince',{time:clockTime(today.openSince)??''}):t('noClockHistory')}</Text>}
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
      style={{flexDirection:'row',alignItems:'center',gap:14,paddingVertical:18,borderTopWidth:1,borderBottomWidth:1,borderColor:palette.border}}>
      <Icon name="approvals" color={palette.text} size={24}/>
      <View style={{flex:1,gap:4}}><Text style={{color:palette.text,fontSize:17,fontWeight:'600'}}>{t('approvalsTitle')}</Text><Text style={{color:palette.muted,fontSize:14}}>{t('homeTasksCount',{n:v.tasks})}</Text></View>
      <Icon name="chevron" color={palette.muted} size={15}/>
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
  return <View>{actions.map(a=><Tactile key={a.key} label={t(a.label)} onPress={()=>router.push(a.href)} style={{minHeight:58,flexDirection:'row',alignItems:'center',gap:14,borderBottomWidth:1,borderColor:palette.border,paddingVertical:14}}>
    <Icon name={a.icon} color={palette.text} size={22}/><Text style={{flex:1,color:palette.text,fontSize:16}}>{t(a.label)}</Text>
    {a.badge? <Text style={{color:palette.muted,fontSize:14}}>{a.badge}</Text>:null}<Icon name="chevron" color={palette.muted} size={14}/>
  </Tactile>)}</View>;
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
