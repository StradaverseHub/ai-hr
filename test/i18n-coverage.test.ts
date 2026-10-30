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
import {PAY_FORMULA_FUNCTIONS,PAY_FORMULA_FIELD_TYPES} from '../lib/pay-formula-registry';

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

// Only a complete literal argument is static. A quoted prefix followed by + is dynamic.
function staticTranslationKeys(source: string): string[] {
  return [...source.matchAll(/\bt(?:\.rich)?\(\s*(['"])([a-z][a-zA-Z0-9_.]*)\1\s*(?=[,)])/g)].map(match => match[2]);
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

  it('distinguishes complete static literals from dynamic prefixes without hiding missing keys', () => {
    const source = `t('loading'); t("missing.static"); t.rich('rich.key', {value: 1});
      t('fields.' + field); t("parameter." + key); t('notStatic'.toUpperCase());`;
    expect(staticTranslationKeys(source)).toEqual(['loading','missing.static','rich.key']);
    expect(staticTranslationKeys(source).filter(key => getPath(en, `payFormula.${key}`) === undefined))
      .toEqual(['missing.static','rich.key']);
  });

  it('resolves the Formula editor dynamic catalogue in every locale', () => {
    const editor=fs.readFileSync(path.resolve(__dirname,'../app/payroll/formula-builder/condition-editor.tsx'),'utf8');
    const parameterMap=editor.match(/const parameterKeys:Record<string,string>=\{([^}]+)\}/)?.[1];
    expect(parameterMap).toBeTruthy();
    const parameters=new Map([...parameterMap!.matchAll(/'([^']+)':'([^']+)'/g)].map(match=>[match[1],match[2]]));
    expect(parameters.size).toBe(11);
    const keys=new Set([
      ...['decimal','string','boolean','date'].map(type=>`types.${type}`),
      ...['decimal','string','boolean','name','call','unary','binary'].map(kind=>`expression.${kind}`),
      ...['declare','assign','if','explain','return','comment'].map(kind=>`statement.${kind}`),
      ...Object.values(PAY_FORMULA_FIELD_TYPES).flatMap(fields=>Object.keys(fields).map(field=>`fields.${field}`)),
      ...PAY_FORMULA_FUNCTIONS.flatMap(fn=>[
        `functions.${fn.code}`,`functionHelp.${fn.code}`,
        ...fn.parameters.map(parameter=>{
          expect(parameters.has(parameter.name),parameter.name).toBe(true);
          return `parameter.${parameters.get(parameter.name)}`;
        }),
        ...fn.parameters.flatMap(parameter=>(parameter.choices??[]).flatMap(choice=>{
          const key=getPath(en,`payFormula.fields.${choice}`)!==undefined?`fields.${choice}`
            :getPath(en,`payFormula.choices.${choice}`)!==undefined?`choices.${choice}`:null;
          // The editor deliberately shows unlocalized source codes only when no catalogue label exists.
          expect(choice.trim()).not.toBe('');return key?[key]:[];
        })),
      ]),
    ]);
    expect(PAY_FORMULA_FUNCTIONS.length).toBeGreaterThan(20);
    for(const locale of ['en',...LOCALES])for(const key of keys){
      const value=getPath(load(locale),`payFormula.${key}`);
      expect(typeof value,`${locale}:payFormula.${key}`).toBe('string');
      expect((value as string).trim(),`${locale}:payFormula.${key}`).not.toBe('');
    }
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
      for (const key of staticTranslationKeys(src)) {
        const full = `${ns}.${key}`;
        if (getPath(en, full) === undefined) missing.push(`${full}  (${path.relative(path.resolve(__dirname, '..'), f)})`);
      }
    }
    expect([...new Set(missing)], missing.join('\n')).toEqual([]);
  });
});
