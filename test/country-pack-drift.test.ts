/**
 * Country-pack drift guard (ADR-0080 D7) — the seam is self-defending from rung 1.
 *
 * Rule (ADR-0080 D1): `core/`, `lib/`, `app/`, shared `components/`, `db/` and `scripts/` never
 * import `localization/my` directly — they go through the registry (`localization/registry.ts`
 * `packFor()`). The only always-allowed importers are the MY pack itself, the registry + contract
 * wiring, its statutory-pack build script, and MY-specific tests (test/ is not scanned).
 *
 * Ratchet semantics on the seeded allowlist (test/pack-drift-allowlist.json, audited 2026-07-23):
 * the list may only SHRINK. A new importer outside it fails; an entry whose file stopped importing
 * fails until the entry is removed. Shipping features while the list shrinks opportunistically is
 * fine — only growth is blocked (ADR-0080 §7, "ratchet fatigue").
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runImportRatchet } from './helpers/import-ratchet';
import allowlists from './pack-drift-allowlist.json';

const ADR = 'docs/adr/0080-country-packs-as-installable-modules.md';
const root = fileURLToPath(new URL('..', import.meta.url));

const ALWAYS_ALLOWED = [
  'localization/my/', // the pack itself
  'localization/registry.ts', // the seam — the one place that resolves packs by design
  'localization/registry.client.ts', // the client-safe seam (rung 5b, D4) — same class as registry.ts: the ONE client-side place that names packs
  'localization/country-pack.ts', // the D1 contract (MY-derived signatures until rung 5)
  'scripts/statutory-pack-build-my.ts', // the pack's build script (ADR-0020)
];

describe('ADR-0080 D7: localization/my import ratchet', () => {
  const result = runImportRatchet({
    root,
    scan: ['app', 'components', 'core', 'db', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs', 'scripts'],
    boundary: 'localization/my',
    allowedImporters: (rel) => ALWAYS_ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a)),
    allowlist: allowlists['localization/my'],
  });

  it('no NEW file imports localization/my directly (the leak may not grow)', () => {
    expect(
      result.violations,
      `These files import localization/my directly but are not in the audited allowlist ` +
        `(test/pack-drift-allowlist.json). Jurisdiction code is resolved through the registry: import ` +
        `packFor() from localization/registry instead of reaching into the MY pack — see ${ADR} (D1/D7). ` +
        `The allowlist only ever shrinks; do not add entries.\n` +
        result.violations.join('\n'),
    ).toEqual([]);
  });

  it('allowlist entries that no longer import localization/my are removed (the ratchet only shrinks)', () => {
    expect(
      result.stale,
      `These test/pack-drift-allowlist.json entries no longer import localization/my — congratulations, ` +
        `the leak shrank. Lock the win in by REMOVING them from the "localization/my" list (${ADR}, D7):\n` +
        result.stale.join('\n'),
    ).toEqual([]);
  });
});
