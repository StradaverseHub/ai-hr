/**
 * The same bounded section tree used by the builder; each data widget consumes its existing authorized API.
 *
 * Home is a summary (mobile declutter round): on the `home` page the clock section is the compact clock card (it opens
 * the Clock tab; Home never clocks), tasks are the two "Needs you" rows, balances are at most three, Who's away is the
 * one away-today row and pay is the latest payslip as one row. A custom page keeps each section's tenant-chosen detail —
 * except clocking, which happens only on the Clock tab, so the clock section is the compact card everywhere.
 * Expense claims are not in the app: the composition catalogue (lib/mobile-composition.ts) has never offered a claims
 * section or destination, and a design naming one is refused by its parser, so no stored design can carry one.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { router, type Href } from 'expo-router';
import type { MobileBlock, MobileDesignV2 } from '../../lib/mobile-design';
import { MOBILE_DESTINATIONS } from '../../lib/mobile-composition';
import { useApi, useApiV2 } from './api';
import { TasksPageV2 } from '../../lib/mobile-api/v2/tasks';
import { ClockSummary, LeaveSummary, PayslipRow } from './home-cards';
import { HomeNeeds } from './inbox';
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
  const keys: Record<string, Parameters<typeof t>[0]> = { home: 'tabHome', clock: 'tabClock', requests: 'tabLeave', leave: 'tabLeave', inbox: 'tabInbox', me: 'tabMe', team: 'teamAvailability' };
  return MOBILE_DESTINATIONS.includes(target as typeof MOBILE_DESTINATIONS[number]) ? t(keys[target]) : design.composition.pages.find(p => p.id === target)?.title || t('tabHome');
}
function Welcome({ block }: { block: MobileBlock }) {
  const { signOut } = useSession(), { palette } = useTenantDesign(), me = useApi('me', {}, signOut);
  return <><Title>{block.title || (me.data?.person.name ? t('hello', { name: me.data.person.name }) : t('helloNoName'))}</Title>{block.body ? <Text style={{ color: palette.muted }}>{block.body}</Text> : null}<LoadState loading={me.loading} hasData={me.data!=null} error={me.error} onRetry={me.reload} /></>;
}
function Balances({ block }: { block: MobileBlock }) {
  const { signOut, employmentId } = useSession(), { design } = useTenantDesign();
  const leave = useApi('leave', { employmentId: employmentId ?? undefined }, signOut);
  return <><LoadState loading={leave.loading} hasData={leave.data!=null} error={leave.error} onRetry={leave.reload} />{leave.data?.cards.map(c => <View key={c.leaveTypeId} style={{ gap: 6, marginBottom: 10 }}><Row label={c.leaveType} value={fmtDays(c.takenOnly ? c.taken : c.isCurrentCycle ? c.canApplyFor : c.balance)} strong />{block.detail === 'expanded' && <Muted>{c.takenOnly ? t('taken') : c.isCurrentCycle ? t('canApplyFor') : t('balance')}</Muted>}{c.sharedPool && <Muted>{t('sharedPool')}</Muted>}</View>)}{leave.data?.cards.length === 0 && <Muted>{t('noLeaveTypes')}</Muted>}<Button title={t('allBalances')} kind="quiet" onPress={() => router.push(mobileDestination('requests'))} /></>;
}
function Messages({ block }: { block: MobileBlock }) {
  const { signOut } = useSession(), { palette } = useTenantDesign(), inbox = useApi('notifications', {}, signOut);
  if (inbox.data && !inbox.data.enabled) return null;
  return <><LoadState loading={inbox.loading} hasData={inbox.data!=null} error={inbox.error} onRetry={inbox.reload} /><>{inbox.data?.items.slice(0, block.detail === 'compact' ? 3 : 20).map(n => <View key={n.id} style={{ gap: 6, marginBottom: 12 }}><Text style={{ color: palette.text, fontWeight: n.readAt ? '400' : '700' }}>{n.title}</Text><Muted>{n.body}</Muted></View>)}{inbox.data?.items.length === 0 && <Muted>{t('inboxEmpty')}</Muted>}</></>;
}
/** M14 — the canonical v2 task list (every kind the approvals screen lists; v1 `tasks` stays for installed clients).
 *  "Nothing needs you" only for a settled, successful, empty first page: never while loading, failed or stale. */
function Tasks({ block }: { block: MobileBlock }) {
  const { signOut } = useSession(), tasks = useApiV2('v2/tasks', TasksPageV2, { limit: block.detail === 'compact' ? '4' : '20' }, signOut);
  const items = tasks.data?.items ?? [], settled = tasks.data != null && !tasks.loading && !tasks.error;
  return <><LoadState loading={tasks.loading} hasData={tasks.data!=null} error={tasks.error} onRetry={tasks.reload} />{items.map(item => <View key={`${item.kind}:${item.id}`} style={{ marginBottom: 12 }}><Row label={t(`task_${item.kind}`)} value={item.subject.name || '—'} /></View>)}{settled && items.length === 0 && <Muted>{t('nothingNeedsYou')}</Muted>}{items.length > 0 && <Button title={t('openApprovals')} kind="quiet" onPress={() => router.push('/approvals')} />}</>;
}
function Requests({ block }: { block: MobileBlock }) {
  const { signOut, employmentId } = useSession(), requests = useApi('leave-requests', { employmentId: employmentId ?? undefined }, signOut);
  return <><LoadState loading={requests.loading} hasData={requests.data!=null} error={requests.error} onRetry={requests.reload} />{requests.data?.items.slice(0, block.detail === 'compact' ? 3 : 20).map(r => <View key={r.id} style={{ gap: 6, marginBottom: 12 }}><Row label={r.type} value={r.status} /><Muted>{r.from} → {r.to}</Muted></View>)}{requests.data?.items.length === 0 && <Muted>{t('noRequests')}</Muted>}<Button title={t('tabLeave')} kind="quiet" onPress={() => router.push('/leave')} /></>;
}
function Pay({ block }: { block: MobileBlock }) {
  const { signOut } = useSession(), pay = useApi('payslips', {}, signOut);
  if (pay.data && !pay.data.enabled) return null;
  return <><LoadState loading={pay.loading} hasData={pay.data!=null} error={pay.error} onRetry={pay.reload} />{pay.data?.items.slice(0, block.detail === 'compact' ? 1 : 20).map(p => <View key={p.id} style={{ marginBottom: 12 }}><Row label={p.payPeriod} value={fmtMoney(p.net)} strong /><Muted>{t('netPay')}</Muted></View>)}{pay.data?.items.length === 0 && <Muted>{t('noPayslips')}</Muted>}</>;
}
function Profile() {
  const { signOut } = useSession(), me = useApi('me', {}, signOut);
  return <><LoadState loading={me.loading} hasData={me.data!=null} error={me.error} onRetry={me.reload} />{me.data && <><Title>{me.data.person.name}</Title><Muted>{me.data.person.email}</Muted></>}<Button title={t('tabMe')} kind="quiet" onPress={() => router.push('/me')} /></>;
}
function Widget({ block, refreshToken, design, home }: { block: MobileBlock; refreshToken: number; design: MobileDesignV2; home: boolean }) {
  const { palette } = useTenantDesign();
  const summary: MobileBlock = home ? { ...block, detail: 'compact' } : block;
  switch (block.kind) {
    case 'welcome': return <Welcome block={block} />;
    case 'clock': return <ClockSummary refreshToken={refreshToken} />;
    case 'leave': return home ? <LeaveSummary refreshToken={refreshToken} /> : <Balances key={refreshToken} block={block} />;
    case 'team': return <TeamPanel refreshToken={refreshToken} compact={home} />;
    case 'tasks': return home ? <HomeNeeds refreshToken={refreshToken} /> : <Tasks key={refreshToken} block={block} />;
    case 'inbox': return <Messages key={refreshToken} block={summary} />;
    case 'requests': return <Requests key={refreshToken} block={summary} />;
    case 'pay': return home ? <PayslipRow refreshToken={refreshToken} /> : <Pay key={refreshToken} block={block} />;
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
    return <View key={block.id} style={{ width: block.width === 'half' ? '50%' : '100%', paddingHorizontal: gap / 2, marginBottom: gap }}><TenantSurface band={surface === 'band'} align={block.align}><View style={{ gap: 12, minWidth: 0, padding: surface === 'plain' ? 0 : 16, borderRadius: c.layout.radius, backgroundColor: surface === 'band' ? palette.button : surface === 'card' ? palette.card : 'transparent', borderWidth: surface === 'card' && c.layout.surface === 'outline' ? 1 : 0, borderColor: palette.border, ...(surface === 'card' && c.layout.surface === 'raised' ? { shadowColor: '#000', shadowOpacity: .08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 } : {}) }}>{block.title && !['welcome', 'text', 'action'].includes(block.kind) ? <Text style={{ color: surface === 'band' ? palette.onButton : palette.text, fontSize: 21, fontWeight: '600' }}>{block.title}</Text> : null}<Widget block={block} design={design} refreshToken={tick} home={page.id === 'home'} /></View></TenantSurface></View>;
  })}</View></> : <><Title>{t('tabHome')}</Title><Button title={t('tabHome')} onPress={() => router.replace('/')} /></>}</Screen>;
}
