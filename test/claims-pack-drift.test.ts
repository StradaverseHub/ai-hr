/**
 * Claims pack drift guard (ADR-0080 D9/D11 criterion 4, retrofit ladder rung 3).
 *
 * Rule: files outside the claims pack surface never import the pack's implementation module
 * (`core/claims`) directly — they import the facade, `packs/claims/service`; the payroll payout
 * path rides the `PayrollInputContributor` kernel contract (packs/contracts.ts +
 * packs/claims/payroll.ts) instead of either. The always-allowed importers are the pack surface
 * itself: the `packs/claims/` wiring + facade + contributor, the implementation file, and the
 * pack's own routes (employee claims screens + admin claims config). test/ is never scanned —
 * claims tests exercise the implementation directly by design.
 *
 * Ratchet semantics on the seeded allowlist (test/pack-drift-allowlist.json "claims", audited
 * 2026-07-23): the list may only SHRINK. Every entry is kernel-contract debt (D9) — a legitimate
 * cross-module consumer (approvals inbox, report-registry catalog reader) that gets a narrow
 * kernel contract at a later rung instead of the facade; the who/why table lives in
 * packs/claims/index.ts. A new importer outside the list fails (`app/payroll/actions.ts` in
 * particular must NEVER reappear — its seam is the D9 contract now); an entry whose file stopped
 * importing fails until the entry is removed.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runImportRatchet } from './helpers/import-ratchet';
import allowlists from './pack-drift-allowlist.json';

const ADR = 'docs/adr/0080-country-packs-as-installable-modules.md';
const root = fileURLToPath(new URL('..', import.meta.url));

/** The pack surface (see packs/claims/index.ts header): wiring/facade/contributor, implementation, routes. */
const ALWAYS_ALLOWED = [
  'packs/claims/', // the pack itself: wiring (index.ts) + service facade + payroll contributor
  'core/claims.ts', // the implementation file
  'app/claims/', // employee routes: submit/list + attachment download
  'app/admin/claims/', // admin routes: catalog, limits, reimbursements + export
];

describe('ADR-0080 D9: claims pack import ratchet (rung 3)', () => {
  const allowlist = allowlists['claims'];
  const { violations, stale } = runImportRatchet({
    root,
    scan: ['app', 'components', 'core', 'db', 'i18n', 'lib', 'localization', 'middleware.ts', 'packs', 'scripts'],
    boundary: 'core/claims',
    allowedImporters: (rel) => ALWAYS_ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a)),
    allowlist,
  });

  it('no NEW file imports core/claims directly (the debt may not grow)', () => {
    expect(
      violations,
      `These files import the claims pack's implementation directly but are not in the audited ` +
        `kernel-contract-debt allowlist (test/pack-drift-allowlist.json "claims"). Claims services ` +
        `are consumed through the pack facade: import from packs/claims/service instead — and the ` +
        `payroll payout path specifically rides the PayrollInputContributor kernel contract ` +
        `(packs/contracts.ts) — see ${ADR} (D9/D11) and packs/claims/index.ts. The allowlist only ` +
        `ever shrinks; do not add entries.\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('allowlist entries that no longer import the pack are removed (the ratchet only shrinks)', () => {
    expect(
      stale,
      `These test/pack-drift-allowlist.json "claims" entries no longer import core/claims — ` +
        `congratulations, the debt shrank. Lock the win in by REMOVING them (${ADR}, D9):\n` +
        stale.join('\n'),
    ).toEqual([]);
  });
});
