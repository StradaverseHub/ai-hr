/**
 * Rewards pack drift guard (ADR-0080 D9/D11; CLAUDE.md §8: a core/ file imports packs/<pack>/service, never a
 * pack's internals).
 *
 * Unlike the claims or performance packs, the Rewards implementation lives INSIDE the pack directory
 * (`packs/rewards/*.ts`), so the boundary is every file there except the facade (`service.ts`) and the
 * client-safe wiring (`index.ts`, imported by packs/register-all.ts). Derived from disk, so a new internal
 * file is guarded the day it is created.
 *
 * Before this guard existed `core/approvals-inbox.ts` imported the task provider from the pack internal
 * `packs/rewards/tasks` and no test noticed (P1 wave 1 moved it into the facade).
 *
 * Scope, stated rather than implied: app/, components/, core/, i18n/, lib/, localization/, middleware.ts and
 * the other packs. NOT scanned: db/ — db/schema.ts types the reward jsonb columns with type-only
 * `import('../packs/rewards/model')` expressions, the schema's own data contract — and scripts/, whose dev
 * fixtures read the model directly. The pack's own routes (app/(app)/rewards/, app/(app)/admin/rewards/) are its surface
 * and may read its pure model modules. No allowlist: there is no audited debt to carry.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runImportRatchet } from './helpers/import-ratchet';

const root = fileURLToPath(new URL('..', import.meta.url));
const FACADE = new Set(['service.ts', 'index.ts']);
const BOUNDARIES = readdirSync(fileURLToPath(new URL('../packs/rewards', import.meta.url)))
  .filter((f) => /\.tsx?$/.test(f) && !FACADE.has(f))
  .map((f) => `packs/rewards/${f.replace(/\.tsx?$/, '')}`);

const ALWAYS_ALLOWED = [
  'packs/rewards/', // the pack: internals import each other, the facade re-exports them
  'app/(app)/rewards/', // the pack's routes
  'app/(app)/admin/rewards/', // the pack's Module Config routes
];

describe('ADR-0080 D9: rewards pack import ratchet', () => {
  it('finds the internal files it is meant to guard (a guard over nothing proves nothing)', () => {
    expect(BOUNDARIES.length).toBeGreaterThanOrEqual(8);
    expect(BOUNDARIES).toContain('packs/rewards/model');
    expect(BOUNDARIES).toContain('packs/rewards/engine');
    expect(BOUNDARIES).not.toContain('packs/rewards/service');
  });

  const results = BOUNDARIES.map((boundary) =>
    runImportRatchet({
      root,
      scan: ['app', 'components', 'core', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs'],
      boundary,
      allowedImporters: (rel) => ALWAYS_ALLOWED.some((a) => rel.startsWith(a)),
      allowlist: [],
    }),
  );

  it('no file outside the pack surface imports a rewards internal (import packs/rewards/service instead)', () => {
    const violations = [...new Set(results.flatMap((r) => r.violations))].sort();
    expect(violations, `Import packs/rewards/service instead:\n${violations.join('\n')}`).toEqual([]);
  });

  it('core/approvals-inbox.ts reaches the Rewards task provider through the facade', () => {
    const importers = new Set(results.flatMap((r) => r.importers));
    expect(importers.has('core/approvals-inbox.ts')).toBe(false);
  });
});
