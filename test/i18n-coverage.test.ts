/**
 * i18n coverage guard (added after the ADR-0016 extraction left orphaned namespaces — payroll.batch,
 * performance.review — referenced in code but absent from en.json, so those pages rendered raw keys).
 *
 * Three structural, deterministic checks that fail CI before a half-translated screen ships:
 *   A. Locale completeness — every key in en.json exists in every other locale (no silent English fallback).
 *   B. Namespace existence — every getTranslations/useTranslations('ns') in code resolves to en.json.
 *   C. Static-key resolution — single-namespace keys and lexically bound custom-copy calls resolve.
 *
 * "en.json" means the catalogue the app serves: i18n/catalogs.ts merges messages/ai-centre/<locale>.json over
 * messages/<locale>.json, so the catalogue file list is read from that file rather than restated here.
 *
 * NOTE: dynamic keys (t(`status.${x}`)) can't be checked statically — that class is covered by the
 * periodic agent audit, not this test.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {personnelFormulaFieldDescriptor} from '../lib/pay-formula-personnel';
import {PAY_FORMULA_FUNCTIONS,PAY_FORMULA_FIELD_TYPES} from '../lib/pay-formula-registry';

const MESSAGES = path.resolve(__dirname, '../messages');
const LOCALES = ['ms', 'ta', 'th', 'vi', 'zh'] as const;

type Dict = Record<string, unknown>;
const ROOT = path.resolve(__dirname, '..');
const readJson = (file: string): Dict => JSON.parse(fs.readFileSync(file, 'utf8'));

// Every catalogue i18n/catalogs.ts imports, as `messages/…/<locale>.json` templates, in its merge order (main first).
function runtimeCatalogues(requestSource: string): string[] {
  const out: string[] = [];
  for (const m of requestSource.matchAll(/['"`]\.\.\/(messages\/(?:[a-z-]+\/)?)(?:en|\$\{locale\})\.json['"`]/g)) {
    const template = `${m[1]}{locale}.json`;
    if (!out.includes(template)) out.push(template);
  }
  return out;
}
const CATALOGUES = runtimeCatalogues(fs.readFileSync(path.join(ROOT, 'i18n/catalogs.ts'), 'utf8'));

// Later catalogues overlay earlier ones key by key. Unlike the runtime's English fallback, nothing fills a gap,
// so check A still sees a locale's own missing or blank keys.
function overlay(base: Dict, over: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
      ? overlay(b as Dict, v as Dict) : v;
  }
  return out;
}
const load = (loc: string): Dict => ({
  ...CATALOGUES.reduce<Dict>((acc, template) => overlay(acc, readJson(path.join(ROOT, template.replace('{locale}', loc)))), {}),
  loginEditorial: readJson(path.join(MESSAGES, 'login-editorial', `${loc}.json`)),
});

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

type Source = { file: string; src: string };
const sources = (): Source[] => sourceFiles().map((f) => ({ file: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }));
const NAMESPACE = /use(?:Translations)\(\s*['"]([^'"]+)['"]\s*\)|getTranslations\(\s*['"]([^'"]+)['"]\s*\)/g;

function namespaceOrphans(files: Source[], catalogue: Dict): string[] {
  const orphans: string[] = [];
  for (const { file, src } of files) {
    for (const m of src.matchAll(NAMESPACE)) {
      const ns = m[1] ?? m[2];
      const node = getPath(catalogue, ns);
      if (node == null || typeof node !== 'object') orphans.push(`${ns}  (${file})`);
    }
  }
  return [...new Set(orphans)];
}

// Track lexical bindings, rather than assigning every t() in a file to its one direct namespace.
// This wrapper deliberately exposes a subset of probationEmailBuilder through its copy member.
// The source-contract regression below ensures that its namespace/prefix cannot silently drift.
const COPY_BINDINGS: Record<string, Record<string, string>> = {
  useProbationEmailCopy: {copy: 'probationEmailBuilder.ui'},
};
function boundStaticTranslationKeys(source: string): string[] {
  const tree = ts.createSourceFile('coverage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bindings = new Map<ts.Node, Map<string, string | null>>();
  const aliases: {scope: ts.Node; name: ts.Identifier; target: ts.Identifier}[] = [];
  const scopeOf = (node: ts.Node): ts.Node => {
    while (!ts.isSourceFile(node) && !ts.isBlock(node) && !ts.isFunctionLike(node)) node = node.parent;
    return node;
  };
  const bind = (scope: ts.Node, name: ts.BindingName, namespace: string | null) => {
    let entries = bindings.get(scope);
    if (!entries) bindings.set(scope, entries = new Map());
    if (ts.isIdentifier(name)) entries.set(name.text, namespace);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(scope, element.name, null);
  };
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      const scope = scopeOf(node.parent);
      bind(scope, node.name, null); // A local non-translation variable must shadow an outer binding.
      const initializer = node.initializer && ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression : node.initializer;
      if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
        const factory = initializer.expression.text;
        const argument = initializer.arguments[0];
        if ((factory === 'useTranslations' || factory === 'getTranslations') && argument && ts.isStringLiteral(argument)) {
          bind(scope, node.name, argument.text);
        } else if (COPY_BINDINGS[factory] && ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const property = element.propertyName ?? element.name;
            if (ts.isIdentifier(property) && COPY_BINDINGS[factory][property.text]) {
              bind(scope, element.name, COPY_BINDINGS[factory][property.text]);
            }
          }
        }
      } else if (initializer && ts.isIdentifier(initializer) && ts.isIdentifier(node.name)) {
        aliases.push({scope, name: node.name, target: initializer});
      }
    } else if (ts.isParameter(node)) bind(scopeOf(node.parent), node.name, null);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const namespaceAt = (node: ts.Node, name: string): string | null => {
    for (let ancestor: ts.Node | undefined = node; ancestor; ancestor = ancestor.parent) {
      const entries = bindings.get(ancestor);
      if (entries?.has(name)) return entries.get(name) ?? null;
    }
    return null;
  };
  // Resolve simple lexical aliases without guessing a namespace for arbitrary parameters/functions.
  // Multiple passes cover a forward-declared alias chain; cycles remain unresolved.
  for (let pass = 0; pass < aliases.length; pass++) for (const alias of aliases) {
    const namespace = namespaceAt(alias.target, alias.target.text);
    if (namespace) bindings.get(alias.scope)!.set(alias.name.text, namespace);
  }
  const keys: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'rich'
        ? node.expression.expression : node.expression;
      const argument = node.arguments[0];
      if (ts.isIdentifier(callee) && argument && ts.isStringLiteral(argument)) {
        const namespace = namespaceAt(node, callee.text);
        if (namespace) keys.push(`${namespace}.${argument.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return keys;
}
function missingStaticKeys(files: Source[], catalogue: Dict): string[] {
  return [...new Set(files.flatMap(({file, src}) => {
    const namespaces = [...new Set([...src.matchAll(NAMESPACE)].map(match => match[1] ?? match[2]))];
    const hasCustomCopy = Object.keys(COPY_BINDINGS).some(factory => new RegExp(`\\b${factory}\\s*\\(`).test(src));
    // Preserve the existing guard exactly for unrelated files, including translators forwarded
    // through props/helper parameters and the existing multi-namespace exclusion. Only custom-copy
    // files need lexical attribution: their t() belongs to a different namespace from the direct hook.
    const keys = hasCustomCopy ? boundStaticTranslationKeys(src)
      : namespaces.length === 1 ? staticTranslationKeys(src).map(key => `${namespaces[0]}.${key}`) : [];
    return keys.filter(full => getPath(catalogue, full) === undefined).map(full => `${full}  (${file})`);
  }))];
}

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

  it('loads exactly the catalogues the app serves, in its merge order', () => {
    expect(CATALOGUES).toEqual(['messages/{locale}.json', 'messages/ai-centre/{locale}.json']);
    for (const loc of ['en', ...LOCALES]) for (const t of CATALOGUES) expect(fs.existsSync(path.join(ROOT, t.replace('{locale}', loc))), `${t} ${loc}`).toBe(true);
    // The AI centre's keys come only from its own catalogue, so they resolve here only through the merge.
    expect(getPath(readJson(path.join(MESSAGES, 'en.json')), 'aiCentre')).toBeUndefined();
    expect(typeof getPath(en, 'aiCentre.tabsLabel')).toBe('string');
  });

  it('keeps loginEditorial references inside the scoped login provider', () => {
    for (const {file, src} of sources()) for (const match of src.matchAll(NAMESPACE)) {
      if ((match[1] ?? match[2]) === 'loginEditorial') expect(file.startsWith('app/login/'), file).toBe(true);
    }
  });

  it('B. every translation namespace referenced in code exists in en.json', () => {
    const orphans = namespaceOrphans(sources(), en);
    expect(orphans, orphans.join('\n')).toEqual([]);
  });

  it('B and C still fail for a namespace or key missing from both catalogues', () => {
    const files: Source[] = [
      { file: 'synthetic/missing-namespace.tsx', src: `const t = useTranslations('aiCentreMissingNamespace'); t('title');` },
      { file: 'synthetic/missing-key.tsx', src: `const t = useTranslations('aiCentre'); t('tabsLabel'); t('keyInNeitherCatalogue');` },
    ];
    expect(namespaceOrphans(files, en)).toEqual(['aiCentreMissingNamespace  (synthetic/missing-namespace.tsx)']);
    expect(missingStaticKeys(files, en)).toEqual([
      'aiCentreMissingNamespace.title  (synthetic/missing-namespace.tsx)',
      'aiCentre.keyInNeitherCatalogue  (synthetic/missing-key.tsx)',
    ]);
  });

  it('distinguishes complete static literals from dynamic prefixes without hiding missing keys', () => {
    const source = `t('loading'); t("missing.static"); t.rich('rich.key', {value: 1});
      t('fields.' + field); t("parameter." + key); t('notStatic'.toUpperCase());`;
    expect(staticTranslationKeys(source)).toEqual(['loading','missing.static','rich.key']);
    expect(staticTranslationKeys(source).filter(key => getPath(en, `payFormula.${key}`) === undefined))
      .toEqual(['missing.static','rich.key']);
  });

  it('attributes custom copy and legacy aliases to their own bindings, including missing keys', () => {
    const file = 'synthetic/mixed-copy.tsx';
    const src = `function Editor() {
      const legacyCopy = useTranslations('automation');
      const {copy: t} = useProbationEmailCopy();
      t('save'); t('missingBuilderKey'); t.rich('missingRichKey', {});
      legacyCopy('templates.retire'); legacyCopy('templates.missingLegacyKey');
      t('dynamic.' + value);
      function Nested(t: (key: string) => string) { t('notATranslationBinding'); }
      function DifferentNamespace() { const t = useTranslations('payFormula'); t('loading'); }
    }`;
    expect(boundStaticTranslationKeys(src)).toEqual([
      'probationEmailBuilder.ui.save', 'probationEmailBuilder.ui.missingBuilderKey',
      'probationEmailBuilder.ui.missingRichKey', 'automation.templates.retire',
      'automation.templates.missingLegacyKey', 'payFormula.loading',
    ]);
    expect(missingStaticKeys([{file, src}], en)).toEqual([
      `probationEmailBuilder.ui.missingBuilderKey  (${file})`,
      `probationEmailBuilder.ui.missingRichKey  (${file})`,
      `automation.templates.missingLegacyKey  (${file})`,
    ]);
  });

  it('retains alias and forwarded-translator coverage outside custom-copy files', () => {
    const file = 'synthetic/legacy-translators.tsx';
    const src = `const translator = useTranslations('payFormula');
      const t = translator; t('missingAliasKey');
      function Forwarded(t: (key: string) => string) { t('missingForwardedKey'); }`;
    expect(boundStaticTranslationKeys(src)).toEqual(['payFormula.missingAliasKey']);
    expect(missingStaticKeys([{file, src}], en)).toEqual([
      `payFormula.missingAliasKey  (${file})`, `payFormula.missingForwardedKey  (${file})`,
    ]);
    const mixed = `const translator=useTranslations('automation'); const legacy=translator;
      const {copy:t}=useProbationEmailCopy();
      legacy('templates.missingAliasKey'); t('save');
      function Shadow(t: (key: string) => string) { t('notATranslationKey'); }`;
    expect(missingStaticKeys([{file, src:mixed}], en)).toEqual([
      `automation.templates.missingAliasKey  (${file})`,
    ]);
  });

  it('checks all 34 actual Probation editor copy keys and both legacy aliases in every locale', () => {
    const hook = fs.readFileSync(path.join(ROOT, 'app/automation/templates/use-probation-email-copy.ts'), 'utf8');
    expect(hook).toMatch(/const t=useTranslations\('probationEmailBuilder'\)/);
    expect(hook).toMatch(/const copy:EmailBuilderCopy=\(key,values\)=>t\('ui\.'\+key,values\)/);
    const file = 'app/automation/templates/probation-email-editor.tsx';
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const keys = [...new Set(boundStaticTranslationKeys(src))];
    expect(keys.filter(key => key.startsWith('probationEmailBuilder.ui.'))).toHaveLength(34);
    expect(keys.filter(key => key.startsWith('automation.')).sort()).toEqual([
      'automation.templates.retire', 'automation.templates.retireConfirm',
    ]);
    for (const locale of ['en', ...LOCALES]) expect(missingStaticKeys([{file, src}], load(locale)), locale).toEqual([]);
  });

  // Explicit timeout: measured 24.6 s against the global 30 s in main gate 42949200222.
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
      ...Object.values(PAY_FORMULA_FIELD_TYPES).flatMap(fields=>Object.keys(fields).filter(field=>getPath(en,`payFormula.fields.${field}`)!==undefined).map(field=>`fields.${field}`)),
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
    for(const [code,fields]of Object.entries(PAY_FORMULA_FIELD_TYPES))for(const field of Object.keys(fields)){
      if(getPath(en,`payFormula.fields.${field}`)!==undefined)continue;
      const descriptor=personnelFormulaFieldDescriptor(code==='profile'?'EmployeeProfile':'EmployeeInformation',field);
      expect(descriptor,`${code}:${field}`).toBeTruthy();
      for(const locale of ['en',...LOCALES]){
        const value=getPath(load(locale),descriptor!.labelKey);
        expect(typeof value,`${locale}:${descriptor!.labelKey}`).toBe('string');
        expect((value as string).trim()).not.toBe('');
      }
    }
    expect(PAY_FORMULA_FUNCTIONS.length).toBeGreaterThan(20);
    for(const locale of ['en',...LOCALES])for(const key of keys){
      const value=getPath(load(locale),`payFormula.${key}`);
      expect(typeof value,`${locale}:payFormula.${key}`).toBe('string');
      expect((value as string).trim(),`${locale}:payFormula.${key}`).not.toBe('');
    }
  }, 90_000);

  it('C. every static translation key in covered files resolves in en.json', () => {
    const missing = missingStaticKeys(sources(), en);
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
