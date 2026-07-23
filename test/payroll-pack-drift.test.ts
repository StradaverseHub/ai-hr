/**
 * Payroll pack drift guard (ADR-0080 D9/D11 criterion 4, retrofit ladder rung 7 — THE FINAL RETROFIT,
 * the money path).
 *
 * Rule: files outside the payroll pack surface never import the pack's implementation modules
 * (`core/payroll`, `core/payroll-*`, `core/pay-components`, `core/pay-rule`, `core/pay-rule-ai`,
 * `core/cp38`, `core/ea-override`, `core/tax-relief`, `core/loans`, `core/loans-compute`,
 * `core/statutory-authority`) directly — they import the facade, `packs/payroll/service`. The
 * always-allowed importers are the pack surface itself: the `packs/payroll/` wiring + facade, the
 * twenty implementation files (they import each other), and the pack's own routes (the payroll
 * workbench + admin config screens + the reprocess job runner + the /me payslip/tax-relief ESS
 * screens). test/ is never scanned — payroll tests exercise the implementation directly by design.
 *
 * `core/comp.ts` is NOT a boundary here: compensation is jurisdiction-neutral employment SPINE
 * (read by 10+ modules, set on hire/promote/movement — ADR-0080's rung-4/rung-6 spine test), so
 * importing it is not a payroll-boundary crossing. See packs/payroll/index.ts.
 *
 * Ratchet semantics on the seeded allowlist (test/pack-drift-allowlist.json "payroll", audited
 * 2026-07-24): the list may only SHRINK. Every entry is kernel-contract debt (D9) — a legitimate
 * cross-module consumer (the cross-pack edges: the performance comp-enactment bonus seam, the
 * attendance allowance-transfer seam, the claims batch-window vocabulary read; pay date-math/release
 * spine vocabulary; reporting / ESS / admin spine readers; personnel-admin profile surfaces; client
 * widgets that cannot use the server facade; provisioning/seed/scripts) that gets a narrow kernel
 * contract, a client-safe pack entry, or a spine-vocabulary move at a later rung; the who/why table
 * lives in packs/payroll/index.ts. A new importer outside the list fails; an entry whose file stopped
 * importing fails until it is removed.
 *
 * The pack has TWENTY boundary modules, not one directory (physical file moves are optional per D11),
 * so the rung-1 helper runs once per module and the results are unioned against the single shared
 * allowlist (same shape as test/leave-pack-drift.test.ts).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runImportRatchet } from './helpers/import-ratchet';
import allowlists from './pack-drift-allowlist.json';

const ADR = 'docs/adr/0080-country-packs-as-installable-modules.md';
const root = fileURLToPath(new URL('..', import.meta.url));

/** The pack's implementation modules (extensionless, as import specifiers resolve them). */
const BOUNDARIES = [
  'core/payroll',
  'core/payroll-cycle',
  'core/payroll-config',
  'core/payroll-policy',
  'core/payroll-policy-config',
  'core/payroll-individual-txn',
  'core/payroll-run-group',
  'core/payroll-view',
  'core/payroll-readiness',
  'core/payroll-history-import',
  'core/payroll-permissions-admin',
  'core/pay-components',
  'core/pay-rule',
  'core/pay-rule-ai',
  'core/cp38',
  'core/ea-override',
  'core/tax-relief',
  'core/loans',
  'core/loans-compute',
  'core/statutory-authority',
];

/** The pack surface (see packs/payroll/index.ts header): wiring/facade, implementation, routes. */
const ALWAYS_ALLOWED = [
  'packs/payroll/', // the pack itself: wiring (index.ts) + service facade
  'core/payroll.ts', // implementation files import each other freely
  'core/payroll-cycle.ts',
  'core/payroll-config.ts',
  'core/payroll-policy.ts',
  'core/payroll-policy-config.ts',
  'core/payroll-individual-txn.ts',
  'core/payroll-run-group.ts',
  'core/payroll-view.ts',
  'core/payroll-readiness.ts',
  'core/payroll-history-import.ts',
  'core/payroll-permissions-admin.ts',
  'core/pay-components.ts',
  'core/pay-rule.ts',
  'core/pay-rule-ai.ts',
  'core/cp38.ts',
  'core/ea-override.ts',
  'core/tax-relief.ts',
  'core/loans.ts',
  'core/loans-compute.ts',
  'core/statutory-authority.ts',
  'app/payroll/', // the payroll workbench: batch, process, transactions, reports, config, history-import, guide
  'app/admin/pay-components/', // pay-component catalog admin
  'app/admin/payroll-config/', // per-company payroll config admin
  'app/admin/payroll-cycle/', // pay-cycle calendar admin
  'app/admin/payroll-policy/', // payroll policy admin
  'app/admin/payroll-permissions/', // payroll permission grants admin
  'app/admin/loans/', // staff-loans admin
  'app/api/payroll/', // reprocess job runner route
  'app/me/payslip/', // employee payslip view + PDF (ESS payroll screen, like app/me/leave)
  'app/me/tax-relief/', // employee TP1 tax-relief declaration (ESS payroll screen)
];

describe('ADR-0080 D9: payroll pack import ratchet (rung 7 — the money path)', () => {
  const allowlist = allowlists['payroll'];
  const perBoundary = BOUNDARIES.map((boundary) =>
    runImportRatchet({
      root,
      scan: ['app', 'components', 'core', 'db', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs', 'scripts'],
      boundary,
      allowedImporters: (rel) => ALWAYS_ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a)),
      allowlist,
    }),
  );
  // Union across the twenty boundary modules; violations/stale are derived against the union so an
  // allowlist entry importing ANY boundary module is live, and stale only when it imports none.
  const importers = [...new Set(perBoundary.flatMap((r) => r.importers))].sort();
  const importerSet = new Set(importers);
  const allowed = new Set(allowlist);
  const violations = importers.filter((f) => !allowed.has(f));
  const stale = allowlist.filter((f) => !importerSet.has(f));

  it('no NEW file imports the payroll pack implementation directly (the debt may not grow)', () => {
    expect(
      violations,
      `These files import the payroll pack's implementation directly but are not in the audited ` +
        `kernel-contract-debt allowlist (test/pack-drift-allowlist.json "payroll"). Payroll services ` +
        `are consumed through the pack facade: import from packs/payroll/service instead — see ${ADR} ` +
        `(D9/D11) and packs/payroll/index.ts. Cross-module WRITES into payroll ride the ` +
        `PayrollInputContributor kernel contract (packs/contracts.ts), not the facade. The allowlist ` +
        `only ever shrinks; do not add entries.\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('allowlist entries that no longer import the pack are removed (the ratchet only shrinks)', () => {
    expect(
      stale,
      `These test/pack-drift-allowlist.json "payroll" entries no longer import any payroll ` +
        `implementation module — congratulations, the debt shrank. Lock the win in by REMOVING them ` +
        `(${ADR}, D9):\n` +
        stale.join('\n'),
    ).toEqual([]);
  });
});
