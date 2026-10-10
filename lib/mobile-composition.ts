/** Declarative presentation only. Bindings name existing authorized widgets, never queries or commands. */
export const MOBILE_BLOCK_KINDS = ['welcome', 'clock', 'leave', 'team', 'tasks', 'requests', 'inbox', 'pay', 'profile', 'text', 'action', 'divider', 'space'] as const;
export type MobileBlockKind = typeof MOBILE_BLOCK_KINDS[number];
export const MOBILE_DESTINATIONS = ['home', 'clock', 'requests', 'inbox', 'me', 'leave', 'team'] as const;
export const MOBILE_NAV_ICONS = ['home', 'clock', 'calendar', 'bell', 'person', 'grid', 'users', 'arrow'] as const;
export type MobileBlock = { id: string; kind: MobileBlockKind; title: string; body: string; target: string; surface: 'inherit' | 'plain' | 'card' | 'band'; align: 'start' | 'center'; width: 'full' | 'half'; detail: 'compact' | 'expanded'; size: number };
export type MobilePage = { id: string; title: string; blocks: MobileBlock[] };
export type MobileTheme = { bg: string; card: string; text: string; muted: string; border: string; accent: string; button: string; onButton: string };
export type MobileComposition = {
  themes: { light: MobileTheme; dark: MobileTheme };
  typography: { family: 'sans' | 'serif' | 'mono'; bodySize: number; headingSize: number };
  layout: { padding: number; gap: number; radius: number; surface: 'flat' | 'outline' | 'raised'; button: 'solid' | 'outline' | 'soft' };
  navigation: { style: 'bar' | 'dock' | 'top'; labels: boolean; items: { target: string; label: string; icon: typeof MOBILE_NAV_ICONS[number] }[] };
  pages: MobilePage[];
};
const keys = (v: unknown, expected: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === [...expected].sort().join();
const choice = (v: unknown, values: readonly string[]) => typeof v === 'string' && values.includes(v);
const bounded = (v: unknown, min: number, max: number) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown, max: number, multiline = false) => typeof v === 'string' && v.length <= max && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(v);
const id = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(v);
export function colorContrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const c = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function themeReadable(theme: MobileTheme): boolean {
  if (!Object.values(theme).every(c => /^#[\da-f]{6}$/i.test(c))) return false;
  return ['text', 'muted', 'accent'].every(k => ['bg', 'card'].every(bg => colorContrast(theme[k as keyof MobileTheme], theme[bg as keyof MobileTheme]) >= 4.5)) && colorContrast(theme.button, theme.onButton) >= 4.5;
}
export function newMobileBlock(kind: MobileBlockKind, blockId: string): MobileBlock {
  return { id: blockId, kind, title: '', body: '', target: 'home', surface: 'inherit', align: 'start', width: 'full', detail: 'expanded', size: 24 };
}
export function parseMobileComposition(value: unknown): MobileComposition {
  const fail = () => { throw new Error('invalid_design'); };
  if (!keys(value, ['themes', 'typography', 'layout', 'navigation', 'pages'])) return fail();
  const { themes, typography: type, layout, navigation: nav, pages } = value;
  if (!keys(themes, ['light', 'dark']) || ![themes.light, themes.dark].every(t => keys(t, ['bg', 'card', 'text', 'muted', 'border', 'accent', 'button', 'onButton']) && themeReadable(t as MobileTheme))) return fail();
  if (!keys(type, ['family', 'bodySize', 'headingSize']) || !choice(type.family, ['sans', 'serif', 'mono']) || !bounded(type.bodySize, 12, 20) || !bounded(type.headingSize, 24, 44)) return fail();
  if (!keys(layout, ['padding', 'gap', 'radius', 'surface', 'button']) || !bounded(layout.padding, 12, 28) || !bounded(layout.gap, 8, 32) || !bounded(layout.radius, 0, 28) || !choice(layout.surface, ['flat', 'outline', 'raised']) || !choice(layout.button, ['solid', 'outline', 'soft'])) return fail();
  if (!Array.isArray(pages) || !pages.length || pages.length > 7) return fail();
  const destinations = new Set<string>(MOBILE_DESTINATIONS), pageIds = new Set<string>();
  for (const page of pages) {
    if (!keys(page, ['id', 'title', 'blocks']) || !id(page.id) || !text(page.title, 64) || pageIds.has(String(page.id)) || (page.id !== 'home' && destinations.has(String(page.id))) || !Array.isArray(page.blocks) || page.blocks.length > 12) return fail();
    pageIds.add(String(page.id)); destinations.add(String(page.id));
  }
  if (!pageIds.has('home')) return fail();
  for (const page of pages as MobilePage[]) {
    const ids = new Set<string>(), bound = new Set<string>();
    for (const block of page.blocks) {
      if (!keys(block, ['id', 'kind', 'title', 'body', 'target', 'surface', 'align', 'width', 'detail', 'size']) || !id(block.id) || ids.has(block.id) || !choice(block.kind, MOBILE_BLOCK_KINDS) || !text(block.title, 64) || !text(block.body, 600, true) || !destinations.has(block.target) || !choice(block.surface, ['inherit', 'plain', 'card', 'band']) || !choice(block.align, ['start', 'center']) || !choice(block.width, ['full', 'half']) || !choice(block.detail, ['compact', 'expanded']) || !bounded(block.size, 8, 64)) return fail();
      if (!['text', 'action', 'divider', 'space'].includes(block.kind) && bound.has(block.kind)) return fail();
      ids.add(block.id); bound.add(block.kind);
    }
  }
  if (!keys(nav, ['style', 'labels', 'items']) || !choice(nav.style, ['bar', 'dock', 'top']) || typeof nav.labels !== 'boolean' || !Array.isArray(nav.items) || nav.items.length < 2 || nav.items.length > 7) return fail();
  const targets = new Set<string>();
  for (const item of nav.items) {
    if (!keys(item, ['target', 'label', 'icon']) || !destinations.has(String(item.target)) || targets.has(String(item.target)) || !text(item.label, 20) || !choice(item.icon, MOBILE_NAV_ICONS)) return fail();
    targets.add(String(item.target));
  }
  if ((nav.items[0] as { target: string }).target !== 'home' || (nav.items.at(-1) as { target: string }).target !== 'me') return fail();
  // An owned, bounded tree. No shared nested references can alter an immutable published release.
  return JSON.parse(JSON.stringify(value)) as MobileComposition;
}
