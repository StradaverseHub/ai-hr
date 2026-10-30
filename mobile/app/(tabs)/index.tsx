import { useState } from 'react';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';
import { ComposedPage } from '../../lib/composed-page';
import { useTenantDesign } from '../../lib/design';
import { BalanceStrip, HomeHero, NeedsYouBanner, PayslipCard, QuickActions, Reveal, SectionHeader, useHomeSummary, type QuickAction } from '../../lib/home-hero';
import { homeNeedsView } from '../../lib/inbox';
import { TeamPanel } from '../../lib/team-panel';
/**
 * Home — the Mobile WOW round. A tenant that composed its own pages (schema 2) keeps its published composition; every
 * other tenant gets the branded home: the hero (greeting, inbox, profile and today's clock card, which OPENS the Clock
 * tab), what needs me, one grid of quick actions for every employee journey, leave balances, who is away and the latest
 * payslip. Each card reads the endpoint its own screen reads; Home records nothing. "Needs you" stays truthful (M14):
 * never "nothing needs you" while a count is loading or failed.
 */
import { useApi } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { LoadState } from '../../lib/ui';

export default function Home() {
  const { design } = useTenantDesign();
  return design.schemaVersion === 2 ? <ComposedPage design={design} /> : <BrandedHome />;
}

function BrandedHome() {
  const { palette, reload: reloadDesign } = useTenantDesign();
  const { signOut } = useSession();
  const me = useApi('me', {}, signOut);
  const [refreshToken, setRefreshToken] = useState(0);
  const summary = useHomeSummary(signOut, refreshToken);
  const needs = homeNeedsView(summary);
  const reloadAll = () => { reloadDesign(); me.reload(); setRefreshToken((n) => n + 1); };
  const payroll = me.data?.modules.payroll !== false;
  const actions: QuickAction[] = [
    { key: 'leave', icon: 'leave', label: 'qaApplyLeave', href: '/leave' },
    { key: 'ot', icon: 'overtime', label: 'qaOtPlan', href: '/attendance/ot-plan' },
    ...(payroll ? [{ key: 'pay', icon: 'payslip', label: 'qaPayslips', href: '/pay' } as const] : []),
    { key: 'attendance', icon: 'attendance', label: 'qaAttendance', href: '/attendance' },
    { key: 'approvals', icon: 'approvals', label: 'qaApprovals', href: '/approvals', badge: typeof needs.tasks === 'number' ? needs.tasks : undefined },
    { key: 'calendar', icon: 'teamCalendar', label: 'qaTeamCalendar', href: '/team-calendar' },
    { key: 'directory', icon: 'directory', label: 'qaDirectory', href: '/directory' },
    payroll ? { key: 'profile', icon: 'profile', label: 'qaProfile', href: '/profile' } : { key: 'settings', icon: 'settings', label: 'qaSettings', href: '/settings' },
  ];
  const unread = typeof needs.inbox === 'number' ? needs.inbox : 0;

  return <ScrollView style={{ flex: 1, backgroundColor: palette.bg }} contentContainerStyle={{ paddingBottom: 36 }}
    refreshControl={<RefreshControl refreshing={me.loading && me.data != null} onRefresh={reloadAll} />}>
    <HomeHero name={me.data?.person.name ?? null} unread={unread} refreshToken={refreshToken} />
    <View style={{ paddingHorizontal: 16, paddingTop: 20, gap: 26 }}>
      {me.error && <LoadState loading={false} hasData={me.data != null} error={me.error} onRetry={me.reload} />}
      <Reveal index={0}><NeedsYouBanner summary={summary} /></Reveal>
      <Reveal index={1}><View style={{ gap: 14 }}><SectionHeader title={t('homeQuickActions')} /><QuickActions actions={actions} /></View></Reveal>
      <Reveal index={2}><BalanceStrip refreshToken={refreshToken} /></Reveal>
      <Reveal index={3}><View style={{ gap: 4 }}><SectionHeader title={t('homeWhosAway')} action={t('qaTeamCalendar')} onAction={() => router.push('/team-calendar')} /><TeamPanel refreshToken={refreshToken} compact hideTitle /></View></Reveal>
      {payroll && <Reveal index={4}><PayslipCard refreshToken={refreshToken} /></Reveal>}
    </View>
  </ScrollView>;
}
