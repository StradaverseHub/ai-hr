/** Presentation only. The clock's value and every action remain owned by the existing journeys. */
import type { ReactNode } from 'react';
import { BlurView } from 'expo-blur';
import { AccessibilityInfo, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useEffect, useState } from 'react';
import { DesignText as Text, useTenantDesign } from './design';
import { mobileSurfaceIsDark } from '../../lib/mobile-design';

export function alpha(color: string, opacity: number): string {
  return /^#[\da-f]{6}$/i.test(color) ? color + Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0') : color;
}
export function Material({ children, style, blur = false }: { children?: ReactNode; style?: StyleProp<ViewStyle>; blur?: boolean }) {
  const { palette, design } = useTenantDesign();
  const dark = mobileSurfaceIsDark(palette);
  const [reduced, setReduced] = useState(Platform.OS === 'ios');
  useEffect(() => {
    let live = true;
    if (Platform.OS !== 'ios') return;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(v => { if (live) setReduced(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduced);
    return () => { live = false; sub.remove(); };
  }, [blur]);
  if (design.schemaVersion === 1) return <View style={[style, { borderRadius: 0, borderWidth: 0, borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border, backgroundColor: 'transparent', boxShadow: 'none', experimental_backgroundImage: undefined }]}>{children}</View>;

  return <View style={[{ overflow: 'hidden', borderRadius: 24, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, borderColor: alpha(palette.text, dark ? .14 : .13), backgroundColor: design.schemaVersion === 1 ? palette.card : alpha(palette.card, reduced ? 1 : blur ? .66 : .82) }, style]}>
    {blur && !reduced && Platform.OS === 'ios' && <BlurView pointerEvents="none" tint={dark ? 'dark' : 'light'} intensity={42} style={StyleSheet.absoluteFill} />}
    {design.schemaVersion === 2 && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { experimental_backgroundImage: `linear-gradient(155deg, ${alpha(palette.text, dark ? .07 : .03)} 0%, transparent 46%, ${alpha(palette.accent, .07)} 100%)` }]} />}
    {children}
  </View>;
}

/** Display-only elapsed time; attendance and capture decisions belong to the clock journey. */
export function TimeDisplay({ seconds, label, compact = false }: { seconds: number; label: string; compact?: boolean }) {
  const { palette } = useTenantDesign();
  const value = Math.max(0, seconds);
  const text = `${Math.floor(value / 3600).toString().padStart(2, '0')}:${Math.floor(value % 3600 / 60).toString().padStart(2, '0')}`;
  return <View accessible accessibilityRole="text" accessibilityLabel={label} style={{ paddingVertical: compact ? 8 : 16, gap: 4 }}>
    <Text style={{ color: palette.text, fontSize: compact ? 26 : 36, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{text}</Text>
    <Text style={{ color: palette.muted, fontSize: 14 }}>{label}</Text>
  </View>;
}

export function StatusPill({ label }: { label: string }) {
  const { palette } = useTenantDesign();
  return <View style={{ alignSelf: 'flex-start', borderRadius: 0, paddingHorizontal: 0, paddingVertical: 5 }}><Text style={{ color: palette.text, fontSize: 13, fontWeight: '600' }}>{label}</Text></View>;
}
