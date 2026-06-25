/**
 * The EA PDF route imports the `payroll.ea` namespace and dereferences a fixed set of leaf keys to build
 * the PDF labels. The i18n-coverage static check (C) skips multi-namespace files, and a server route is
 * exempt from its single-namespace heuristic — so a key the route requires could silently go missing from
 * en.json without any guard. This test closes that gap: every `t('…')` literal in the route must resolve
 * under `payroll.ea` in en.json. (Locale completeness — every key mirrored across all 6 locales — is
 * already enforced by i18n-coverage check A.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTE = path.resolve(__dirname, '../app/me/ea/[employmentId]/pdf/route.ts');
const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8')) as Record<string, unknown>;

function get(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('EA PDF route — payroll.ea key coverage', () => {
  it('every t() key the route dereferences exists under payroll.ea in en.json', () => {
    const src = fs.readFileSync(ROUTE, 'utf8');
    const keys = [...src.matchAll(/\bt\(\s*['"]([a-zA-Z][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10); // sanity: the route does dereference the namespace
    const missing = [...new Set(keys)].filter((k) => get(en, `payroll.ea.${k}`) === undefined);
    expect(missing, `missing payroll.ea keys: ${missing.join(', ')}`).toEqual([]);
  });
});
