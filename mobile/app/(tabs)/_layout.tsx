import { DailyNavigation } from '../../lib/daily-navigation';
import { Redirect, Tabs } from 'expo-router';
import { View } from 'react-native';
import { TenantNavigation } from '../../lib/tenant-navigation';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { useTenantDesign } from '../../lib/design';

/** Five default destinations; published tenant navigation retains its own renderer. */
export default function TabsLayout() {
  const { status } = useSession();
  const { palette, design, reduceMotion } = useTenantDesign();
  if (status !== 'signedIn') return <Redirect href="/sign-in" />;
  if (design.schemaVersion === 2) return <View style={{ flex: 1, backgroundColor: palette.bg }}>{design.composition.navigation.style === 'top' && <TenantNavigation design={design} />}<Tabs tabBar={() => design.composition.navigation.style === 'top' ? null : <TenantNavigation design={design} />} screenOptions={{ headerShown: false, animation: reduceMotion ? 'none' : 'fade' }}>{['index', 'clock', 'leave', 'inbox', 'me', 'custom', 'team', 'work'].map(name => <Tabs.Screen key={name} name={name} />)}</Tabs></View>;
  return (
    <Tabs tabBar={() => <DailyNavigation />} screenOptions={{headerShown:false,animation:'none'}}>
      <Tabs.Screen name="index" options={{title:t('tabHome')}}/>
      <Tabs.Screen name="clock" options={{title:t('tabClock')}}/>
      <Tabs.Screen name="leave" options={{title:t('tabLeave')}}/>
      <Tabs.Screen name="work" options={{title:t('approvalsTitle')}}/>
      <Tabs.Screen name="me" options={{title:t('tabMe')}}/>
      <Tabs.Screen name="inbox" options={{href:null}}/>
      <Tabs.Screen name="custom" options={{href:null}}/>
      <Tabs.Screen name="team" options={{href:null}}/>
    </Tabs>
  );
}
