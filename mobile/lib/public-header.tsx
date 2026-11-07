import { Pressable, View } from 'react-native';
import { DesignText as Text, useTenantDesign } from './design';
import { setDisplayPref } from './preferences';
import { t } from './i18n';

/** Public appearance controls never enter the authenticated navigator. */
export function PublicHeader() {
  const { palette, appearance } = useTenantDesign();
  return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, paddingBottom: 24 }}>
    <Text style={{ color: palette.text, fontSize: 24, fontWeight: '800', letterSpacing: -.7 }}>OneHR+</Text>
    <View style={{ flexDirection: 'row', gap: 12 }}>
      {(['light', 'dark'] as const).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: appearance === value }}
        onPress={() => setDisplayPref('appearance', value)}
        style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', borderBottomWidth: appearance === value ? 2 : 0, borderColor: palette.accent }}>
        <Text style={{ color: palette.text, fontSize: 13, fontWeight: appearance === value ? '700' : '400' }}>{t(value === 'light' ? 'appearanceLight' : 'appearanceDark')}</Text>
      </Pressable>)}
    </View>
  </View>;
}
