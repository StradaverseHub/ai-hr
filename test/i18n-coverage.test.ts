/**
 * i18n coverage guard (added after the ADR-0016 extraction left orphaned namespaces — payroll.batch,
 * performance.review — referenced in code but absent from en.json, so those pages rendered raw keys).
 *
 * Three structural, deterministic checks that fail CI before a half-translated screen ships:
 *   A. Locale completeness — every key in en.json exists in every other locale (no silent English fallback).
 *   B. Namespace existence — every getTranslations/useTranslations('ns') in code resolves to en.json.
 *   C. Static-key resolution — every literal t('a.b') in a single-namespace file resolves in en.json.
 *
 * NOTE: dynamic keys (t(`status.${x}`)) can't be checked statically — that class is covered by the
 * periodic agent audit, not this test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MESSAGES = path.resolve(__dirname, '../messages');
const LOCALES = ['ms', 'ta', 'th', 'vi', 'zh'] as const;

type Dict = Record<string, unknown>;
const load = (loc: string): Dict => JSON.parse(fs.readFileSync(path.join(MESSAGES, `${loc}.json`), 'utf8'));

function flatten(obj: Dict, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Dict, key, out);
    else out[key] = v;
  }
  return out;
}
function getPath(obj: Dict, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);
}

function sourceFiles(): string[] {
  const roots = ['app', 'components'].map((d) => path.resolve(__dirname, '..', d));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|ts)$/.test(e.name)) out.push(p);
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  return out;
}

const en = load('en');

describe('i18n coverage', () => {
  it('A. every en.json key exists in every locale (no missing/blank fallbacks)', () => {
    const enFlat = flatten(en);
    const report: string[] = [];
    for (const loc of LOCALES) {
      const flat = flatten(load(loc));
      const missing = Object.keys(enFlat).filter((k) => !(k in flat) || flat[k] === '' || flat[k] == null);
      if (missing.length) report.push(`[${loc}] missing ${missing.length}: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`);
    }
    expect(report, report.join('\n')).toEqual([]);
  });

  it('B. every translation namespace referenced in code exists in en.json', () => {
    const orphans: string[] = [];
    for (const f of sourceFiles()) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/use(?:Translations)\(\s*['"]([^'"]+)['"]\s*\)|getTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const ns = m[1] ?? m[2];
        const node = getPath(en, ns);
        if (node == null || typeof node !== 'object') orphans.push(`${ns}  (${path.relative(path.resolve(__dirname, '..'), f)})`);
      }
    }
    expect([...new Set(orphans)], orphans.join('\n')).toEqual([]);
  });

  it('C. every static t() key in a single-namespace file resolves in en.json', () => {
    const missing: string[] = [];
    for (const f of sourceFiles()) {
      const src = fs.readFileSync(f, 'utf8');
      const namespaces = [
        ...src.matchAll(/use(?:Translations)\(\s*['"]([^'"]+)['"]\s*\)|getTranslations\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((m) => m[1] ?? m[2]);
      const uniq = [...new Set(namespaces)];
      if (uniq.length !== 1) continue; // multi-namespace files: skip (can't attribute keys statically)
      const ns = uniq[0];
      for (const km of src.matchAll(/\bt(?:\.rich)?\(\s*['"]([a-z][a-zA-Z0-9_.]*)['"]/g)) {
        const full = `${ns}.${km[1]}`;
        if (getPath(en, full) === undefined) missing.push(`${full}  (${path.relative(path.resolve(__dirname, '..'), f)})`);
      }
    }
    expect([...new Set(missing)], missing.join('\n')).toEqual([]);
  });
});
