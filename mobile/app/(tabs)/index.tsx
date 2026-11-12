import { useRouter } from 'expo-router';
import { HomeApprovalQueue } from '../../lib/approval-decision';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { ComposedPage } from '../../lib/composed-page';
import { useTenantDesign } from '../../lib/design';
import { HomeHero, QuickActions, SectionHeader, useHomeSummary, type QuickAction } from '../../lib/home-hero';
import { LeaveSummary } from '../../lib/home-cards';
import { homeNeedsView } from '../../lib/inbox';
import { TodayComingUpList, TodayHours, TodayPayday, TodayReminders, TodaySteps, tt, useToday } from '../../lib/today';
/** Default Home is Today (owner decision, 12 November 2026); published schema-2 tenant compositions retain their
 * renderer. The shared clock journey prepares and reviews on Home. Counts and every Today fact remain server-authorized:
 * Today's sections come from GET /api/mobile/v2/today, each failing on its own; leave and approvals keep their owners.
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
  const router = useRouter();
  const { palette, reload: reloadDesign } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const me = useApi('me', {}, signOut);
  const [refreshToken, setRefreshToken] = useState(0);
  const summary = useHomeSummary(signOut, refreshToken);
  const today = useToday(refreshToken);
  const needs = homeNeedsView(summary);
  const reloadAll = () => { reloadDesign(); me.reload(); setRefreshToken((n) => n + 1); };
  const actions: QuickAction[] = [
    {key:'leave',icon:'leave',label:'qaApplyLeave',href:'/leave'},
    ...(me.data?.modules.payroll === false ? [] : [{key:'pay',icon:'payslip',label:'qaPayslips',href:'/pay'} as const]),
  ];
  const unread = typeof needs.inbox === 'number' ? needs.inbox : 0;
  const data = today.data;

  return <ScrollView style={{ flex: 1, backgroundColor: palette.bg }} contentContainerStyle={{ paddingBottom: 32 }}
    refreshControl={<RefreshControl refreshing={(me.loading && me.data != null) || (today.loading && data != null)} onRefresh={reloadAll} />}>
    <HomeHero name={me.data?.person.name ?? null} unread={unread} refreshToken={refreshToken} companyName={me.data?.employments.find(item => item.employmentId === employmentId)?.company ?? me.data?.employments[0]?.company} />
    <View style={{ paddingHorizontal: 20, paddingTop: 0, gap: 16 }}>
      {me.error && <LoadState loading={false} hasData={me.data != null} error={me.error} onRetry={me.reload} />}
      <QuickActions actions={actions} />
      <View style={{ gap: 8, paddingTop: 8 }}>
        <SectionHeader title={tt('remindersTitle')} />
        {/* One load state for Today: a first read spins, a failed read says so with a retry (kept data stays shown). */}
        {(!data || today.error) && <LoadState loading={today.loading && !data} hasData={data != null} error={today.error} onRetry={today.reload} />}
        {data && <TodayReminders section={data.reminders} onReload={today.reload} />}
      </View>
      {data && (data.steps.status === 'unavailable' || data.steps.items.length > 0 || data.steps.partial || data.steps.more > 0) && <View style={{ gap: 8, paddingTop: 8 }}>
        <SectionHeader title={tt('stepsTitle')} />
        <TodaySteps section={data.steps} onReload={today.reload} />
      </View>}
      <View style={{ gap: 8, paddingTop: 8 }}>
        <SectionHeader title={t('fieldReviewTitle')} count={typeof needs.tasks === 'number'?needs.tasks:undefined} action={typeof needs.tasks === 'number' ? t('homeTasksCount', {n: needs.tasks}) : undefined} onAction={() => router.navigate('/approvals')} />
        <HomeApprovalQueue refreshToken={refreshToken} />
      </View>
      {data && data.hours.status !== 'off' && <View style={{ gap: 8, paddingTop: 8 }}>
        <SectionHeader title={tt('weekTitle')} />
        <TodayHours section={data.hours} today={data.date} onReload={today.reload} />
      </View>}
      <View style={{ gap: 8, paddingTop: 8 }}>
        <SectionHeader title={t('homeYourLeave')} />
        <LeaveSummary refreshToken={refreshToken} />
      </View>
      {data && <View style={{ gap: 8, paddingTop: 8 }}>
        <SectionHeader title={tt('comingUpTitle')} />
        <TodayPayday section={data.payday} onReload={today.reload} />
        <TodayComingUpList section={data.comingUp} onReload={today.reload} />
      </View>}
    </View>
  </ScrollView>;
}
