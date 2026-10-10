import { router, useGlobalSearchParams, usePathname } from 'expo-router';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { MobileDesignV2 } from '../../lib/mobile-design';
import { DesignText as Text, useTenantDesign } from './design';
import { destinationTitle, mobileDestination } from './composed-page';
const icons: Record<string, SymbolViewProps['name']> = {
  home: { ios: 'house', android: 'home' }, clock: { ios: 'clock', android: 'schedule' },
  calendar: { ios: 'calendar', android: 'calendar_month' }, bell: { ios: 'bell', android: 'notifications' },
  person: { ios: 'person.crop.circle', android: 'person' }, grid: { ios: 'square.grid.2x2', android: 'grid_view' },
  users: { ios: 'person.2', android: 'group' }, arrow: { ios: 'arrow.up.right', android: 'arrow_outward' },
};
export function TenantNavigation({ design }: { design: MobileDesignV2 }) {
  const { palette } = useTenantDesign(), path = usePathname(), { id } = useGlobalSearchParams<{ id: string }>();
  const c = design.composition, dock = c.navigation.style === 'dock';
  const current = path === '/' ? 'home' : path === '/leave' ? 'requests' : path === '/custom' ? id : path.slice(1);
  return <SafeAreaView edges={[c.navigation.style === 'top' ? 'top' : 'bottom']} style={{ backgroundColor: palette.bg }}><View style={{ flexDirection: 'row', backgroundColor: dock ? palette.card : palette.bg, borderTopWidth: dock ? 0 : 1, borderWidth: dock ? 1 : 0, borderColor: palette.border, borderRadius: dock ? c.layout.radius : 0, marginHorizontal: dock ? 12 : 0, marginVertical: dock ? 8 : 0 }}>{c.navigation.items.map(item => {
    const selected = current === item.target || current === 'requests' && item.target === 'leave';
    const color = selected ? palette.accent : palette.muted, label = item.label || destinationTitle(item.target, design);
    return <Pressable key={item.target} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={() => router.navigate(mobileDestination(item.target))} style={{ flex: 1, minWidth: 0, minHeight: 58, gap: 4, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 3, paddingVertical: 8 }}><SymbolView name={icons[item.icon]} tintColor={color} size={21} />{c.navigation.labels ? <Text numberOfLines={2} style={{ color, fontSize: 11, textAlign: 'center' }}>{label}</Text> : null}</Pressable>;
  })}</View></SafeAreaView>;
}
