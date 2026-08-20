/**
 * 9066bd6c — every translation key the Remove Employee Payroll surfaces use resolves, in all six locales.
 *
 * WHY THIS FILE EXISTS AT ALL, given test/i18n-coverage.test.ts. That guard's Check C — "every static
 * t('a.b') resolves in en.json" — only runs on files that reference exactly ONE namespace, because it
 * cannot tell which namespace a key belongs to otherwise. The Remove screen reads two (`payroll.batch`
 * for its own copy, `payroll.list` for the summary strip's column labels, exactly as the Reprocess screen
 * does), and so do the Payroll Process list and the run screen where the two entry points live. Check C
 * is therefore SILENT on all three, which is precisely the r134 shape: a screen shipped reading a
 * namespace that never had its keys, passing tsc, the suite and `next build`, returning 200, and
 * rendering MISSING_MESSAGE on every line.
 *
 * This file closes that hole for these files by binding each `t(…)` / `tl(…)` / `tb(…)` call to the
 * namespace its own variable was declared with, then resolving it in every locale — not only English,
 * because a key present in en.json and absent from ms.json fails for exactly one set of users.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const dicts = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${l}.json`), 'utf8'))]),
) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

const resolve = (dict: Record<string, unknown>, dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), dict);

/**
 * Every `<var> = (get|use)Translations('<ns>')` in a file, then every literal `<var>('key')` call, mapped
 * to `<ns>.key`. Template-literal keys (t(`status.${x}`)) are skipped by construction — they cannot be
 * resolved statically, and inventing a resolution for them would make this guard lie.
 */
function staticKeysOf(rel: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const ns = new Map<string, string>();
  for (const m of src.matchAll(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:get|use)Translations\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    ns.set(m[1], m[2]);
  }
  expect(ns.size, `${rel}: no getTranslations/useTranslations binding found — has the file moved?`).toBeGreaterThan(0);
  const keys = new Set<string>();
  for (const [v, namespace] of ns) {
    const call = new RegExp(`\\b${v}\\(\\s*'([A-Za-z0-9_.]+)'`, 'g');
    for (const m of src.matchAll(call)) keys.add(`${namespace}.${m[1]}`);
  }
  return [...keys].sort();
}

/**
 * The multi-namespace payroll surfaces Check C is silent on. Most were added or touched by the Remove
 * feature and carry a `remove*` key; the Reset SCREEN (9f8cd608) is here because it is the same shape and
 * the same blind spot — three namespaces (`payroll.batch`, `payroll.list`, `common`), eighteen keys, and
 * Check C skips it for exactly the reason it skips the other five. A guard that only covered the files
 * whose name happens to contain "remove" would be a coincidence, not a fence.
 */
const FILES = [
  'app/payroll/[batchId]/remove/page.tsx',
  'app/payroll/[batchId]/remove/remove-form.tsx',
  'app/payroll/[batchId]/reset/page.tsx',
  'app/payroll/page.tsx',
  'app/payroll/[batchId]/page.tsx',
  'app/payroll/back.ts',
];

/**
 * The action layer is deliberately NOT in the list above and is asserted by name here instead.
 * `app/payroll/actions.ts` declares a FRESH `const t = await getTranslations(...)` inside each of its
 * twenty-odd server actions, several with different namespaces, so a file-level "variable → namespace"
 * extractor binds every call to whichever declaration it saw last and reports keys that are not really
 * missing. Naming the keys is the honest form of the same check for this file.
 */
const ACTION_KEYS = [
  'payroll.batch.removeNoneSelected',
  // The two ENTITLEMENT refusals, thrown before the reason check and therefore before every other line
  // below. They were the hole this list was meant to make impossible: unmapped, the catch fell through to
  // `(e as Error).message` and painted the service's raw English ("Payroll reset is not enabled.") into
  // the error banner in all six locales.
  'payroll.batch.removeDisabled',
  'payroll.batch.removeModuleOff',
  'payroll.batch.removeAdminOnly',
  'payroll.batch.removeReasonMissing',
  'payroll.batch.removeWholeRunRefused',
  'payroll.batch.removePeriodClosed',
  'payroll.batch.removeNotOnRun',
  'payroll.batch.removeNotProcessed',
];

describe('Remove Employee Payroll — i18n resolution', () => {
  it.each(FILES)('%s: every static key resolves non-empty in all six locales', (rel) => {
    const keys = staticKeysOf(rel);
    expect(keys.length, `${rel}: extracted no keys`).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const key of keys) {
      for (const loc of LOCALES) {
        const v = resolve(dicts[loc], key);
        if (typeof v !== 'string' || v.trim() === '') bad.push(`[${loc}] ${key}`);
      }
    }
    expect(bad, `unresolved keys in ${rel}:\n${bad.join('\n')}`).toEqual([]);
  });

  it('removeEmployeePayrollAction: every refusal it can render resolves in all six locales', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/payroll/actions.ts'), 'utf8');
    const action = src.slice(src.indexOf('export async function removeEmployeePayrollAction'));
    const body = action.slice(0, action.indexOf('\nexport async function', 1));
    const bad: string[] = [];
    for (const key of ACTION_KEYS) {
      // The list above is only trustworthy while it matches the source, so assert BOTH directions:
      // the action really uses the key, and the key really resolves.
      expect(body, `removeEmployeePayrollAction no longer uses ${key}`).toContain(`t('${key.split('.').pop()}')`);
      for (const loc of LOCALES) {
        const v = resolve(dicts[loc], key);
        if (typeof v !== 'string' || v.trim() === '') bad.push(`[${loc}] ${key}`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('the whole remove* key set is present in every locale (nothing half-translated)', () => {
    const en = resolve(dicts.en, 'payroll.batch') as Record<string, string>;
    const removeKeys = Object.keys(en).filter((k) => k.startsWith('remove'));
    // A floor, so a botched merge that drops the block fails here rather than passing vacuously.
    expect(removeKeys.length).toBeGreaterThanOrEqual(30);
    for (const loc of LOCALES) {
      const d = resolve(dicts[loc], 'payroll.batch') as Record<string, string>;
      const missing = removeKeys.filter((k) => typeof d[k] !== 'string' || d[k].trim() === '');
      expect(missing, `[${loc}] missing: ${missing.join(', ')}`).toEqual([]);
    }
  });

  it('Remove and Reset never share a string — the two actions must read differently', () => {
    // The reporter's explicit ask, and a real hazard: a confirmation dialog that reuses Reset's wording
    // tells the operator the wrong thing about what happens to the other twenty-two people on the run.
    //
    // ONE DELIBERATE EXCEPTION, and it is a neutral FIELD LABEL rather than copy that describes an
    // action: both dialogs ask for "Reason (required)" and both mean it identically. Making them differ
    // would be inventing a distinction to satisfy a test.
    const SHARED_NEUTRAL_LABELS = new Set(['removeReasonLabel']);
    const b = resolve(dicts.en, 'payroll.batch') as Record<string, string>;
    const resetCopy = new Set(
      Object.entries(b)
        .filter(([k]) => k.startsWith('reset'))
        .map(([, v]) => v),
    );
    const shared = Object.entries(b)
      .filter(([k, v]) => k.startsWith('remove') && !SHARED_NEUTRAL_LABELS.has(k) && resetCopy.has(v))
      .map(([k]) => k);
    expect(shared, `remove keys reusing Reset's exact copy: ${shared.join(', ')}`).toEqual([]);

    // And the four that carry the ACTION's meaning must each be its own sentence.
    for (const [removeKey, resetKey] of [
      ['removeConfirmTitle', 'resetTitle'],
      ['removeConfirmBody', 'resetDescription'],
      ['removeConfirmYes', 'resetConfirm'],
      ['removeHeaderAction', 'resetPayroll'],
    ] as const) {
      for (const loc of LOCALES) {
        const d = resolve(dicts[loc], 'payroll.batch') as Record<string, string>;
        expect(d[removeKey], `[${loc}] ${removeKey} must not read as ${resetKey}`).not.toBe(d[resetKey]);
      }
    }
  });
});


/**
 * THE GATE → REFUSAL CONTRACT, asserted across the three files that hold it.
 *
 * It lives in this file rather than in test/payroll-remove-employee.test.ts because it is the same shape
 * as the ACTION_KEYS check above and fails for the same reason: a defect that lives BETWEEN two files is
 * invisible to a unit test of either half. `removeEmployeePayroll` can be perfect and every DB case green
 * while the screen still renders a selection form for a door that is shut, and the action still paints the
 * service’s raw English into the error banner for all six locales — which is exactly what shipped for
 * `payroll.reset_enabled` until this guard existed.
 */
describe('Remove Employee Payroll — every refusal the engine can raise has a translated surface', () => {
  const SRC = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /** The body of one exported function, up to the next top-level `export`. */
  const bodyOf = (src: string, decl: string) => {
    const from = src.indexOf(decl);
    expect(from, `${decl} not found — has it been renamed?`).toBeGreaterThan(-1);
    const rest = src.slice(from);
    const end = rest.indexOf('\nexport ', 1);
    return end === -1 ? rest : rest.slice(0, end);
  };

  it('every named error removeEmployeePayroll throws is mapped by removeEmployeePayrollAction', () => {
    // Derived from the SERVICE's own source, so a refusal added there without a translated line here
    // fails immediately rather than reaching an operator as untranslated English. A bare `Error` is
    // excluded on purpose: it is the "batch not found" impossible-state throw, which has no operator copy
    // because it is not an operator-facing outcome.
    const service = bodyOf(SRC('core/payroll.ts'), 'export async function removeEmployeePayroll(');
    const thrown = [...new Set([...service.matchAll(/throw new ([A-Z]\w*)\(/g)].map((m) => m[1]))]
      .filter((n) => n !== 'Error')
      .sort();
    // A floor, so a refactor that stops matching cannot make this pass vacuously.
    expect(thrown.length).toBeGreaterThanOrEqual(6);

    const action = bodyOf(SRC('app/payroll/actions.ts'), 'export async function removeEmployeePayrollAction(');
    const unmapped = thrown.filter((n) => !action.includes(`instanceof ${n}`));
    expect(unmapped, `unmapped in removeEmployeePayrollAction: ${unmapped.join(', ')}`).toEqual([]);

    // The permission refusal is thrown THROUGH assertPayrollPermission rather than by a literal `throw`
    // in the body, so the regex above cannot see it. Named here so it is still covered.
    expect(action).toContain('instanceof PayrollPermissionDeniedError');
  });

  it('the Remove page renders a reason for every field removeEligibility reports', () => {
    // The SECOND surface the page header promises. `enabled` is the one that was missing: both entry
    // points hide their link while `payroll.reset_enabled` is off, so the only way in is a direct visit,
    // and the page answered it with the full selection form.
    const page = SRC('app/payroll/[batchId]/remove/page.tsx');
    const eligibility = bodyOf(SRC('core/payroll.ts'), 'export type RemoveEligibility = {');
    const fields = [...eligibility.matchAll(/^\s{2}(\w+): boolean;/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(['enabled', 'periodClosed', 'permitted', 'processed']);
    const missing = fields.filter((f) => !page.includes(`eligibility.${f}`));
    expect(missing, `RemoveEligibility fields the page never reads: ${missing.join(', ')}`).toEqual([]);
    // …and each one resolves to copy, not to a bare boolean the page swallows.
    for (const key of ['removeDisabled', 'removeAdminOnly', 'removeNotProcessed', 'removePeriodClosed']) {
      expect(page, `the refusal chain no longer renders ${key}`).toContain(`t('${key}')`);
    }
  });
});
