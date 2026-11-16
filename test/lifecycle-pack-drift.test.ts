/**
 * Lifecycle pack drift guard (ADR-0080 D9/D11, ADR-0095). Files outside the lifecycle pack surface never
 * import the pack's implementation modules (`core/lifecycle-*`) directly; they import the facade,
 * `packs/lifecycle/service`. The pack was born with NO outside importers, so its allowlist is empty and is
 * seeded empty on purpose: there is no audited debt to carry, and the list may only shrink, which for an
 * empty list means it stays empty. A violation here is a new leak, not a legacy one.
 *
 * The rung-1 helper runs once per owned implementation file and the results are
 * unioned (same shape as test/leave-pack-drift.test.ts).
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runImportRatchet } from './helpers/import-ratchet';
import allowlists from './pack-drift-allowlist.json';

const root = fileURLToPath(new URL('..', import.meta.url));

const RESIGNATION_BOUNDARIES = [
  'core/resignation-journey',
  'core/resignation-clearance',
  'core/resignation-letter',
  'core/resignation-proof',
] as const;

/** Lifecycle-prefixed files are discovered; the resignation aggregate has explicit pack ownership. */
const LIFECYCLE_BOUNDARIES = readdirSync(fileURLToPath(new URL('../core', import.meta.url)))
  .filter((f) => /^lifecycle-.+\.ts$/.test(f))
  .map((f) => `core/${f.replace(/\.ts$/, '')}`);

const BOUNDARIES = [...LIFECYCLE_BOUNDARIES, ...RESIGNATION_BOUNDARIES, 'packs/lifecycle/resignation/service'];

const ALWAYS_ALLOWED = [
  'packs/lifecycle/', // the pack: wiring (index.ts) + the service facade
  'core/lifecycle-', // implementation files import each other freely
  'app/lifecycle/', // employee + staff routes
  'app/admin/lifecycle/', // Module Config
];

describe('ADR-0080 D9: lifecycle pack import ratchet', () => {
  it('finds the implementation files it is meant to guard (a guard over nothing proves nothing)', () => {
    expect(BOUNDARIES.length).toBeGreaterThanOrEqual(10);
    expect(BOUNDARIES).toContain('core/lifecycle-cases');
    expect(BOUNDARIES).toContain('core/lifecycle-it');
    expect(BOUNDARIES).toEqual(expect.arrayContaining([...RESIGNATION_BOUNDARIES]));
    expect(RESIGNATION_BOUNDARIES).toHaveLength(4);
  });

  const results = BOUNDARIES.map((boundary) =>
    runImportRatchet({
      root,
      scan: ['app', 'components', 'core', 'db', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs', 'scripts'],
      boundary,
      allowedImporters: (rel) => RESIGNATION_BOUNDARIES.some((boundary) => rel === `${boundary}.ts`) ||
        ALWAYS_ALLOWED.some((a) => (a.endsWith('/') || a.endsWith('-') ? rel.startsWith(a) : rel === a)),
      allowlist: allowlists['lifecycle'],
    }),
  );

  it('no file outside the pack imports a lifecycle implementation module directly', () => {
    const violations = [...new Set(results.flatMap((r) => r.violations))].sort();
    expect(violations, `Import packs/lifecycle/service instead:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the allowlist is empty and stays empty', () => {
    expect(allowlists['lifecycle']).toEqual([]);
  });

  it('the facade re-exports every implementation module that has exports for callers', () => {
    const facade = readdirSync(fileURLToPath(new URL('../core', import.meta.url)));
    expect(facade.filter((f) => /^lifecycle-.+\.ts$/.test(f)).length).toBe(LIFECYCLE_BOUNDARIES.length);
  });
});
