/** Presentation-only contract shared by the web builder and the store-installed app. No executable code, URLs, permissions or policy. */
import { parseMobileComposition, newMobileBlock, type MobileComposition } from './mobile-composition';
export type { MobileComposition, MobileBlock, MobilePage, MobileTheme } from './mobile-composition';
export type MobileDesignV1 = {
  schemaVersion: 1;
  brandName: string;
  logo: string | null;
  accent: 'coral' | 'cobalt' | 'jade';
  appearance: 'dark' | 'light' | 'system';
  clockLayout: 'flow' | 'punch' | 'rail';
  leaveLayout: 'ledger' | 'list';
  corners: 'crisp' | 'soft';
  motion: 'standard' | 'reduced';
  homeOrder: ('clock' | 'tasks' | 'leave' | 'team')[];
  navigationOrder: ('clock' | 'requests' | 'inbox')[];
};
export type MobileDesignV2 = Omit<MobileDesignV1, 'schemaVersion'> & { schemaVersion: 2; composition: MobileComposition };
export type MobileDesign = MobileDesignV1 | MobileDesignV2;
export const DEFAULT_MOBILE_DESIGN: MobileDesignV1 = {
  schemaVersion: 1, brandName: 'AIHR', logo: null, accent: 'coral', appearance: 'dark',
  clockLayout: 'flow', leaveLayout: 'ledger', corners: 'crisp', motion: 'standard',
  homeOrder: ['clock', 'tasks', 'leave', 'team'], navigationOrder: ['clock', 'requests', 'inbox'],
};
export const MOBILE_ACCENTS = {
  coral: { dark: '#ff8958', light: '#bd3800', button: '#ff8958', onButton: '#111111' },
  cobalt: { dark: '#91b5ff', light: '#174bb5', button: '#91b5ff', onButton: '#111111' },
  jade: { dark: '#75d9b0', light: '#126d50', button: '#75d9b0', onButton: '#111111' },
} as const;
export function mobilePalette(design: MobileDesign, appearance: 'dark' | 'light') {
  if (design.schemaVersion === 2) return design.composition.themes[appearance];
  const colors = MOBILE_ACCENTS[design.accent];
  const palette = appearance === 'dark'
    ? { bg: '#111111', card: '#22211f', text: '#f2f0eb', muted: '#b1aea6', border: '#45433f', accent: MOBILE_ACCENTS[design.accent].dark }
    : { bg: '#f2f0eb', card: '#ffffff', text: '#111111', muted: '#63625d', border: '#d2cfc7', accent: MOBILE_ACCENTS[design.accent].light };
  return { ...palette, button: colors.button, onButton: colors.onButton };
}
const oneOf = (v: unknown, values: readonly string[]) => typeof v === 'string' && values.includes(v);
const permutation = (v: unknown, values: readonly string[]) => Array.isArray(v) && v.length === values.length && new Set(v).size === values.length && v.every(x => values.includes(x));
/** Bound decoded raster dimensions too. This tiny base64 header reader works in web, Node and React Native. */
function logoValid(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 48000 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const data = value.slice('data:image/png;base64,'.length);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  for (let i = 0; i < 44 && i < data.length; i += 4) {
    const n = alphabet.indexOf(data[i]) << 18 | alphabet.indexOf(data[i + 1]) << 12 | alphabet.indexOf(data[i + 2]) << 6 | alphabet.indexOf(data[i + 3]);
    bytes.push(n >>> 16 & 255, n >>> 8 & 255, n & 255);
  }
  const dimension = (start: number) => bytes.slice(start, start + 4).reduce((n, byte) => n * 256 + byte, 0);
  return bytes.length >= 24 && bytes.slice(12, 16).join(',') === '73,72,68,82' && [dimension(16), dimension(20)].every(n => n > 0 && n <= 256);
}
/** Reject unknown keys as well as invalid values; CSS, scripts, remote images and rules are never accepted. */
export function parseMobileDesign(value: unknown): MobileDesign {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_design');
  const v = value as Record<string, unknown>;
  const expected = [...Object.keys(DEFAULT_MOBILE_DESIGN), ...(v.schemaVersion === 2 ? ['composition'] : [])];
  if (Object.keys(v).sort().join(',') !== expected.sort().join(',') ||
    (typeof v.schemaVersion !== 'number' || ![1, 2].includes(v.schemaVersion)) || typeof v.brandName !== 'string' || !v.brandName.trim() || v.brandName.length > 32 || /[\u0000-\u001f\u007f]/.test(v.brandName) ||
    !logoValid(v.logo) ||
    !oneOf(v.accent, ['coral', 'cobalt', 'jade']) || !oneOf(v.appearance, ['dark', 'light', 'system']) ||
    !oneOf(v.clockLayout, ['flow', 'punch', 'rail']) || !oneOf(v.leaveLayout, ['ledger', 'list']) ||
    !oneOf(v.corners, ['crisp', 'soft']) || !oneOf(v.motion, ['standard', 'reduced']) ||
    !permutation(v.homeOrder, ['clock', 'tasks', 'leave', 'team']) || !permutation(v.navigationOrder, ['clock', 'requests', 'inbox'])) throw new Error('invalid_design');
  // Return an owned value, never an object the caller can mutate behind a saved snapshot.
  const encoded = JSON.stringify(v);
  let bytes = 0; for (const char of encoded) { const n = char.codePointAt(0)!; bytes += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4; }
  if (bytes > 110000) throw new Error('invalid_design');
  const composition = v.schemaVersion === 2 ? parseMobileComposition(v.composition) : undefined;
  return { ...(v as MobileDesign), ...(composition ? { composition } : {}), brandName: v.brandName.trim(), homeOrder: [...v.homeOrder as MobileDesign['homeOrder']], navigationOrder: [...v.navigationOrder as MobileDesign['navigationOrder']] };
}
export function resolveMobileDesign(value: unknown): MobileDesign {
  try { return parseMobileDesign(value); } catch { return parseMobileDesign(DEFAULT_MOBILE_DESIGN); }
}
export type MobileDesignRelease = { revision: number; publishedAt: string; config: MobileDesign };
export type MobileBuilderState = { tenantName: string; draft: MobileDesign; draftRevision: number; releases: MobileDesignRelease[] };

/** Explicit compatibility projection for older installed clients. Version 2 is opt-in. */
export function legacyMobileDesign(value: MobileDesign): MobileDesignV1 {
  const { composition: _composition, ...legacy } = value as MobileDesignV2;
  return parseMobileDesign({ ...legacy, schemaVersion: 1 }) as MobileDesignV1;
}
export function composeMobileDesign(value: MobileDesign): MobileDesignV2 {
  if (value.schemaVersion === 2) return parseMobileDesign(value) as MobileDesignV2;
  return { ...parseMobileDesign(value), schemaVersion: 2, composition: {
    themes: { light: mobilePalette(value, 'light'), dark: mobilePalette(value, 'dark') },
    typography: { family: 'sans', bodySize: 14, headingSize: 29 },
    layout: { padding: 22, gap: 16, radius: value.corners === 'soft' ? 18 : 3, surface: 'flat', button: 'solid' },
    navigation: { style: 'bar', labels: true, items: [{ target: 'home', label: '', icon: 'home' }, ...value.navigationOrder.map(target => ({ target, label: '', icon: target === 'clock' ? 'clock' as const : target === 'requests' ? 'calendar' as const : 'bell' as const })), { target: 'me', label: '', icon: 'person' }] },
    pages: [{ id: 'home', title: '', blocks: [newMobileBlock('welcome', 'welcome'), ...value.homeOrder.map(kind => ({ ...newMobileBlock(kind, kind), detail: 'compact' as const }))] }],
  } };
}
export type MobileTemplate = 'monolith' | 'studio' | 'editorial' | 'vivid';
export function mobileDesignTemplate(name: MobileTemplate, source: MobileDesign = DEFAULT_MOBILE_DESIGN): MobileDesignV2 {
  const d = composeMobileDesign({ ...legacyMobileDesign(source), corners: name === 'monolith' || name === 'editorial' ? 'crisp' : 'soft' });
  const c = d.composition;
  if (name === 'studio') {
    c.themes.light = { bg: '#f4f6fc', card: '#ffffff', text: '#17213c', muted: '#505c76', border: '#b5bfd4', accent: '#3048a5', button: '#3048a5', onButton: '#ffffff' };
    c.themes.dark = { bg: '#101625', card: '#1a2235', text: '#f1f4ff', muted: '#b6bfd5', border: '#586681', accent: '#a7b7ff', button: '#a7b7ff', onButton: '#101625' };
    c.layout = { padding: 18, gap: 18, radius: 24, surface: 'raised', button: 'solid' }; c.navigation.style = 'dock';
  } else if (name === 'editorial') {
    c.themes.light = { bg: '#ffffff', card: '#f2f3f2', text: '#172622', muted: '#4e5c55', border: '#a8b4ad', accent: '#236044', button: '#172622', onButton: '#ffffff' };
    c.themes.dark = { bg: '#101b16', card: '#1c2a22', text: '#edf7f1', muted: '#b0c7b9', border: '#5e7869', accent: '#a4dab8', button: '#edf7f1', onButton: '#101b16' };
    c.typography = { family: 'serif', bodySize: 15, headingSize: 38 }; c.layout = { padding: 26, gap: 24, radius: 0, surface: 'flat', button: 'outline' }; c.navigation.style = 'top'; d.clockLayout = 'rail';
  } else if (name === 'vivid') {
    c.themes.light = { bg: '#4524a6', card: '#ffffff', text: '#ffffff', muted: '#ede7ff', border: '#b7a4ef', accent: '#ffffff', button: '#e7ff84', onButton: '#212900' };
    // One foreground vocabulary must work on both surfaces; a saturated surface is intentional.
    c.themes.light.card = '#5631be';
    c.themes.dark = { bg: '#160d30', card: '#29184d', text: '#f9f5ff', muted: '#c7b9e3', border: '#705c94', accent: '#e7ff84', button: '#e7ff84', onButton: '#212900' };
    c.typography.headingSize = 38; c.layout = { padding: 18, gap: 20, radius: 20, surface: 'outline', button: 'solid' }; c.navigation.style = 'dock'; d.clockLayout = 'punch';
  }
  c.pages[0].blocks.forEach(b => { if (b.kind === 'clock') b.surface = name === 'monolith' || name === 'editorial' ? 'plain' : 'card'; if (b.kind === 'leave') b.detail = name === 'monolith' ? 'compact' : 'expanded'; });
  return parseMobileDesign(d) as MobileDesignV2;
}
