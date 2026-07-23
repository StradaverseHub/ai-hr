/**
 * Performance pack drift guard (ADR-0080 D9/D11 criterion 4, retrofit ladder rung 4).
 *
 * Rule: files outside the performance pack surface never import the pack's implementation module
 * (`core/performance`) directly — they import the facade, `packs/performance/service`. The
 * always-allowed importers are the pack surface itself: the `packs/performance/` wiring + facade,
 * the implementation file, and the pack's own routes (cycle/review screens + attachment download
 * under app/performance/ — the module has no separate admin routes). test/ is never scanned —
 * performance tests exercise the implementation directly by design.
 *
 * Ratchet semantics on the seeded allowlist (test/pack-drift-allowlist.json "performance",
 * audited 2026-07-23): the list may only SHRINK. The single entry is kernel debt —
 * `core/employment-review.ts` (employment-spine, NOT this pack) reuses the `currentAdminManager`
 * reporting-line helper that happens to live in `core/performance.ts`; that is spine vocabulary
 * (the D6 pattern, like attendance's `isoWeekday`) whose future home is the org/reporting-line
 * spine — the who/why table lives in packs/performance/index.ts. A new importer outside the list
 * fails; an entry whose file stopped importing fails until the entry is removed.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runImportRatchet } from './helpers/import-ratchet';
import allowlists from './pack-drift-allowlist.json';

const ADR = 'docs/adr/0080-country-packs-as-installable-modules.md';
const root = fileURLToPath(new URL('..', import.meta.url));

/** The pack surface (see packs/performance/index.ts header): wiring/facade, implementation, routes. */
const ALWAYS_ALLOWED = [
  'packs/performance/', // the pack itself: wiring (index.ts) + service facade
  'core/performance.ts', // the implementation file
  'app/performance/', // module routes: cycles, calibration, reviews, attachments, actions
];

describe('ADR-0080 D9: performance pack import ratchet (rung 4)', () => {
  const allowlist = allowlists['performance'];
  const { violations, stale } = runImportRatchet({
    root,
    scan: ['app', 'components', 'core', 'db', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs', 'scripts'],
    boundary: 'core/performance',
    allowedImporters: (rel) => ALWAYS_ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a)),
    allowlist,
  });

  it('no NEW file imports core/performance directly (the debt may not grow)', () => {
    expect(
      violations,
      `These files import the performance pack's implementation directly but are not in the audited ` +
        `kernel-debt allowlist (test/pack-drift-allowlist.json "performance"). Performance services ` +
        `are consumed through the pack facade: import from packs/performance/service instead — see ` +
        `${ADR} (D9/D11) and packs/performance/index.ts. The allowlist only ever shrinks; do not ` +
        `add entries.\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('allowlist entries that no longer import the pack are removed (the ratchet only shrinks)', () => {
    expect(
      stale,
      `These test/pack-drift-allowlist.json "performance" entries no longer import core/performance — ` +
        `congratulations, the debt shrank. Lock the win in by REMOVING them (${ADR}, D9):\n` +
        stale.join('\n'),
    ).toEqual([]);
  });
});
