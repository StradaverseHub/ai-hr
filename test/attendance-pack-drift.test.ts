/**
 * Attendance pack drift guard (ADR-0080 D9/D11 criterion 4, retrofit ladder rung 2).
 *
 * Rule: files outside the attendance pack surface never import the pack's implementation modules
 * (`core/attendance*`, `core/clocking-location`) directly — they import the facade,
 * `packs/attendance/service`. The always-allowed importers are the pack surface itself: the
 * `packs/attendance/` wiring + facade, the six implementation files (they import each other), and
 * the pack's own routes (attendance screens + clock portal + its admin config screens). test/ is
 * never scanned — attendance tests exercise the implementation directly by design.
 *
 * Ratchet semantics on the seeded allowlist (test/pack-drift-allowlist.json "attendance", audited
 * 2026-07-23): the list may only SHRINK. Every entry is kernel-contract debt (D9) — a legitimate
 * cross-module consumer (payroll input, approvals inbox, reporting/analytics readers, shared
 * schedule vocabulary) that gets a narrow kernel contract at a later rung instead of the facade;
 * the who/why table lives in packs/attendance/index.ts. A new importer outside the list fails; an
 * entry whose file stopped importing fails until the entry is removed.
 *
 * The pack has SIX boundary modules, not one directory (physical file moves are optional per
 * D11), so the rung-1 helper runs once per module and the results are unioned against the single
 * shared allowlist.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runImportRatchet } from './helpers/import-ratchet';
import allowlists from './pack-drift-allowlist.json';

const ADR = 'docs/adr/0080-country-packs-as-installable-modules.md';
const root = fileURLToPath(new URL('..', import.meta.url));

/** The pack's implementation modules (extensionless, as import specifiers resolve them). */
const BOUNDARIES = [
  'core/attendance',
  'core/attendance-allowance',
  'core/attendance-derive',
  'core/attendance-device',
  'core/attendance-rule',
  'core/clocking-location',
];

/** The pack surface (see packs/attendance/index.ts header): wiring/facade, implementation, routes. */
const ALWAYS_ALLOWED = [
  'packs/attendance/', // the pack itself: wiring (index.ts) + service facade
  'core/attendance.ts', // implementation files import each other freely
  'core/attendance-allowance.ts',
  'core/attendance-derive.ts',
  'core/attendance-device.ts',
  'core/attendance-rule.ts',
  'core/clocking-location.ts',
  'app/attendance/', // module routes: records/daily/individual/import/ot-report + R63–R65 clock portal
  'app/admin/attendance/', // shift-settings screen (shared shift library page under the Attendance nav)
  'app/admin/attendance-policy/', // policy + rule library + device admin
  'app/admin/attendance-allowance/',
  'app/admin/locations/', // clocking-site admin (clocking-location is pack-owned)
];

describe('ADR-0080 D9: attendance pack import ratchet (rung 2)', () => {
  const allowlist = allowlists['attendance'];
  const perBoundary = BOUNDARIES.map((boundary) =>
    runImportRatchet({
      root,
      scan: ['app', 'components', 'core', 'db', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs', 'scripts'],
      boundary,
      allowedImporters: (rel) => ALWAYS_ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a)),
      allowlist,
    }),
  );
  // Union across the six boundary modules; violations/stale are derived against the union so an
  // allowlist entry importing ANY boundary module is live, and stale only when it imports none.
  const importers = [...new Set(perBoundary.flatMap((r) => r.importers))].sort();
  const importerSet = new Set(importers);
  const allowed = new Set(allowlist);
  const violations = importers.filter((f) => !allowed.has(f));
  const stale = allowlist.filter((f) => !importerSet.has(f));

  it('no NEW file imports core/attendance*/core/clocking-location directly (the debt may not grow)', () => {
    expect(
      violations,
      `These files import the attendance pack's implementation directly but are not in the audited ` +
        `kernel-contract-debt allowlist (test/pack-drift-allowlist.json "attendance"). Attendance ` +
        `services are consumed through the pack facade: import from packs/attendance/service instead — ` +
        `see ${ADR} (D9/D11) and packs/attendance/index.ts. The allowlist only ever shrinks; do not ` +
        `add entries.\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('allowlist entries that no longer import the pack are removed (the ratchet only shrinks)', () => {
    expect(
      stale,
      `These test/pack-drift-allowlist.json "attendance" entries no longer import any attendance ` +
        `implementation module — congratulations, the debt shrank. Lock the win in by REMOVING them ` +
        `(${ADR}, D9):\n` +
        stale.join('\n'),
    ).toEqual([]);
  });
});
