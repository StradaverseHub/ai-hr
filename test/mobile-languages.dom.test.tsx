/**
 * Mobile WOW round — six languages and the phone's display preferences.
 *  - Every catalogue (en, ms, zh, ta, th, vi) has exactly the English keys, no empty string, the same {placeholders} and
 *    the same line breaks; the connection screens' copy is complete in all six; the sign-in copy is the web's own.
 *  - The language is the person's choice, else the phone's first language the app has, else English; dates follow it.
 *  - Stored preferences that are missing, damaged or unknown fall back to Automatic, and a choice is kept.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const device = vi.hoisted(() => ({ locales: [{ languageCode: 'en' }] as { languageCode: string | null }[], store: new Map<string, string>() }));
vi.mock('expo-localization', () => ({ getLocales: () => device.locales }));
vi.mock('expo-secure-store', () => ({
  getItem: (k: string) => device.store.get(k) ?? null,
  setItem: (k: string, v: string) => { device.store.set(k, v); },
}));

async function fresh() {
  vi.resetModules();
  const prefs = await import('../mobile/lib/preferences');
  const i18n = await import('../mobile/lib/i18n');
  return { prefs, i18n };
}
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
const breaks = (s: string) => (s.match(/\n/g) ?? []).length;

beforeEach(() => { device.locales = [{ languageCode: 'en' }]; device.store.clear(); });

describe('six language catalogues', () => {
  it('every language has every English key, filled, with the same placeholders and line breaks', async () => {
    const { prefs, i18n } = await fresh();
    const en: Record<string, string> = {};
    prefs.setDisplayPref('language', 'en');
    const keys = Object.keys((await import('../mobile/lib/locales/zh')).default);
    for (const k of keys) en[k] = i18n.t(k as never);
    expect(keys.length).toBeGreaterThan(800);
    for (const code of prefs.APP_LOCALES) {
      prefs.setDisplayPref('language', code);
      for (const k of keys) {
        const raw = i18n.t(k as never, Object.fromEntries((en[k]!.match(/\{(\w+)\}/g) ?? []).map((p) => [p.slice(1, -1), `{${p.slice(1, -1)}}`])));
        expect(raw.trim(), `${code}.${k}`).not.toBe('');
        expect(placeholders(raw), `${code}.${k} placeholders`).toBe(placeholders(en[k]!));
        expect(breaks(raw), `${code}.${k} line breaks`).toBe(breaks(en[k]!));
      }
    }
  });
  it('the four new catalogues define exactly the English key set', async () => {
    const zh = (await import('../mobile/lib/locales/zh')).default, ta = (await import('../mobile/lib/locales/ta')).default;
    const th = (await import('../mobile/lib/locales/th')).default, vi_ = (await import('../mobile/lib/locales/vi')).default;
    const src = readFileSync('mobile/lib/i18n.ts', 'utf8');
    const enBlock = src.slice(src.indexOf('const en = {'), src.indexOf('} as const;\n\nexport type MessageKey'));
    const enKeys = [...enBlock.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]).sort();
    for (const cat of [zh, ta, th, vi_]) expect(Object.keys(cat).sort()).toEqual(enKeys);
  });
  it('translates most of the app, not just a few strings', async () => {
    const { prefs, i18n } = await fresh();
    const keys = Object.keys((await import('../mobile/lib/locales/zh')).default);
    prefs.setDisplayPref('language', 'en');
    const en = new Map(keys.map((k) => [k, i18n.t(k as never)]));
    for (const code of ['ms', 'zh', 'ta', 'th', 'vi'] as const) {
      prefs.setDisplayPref('language', code);
      const same = keys.filter((k) => en.get(k)!.length > 12 && i18n.t(k as never) === en.get(k)).length;
      expect(same, code).toBeLessThan(20);
    }
  });
  it('the connection screens and sign-in speak all six languages, the sign-in in the web’s own words', async () => {
    const copy = JSON.parse(readFileSync('mobile/lib/internal-auth-copy.json', 'utf8'));
    for (const code of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      expect(copy[code]).toEqual(JSON.parse(readFileSync(`messages/${code}.json`, 'utf8')).internalAuth);
    }
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, p + k + '.') : [p + k])).sort();
    // The English connection copy, read from its source (importing the screen would pull in native modules).
    const file = ts.createSourceFile('c.tsx', readFileSync('mobile/lib/company-connection.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let enNode: ts.Expression | undefined;
    file.forEachChild((n) => { if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === 'enCopy') enNode = d.initializer; });
    const shape = (n: ts.Expression): object => Object.fromEntries((n as ts.ObjectLiteralExpression).properties.map((p) => {
      const init = (p as ts.PropertyAssignment).initializer;
      return [(p.name as ts.Identifier).text, ts.isObjectLiteralExpression(init) ? shape(init) : ''];
    }));
    const en = shape(enNode!);
    expect(keys(en).length).toBeGreaterThan(20);
    for (const code of ['zh', 'ta', 'th', 'vi'] as const) {
      const c = (await import(`../mobile/lib/locales/${code}.ts`)).company;
      expect(keys(c)).toEqual(keys(en));
    }
  });
});

describe('which language the app speaks', () => {
  it('follows the phone’s first language the app has, else English', async () => {
    device.locales = [{ languageCode: 'fr' }, { languageCode: 'ta' }, { languageCode: 'ms' }];
    let { i18n } = await fresh();
    expect(i18n.appLocale()).toBe('ta');
    device.locales = [{ languageCode: 'de' }, { languageCode: null }];
    ({ i18n } = await fresh());
    expect(i18n.appLocale()).toBe('en');
  });
  it('the person’s choice wins over the phone, is kept across launches, and drives dates and the API language', async () => {
    device.locales = [{ languageCode: 'ms' }];
    let { prefs, i18n } = await fresh();
    expect(i18n.appLocale()).toBe('ms');
    prefs.setDisplayPref('language', 'zh');
    expect(i18n.appLocale()).toBe('zh');
    expect(i18n.intlLocale()).toBe('zh-Hans-MY');
    ({ prefs, i18n } = await fresh()); // a relaunch reads the stored choice
    expect(i18n.appLocale()).toBe('zh');
    prefs.setDisplayPref('language', 'auto');
    expect(i18n.appLocale()).toBe('ms');
    expect(i18n.intlLocale()).toBe('ms-MY');
    const tags = { en: 'en-MY', ms: 'ms-MY', zh: 'zh-Hans-MY', ta: 'ta-MY', th: 'th-TH', vi: 'vi-VN' } as const;
    for (const [code, tag] of Object.entries(tags)) { prefs.setDisplayPref('language', code as never); expect(i18n.intlLocale()).toBe(tag); expect(() => new Intl.DateTimeFormat(tag)).not.toThrow(); }
  });
  it('names each language in its own script', async () => {
    const { i18n, prefs } = await fresh();
    expect(Object.keys(i18n.LANGUAGE_NAMES).sort()).toEqual([...prefs.APP_LOCALES].sort());
    expect(i18n.LANGUAGE_NAMES.ta).toBe('தமிழ்');
  });
});

describe('display preferences', () => {
  it('fall back to Automatic for anything missing, damaged or unknown', async () => {
    const { prefs } = await fresh();
    expect(prefs.parsePrefs(null)).toEqual({ appearance: 'auto', language: 'auto' });
    expect(prefs.parsePrefs('{not json')).toEqual({ appearance: 'auto', language: 'auto' });
    expect(prefs.parsePrefs(JSON.stringify({ appearance: 'sepia', language: 'fr' }))).toEqual({ appearance: 'auto', language: 'auto' });
    expect(prefs.parsePrefs(JSON.stringify({ appearance: 'dark', language: 'th' }))).toEqual({ appearance: 'dark', language: 'th' });
  });
  it('notifies the app and keeps the choice; the language change asks to reopen Settings once', async () => {
    const { prefs } = await fresh();
    const seen = vi.fn();
    const off = prefs.subscribeDisplayPrefs(seen);
    prefs.setDisplayPref('appearance', 'light');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(JSON.parse(device.store.get('aihr.display-preferences.v1')!)).toEqual({ appearance: 'light', language: 'auto' });
    off();
    prefs.reopenAfterLanguageChange('/settings');
    expect(prefs.takeReopenAfterLanguage()).toBe('/settings');
    expect(prefs.takeReopenAfterLanguage()).toBeNull();
  });
});
