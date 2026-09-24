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
  // 7c834696 stage 1 — the pure per-day calculation module. Declared as a boundary (not slipped into the
  // debt allowlist) because it IS pack implementation, exactly like attendance-derive beside it.
  'core/attendance-calc',
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
  'core/attendance-calc.ts',
  'core/attendance-derive.ts',
  'core/attendance-device.ts',
  'core/attendance-rule.ts',
  'core/clocking-location.ts',
  'app/attendance/', // module routes: records/daily/individual/import/ot-report + R63–R65 clock portal
  'app/admin/attendance/', // shift-settings screen (shared shift library page under the Attendance nav)
  'app/admin/attendance-policy/', // policy + rule library + device admin
  'app/admin/attendance-allowance/',
  // 639bf4a5 (r336) — THE CLOCKING-SITE ADMIN PREFIX LEFT THIS LIST, and this ratchet is tighter for it.
  //
  // The entry read (repo-relative) app/admin/locations/ and was commented "clocking-site admin
  // (clocking-location is pack-owned)". It authorised that whole route tree to import
  // core/clocking-location directly, because the register genuinely WAS an attendance screen. It is not
  // any more: the reporter asked for the work-site setup to live under Organization, the tree moved to
  // app/admin/work-locations/ and the row left ATTENDANCE_NAV (packs/attendance/index.ts). Its one
  // direct import of the boundary went with it — the list reads listClockingLocations through
  // packs/attendance/service now, exactly like app/admin/actions.ts and the edit page already did.
  //
  // ⚠️ DO NOT RE-ADD THE MOVED PREFIX. This is a SHRINK, which is the only direction this file moves in;
  // replacing the deleted line with the new directory would re-open the same hole at a new address and
  // undo the ownership half of the item. If a NEW screen genuinely belongs to the attendance pack, add
  // it — but app/admin/work-locations/ is an ORGANIZATION surface and consumes the pack through its
  // published facade like every other outside caller. Pinned by
  // test/work-location-organization-relocation.test.ts.
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
  // Union across the boundary modules; violations/stale are derived against the union so an
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
