/**
 * D-P1-32 D3 (APR-025, ADR-0152) — the Performance & Talent area theme's SOURCE contract. jsdom applies no CSS,
 * so the wrapper is pinned by test/performance-area-theme.dom.test.tsx and the computed cascade by
 * test/performance-area-theme.browser.test.tsx; this file pins what a regression would silently break in the
 * sources themselves:
 *  • the stylesheet is a module import of the root layout, after atelier.css (its layer must be declared after
 *    Tailwind's, and the deploy cache guard hashes the layout's CSS import lines);
 *  • every rule in it is scoped to the area wrapper, so it cannot reach another screen;
 *  • each theme neutraliser is an exact mirror of a live Atelier / Monolith rule plus the wrapper, and only
 *    ever says `revert-layer`;
 *  • the `monolith:` / `atelier:` variants exclude the area at zero specificity (the exclusion lines);
 *  • text contrast of the light and dark tokens (WCAG AA 4.5:1), with the source system's two light values
 *    that fall short listed explicitly rather than hidden.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const AREA = "[data-area-theme='performance']";
const css = read('app/(app)/performance/area-theme.css');
const layout = read('app/(app)/layout.tsx');
const globals = read('app/globals.css');
const atelier = read('app/atelier.css');

type Rule = { selector: string; body: string; atRules: string[] };
/** Every style rule, walking into @layer and @media blocks; selectors whitespace-normalised. */
function rules(source: string): Rule[] {
  const out: Rule[] = [];
  const walk = (src: string, atRules: string[]) => {
    let pos = 0;
    for (;;) {
      const open = src.indexOf('{', pos);
      if (open < 0) return;
      // A statement at-rule (`@import …;`, `@custom-variant …;`) before a rule is not part of its selector.
      const raw = src.slice(pos, open);
      const head = raw.slice(raw.lastIndexOf(';') + 1).trim().replace(/\s+/g, ' ');
      let depth = 1;
      let end = open + 1;
      while (depth > 0 && end < src.length) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') depth--;
        end++;
      }
      const inner = src.slice(open + 1, end - 1);
      if (head.startsWith('@')) walk(inner, [...atRules, head]);
      else out.push({ selector: head, body: inner, atRules });
      pos = end;
    }
  };
  walk(stripComments(source), []);
  return out;
}
/** A selector list split on its TOP-LEVEL commas only. */
function parts(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}
const declarations = (body: string) =>
  body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()] as const);

const areaRules = rules(css);

describe('the area stylesheet is loaded once, from the root layout, after the theme CSS', () => {
  it('is a module import of app/(app)/layout.tsx placed after atelier.css', () => {
    expect(layout).toMatch(/^import '\.\/performance\/area-theme\.css';$/m);
    const atelierAt = layout.indexOf("import '../atelier.css';");
    const areaAt = layout.indexOf("import './performance/area-theme.css';");
    expect(atelierAt).toBeGreaterThan(layout.indexOf("import '../globals.css';"));
    expect(areaAt).toBeGreaterThan(atelierAt);
    expect(globals).not.toMatch(/@import\s+["'][^"']*area-theme\.css/);
  });

  it('the segment layout renders the wrapper and keeps its module guard', () => {
    const segment = read('app/(app)/performance/layout.tsx');
    expect(segment).toContain("moduleLayout('performance')");
    expect(segment).toContain('data-area-theme="performance"');
    expect(segment).toContain("t('performanceTalent')");
  });
});

describe('every rule is scoped to the area wrapper', () => {
  it('parses a real stylesheet (non-vacuity)', () => {
    expect(areaRules.length).toBeGreaterThan(80);
    expect(areaRules.filter((r) => r.atRules.includes('@layer area-theme')).length).toBeGreaterThan(40);
  });

  it('no selector can match outside <div data-area-theme="performance">', () => {
    for (const rule of areaRules) for (const part of parts(rule.selector)) expect(part, part).toContain(AREA);
  });

  it('the tokens are unlayered and the dark block is the only other token block', () => {
    const tokenBlocks = areaRules.filter((r) => /--primary:/.test(r.body));
    expect(tokenBlocks.map((r) => [r.selector, r.atRules])).toEqual([
      [AREA, []],
      [`.dark ${AREA}`, []],
    ]);
  });
});

describe('theme neutralisers mirror live theme rules exactly', () => {
  const atelierSelectors = new Set(rules(atelier).flatMap((r) => parts(r.selector)));
  const globalsSelectors = new Set(rules(globals).flatMap((r) => parts(r.selector)));
  const neutralisers = areaRules.filter((r) => r.atRules.length === 0 && /^:root\[data-ui-theme='(atelier|monolith)'\]/.test(r.selector));

  it('there are neutralisers for both themes', () => {
    expect(neutralisers.filter((r) => r.selector.startsWith(":root[data-ui-theme='atelier']")).length).toBeGreaterThan(30);
    expect(neutralisers.filter((r) => r.selector.startsWith(":root[data-ui-theme='monolith']")).length).toBeGreaterThanOrEqual(1);
  });

  it('each is the theme rule with the wrapper inserted once, and says only revert-layer', () => {
    for (const rule of neutralisers) {
      for (const part of parts(rule.selector)) {
        expect(part.split(AREA)).toHaveLength(2);
        const original = part.replace(` ${AREA}`, '');
        const pool = original.startsWith(":root[data-ui-theme='atelier']") ? atelierSelectors : globalsSelectors;
        expect(pool.has(original), `${original} is a live theme selector`).toBe(true);
      }
      const decls = declarations(rule.body);
      expect(decls.length, rule.selector).toBeGreaterThan(0);
      for (const [prop, value] of decls) expect(value, `${rule.selector} ${prop}`).toBe('revert-layer');
    }
  });
});

describe('the monolith: and atelier: variants exclude the area (zero specificity)', () => {
  it.each([
    "@custom-variant monolith (&:where([data-ui-theme='monolith'] *):not(:where([data-area-theme], [data-area-theme] *)));",
    "@custom-variant atelier (&:where([data-ui-theme='atelier'] *):not(:where([data-area-theme], [data-area-theme] *)));",
  ])('%s', (line) => {
    expect(globals).toContain(line);
  });
});

describe('the area palette', () => {
  const tokens = (selector: string) => {
    const rule = areaRules.find((r) => r.selector === selector && r.atRules.length === 0);
    expect(rule, selector).toBeDefined();
    return Object.fromEntries([...rule!.body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((m) => [m[1], m[2]]));
  };
  const light = tokens(AREA);
  const dark = { ...light, ...tokens(`.dark ${AREA}`) };
  const WHITE = '#ffffff';

  function luminance(hex: string) {
    const rgb = hex.slice(1).match(/../g)!.map((s) => parseInt(s, 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const resolve = (t: Record<string, string>, name: string) => (name === 'white' ? WHITE : t[name]);

  it('keeps the approved light values (navy, red, grey page, white cards, 12px)', () => {
    expect(light['--primary']).toBe('#252a59');
    expect(light['--pt-band']).toBe('#252a59');
    expect(light['--pt-ai']).toBe('#d61923');
    expect(light['--background']).toBe('#f5f6fa');
    expect(light['--card']).toBe('#ffffff');
    expect(css).toMatch(/--radius: 12px;/);
    // Dark keeps the same accents for the band and the AI action.
    expect(dark['--pt-band']).toBe('#252a59');
    expect(dark['--pt-ai']).toBe('#d61923');
  });

  const pairs: [string, string][] = [
    ['--foreground', '--background'], ['--foreground', '--card'], ['--card-foreground', '--card'],
    ['--popover-foreground', '--popover'], ['--muted-foreground', '--card'], ['--muted-foreground', '--background'],
    ['--muted-foreground', '--muted'], ['--secondary-foreground', '--secondary'], ['--accent-foreground', '--accent'],
    ['--primary-foreground', '--primary'], ['--destructive-foreground', '--destructive'], ['--destructive', '--card'],
    ['--pt-heading', '--card'], ['--pt-link', '--card'], ['--pt-note', '--card'], ['--pt-band-ink', '--pt-band'],
    ['white', '--pt-ai'], ['white', '--pt-ai-hover'], ['white', '--pt-navy-700'], ['--pt-ai-ink', '--card'],
    ['--pt-ai-ink', '--pt-ai-tint'], ['--pt-accent-ink', '--card'], ['--pt-accent-ink', '--pt-tab-on'],
    ['--muted-foreground', '--pt-track'], ['--pt-rail-name', '--card'], ['--pt-faint', '--card'],
    ...['default', 'low', 'mid', 'high', 'ae', 'ua', 'none'].map((p) => [`--pt-pill-${p}-ink`, `--pt-pill-${p}-bg`] as [string, string]),
  ];
  /** The source system's own light values below 4.5:1, kept for fidelity and listed so they stay visible. */
  const LIGHT_EXCEPTIONS = new Set(['--pt-faint/--card', '--pt-pill-ae-ink/--pt-pill-ae-bg']);

  for (const [mode, t] of [['light', light], ['dark', dark]] as const) {
    it.each(pairs)(`${mode}: %s on %s is at least 4.5:1`, (fg, bg) => {
      const [a, b] = [resolve(t, fg), resolve(t, bg)];
      expect(a, fg).toMatch(/^#[0-9a-f]{6}$/);
      expect(b, bg).toMatch(/^#[0-9a-f]{6}$/);
      if (mode === 'light' && LIGHT_EXCEPTIONS.has(`${fg}/${bg}`)) {
        expect(contrast(a, b)).toBeGreaterThanOrEqual(3);
        expect(contrast(a, b)).toBeLessThan(4.5);
      } else expect(contrast(a, b)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('the band title', () => {
  it.each(['en', 'ms', 'ta', 'th', 'vi', 'zh'])('%s has nav.performanceTalent', (locale) => {
    const messages = JSON.parse(read(`messages/${locale}.json`)) as { nav: Record<string, string> };
    expect(messages.nav.performanceTalent?.trim().length).toBeGreaterThan(0);
  });
});
