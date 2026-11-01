/** Shared store app, tenant-owned presentation. Nothing is persisted across accounts or locks. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, AppState, Image, Text as NativeText, StyleSheet, Platform, type TextProps, useColorScheme, View } from 'react-native';
import { DEFAULT_MOBILE_DESIGN, mobileSurfaceIsDark, mobilePalette, parseMobileDesign, type MobileDesign, type MobileBackgrounds } from '../../lib/mobile-design';
import { useApi } from './api';
import { nativeMobilePalette } from './daily-switch-theme';
import { useDisplayPrefs } from './preferences';
import { useSession } from './session';

const Align = createContext<'start' | 'center'>('start');
const Ctx = createContext<{ design: MobileDesign; palette: ReturnType<typeof mobilePalette>; reload: () => void; reduceMotion: boolean; artwork?: MobileBackgrounds; appearance?: 'light' | 'dark' } | null>(null);
/** Public screens use the same appearance preference without requesting authenticated tenant data. */
export function PublicDesignProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const { appearance } = useDisplayPrefs();
  const chosen = appearance === 'auto' ? scheme === 'light' ? 'light' : 'dark' : appearance;
  return <Ctx.Provider value={{ design: DEFAULT_MOBILE_DESIGN, palette: nativeMobilePalette(DEFAULT_MOBILE_DESIGN, chosen), appearance: chosen, reload: () => {}, reduceMotion: true }}>{children}</Ctx.Provider>;
}
export function TenantDesignProvider({ children }: { children: ReactNode }) {
  const { signOut } = useSession();
  const response = useApi('design', { schema: '2', artwork: '1' }, signOut);
  const scheme = useColorScheme();
  const [deviceReduced, setDeviceReduced] = useState(true);
  useEffect(() => { let live = true; void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (live) setDeviceReduced(value); }).catch(() => {}); const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setDeviceReduced); return () => { live = false; sub.remove(); }; }, []);
  // A previous server can serve the default design (404), while malformed configuration never renders.
  const design = useMemo(() => { try { return response.data?.revision === 0 ? DEFAULT_MOBILE_DESIGN : parseMobileDesign(response.data?.config); } catch { return DEFAULT_MOBILE_DESIGN; } }, [response.data]);
  useEffect(() => { const sub = AppState.addEventListener('change', value => { if (value === 'active') response.reload(); }); return () => sub.remove(); }, [response.reload]);
  // The person's own Light/Dark choice (Settings) wins; Automatic follows the company design, which may follow the phone.
  const { appearance: chosen } = useDisplayPrefs();
  const companyAppearance = design.appearance === 'system' ? scheme === 'light' ? 'light' : 'dark' : design.appearance;
  const appearance = chosen === 'auto' ? companyAppearance : chosen;
  const palette = nativeMobilePalette(design, appearance);
  return <Ctx.Provider value={{ design, palette, reload: response.reload, artwork: response.data?.artwork, appearance, reduceMotion: deviceReduced || design.motion === 'reduced' }}>{children}</Ctx.Provider>;
}
export function useTenantDesign() {
  return useContext(Ctx) ?? { design: DEFAULT_MOBILE_DESIGN, palette: nativeMobilePalette(DEFAULT_MOBILE_DESIGN, 'light'), reload: () => {}, reduceMotion: true, artwork: undefined, appearance: 'light' as const };
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
  // Older servers can still publish the former default product name. Company branding stays intact.
  const brandName = design.brandName === 'AIHR' || design.brandName === 'AI HR' ? 'OneHR+' : design.brandName;
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 12 }}>
    {design.logo && <Image source={{ uri: design.logo }} style={{ width: 28, height: 28 }} resizeMode="contain" />}
    <DesignText style={{ color: palette.text, fontSize: design.schemaVersion === 1 ? 28 : 14, fontWeight: '700', flexShrink: 1 }}>{brandName}{brandName === 'OneHR+' ? null : <DesignText style={{ color: palette.accent }}>.</DesignText>}</DesignText>
  </View>;
}

/** Bundled artwork is decorative: no network request, focus stop or company information. */
export function Atmosphere({ strong = false }: { strong?: boolean }) {
  const { palette, artwork, appearance, design } = useTenantDesign();
  const [failed, setFailed] = useState<string | null>(null);
  const dark = appearance ? appearance === 'dark' : mobileSurfaceIsDark(palette);
  const uploaded = artwork?.[dark ? 'dark' : 'light'];
  const source = uploaded && uploaded !== failed ? { uri: uploaded } : dark ? require('../assets/atmosphere/onehr-dark.png') : require('../assets/atmosphere/onehr-light.png');
  if (design.schemaVersion !== 2) return null;
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
    <Image source={source} onError={() => setFailed(uploaded ?? null)} resizeMode="cover" accessible={false} style={{ position: 'absolute', top: 0, width: '100%', height: strong ? 660 : 480, opacity: strong ? dark ? .66 : .72 : .16 }} />
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, width: '100%', height: strong ? 660 : 480, experimental_backgroundImage: `linear-gradient(180deg, ${palette.bg}00 10%, ${palette.bg}55 38%, ${palette.bg} 92%)` }} />
  </View>;
}
