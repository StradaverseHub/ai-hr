/** Shared store app, tenant-owned presentation. Nothing is persisted across accounts or locks. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, AppState, Image, Text, useColorScheme, View } from 'react-native';
import { DEFAULT_MOBILE_DESIGN, mobilePalette, parseMobileDesign, type MobileDesign } from '../../lib/mobile-design';
import { useApi } from './api';
import { useSession } from './session';

const Ctx = createContext<{ design: MobileDesign; palette: ReturnType<typeof mobilePalette>; reload: () => void; reduceMotion: boolean } | null>(null);
export function TenantDesignProvider({ children }: { children: ReactNode }) {
  const { signOut } = useSession();
  const response = useApi('design', {}, signOut);
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
  return useContext(Ctx) ?? { design: DEFAULT_MOBILE_DESIGN, palette: mobilePalette(DEFAULT_MOBILE_DESIGN, 'dark'), reload: () => {}, reduceMotion: true };
}
export function TenantBrand() {
  const { design, palette } = useTenantDesign();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 12 }}>
    {design.logo && <Image source={{ uri: design.logo }} style={{ width: 28, height: 28 }} resizeMode="contain" />}
    <Text style={{ color: palette.text, fontSize: 14, fontWeight: '600' }}>{design.brandName}<Text style={{ color: palette.accent }}>.</Text></Text>
  </View>;
}
