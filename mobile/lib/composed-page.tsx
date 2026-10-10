/** The same bounded section tree used by the builder; each data widget consumes its existing authorized API. */
import { useState } from 'react';
import { View } from 'react-native';
import { router, type Href } from 'expo-router';
import type { MobileBlock, MobileDesignV2 } from '../../lib/mobile-design';
import { MOBILE_DESTINATIONS } from '../../lib/mobile-composition';
import { useApi } from './api';
import { ClockPanel } from './clock-panel';
import { TeamPanel } from './team-panel';
import { DesignText as Text, TenantSurface, useTenantDesign } from './design';
import { useSession } from './session';
import { t } from './i18n';
import { Button, LoadState, Muted, Row, Screen, Title, fmtDays, fmtMoney } from './ui';

export function mobileDestination(target: string): Href {
  if (target === 'home') return '/';
  if (target === 'requests' || target === 'leave') return '/leave';
  if (['clock', 'inbox', 'me', 'team'].includes(target)) return `/${target}` as Href;
  return { pathname: '/custom', params: { id: target } } as Href;
}
export function destinationTitle(target: string, design: MobileDesignV2): string {
  const keys: Record<string, Parameters<typeof t>[0]> = { home: 'tabHome', clock: 'tabClock', requests: 'tabRequests', leave: 'tabLeave', inbox: 'tabInbox', me: 'tabMe', team: 'teamAvailability' };
  return MOBILE_DESTINATIONS.includes(target as typeof MOBILE_DESTINATIONS[number]) ? t(keys[target]) : design.composition.pages.find(p => p.id === target)?.title || t('tabHome');
}
function Welcome({ block }: { block: MobileBlock }) {
  const { signOut } = useSession(), { palette } = useTenantDesign(), me = useApi('me', {}, signOut);
  return <><Title>{block.title || (me.data?.person.name ? t('hello', { name: me.data.person.name }) : t('helloNoName'))}</Title>{block.body ? <Text style={{ color: palette.muted }}>{block.body}</Text> : null}<LoadState loading={me.loading && !me.data} error={me.error} onRetry={me.reload} /></>;
}
function Balances({ block }: { block: MobileBlock }) {
  const { signOut, employmentId } = useSession(), { design } = useTenantDesign();
  const leave = useApi('leave', { employmentId: employmentId ?? undefined }, signOut);
  return <><LoadState loading={leave.loading && !leave.data} error={leave.error} onRetry={leave.reload} />{leave.data?.cards.map(c => <View key={c.leaveTypeId} style={{ gap: 6, marginBottom: 10 }}><Row label={c.leaveType} value={fmtDays(c.takenOnly ? c.taken : c.isCurrentCycle ? c.canApplyFor : c.balance)} strong />{block.detail === 'expanded' && <Muted>{c.takenOnly ? t('taken') : c.isCurrentCycle ? t('canApplyFor') : t('balance')}</Muted>}{c.sharedPool && <Muted>{t('sharedPool')}</Muted>}</View>)}{leave.data?.cards.length === 0 && <Muted>{t('noLeaveTypes')}</Muted>}<Button title={t('tabRequests')} kind="quiet" onPress={() => router.push(mobileDestination('requests'))} /></>;
}
function Messages({ block }: { block: MobileBlock }) {
  const { signOut } = useSession(), { palette } = useTenantDesign(), inbox = useApi('notifications', {}, signOut);
  if (inbox.data && !inbox.data.enabled) return null;
  return <><LoadState loading={inbox.loading && !inbox.data} error={inbox.error} onRetry={inbox.reload} />{block.kind === 'tasks' ? <><Muted>{inbox.data?.unread ? t('unreadCount', { n: inbox.data.unread }) : t('nothingNeedsYou')}</Muted><Button title={t('tabInbox')} kind="quiet" onPress={() => router.push('/inbox')} /></> : <>{inbox.data?.items.slice(0, block.detail === 'compact' ? 3 : 20).map(n => <View key={n.id} style={{ gap: 6, marginBottom: 12 }}><Text style={{ color: palette.text, fontWeight: n.readAt ? '400' : '700' }}>{n.title}</Text><Muted>{n.body}</Muted></View>)}{inbox.data?.items.length === 0 && <Muted>{t('inboxEmpty')}</Muted>}</>}</>;
}
function Requests({ block }: { block: MobileBlock }) {
  const { signOut, employmentId } = useSession(), requests = useApi('leave-requests', { employmentId: employmentId ?? undefined }, signOut);
  return <><LoadState loading={requests.loading && !requests.data} error={requests.error} onRetry={requests.reload} />{requests.data?.items.slice(0, block.detail === 'compact' ? 3 : 20).map(r => <View key={r.id} style={{ gap: 6, marginBottom: 12 }}><Row label={r.type} value={r.status} /><Muted>{r.from} → {r.to}</Muted></View>)}{requests.data?.items.length === 0 && <Muted>{t('noRequests')}</Muted>}<Button title={t('tabRequests')} kind="quiet" onPress={() => router.push('/leave')} /></>;
}
function Pay({ block }: { block: MobileBlock }) {
  const { signOut } = useSession(), pay = useApi('payslips', {}, signOut);
  if (pay.data && !pay.data.enabled) return null;
  return <><LoadState loading={pay.loading && !pay.data} error={pay.error} onRetry={pay.reload} />{pay.data?.items.slice(0, block.detail === 'compact' ? 1 : 20).map(p => <View key={p.id} style={{ marginBottom: 12 }}><Row label={p.payPeriod} value={fmtMoney(p.net)} strong /><Muted>{t('netPay')}</Muted></View>)}{pay.data?.items.length === 0 && <Muted>{t('noPayslips')}</Muted>}</>;
}
function Profile() {
  const { signOut } = useSession(), me = useApi('me', {}, signOut);
  return <><LoadState loading={me.loading && !me.data} error={me.error} onRetry={me.reload} />{me.data && <><Title>{me.data.person.name}</Title><Muted>{me.data.person.email}</Muted></>}<Button title={t('tabMe')} kind="quiet" onPress={() => router.push('/me')} /></>;
}
function Widget({ block, refreshToken, design }: { block: MobileBlock; refreshToken: number; design: MobileDesignV2 }) {
  const { palette } = useTenantDesign();
  switch (block.kind) {
    case 'welcome': return <Welcome block={block} />;
    case 'clock': return <ClockPanel refreshToken={refreshToken} />;
    case 'leave': return <Balances key={refreshToken} block={block} />;
    case 'team': return <TeamPanel refreshToken={refreshToken} />;
    case 'tasks': case 'inbox': return <Messages key={refreshToken} block={block} />;
    case 'requests': return <Requests key={refreshToken} block={block} />;
    case 'pay': return <Pay key={refreshToken} block={block} />;
    case 'profile': return <Profile key={refreshToken} />;
    case 'text': return <>{block.title ? <Title>{block.title}</Title> : null}{block.body ? <Text style={{ color: palette.text, lineHeight: design.composition.typography.bodySize * 1.6 }}>{block.body}</Text> : null}</>;
    case 'action': return <Button title={block.title || destinationTitle(block.target, design)} onPress={() => router.push(mobileDestination(block.target))} />;
    case 'divider': return <View style={{ height: 1, backgroundColor: palette.border }} />;
    case 'space': return <View style={{ height: block.size }} />;
  }
}
export function ComposedPage({ design, id = 'home' }: { design: MobileDesignV2; id?: string }) {
  const { palette } = useTenantDesign(), [tick, setTick] = useState(0);
  const c = design.composition, page = c.pages.find(p => p.id === id), gap = c.layout.gap;
  return <Screen onRefresh={() => setTick(n => n + 1)}>{page ? <>{page.title ? <Title>{page.title}</Title> : null}<View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -gap / 2 }}>{page.blocks.map(block => {
    const surface = block.surface === 'inherit' ? c.layout.surface === 'flat' ? 'plain' : 'card' : block.surface;
    return <View key={block.id} style={{ width: block.width === 'half' ? '50%' : '100%', paddingHorizontal: gap / 2, marginBottom: gap }}><TenantSurface band={surface === 'band'} align={block.align}><View style={{ gap: 12, minWidth: 0, padding: surface === 'plain' ? 0 : 16, borderRadius: c.layout.radius, backgroundColor: surface === 'band' ? palette.button : surface === 'card' ? palette.card : 'transparent', borderWidth: surface === 'card' && c.layout.surface === 'outline' ? 1 : 0, borderColor: palette.border, ...(surface === 'card' && c.layout.surface === 'raised' ? { shadowColor: '#000', shadowOpacity: .08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 } : {}) }}>{block.title && !['welcome', 'text', 'action'].includes(block.kind) ? <Text style={{ color: surface === 'band' ? palette.onButton : palette.text, fontSize: 21, fontWeight: '600' }}>{block.title}</Text> : null}<Widget block={block} design={design} refreshToken={tick} /></View></TenantSurface></View>;
  })}</View></> : <><Title>{t('tabHome')}</Title><Button title={t('tabHome')} onPress={() => router.replace('/')} /></>}</Screen>;
}
