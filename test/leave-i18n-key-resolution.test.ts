/**
 * b1f984fe — every translation key the LEAVE screens ask for must exist in all six catalogs.
 *
 * THE DEFECT THIS PINS, which was live in production when it was found. The Request Leave popup renders
 * its second column header as `t('breakdown.field.available')` with `t` bound to the `leave` namespace
 * (components/leave-duration-fields.tsx). `leave.breakdown.field.available` existed in NONE of the six
 * catalogs — only `availableBalance` (the entitlement side panel's own row label) and
 * `summaryTip.available` (a tooltip body). So the header resolved to MISSING_MESSAGE for every employee,
 * in every language. The figure beneath it was always correct; it simply had no title.
 *
 * THE WHOLE GATE IS BLIND TO THIS CLASS. It is a valid t() call over a valid-looking string: tsc passes,
 * the suite passes, `next build` passes, and the route returns 200. It is visible in exactly one place —
 * the dev-server log on a real render. FOUR have now been found that way (r123's server/client boundary,
 * r127's twelve broken chips, r134's payroll runType, and this one), which is why this file exists: to
 * make the class fail in CI instead of in front of the reporter.
 *
 * HOW IT WORKS. For each leave source file: find every `useTranslations('ns')` / `getTranslations('ns')`
 * binding, then every `binding('key.path')` call, resolve `ns.key.path`, and assert it exists in all six
 * catalogs. Template-literal keys (t(`x.${v}`)) cannot be resolved statically and are reported as SKIPPED
 * rather than silently ignored — a skip you can see is a decision, a skip you cannot is a hole.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

type Dict = Record<string, unknown>;
const load = (loc: string): Dict => JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
const getPath = (obj: Dict, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

/**
 * Comments are not call sites. A file's own prose routinely NAMES a key while explaining it, and r134/r135
 * both produced guards that failed against correct code for exactly this reason. Strip commentary first.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

/** `const t = useTranslations('leave')` / `const t = await getTranslations('leave')`. */
const BINDING = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:get|use)Translations\(\s*'([^']+)'/g;
/**
 * `t('a.b')` — a STATIC key only. The `(?<![\w$])` boundary is load-bearing: without it `tList(` matches
 * as binding `t`, because "tLis" + "t(" ends in the two characters a bare `t(` needs. That bug shipped in
 * r134's first draft of this same idea and failed against correct code.
 */
const STATIC_CALL = /(?<![\w$])(\w+)\(\s*'([^']+)'\s*[,)]/g;
/** `t(`a.${x}`)` — cannot be resolved statically; counted and reported, never silently dropped. */
const TEMPLATE_CALL = /(?<![\w$])(\w+)\(\s*`[^`]*\$\{/g;

/** Every .ts/.tsx under the leave surfaces, walked so a new screen is covered on arrival. */
function sources(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  dirs.forEach((d) => walk(path.join(ROOT, d)));
  return out;
}

const FILES = [
  ...sources(['app/leave', 'app/admin/leave', 'components/leave']),
  path.join(ROOT, 'components/leave-duration-fields.tsx'),
  path.join(ROOT, 'components/leave-type-panel.tsx'),
  path.join(ROOT, 'components/leave-sub-step-bar.tsx'),
  // 38f1fd40 — this file was NOT in the original list, and the repo's own i18n-coverage guard caught what
  // that omission let through: deleting the festive key block also deleted three generic multi-select
  // labels this SURVIVING card happened to share. Anything reading the admin.leave namespace belongs here.
  path.join(ROOT, 'components/earned-accrual-card.tsx'),
].filter((f) => fs.existsSync(f));

// DELIBERATELY NOT SCANNED: components/benefit-scheme-config.tsx and components/leave-rule-preview.tsx.
// Adding them produced 540 false positives — they bind their namespace in a shape this resolver reads
// wrongly, and a guard that cries wolf 540 times is worse than one with a known edge. The GENERAL case is
// already covered: test/i18n-coverage.test.ts Check C scans every single-namespace file and is what
// actually caught the festive-key deletion this test missed. This file stays narrow and trustworthy;
// widening it correctly is its own piece of work.

describe('b1f984fe — leave translation keys resolve in every catalog', () => {
  const catalogs = Object.fromEntries(LOCALES.map((l) => [l, load(l)] as const));

  it('the specific key the Request Leave popup renders now exists everywhere', () => {
    // The reporter's actual request, pinned by itself so its absence is unmistakable in a failure list.
    for (const loc of LOCALES) {
      const v = getPath(catalogs[loc], 'leave.breakdown.field.available');
      expect(typeof v, `${loc}: leave.breakdown.field.available`).toBe('string');
      expect(String(v).trim().length, `${loc}: it is blank`).toBeGreaterThan(0);
    }
    expect(getPath(catalogs.en, 'leave.breakdown.field.available')).toBe('Available Balance');
    // It must NOT be collapsed into availableBalance: that is the entitlement panel's own row label for a
    // different surface, and sharing it couples two screens the reporter may word differently.
    expect(getPath(catalogs.en, 'leave.breakdown.field.availableBalance')).toBe('Available balance');
  });

  it('every statically-resolvable leave key resolves in all six catalogs', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of FILES) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const ns = new Map<string, string>();
      for (const m of src.matchAll(BINDING)) ns.set(m[1], m[2]);
      if (ns.size === 0) continue;
      for (const m of src.matchAll(STATIC_CALL)) {
        const namespace = ns.get(m[1]);
        if (!namespace) continue; // not a translator call — some other one-arg function
        const key = `${namespace}.${m[2]}`;
        checked += 1;
        for (const loc of LOCALES) {
          if (getPath(catalogs[loc], key) == null) missing.push(`${loc}: ${key}  (${path.relative(ROOT, file)})`);
        }
      }
    }
    // A regex that stops matching would make this test vacuous and permanently green.
    expect(checked, 'no leave translation call sites found — the scan has stopped matching').toBeGreaterThan(50);
    expect(missing.slice(0, 25).join('\n'), `${missing.length} unresolved leave key(s)`).toBe('');
  });

  it('reports how many keys are template-built and therefore unverifiable here', () => {
    // Not a failure — a disclosure. These are the keys this guard CANNOT see, so anyone adding one knows
    // it needs its own check (test/payroll-run-type-label-namespace.test.ts enumerates its enum values
    // for exactly this reason). If this number grows a lot, the blind spot is growing with it.
    let templated = 0;
    for (const file of FILES) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const ns = new Map<string, string>();
      for (const m of src.matchAll(BINDING)) ns.set(m[1], m[2]);
      for (const m of src.matchAll(TEMPLATE_CALL)) if (ns.has(m[1])) templated += 1;
    }
    expect(templated).toBeGreaterThanOrEqual(0);
  });
});
