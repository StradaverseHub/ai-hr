/** Shared store app, tenant-owned presentation. Nothing is persisted across accounts or locks. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, AppState, Image, Text as NativeText, StyleSheet, Platform, type TextProps, useColorScheme, View } from 'react-native';
import { DEFAULT_MOBILE_DESIGN, mobilePalette, parseMobileDesign, type MobileDesign } from '../../lib/mobile-design';
import { useApi } from './api';
import { useSession } from './session';

const Align = createContext<'start' | 'center'>('start');
const Ctx = createContext<{ design: MobileDesign; palette: ReturnType<typeof mobilePalette>; reload: () => void; reduceMotion: boolean } | null>(null);
export function TenantDesignProvider({ children }: { children: ReactNode }) {
  const { signOut } = useSession();
  const response = useApi('design', { schema: '2' }, signOut);
  const scheme = useColorScheme();
  const [deviceReduced, setDeviceReduced] = useState(true);
  useEffect(() => { let live = true; void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (live) setDeviceReduced(value); }).catch(() => {}); const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setDeviceReduced); return () => { live = false; sub.remove(); }; }, []);
  // A previous server can serve the default design (404), while malformed configuration never renders.
  const design = useMemo(() => { try { return parseMobileDesign(response.data?.config); } catch { return DEFAULT_MOBILE_DESIGN; } }, [response.data]);
  useEffect(() => { const sub = AppState.addEventListener('change', value => { if (value === 'active') response.reload(); }); return () => sub.remove(); }, [response.reload]);
  const palette = mobilePalette(design, design.appearance === 'system' ? scheme === 'light' ? 'light' : 'dark' : design.appearance);
  return <Ctx.Provider value={{ design, palette, reload: response.reload, reduceMotion: deviceReduced || design.motion === 'reduced' }}>{children}</Ctx.Provider>;
}
export function useTenantDesign() {
  return useContext(Ctx) ?? { design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'light'), reload: () => {}, reduceMotion: true };
}
export function DesignText({ style, ...props }: TextProps) {
  const { design } = useTenantDesign(), align = useContext(Align);
  const c = design.schemaVersion === 2 ? design.composition : null;
  const base = StyleSheet.flatten(style) ?? {};
  const size = typeof base.fontSize === 'number' ? base.fontSize : 14;
  const fontSize = c ? size >= 24 ? size * c.typography.headingSize / 29 : size * c.typography.bodySize / 14 : size;
  const family = !c || c.typography.family === 'sans' ? undefined : c.typography.family === 'serif' ? Platform.OS === 'ios' ? 'Georgia' : 'serif' : Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  return <NativeText {...props} style={[style, { fontSize, ...(family ? { fontFamily: family } : {}), ...(align === 'center' ? { textAlign: 'center' } : {}) }]} />;
}
export function TenantSurface({ band, align, children }: { band: boolean; align: 'start' | 'center'; children: ReactNode }) {
  const parent = useTenantDesign(), p = parent.palette;
  return <Ctx.Provider value={band ? { ...parent, palette: { ...p, bg: p.button, card: p.button, text: p.onButton, muted: p.onButton, accent: p.onButton, border: p.onButton } } : parent}><Align.Provider value={align}>{children}</Align.Provider></Ctx.Provider>;
}
export function TenantBrand() {
  const { design, palette } = useTenantDesign();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 12 }}>
    {design.logo && <Image source={{ uri: design.logo }} style={{ width: 28, height: 28 }} resizeMode="contain" />}
    <DesignText style={{ color: palette.text, fontSize: 14, fontWeight: '600', flexShrink: 1 }}>{design.brandName}<DesignText style={{ color: palette.accent }}>.</DesignText></DesignText>
  </View>;
}
