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
  const { palette } = useTenantDesign();
  const dark = mobileSurfaceIsDark(palette);
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let live = true;
    if (Platform.OS !== 'ios' || !blur) return;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(v => { if (live) setReduced(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduced);
    return () => { live = false; sub.remove(); };
  }, [blur]);
  return <View style={[{ overflow: 'hidden', borderRadius: 24, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, borderColor: alpha(palette.text, dark ? .14 : .13), backgroundColor: alpha(palette.card, blur && !reduced ? .66 : .90) }, style]}>
    {blur && !reduced && Platform.OS === 'ios' && <BlurView pointerEvents="none" tint={dark ? 'dark' : 'light'} intensity={42} style={StyleSheet.absoluteFill} />}
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { experimental_backgroundImage: `linear-gradient(155deg, ${alpha(palette.text, dark ? .07 : .03)} 0%, transparent 46%, ${alpha(palette.accent, .07)} 100%)` }]} />
    {children}
  </View>;
}

const SEGMENTS: Record<string, string> = { '0': 'abcedf', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd' };
/** A real numeric instrument, rather than a decorative picture with a fabricated time. */
export function TimeDisplay({ seconds, label, compact = false }: { seconds: number; label: string; compact?: boolean }) {
  const { palette } = useTenantDesign();
  const dark = mobileSurfaceIsDark(palette);
  const text = `${Math.floor(Math.max(0, seconds) / 3600).toString().padStart(2, '0')}:${Math.floor(Math.max(0, seconds) % 3600 / 60).toString().padStart(2, '0')}`;
  return <View accessible accessibilityLabel={label} accessibilityRole="text" style={{ padding: 7, borderRadius: 28, borderCurve: 'continuous', borderWidth: 1, borderColor: dark ? '#6c7b70' : '#728977', backgroundColor: dark ? '#0a0e0c' : '#63766a', boxShadow: '0px 9px 22px rgba(0,0,0,0.28)' }}>
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ borderRadius: 21, paddingHorizontal: 18, paddingVertical: compact ? 21 : 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: dark ? '#b4c8af' : '#e5efdc', experimental_backgroundImage: `linear-gradient(155deg, ${dark ? '#bfd1b8' : '#f5f7e9'} 0%, ${dark ? '#7a9b8c' : '#bfd3c2'} 100%)` }}>
      {text.split('').map((digit, index) => digit === ':' ? <View key={index} style={{ gap: 22, paddingHorizontal: 2 }}>{[0, 1].map(v => <View key={v} style={{ width: 5, height: 5, backgroundColor: '#142c22', borderRadius: 1 }} />)}</View> : <View key={index} style={{ width: compact ? 31 : 38, height: compact ? 55 : 68 }}>
        {Object.entries({ a: { top: 0, left: '12%', width: '76%', height: '9%' }, g: { top: '45.5%', left: '12%', width: '76%', height: '9%' }, d: { bottom: 0, left: '12%', width: '76%', height: '9%' }, f: { top: '9%', left: 0, width: '14%', height: '36%' }, b: { top: '9%', right: 0, width: '14%', height: '36%' }, e: { bottom: '9%', left: 0, width: '14%', height: '36%' }, c: { bottom: '9%', right: 0, width: '14%', height: '36%' } }).map(([segment, position]) => <View key={segment} style={{ position: 'absolute', ...position, borderRadius: 2, backgroundColor: '#142c22', opacity: SEGMENTS[digit]?.includes(segment) ? 1 : .045 } as ViewStyle} />)}
      </View>)}
    </View>
  </View>;
}

export function StatusPill({ label }: { label: string }) {
  const { palette } = useTenantDesign();
  return <View style={{ alignSelf: 'flex-start', borderRadius: 20, backgroundColor: alpha(palette.accent, .12), paddingHorizontal: 10, paddingVertical: 5 }}><Text style={{ color: palette.accent, fontSize: 12, fontWeight: '500' }}>{label}</Text></View>;
}
