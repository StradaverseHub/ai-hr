import { Redirect, Tabs } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { useTenantDesign } from '../../lib/design';

/** SF Symbol on iOS, the matching Material symbol on Android (expo-symbols, as the SDK 57 template does). */
const icon = (name: SymbolViewProps['name']) => ({ color, size }: { color: ColorValue; size: number }) => (
  <SymbolView name={name} tintColor={color} size={size} />
);

/** Home · Leave · Inbox · Me. Clock joins when the clock endpoint does (ADR-0088 phase 1, next slice). */
export default function TabsLayout() {
  const { status } = useSession();
  const { palette, design, reduceMotion } = useTenantDesign();
  if (status !== 'signedIn') return <Redirect href="/sign-in" />;
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: palette.accent, tabBarInactiveTintColor: palette.muted, tabBarStyle: { backgroundColor: palette.bg, borderTopColor: palette.border }, animation: reduceMotion ? 'none' : 'fade' }}>
      <Tabs.Screen name="index" options={{ title: t('tabHome'), tabBarIcon: icon({ ios: 'house', android: 'home' }) }} />
      {design.navigationOrder.filter(id => id !== 'clock').map(id => id === 'requests'
        ? <Tabs.Screen key={id} name="leave" options={{ title: t('tabLeave'), tabBarIcon: icon({ ios: 'calendar', android: 'calendar_month' }) }} />
        : <Tabs.Screen key={id} name="inbox" options={{ title: t('tabInbox'), tabBarIcon: icon({ ios: 'bell', android: 'notifications' }) }} />)}
      <Tabs.Screen name="me" options={{ title: t('tabMe'), tabBarIcon: icon({ ios: 'person.crop.circle', android: 'person' }) }} />
    </Tabs>
  );
}
