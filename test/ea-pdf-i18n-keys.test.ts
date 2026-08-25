/**
 * The EA PDF label bundle imports the `payroll.ea` namespace and dereferences a fixed set of leaf keys.
 * The i18n-coverage static check (C) skips multi-namespace files, scans only `app/` and `components/`, and
 * exempts a server route from its single-namespace heuristic — so a key the bundle requires could silently
 * go missing from en.json without any guard. This test closes that gap: every `t('…')` literal in the
 * bundle must resolve under `payroll.ea` in en.json. (Locale completeness — every key mirrored across all
 * 6 locales — is already enforced by i18n-coverage check A.)
 *
 * r220 — THE BUNDLE MOVED, AND THAT IS WHY THIS FILE NOW READS `lib/`. It used to be built inline in
 * app/me/ea/[employmentId]/pdf/route.ts. A second route prints the same form (the blank C.P.8A at
 * app/payroll/ea/blank), and two hand-maintained copies of one statutory form's fifty-odd captions is how
 * the blank and the filled version stop being the same page — so both routes now call
 * `eaPdfLabels()` in lib/ea-pdf-labels.ts, and BOTH are pinned below. `lib/` is outside i18n-coverage's
 * scan roots entirely, which makes this file the only guard on those keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LABELS = path.resolve(__dirname, '../lib/ea-pdf-labels.ts');
const ROUTES = [
  '../app/me/ea/[employmentId]/pdf/route.ts',
  '../app/payroll/ea/blank/route.ts',
].map((r) => path.resolve(__dirname, r));
const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8')) as Record<string, unknown>;

function get(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('EA PDF labels — payroll.ea key coverage', () => {
  it('every t() key the bundle dereferences exists under payroll.ea in en.json', () => {
    const src = fs.readFileSync(LABELS, 'utf8');
    const keys = [...src.matchAll(/\bt\(\s*['"]([a-zA-Z][a-zA-Z0-9_.]*)['"]/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10); // sanity: the bundle does dereference the namespace
    const missing = [...new Set(keys)].filter((k) => get(en, `payroll.ea.${k}`) === undefined);
    expect(missing, `missing payroll.ea keys: ${missing.join(', ')}`).toEqual([]);
    // r220 — the blank form's own footnote. It is resolved on ONE branch of the bundle, so a plain
    // "does every key exist" sweep would still pass if the branch were deleted; name it.
    expect(src).toContain("t('blankDisclaimer')");
    expect(get(en, 'payroll.ea.blankDisclaimer')).toBeTypeOf('string');
  });

  /**
   * r220 — and NEITHER route may grow its own copy of the bundle again. tsc would accept a second inline
   * object (every key is required, so it would compile) and the two forms would then drift one caption at
   * a time, which is the failure the extraction exists to prevent.
   */
  it('both EA PDF routes build their labels from the shared bundle, and neither inlines its own', () => {
    for (const route of ROUTES) {
      const src = fs.readFileSync(route, 'utf8');
      expect(src, `${route} does not use the shared bundle`).toContain('eaPdfLabels(');
      const inlineKeys = [...src.matchAll(/\bt\(\s*['"][a-zA-Z][a-zA-Z0-9_.]*['"]/g)];
      expect(inlineKeys.map((m) => m[0]), `${route} resolves payroll.ea keys of its own`).toEqual([]);
    }
  });
});
