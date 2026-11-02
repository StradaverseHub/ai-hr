import { router, usePathname, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import { DesignText as Text, useTenantDesign } from './design';
import { t } from './i18n';
import { dailyDestinationForPath } from './navigation-routes';

const destinations = [
  { path: '/', label: 'tabHome', icon: { ios: 'house.fill', android: 'home' } },
  { path: '/clock', label: 'tabClock', icon: { ios: 'clock', android: 'schedule' } },
  { path: '/leave', label: 'tabLeave', icon: { ios: 'calendar', android: 'calendar_month' } },
  { path: '/work', label: 'approvalsTitle', icon: { ios: 'checkmark.seal', android: 'approval' } },
  { path: '/me', label: 'tabMe', icon: { ios: 'person.crop.circle', android: 'person' } },
] as const;

/** Full labels take their intrinsic width; very large text wraps whole tabs instead of splitting words. */
export function DailyNavigation({ inline = false }: { inline?: boolean } = {}) {
  const { palette, appearance } = useTenantDesign();
  const path = dailyDestinationForPath(usePathname());
  return <SafeAreaView edges={['bottom']} style={inline ? { backgroundColor: palette.bg } : { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'transparent' }}>
    <View style={{ marginHorizontal: 12, marginBottom: 6, padding: 5, maxWidth: 560, width: '94%', alignSelf: 'center', flexDirection: 'row', flexWrap: 'wrap', borderRadius: 27, borderCurve: 'continuous', borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card, boxShadow: '0px 4px 16px rgba(0,0,0,0.10)' }}>
      {destinations.map(item => {
        const selected = path === item.path;
        const color = selected ? appearance === 'dark' ? palette.button : palette.text : palette.muted;
        return <Pressable key={item.path} accessibilityRole="tab" accessibilityLabel={t(item.label)} accessibilityState={{ selected }} onPress={() => router.navigate(item.path as Href)}
          style={({ pressed }) => ({ flexGrow: 1, flexShrink: 0, flexBasis: 'auto', minWidth: 48, maxWidth: '100%', minHeight: 52, paddingVertical: 7, paddingHorizontal: 4, gap: 5, alignItems: 'center', justifyContent: 'center', borderRadius: 22, opacity: pressed ? .65 : 1 })}>
          <SymbolView name={item.icon} tintColor={color} size={22}/>
          <Text style={{ color, fontSize: 11, fontWeight: selected ? '700' : '400', textAlign: 'center' }}>{t(item.label)}</Text>
        </Pressable>;
      })}
    </View>
  </SafeAreaView>;
}
