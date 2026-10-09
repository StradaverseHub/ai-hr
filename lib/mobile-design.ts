/** Presentation-only contract shared by the web builder and the store-installed app. No executable code, URLs, permissions or policy. */
export type MobileDesign = {
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
export const DEFAULT_MOBILE_DESIGN: MobileDesign = {
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
  return appearance === 'dark'
    ? { bg: '#111111', card: '#22211f', text: '#f2f0eb', muted: '#b1aea6', border: '#45433f', accent: MOBILE_ACCENTS[design.accent].dark }
    : { bg: '#f2f0eb', card: '#ffffff', text: '#111111', muted: '#63625d', border: '#d2cfc7', accent: MOBILE_ACCENTS[design.accent].light };
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
  if (Object.keys(v).sort().join(',') !== Object.keys(DEFAULT_MOBILE_DESIGN).sort().join(',') ||
    v.schemaVersion !== 1 || typeof v.brandName !== 'string' || !v.brandName.trim() || v.brandName.length > 32 || /[\u0000-\u001f\u007f]/.test(v.brandName) ||
    !logoValid(v.logo) ||
    !oneOf(v.accent, ['coral', 'cobalt', 'jade']) || !oneOf(v.appearance, ['dark', 'light', 'system']) ||
    !oneOf(v.clockLayout, ['flow', 'punch', 'rail']) || !oneOf(v.leaveLayout, ['ledger', 'list']) ||
    !oneOf(v.corners, ['crisp', 'soft']) || !oneOf(v.motion, ['standard', 'reduced']) ||
    !permutation(v.homeOrder, ['clock', 'tasks', 'leave', 'team']) || !permutation(v.navigationOrder, ['clock', 'requests', 'inbox'])) throw new Error('invalid_design');
  // Return an owned value, never an object the caller can mutate behind a saved snapshot.
  return { ...(v as MobileDesign), brandName: v.brandName.trim(), homeOrder: [...v.homeOrder as MobileDesign['homeOrder']], navigationOrder: [...v.navigationOrder as MobileDesign['navigationOrder']] };
}
export function resolveMobileDesign(value: unknown): MobileDesign {
  try { return parseMobileDesign(value); } catch { return parseMobileDesign(DEFAULT_MOBILE_DESIGN); }
}
export type MobileDesignRelease = { revision: number; publishedAt: string; config: MobileDesign };
export type MobileBuilderState = { draft: MobileDesign; draftRevision: number; releases: MobileDesignRelease[] };
