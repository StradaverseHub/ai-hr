import { Redirect, Tabs } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { View } from 'react-native';
import { TenantNavigation } from '../../lib/tenant-navigation';
import type { ColorValue } from 'react-native';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { useTenantDesign } from '../../lib/design';

/** SF Symbol on iOS, the matching Material symbol on Android (expo-symbols, as the SDK 57 template does). */
const icon = (name: SymbolViewProps['name']) => ({ color, size }: { color: ColorValue; size: number }) => (
  <SymbolView name={name} tintColor={color} size={size} />
);

/** One shared app. Published tenant order arranges Clock, Requests and Inbox between Home and Me. */
export default function TabsLayout() {
  const { status } = useSession();
  const { palette, design, reduceMotion } = useTenantDesign();
  if (status !== 'signedIn') return <Redirect href="/sign-in" />;
  if (design.schemaVersion === 2) return <View style={{ flex: 1, backgroundColor: palette.bg }}>{design.composition.navigation.style === 'top' && <TenantNavigation design={design} />}<Tabs tabBar={() => design.composition.navigation.style === 'top' ? null : <TenantNavigation design={design} />} screenOptions={{ headerShown: false, animation: reduceMotion ? 'none' : 'fade' }}>{['index', 'clock', 'leave', 'inbox', 'me', 'custom', 'team'].map(name => <Tabs.Screen key={name} name={name} />)}</Tabs></View>;
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: palette.accent, tabBarInactiveTintColor: palette.muted, tabBarStyle: { backgroundColor: palette.bg, borderTopColor: palette.border }, animation: reduceMotion ? 'none' : 'fade' }}>
      <Tabs.Screen name="index" options={{ title: t('tabHome'), tabBarIcon: icon({ ios: 'house', android: 'home' }) }} />
      {design.navigationOrder.map(id => id === 'clock' ? <Tabs.Screen key={id} name="clock" options={{title:t('tabClock'),tabBarIcon:icon({ios:'clock',android:'schedule'})}} /> : id === 'requests'
        ? <Tabs.Screen key={id} name="leave" options={{ title: t('tabRequests'), tabBarIcon: icon({ ios: 'calendar', android: 'calendar_month' }) }} />
        : <Tabs.Screen key={id} name="inbox" options={{ title: t('tabInbox'), tabBarIcon: icon({ ios: 'bell', android: 'notifications' }) }} />)}
      <Tabs.Screen name="me" options={{ title: t('tabMe'), tabBarIcon: icon({ ios: 'person.crop.circle', android: 'person' }) }} />
      <Tabs.Screen name="custom" options={{ href: null }} />
      <Tabs.Screen name="team" options={{ href: null }} />
    </Tabs>
  );
}
