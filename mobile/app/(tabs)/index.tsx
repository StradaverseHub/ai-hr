import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { ComposedPage } from '../../lib/composed-page';
import { useTenantDesign } from '../../lib/design';
import { HomeHero, NeedsYouBanner, QuickActions, Reveal, SectionHeader, useHomeSummary, type QuickAction } from '../../lib/home-hero';
import { homeNeedsView } from '../../lib/inbox';
/** Default Daily Switch Home; published schema-2 tenant compositions retain their renderer.
 * The shared clock journey prepares and reviews on Home. Counts remain server-authorized.
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
  const actions: QuickAction[] = [
    {key:'leave',icon:'leave',label:'qaApplyLeave',href:'/leave'},
    {key:'attendance',icon:'attendance',label:'qaAttendance',href:'/attendance'},
  ];
  const unread = typeof needs.inbox === 'number' ? needs.inbox : 0;

  return <ScrollView style={{ flex: 1, backgroundColor: palette.bg }} contentContainerStyle={{ paddingBottom: 130 }}
    refreshControl={<RefreshControl refreshing={me.loading && me.data != null} onRefresh={reloadAll} />}>
    <HomeHero name={me.data?.person.name ?? null} unread={unread} refreshToken={refreshToken} />
    <View style={{ paddingHorizontal: 20, paddingTop: 12, gap: 24 }}>
      {me.error && <LoadState loading={false} hasData={me.data != null} error={me.error} onRetry={me.reload} />}
      <Reveal index={0}><NeedsYouBanner summary={summary} /></Reveal>
      <Reveal index={1}><View style={{ gap: 14 }}><SectionHeader title={t('homeQuickActions')} /><QuickActions actions={actions} /></View></Reveal>

    </View>
  </ScrollView>;
}
