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

const SCAN = ['app', 'components', 'core', 'db', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs', 'scripts'];
const isAllowedImporter = (rel: string) =>
  ALWAYS_ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));

// Rung 5c (ADR-0080 D4): two ratcheted sets guard the SAME `localization/my` boundary.
//   - `localization/my`         — genuine remaining DEBT (generic code that still reaches into the MY
//                                 pack; retires as it is routed through the registry).
//   - `localization/my.pack-ui` — the MY pack's OWN admin UI (Statutory Configuration routes + zakat
//                                 screens + the PCB classification island), kept physically in app/
//                                 pending migration under localization/my/ui/ (open decision 2). Its
//                                 mounting is registry-driven (app/payroll/configuration/guard.ts).
// The guard is enforced on the UNION: any importer outside BOTH sets (and the always-allowed wiring)
// is a violation, so recategorizing pack-UI does NOT weaken the ratchet — a genuinely NEW leak still
// fails. Both sets only ever shrink (stale entries fail).
const DEBT = allowlists['localization/my'];
const PACK_UI = allowlists['localization/my.pack-ui'];

describe('ADR-0080 D7/D4: localization/my import ratchet', () => {
  const result = runImportRatchet({
    root,
    scan: SCAN,
    boundary: 'localization/my',
    allowedImporters: isAllowedImporter,
    allowlist: [...DEBT, ...PACK_UI],
  });

  it('no NEW file imports localization/my directly, outside the debt allowlist OR the pack-UI set', () => {
    expect(
      result.violations,
      `These files import localization/my directly but are in neither the audited debt allowlist nor the ` +
        `pack-UI set (test/pack-drift-allowlist.json). Generic code resolves jurisdiction through the ` +
        `registry: import packFor()/requirePackFor()/countryPacks() from localization/registry instead of ` +
        `reaching into the MY pack — see ${ADR} (D1/D7). A NEW MY admin screen belongs in the pack-UI set ` +
        `ONLY if it is genuinely the pack's own UI. Both lists only ever shrink; do not add debt.\n` +
        result.violations.join('\n'),
    ).toEqual([]);
  });

  it('allowlist/pack-ui entries that no longer import localization/my are removed (the ratchet only shrinks)', () => {
    expect(
      result.stale,
      `These test/pack-drift-allowlist.json entries no longer import localization/my — congratulations, ` +
        `the leak shrank. Lock the win in by REMOVING them from the "localization/my" or ` +
        `"localization/my.pack-ui" list (${ADR}, D7):\n` +
        result.stale.join('\n'),
    ).toEqual([]);
  });

  it('the debt allowlist and the pack-UI set are disjoint (a file is debt XOR pack-owned UI)', () => {
    const overlap = DEBT.filter((f) => PACK_UI.includes(f));
    expect(overlap, `A file must be in exactly one set — overlap:\n${overlap.join('\n')}`).toEqual([]);
  });

  // The recategorization is NOT a weakening: prove the ratchet still bites. Drop one pack-UI entry from
  // the allowed union and it must resurface as a violation — exactly what happens to a genuinely new leak.
  it('a file outside BOTH sets is a violation — the guard still fails on new leaks', () => {
    const sentinel = 'app/payroll/configuration/page.tsx';
    expect(PACK_UI, 'sentinel must be a known pack-UI importer').toContain(sentinel);
    const withoutSentinel = runImportRatchet({
      root,
      scan: SCAN,
      boundary: 'localization/my',
      allowedImporters: isAllowedImporter,
      allowlist: [...DEBT, ...PACK_UI].filter((f) => f !== sentinel),
    });
    expect(withoutSentinel.violations).toContain(sentinel);
  });
});
