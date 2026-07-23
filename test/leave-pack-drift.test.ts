/**
 * Leave pack drift guard (ADR-0080 D9/D11 criterion 4, retrofit ladder rung 6 — second-largest module).
 *
 * Rule: files outside the leave pack surface never import the pack's implementation modules
 * (`core/leave`, `core/leave-*`, `core/toil`, `core/benefit-scheme`) directly — they import the
 * facade, `packs/leave/service`. The always-allowed importers are the pack surface itself: the
 * `packs/leave/` wiring + facade, the ten implementation files (they import each other), and the
 * pack's own routes (the My Absence self-service home + the leave/TOIL admin config screens +
 * the /me own-attachment back-compat route). test/ is never scanned — leave tests exercise the
 * implementation directly by design.
 *
 * `core/holidays.ts` is NOT a boundary here: the editable holiday system is shared spine (consumed by
 * attendance + leave + payroll, ADR-0080 open decision 3), so importing it is not a leave-boundary
 * crossing. See packs/leave/index.ts.
 *
 * Ratchet semantics on the seeded allowlist (test/pack-drift-allowlist.json "leave", audited
 * 2026-07-24): the list may only SHRINK. Every entry is kernel-contract debt (D9) — a legitimate
 * cross-module consumer (the two strict cross-pack edges: the attendance pack's approved-leave/TOIL
 * reads and the country pack's LeaveEligibility type; the payroll encashment advisory; dashboards /
 * analytics / approvals / ESS / offboarding readers; client widgets that cannot use the server
 * facade; overnight sweeps + seed) that gets a narrow kernel contract, a client-safe pack entry, or a
 * spine-vocabulary move at a later rung; the who/why table lives in packs/leave/index.ts. A new
 * importer outside the list fails; an entry whose file stopped importing fails until it is removed.
 *
 * The pack has TEN boundary modules, not one directory (physical file moves are optional per D11), so
 * the rung-1 helper runs once per module and the results are unioned against the single shared
 * allowlist (same shape as test/attendance-pack-drift.test.ts).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runImportRatchet } from './helpers/import-ratchet';
import allowlists from './pack-drift-allowlist.json';

const ADR = 'docs/adr/0080-country-packs-as-installable-modules.md';
const root = fileURLToPath(new URL('..', import.meta.url));

/** The pack's implementation modules (extensionless, as import specifiers resolve them). */
const BOUNDARIES = [
  'core/leave',
  'core/leave-approval-policy',
  'core/leave-approval-template',
  'core/leave-compute',
  'core/leave-encashment',
  'core/leave-escalation',
  'core/leave-formula',
  'core/leave-import',
  'core/toil',
  'core/benefit-scheme',
];

/** The pack surface (see packs/leave/index.ts header): wiring/facade, implementation, routes. */
const ALWAYS_ALLOWED = [
  'packs/leave/', // the pack itself: wiring (index.ts) + service facade
  'core/leave.ts', // implementation files import each other freely
  'core/leave-approval-policy.ts',
  'core/leave-approval-template.ts',
  'core/leave-compute.ts',
  'core/leave-encashment.ts',
  'core/leave-escalation.ts',
  'core/leave-formula.ts',
  'core/leave-import.ts',
  'core/toil.ts',
  'core/benefit-scheme.ts',
  'app/leave/', // the My Absence self-service home (balances/apply/history/export)
  'app/admin/leave/', // leave config: type master, entitlements, rules, approval, payroll, import, audit
  'app/admin/leave-approval/', // approval templates + workflow matrix
  'app/admin/toil/', // TOIL policy admin
  'app/me/leave/', // own-attachment download route (kept for /me?tab=leave back-compat)
];

describe('ADR-0080 D9: leave pack import ratchet (rung 6)', () => {
  const allowlist = allowlists['leave'];
  const perBoundary = BOUNDARIES.map((boundary) =>
    runImportRatchet({
      root,
      scan: ['app', 'components', 'core', 'db', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs', 'scripts'],
      boundary,
      allowedImporters: (rel) => ALWAYS_ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a)),
      allowlist,
    }),
  );
  // Union across the ten boundary modules; violations/stale are derived against the union so an
  // allowlist entry importing ANY boundary module is live, and stale only when it imports none.
  const importers = [...new Set(perBoundary.flatMap((r) => r.importers))].sort();
  const importerSet = new Set(importers);
  const allowed = new Set(allowlist);
  const violations = importers.filter((f) => !allowed.has(f));
  const stale = allowlist.filter((f) => !importerSet.has(f));

  it('no NEW file imports the leave pack implementation directly (the debt may not grow)', () => {
    expect(
      violations,
      `These files import the leave pack's implementation directly but are not in the audited ` +
        `kernel-contract-debt allowlist (test/pack-drift-allowlist.json "leave"). Leave services are ` +
        `consumed through the pack facade: import from packs/leave/service instead — see ${ADR} ` +
        `(D9/D11) and packs/leave/index.ts. The allowlist only ever shrinks; do not add entries.\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('allowlist entries that no longer import the pack are removed (the ratchet only shrinks)', () => {
    expect(
      stale,
      `These test/pack-drift-allowlist.json "leave" entries no longer import any leave ` +
        `implementation module — congratulations, the debt shrank. Lock the win in by REMOVING them ` +
        `(${ADR}, D9):\n` +
        stale.join('\n'),
    ).toEqual([]);
  });
});
