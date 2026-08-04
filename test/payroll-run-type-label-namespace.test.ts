/**
 * r134 — the payroll-cycle label must resolve under the namespace the SCREEN reads it from.
 *
 * THE BUG THIS PINS, which was live in production when it was found. `app/payroll/[batchId]/page.tsx`
 * rendered the run's Cycle field as `t('runType.<cycle>')` with `t` bound to `payroll.batch` — a
 * namespace that has never contained `runType`. The four cycle names are catalogued under
 * `payroll.list`, `payroll.process` and `payrollCycleConfig`. So the Cycle field on EVERY payroll run
 * detail page resolved to `MISSING_MESSAGE: Could not resolve payroll.batch.runType.regular`.
 *
 * NOTHING IN THE GATE COULD SEE IT. It is a valid `t()` call over a valid string, so tsc is happy; no
 * test rendered the page; `next build` compiles it; and the route returns 200 with the field simply
 * blank-ish. It is visible in exactly one place — the dev-server log on a real render. Third time in
 * five rounds (r123's server/client boundary, r127's twelve broken labels, now this).
 *
 * So this test does structurally what only a render could do before: it reads each payroll source file
 * that renders a `runType.${…}` label, resolves WHICH translator binding that call uses, maps the
 * binding back to its namespace, and asserts the key exists in all six catalogs. A future screen that
 * reaches for the label from a namespace that lacks it fails here instead of in production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { payrollRunTypeEnum } from '../db/schema';

const ROOT = path.resolve(__dirname, '..');
const MESSAGES = path.join(ROOT, 'messages');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

type Dict = Record<string, unknown>;
const load = (loc: string): Dict => JSON.parse(fs.readFileSync(path.join(MESSAGES, `${loc}.json`), 'utf8'));
const getPath = (obj: Dict, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

/** Every .ts/.tsx under app/payroll, walked rather than listed — a new screen is covered on arrival. */
function payrollSources(dir = path.join(ROOT, 'app', 'payroll')): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return payrollSources(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** `const t = await getTranslations('payroll.batch')` / `const t = useTranslations('payroll.process')`. */
const BINDING = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:getTranslations|useTranslations)\(\s*'([^']+)'/g;
/**
 * A call site rendering the cycle label: t('runType.regular') or tList(`runType.${…}`).
 *
 * The leading `(?<![\w$])` matters more than it looks: without it, `tList(` matches as the binding `t`,
 * because `tLis` + `t(` ends in exactly the two characters a bare `t(` needs. The first draft of this
 * test failed that way — a guard that reports the RIGHT code as wrong is worse than no guard.
 */
const CALL = /(?<![\w$])(\w+)\(\s*[`'"]runType\./g;

/** Comments are not call sites. This file's own prose names `t('runType.…')` while explaining the bug,
 *  and a scanner that cannot tell code from commentary would flag every explanation of it. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

describe('r134 — payroll runType labels resolve under the namespace each screen reads', () => {
  const catalogs = Object.fromEntries(LOCALES.map((l) => [l, load(l)] as const));

  it('every runType.${…} call site in app/payroll resolves in all six catalogs', () => {
    const checked: string[] = [];
    for (const file of payrollSources()) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const namespaceOf = new Map<string, string>();
      for (const m of src.matchAll(BINDING)) namespaceOf.set(m[1], m[2]);

      for (const m of src.matchAll(CALL)) {
        const ns = namespaceOf.get(m[1]);
        // A call through a binding this file does not declare (a prop, an import) is out of scope for a
        // static check — recorded as unresolvable rather than silently passing.
        expect(ns, `${path.relative(ROOT, file)}: could not resolve the namespace for \`${m[1]}(\``).toBeTruthy();

        for (const cycle of payrollRunTypeEnum.enumValues) {
          const key = `${ns}.runType.${cycle}`;
          for (const loc of LOCALES) {
            expect(getPath(catalogs[loc], key), `${loc}: ${key} (read by ${path.relative(ROOT, file)})`).toBeTruthy();
          }
        }
        checked.push(`${path.relative(ROOT, file)} → ${ns}`);
      }
    }
    // The walk must actually have found call sites — a regex that silently matches nothing would make
    // every assertion above vacuous and this test permanently, uselessly green.
    expect(checked.length, 'no runType label call sites found — the scan regex has stopped matching').toBeGreaterThan(0);
  });

  it('the run detail page reads the cycle label from payroll.list, where it actually lives', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'app', 'payroll', '[batchId]', 'page.tsx'), 'utf8'));
    // Pinned as the specific reversion guard: re-binding this call to `t` (payroll.batch) reintroduces
    // the exact MISSING_MESSAGE this test was written for. The negative needs the same `(?<![\w$])`
    // boundary as CALL above — a plain substring check matches `tLis` + `t(` and fails on correct code.
    expect(src).toContain('tList(`runType.${batch.runType}`)');
    expect(src).not.toMatch(/(?<![\w$])t\(`runType\.\$\{batch\.runType\}`\)/);
    expect(getPath(catalogs.en, 'payroll.batch.runType'), 'payroll.batch must NOT grow a fourth copy').toBeUndefined();
  });
});
