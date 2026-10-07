/**
 * r396 — the user-selectable UI theme (Monolith | Classic), step 1 of the Monolith rollout.
 *
 * WHAT IS PINNED, and how each half is exercised rather than described:
 *   A. lib/ui-theme.ts resolves the `ui_theme` cookie: absent / empty / unknown → monolith; the two names
 *      → themselves. Pure function, called directly.
 *   B. app/ui-theme-actions.ts accepts ONLY the two names and sets the cookie with the agreed attributes
 *      (1 year, SameSite=Lax, path=/). Called directly with next/headers' cookie jar replaced by a spy.
 *   C. app/layout.tsx writes the cookie's theme onto <html data-ui-theme>. The layout is CALLED (the
 *      auth-route branch, which needs no session) and the returned <html> element's props are read — and
 *      the authenticated branch is pinned by source to carry the same attribute.
 *   D. app/globals.css: every token docs/design/monolith/tokens.css defines appears, with its value, under
 *      the Monolith scope (light and dark); Classic's :root and .dark blocks are byte-identical to main's;
 *      the font mapping, the @theme additions and the scoped .mono/.num classes are present.
 * The six-locale render of the control lives in test/r396-theme-switch.dom.test.tsx (jsdom project).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

// ── next/* replaced for B and C ────────────────────────────────────────────────────────────────────────
const jar = new Map<string, string>();
const cookieSet = vi.fn();
const revalidatePath = vi.fn();
let pathname = '/login';
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (...args: unknown[]) => cookieSet(...args),
  }),
  headers: async () => ({ get: (name: string) => (name === 'x-pathname' ? pathname : null) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
// next/font/google only works under the Next compiler; record each call's options instead.
const fontCalls: Record<string, Record<string, unknown>> = {};
vi.mock('next/font/google', () => {
  const font = (name: string) => (opts: Record<string, unknown>) => {
    fontCalls[name] = opts;
    return { variable: `v-${name}`, className: `c-${name}`, style: { fontFamily: name } };
  };
  return {
    Plus_Jakarta_Sans: font('Plus_Jakarta_Sans'),
    Geist_Mono: font('Geist_Mono'),
    Schibsted_Grotesk: font('Schibsted_Grotesk'),
    DM_Mono: font('DM_Mono'),
  };
});

import { DEFAULT_UI_THEME, UI_THEME_COOKIE, UI_THEMES, isUiTheme, resolveUiTheme } from '@/lib/ui-theme';
import { setUiTheme } from '@/app/ui-theme-actions';

beforeEach(() => {
  jar.clear();
  cookieSet.mockClear();
  revalidatePath.mockClear();
  pathname = '/login';
});

describe('A. resolveUiTheme — the cookie decides, the default is Monolith', () => {
  it('the vocabulary is exactly monolith | classic, cookie `ui_theme`, default monolith', () => {
    expect(UI_THEME_COOKIE).toBe('ui_theme');
    expect([...UI_THEMES]).toEqual(['monolith', 'classic']);
    expect(DEFAULT_UI_THEME).toBe('monolith');
  });
  it('cookie absent → monolith', () => {
    expect(resolveUiTheme(undefined)).toBe('monolith');
    expect(resolveUiTheme(null)).toBe('monolith');
  });
  it('cookie classic → classic; cookie monolith → monolith', () => {
    expect(resolveUiTheme('classic')).toBe('classic');
    expect(resolveUiTheme('monolith')).toBe('monolith');
  });
  it('invalid value → monolith (never a third state)', () => {
    for (const bad of ['', 'Classic', 'CLASSIC', ' classic', 'dark', 'light', 'indigo', 'monolith;classic']) {
      expect(resolveUiTheme(bad), bad).toBe('monolith');
      expect(isUiTheme(bad), bad).toBe(false);
    }
  });
});

describe('B. setUiTheme — the server action', () => {
  it.each(['classic', 'monolith'])('accepts %s and sets ui_theme for 1 year, SameSite=Lax, path=/', async (theme) => {
    await expect(setUiTheme(theme)).resolves.toEqual({ ok: true });
    expect(cookieSet).toHaveBeenCalledTimes(1);
    expect(cookieSet).toHaveBeenCalledWith('ui_theme', theme, {
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
    // …and re-renders the root layout so the server's <html data-ui-theme> agrees.
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
  it('refuses anything else: no cookie written, nothing revalidated', async () => {
    for (const bad of ['', 'Classic', 'dark', 'x'.repeat(5000), undefined, null, 1, {}, ['classic']]) {
      await expect(setUiTheme(bad)).resolves.toEqual({ ok: false });
    }
    expect(cookieSet).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('C. app/layout.tsx writes the theme onto <html data-ui-theme>', () => {
  type El = { type: unknown; props: Record<string, unknown> };
  const renderLayout = async (): Promise<El> => {
    const { default: RootLayout } = await import('@/app/layout');
    return (await RootLayout({ children: null })) as unknown as El;
  };

  it('cookie absent → data-ui-theme="monolith"', async () => {
    const html = await renderLayout();
    expect(html.type).toBe('html');
    expect(html.props['data-ui-theme']).toBe('monolith');
  });
  it('cookie classic → data-ui-theme="classic"', async () => {
    jar.set('ui_theme', 'classic');
    expect((await renderLayout()).props['data-ui-theme']).toBe('classic');
  });
  it('cookie invalid → data-ui-theme="monolith"', async () => {
    jar.set('ui_theme', 'neon');
    expect((await renderLayout()).props['data-ui-theme']).toBe('monolith');
  });
  it('every theme\'s fonts are on <html>, and the Monolith faces are loaded as README §2 says', async () => {
    const html = await renderLayout();
    const cls = String(html.props.className);
    for (const v of ['v-Plus_Jakarta_Sans', 'v-Geist_Mono', 'v-Schibsted_Grotesk', 'v-DM_Mono']) expect(cls).toContain(v);
    expect(fontCalls.Schibsted_Grotesk).toMatchObject({ variable: '--font-schibsted', weight: ['400', '500', '600'] });
    expect(fontCalls.DM_Mono).toMatchObject({ variable: '--font-dm-mono', weight: ['400', '500'] });
    // Classic's faces are unchanged.
    expect(fontCalls.Plus_Jakarta_Sans).toMatchObject({ variable: '--font-jakarta' });
    expect(fontCalls.Geist_Mono).toMatchObject({ variable: '--font-geist-mono' });
  });
  it('the AUTHENTICATED <html> carries the same attribute (one per <html> in the file)', () => {
    const src = read('app/layout.tsx');
    const htmlTags = src.match(/<html\b/g) ?? [];
    expect(htmlTags.length).toBe(2);
    expect(src.match(/data-ui-theme=\{uiTheme\}/g) ?? []).toHaveLength(htmlTags.length);
    expect(src).toMatch(/const uiTheme = resolveUiTheme\(\(await cookies\(\)\)\.get\(UI_THEME_COOKIE\)\?\.value\);/);
  });
});

// ── D. CSS ───────────────────────────────────────────────────────────────────────────────────────────
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** The body of the FIRST rule whose selector line is exactly `selector {` (at column 0). */
function block(css: string, selector: string): string {
  const clean = stripComments(css);
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{\\n`);
  const m = re.exec(clean);
  if (!m) return '';
  const start = m.index + m[0].length;
  const end = clean.indexOf('\n}', start);
  return end < 0 ? '' : clean.slice(start, end);
}
function decls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of body.split(';')) {
    const i = d.indexOf(':');
    if (i < 0) continue;
    const name = d.slice(0, i).trim();
    if (name.startsWith('--')) out.set(name, d.slice(i + 1).replace(/\s+/g, ' ').trim().toLowerCase());
  }
  return out;
}

const globals = read('app/globals.css');
const tokens = read('docs/design/monolith/tokens.css');
const MONO = ":root[data-ui-theme='monolith']";
const MONO_DARK = ":root[data-ui-theme='monolith'].dark";

describe('D. app/globals.css — Monolith scoped, Classic untouched', () => {
  it.each([
    [':root', MONO],
    ['.dark', MONO_DARK],
  ])('every token tokens.css sets in `%s` appears, with its value, under `%s`', (src, dst) => {
    const want = decls(block(tokens, src));
    const have = decls(block(globals, dst));
    // Non-vacuity: both sides parsed to a real token list, not an empty slice.
    expect(want.size).toBeGreaterThanOrEqual(30);
    expect(have.size).toBeGreaterThanOrEqual(want.size);
    const wrong = [...want].filter(([k, v]) => have.get(k) !== v).map(([k, v]) => `${k}: want ${v}, got ${have.get(k)}`);
    expect(wrong).toEqual([]);
  });

  it("Classic's :root and .dark blocks are byte-identical to main's", () => {
    const mainCss = execFileSync('git', ['show', 'main:app/globals.css'], { cwd: ROOT, encoding: 'utf8' });
    for (const sel of [':root', '.dark']) {
      const before = block(mainCss, sel);
      expect(before.length, sel).toBeGreaterThan(500);
      expect(block(globals, sel), sel).toBe(before);
    }
  });

  it('every Classic token name is restated by Monolith, so no Classic value leaks into Monolith', () => {
    const classic = decls(block(globals, ':root'));
    const mono = decls(block(globals, MONO));
    expect(classic.size).toBeGreaterThanOrEqual(25);
    expect([...classic.keys()].filter((k) => !mono.has(k))).toEqual([]);
    const classicDark = decls(block(globals, '.dark'));
    const monoAll = new Map([...mono, ...decls(block(globals, MONO_DARK))]);
    expect([...classicDark.keys()].filter((k) => !monoAll.has(k))).toEqual([]);
  });

  it('Monolith is square and shadowless through the tokens', () => {
    const mono = decls(block(globals, MONO));
    expect(mono.get('--radius')).toBe('0px');
    expect(mono.get('--radius-panel')).toBe('0px');
    for (const s of ['--shadow-sm', '--shadow-card', '--shadow-shell']) expect(mono.get(s), s).toBe('none');
    // rounded-xl reads --radius-panel first, falling back to Classic's exact old expression.
    expect(stripComments(globals)).toContain('--radius-xl: var(--radius-panel, calc(var(--radius) + 8px));');
  });

  it('the Monolith scope re-points the app font variables; the CJK fallback chain is kept', () => {
    const mono = decls(block(globals, MONO));
    expect(mono.get('--font-jakarta')).toBe('var(--font-schibsted)');
    expect(mono.get('--font-geist-mono')).toBe('var(--font-dm-mono)');
    const theme = decls(block(globals, '@theme inline'));
    expect(theme.get('--font-sans')).toMatch(/^var\(--font-jakarta\), 'pingfang sc', 'hiragino sans gb'/);
    expect(theme.get('--font-sans')).toContain("'noto sans cjk sc'");
  });

  it("every @theme inline addition tokens.css asks for (except the fonts, mapped above) is present", () => {
    const want = decls(block(tokens, '@theme inline'));
    want.delete('--font-sans');
    want.delete('--font-mono');
    expect(want.size).toBeGreaterThanOrEqual(11);
    const have = decls(block(globals, '@theme inline'));
    expect([...want].filter(([k, v]) => have.get(k) !== v)).toEqual([]);
  });

  it('.mono and .num exist ONLY under the Monolith scope', () => {
    const clean = stripComments(globals);
    expect(clean).toMatch(/:root\[data-ui-theme='monolith'\] \.mono \{[^}]*letter-spacing: 0\.12em;[^}]*text-transform: uppercase;/);
    expect(clean).toMatch(/:root\[data-ui-theme='monolith'\] \.num \{[^}]*font-variant-numeric: tabular-nums;/);
    expect(clean).not.toMatch(/^\s*\.(mono|num)\s*[{,]/m);
  });
});
