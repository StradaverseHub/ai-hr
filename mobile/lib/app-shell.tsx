/** One signed-in frame for tab pages, pushed forms, loading states and detail screens. */
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { TenantBrand, useTenantDesign } from './design';
import { Icon } from './icon';
import { t } from './i18n';
import { DailyNavigation } from './daily-navigation';
import { TenantNavigation } from './tenant-navigation';
import { InAppAlertBoundary } from './in-app-alert';

export function SignedInShell({ children }: { children: ReactNode }) {
  const { palette, design } = useTenantDesign();
  return <InAppAlertBoundary><View style={{ flex: 1, backgroundColor: palette.bg }}>
    <SafeAreaView edges={['top']} style={{ backgroundColor: palette.bg }}>
      <View style={{ minHeight: 56, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, paddingVertical: 10 }}><TenantBrand /></View>
        <Pressable accessibilityRole="button" accessibilityLabel={t('qaSettings')} onPress={() => router.navigate('/settings')}
          style={({ pressed }) => ({ minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .65 : 1 })}>
          <Icon name="settings" size={23} color={palette.text} />
        </Pressable>
      </View>
    </SafeAreaView>
    {design.schemaVersion === 2 && design.composition.navigation.style === 'top' && <TenantNavigation design={design} inline />}
    <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
    {/* In normal flow: fixed page actions end above navigation instead of underneath it. */}
    {design.schemaVersion === 2 && design.composition.navigation.style !== 'top' ? <TenantNavigation design={design} inline /> : <DailyNavigation inline />}
  </View></InAppAlertBoundary>;
}
