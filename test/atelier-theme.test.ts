import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveUiTheme, UI_THEMES } from '@/lib/ui-theme';

/**
 * Atelier round 1 — the assistant-first shell (brief: .impeccable/surfaces/app-layout-tsx.md).
 * Pins what the brief promises and a regression would silently break: readable tokens in both modes, the
 * single accent, the theme reaching the shell only through its own scope, one nav source for the rail and
 * the command bar, and a Home that never shows the assistant box to someone it cannot answer.
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('app/atelier.css');
const block = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  // Non-vacuity: a renamed selector must fail here, not sweep an empty string.
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(at, css.indexOf('\n}', at));
  expect(body.length).toBeGreaterThan(400);
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
};
const light = block(":root[data-ui-theme='atelier']");
const dark = { ...light, ...block(":root[data-ui-theme='atelier'].dark") };

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map((s) => parseInt(s, 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('Atelier theme value', () => {
  it('is the default for a browser without a saved theme', () => {
    expect(UI_THEMES).toContain('atelier');
    expect(resolveUiTheme('atelier')).toBe('atelier');
    expect(resolveUiTheme(undefined)).toBe('atelier');
  });
});

describe('Atelier tokens are readable (WCAG AA, 4.5:1) in light and dark', () => {
  const pairs = [
    ['--foreground', '--background'], ['--card-foreground', '--card'], ['--popover-foreground', '--popover'],
    ['--muted-foreground', '--muted'], ['--muted-foreground', '--background'], ['--sidebar-foreground', '--sidebar'],
    ['--primary-foreground', '--primary'], ['--accent-foreground', '--accent'], ['--destructive', '--card'],
    ['--atelier-ink-3', '--background'], ['--atelier-ink-3', '--sidebar'], ['--atelier-tan', '--atelier-tan-wash'],
    ['--atelier-ok', '--atelier-ok-wash'], ['--atelier-warn', '--atelier-warn-wash'], ['--atelier-info', '--atelier-info-wash'],
  ] as const;
  for (const [mode, tokens] of [['light', light], ['dark', dark]] as const) {
    it.each(pairs)(`${mode}: %s on %s`, (fg, bg) => {
      expect(tokens[fg], fg).toMatch(/^#[0-9a-f]{6}$/);
      expect(tokens[bg], bg).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('fire orange is the one accent: primary and ring are the same colour', () => {
    expect(light['--primary']).toBe('#c2410c');
    expect(light['--ring']).toBe(light['--primary']);
    expect(dark['--ring']).toBe(dark['--primary']);
  });
});

/** A selector list split on its TOP-LEVEL commas only: `:root[x] :is(a,b)` is one selector, not three. */
function topLevelParts(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

describe('Atelier reaches the app only through its own scope', () => {
  it('every rule in app/atelier.css is scoped to the atelier theme', () => {
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|[{}])\s*([^{}@;]+)\{/g)].map((m) => m[2].trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(40);
    for (const sel of selectors) {
      for (const part of topLevelParts(sel)) {
        expect(part, part).toMatch(/^:root\[data-ui-theme='atelier'\]/);
      }
    }
  });
  it('the layout imports it as a module (never an @import a warm build cache can drop); the variant stays in globals', () => {
    const layout = read('app/(app)/layout.tsx');
    const globals = read('app/globals.css');
    expect(layout).toMatch(/^import '\.\/atelier\.css';$/m);
    expect(layout.indexOf("import './atelier.css';")).toBeGreaterThan(layout.indexOf("import './globals.css';"));
    expect(globals).not.toMatch(/@import\s+["']\.\/atelier\.css/);
    // D-P1-32 D3: the same variant, with an area theme (<div data-area-theme>) excluded at zero specificity.
    expect(globals).toContain("@custom-variant atelier (&:where([data-ui-theme='atelier'] *):not(:where([data-area-theme], [data-area-theme] *)));");
  });
});

describe('one navigation source', () => {
  const sidebar = read('components/sidebar.tsx');
  const bar = read('components/command-bar.tsx');
  it('the rail publishes the destinations it renders, from the same filtered groups, before any early return', () => {
    const publish = sidebar.indexOf('usePublishNavIndex(navEntries, activeEntry);');
    const firstReturn = sidebar.indexOf('return null;', sidebar.indexOf('export function Sidebar('));
    expect(publish).toBeGreaterThan(-1);
    expect(firstReturn).toBeGreaterThan(-1);
    expect(publish).toBeLessThan(firstReturn);
    const build = sidebar.slice(sidebar.indexOf('const navEntries: NavIndexEntry[] = [];'), publish);
    expect(build.length).toBeGreaterThan(400);
    expect(build).toContain('for (const g of groups)');
    expect(build).toContain('r.children.filter(canSeeChild)');
  });
  it('the Atelier rail walks the same groups and shares the section state owner', () => {
    const rail = sidebar.slice(sidebar.indexOf('if (atelier) {'), sidebar.indexOf('// Current uses the same authorized navigation graph'));
    expect(rail.length).toBeGreaterThan(2000);
    expect(rail).toContain('{groups.map((group, gi) => (');
    expect(rail).toContain('onClick={() => toggleSection(group.labelKey!)}');
    expect(rail).toContain('item.children.filter(canSeeChild)');
    expect(rail).not.toMatch(/\bGROUPS\b/);
  });
  it('the command bar lists only published destinations; it owns no nav list of its own', () => {
    expect(bar).toContain('const { entries: navEntries } = useNavIndex();');
    expect(bar).not.toMatch(/href: '\//);
  });
});

describe('Atelier Home', () => {
  const page = read('app/(app)/page.tsx');
  const home = read('app/dashboard-atelier.tsx');
  it('offers the ask box only to someone the assistant can answer', () => {
    expect(page).toContain('mayUseAssistant(s)');
    expect(page).toContain('canAsk={assistant.allowed}');
    expect(home).toMatch(/\{canAsk && \(\s*<AtelierAskBox/);
  });
  it('never labels anything as prepared by the assistant (the action layer does not exist yet)', () => {
    const en = JSON.parse(read('messages/en.json'));
    const strings = JSON.stringify(en.dashboard.atelier).toLowerCase();
    expect(strings.length).toBeGreaterThan(200);
    expect(strings).not.toContain('prepared');
  });
  it('the history read is gated exactly like the bell (approvers only) and dated in Malaysia', () => {
    expect(page).toContain('const showHistory = admin || managerRole;');
    expect(page).toContain('todayInKualaLumpur(now)');
  });
});
