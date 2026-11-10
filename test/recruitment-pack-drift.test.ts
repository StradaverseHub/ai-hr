/**
 * Recruitment pack drift guard (ADR-0080 D9/D10/D11 criterion 4) — in place from the pack's first slice.
 *
 * Two rules:
 *   1. Nothing outside the pack surface imports a recruitment internal (`packs/recruitment/<file>` other than the
 *      `service` facade and the client-safe `index` wiring). The surface is the pack directory and its own routes
 *      under app/recruitment/. Derived from disk, so a new internal file is guarded the day it is created. The
 *      allowlist is EMPTY and may only stay empty.
 *   2. The pack imports no other pack (D9). Kernel modules (packs/registry, packs/catalog, core/, db/, lib/) are
 *      allowed; `packs/<other>/…` is not — cross-module effects ride kernel contracts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runImportRatchet } from './helpers/import-ratchet';

const root = fileURLToPath(new URL('..', import.meta.url));
const PACK = join(root, 'packs/recruitment');
const FACADE = new Set(['service.ts', 'index.ts']);
const FILES = readdirSync(PACK).filter((f) => /\.tsx?$/.test(f));
const BOUNDARIES = FILES.filter((f) => !FACADE.has(f)).map((f) => `packs/recruitment/${f.replace(/\.tsx?$/, '')}`);
const ALWAYS_ALLOWED = ['packs/recruitment/', 'app/recruitment/'];

describe('ADR-0080 D9: recruitment pack import ratchet', () => {
  it('finds the internal files it is meant to guard (a guard over nothing proves nothing)', () => {
    expect(BOUNDARIES).toEqual(expect.arrayContaining(['packs/recruitment/model', 'packs/recruitment/data', 'packs/recruitment/schema']));
    expect(BOUNDARIES).not.toContain('packs/recruitment/service');
    expect(BOUNDARIES).not.toContain('packs/recruitment/index');
  });

  const results = BOUNDARIES.map((boundary) => runImportRatchet({
    root,
    scan: ['app', 'components', 'core', 'db', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs', 'scripts'],
    boundary,
    allowedImporters: (rel) => ALWAYS_ALLOWED.some((a) => rel.startsWith(a)),
    allowlist: [],
  }));

  it('no file outside the pack surface imports a recruitment internal (import packs/recruitment/service instead)', () => {
    const violations = [...new Set(results.flatMap((r) => r.violations))].sort();
    expect(violations, `Import packs/recruitment/service instead:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the pack routes reach the service through the facade only', () => {
    const importers = new Set(results.flatMap((r) => r.importers));
    expect([...importers].filter((f) => f.startsWith('app/recruitment/'))).toEqual([]);
  });

  it('the pack imports no other pack (kernel contracts only)', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(join(PACK, file), 'utf8');
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        const target = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? relative(root, resolve(dirname(join(PACK, file)), spec)) : spec;
        if (/^packs\/[^/]+\//.test(target) && !target.startsWith('packs/recruitment/')) offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('registers as a module pack whose service facade is the file guarded here', async () => {
    const { recruitmentPack } = await import('../packs/recruitment/index');
    expect(recruitmentPack).toMatchObject({ id: 'recruitment', kind: 'module', serviceFacade: 'packs/recruitment/service' });
    expect(recruitmentPack.navLinks).toEqual([expect.objectContaining({ group: 'manage', href: '/recruitment', labelKey: 'recruitment' })]);
  });
});
