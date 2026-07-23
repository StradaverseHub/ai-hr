/**
 * The Claims module pack (ADR-0080 D8/D10/D11 — retrofit ladder rung 3).
 *
 * This file is the pack's DECLARATION + registry wiring and is deliberately client-safe (the
 * sidebar imports it to mount the nav rows): lucide icon refs and flat data only. The pack's
 * service surface lives in `./service` (the facade); its payroll-input contribution — the
 * ladder's first kernel contract (D9) — lives in `./payroll`. Importing either here would drag
 * db/client into the client bundle.
 *
 * ## Pack surface (audited 2026-07-23; physical file moves are OPTIONAL per D11 and not done here)
 *
 * - Service (implementation file, reachable from outside ONLY via `packs/claims/service`):
 *   `core/claims.ts` — the whole module in one service: claim-type/item catalog CRUD,
 *   effective-dated budget policy + limits, employee entitlement resolution, submit/decide/cancel
 *   lifecycle, receipt attachments, and both payout routes (taxable → payroll prefill via the D9
 *   contract below; non-taxable → off-cycle reimbursement list/CSV/mark-paid).
 * - Routes: `app/claims/**` (employee submit/list + attachment download),
 *   `app/admin/claims/**` (catalog admin, limits, reimbursements + CSV export).
 * - Client widgets (UI-only, no service imports): `components/claim-form.tsx`,
 *   `components/claims-tabs.tsx`, `components/claim-type-panel.tsx`,
 *   `components/claim-limit-editor.tsx`.
 * - The boundary is enforced by test/claims-pack-drift.test.ts (D11 criterion 4, shrink-only
 *   ratchet seeded in test/pack-drift-allowlist.json under "claims").
 *
 * ## The payout seam → the first PayrollInputContributor (D9) — LANDED this rung
 *
 * Audited finding: approved TAXABLE claims reach payroll through real code — the batch page's
 * "queue claims" action (`app/payroll/actions.ts` → `prefillClaimsForBatch`) sums them into
 * `payroll_input.claim_allowance` and reserves each claim to the batch; `generatePayslips` folds
 * the amount into the taxable allowance base and marks the claims paid on processing. Rung 3 cut
 * that seam over to the kernel contract: `packs/contracts.ts` owns `PayrollInputContributor`,
 * `packs/claims/payroll.ts` registers the claims contributor (a thin wrapper over the UNCHANGED
 * `prefillClaimsForBatch`), and the payroll action resolves it by id — it no longer imports
 * `core/claims`. Non-taxable claims never enter payroll (off-cycle reimbursement CSV) and need no
 * contract.
 *
 * ## Audited kernel-contract debt (D9) — who still reads the pack's core directly and why
 *
 * These outside callers are deliberately NOT rerouted through the facade: each is a legitimate
 * cross-module consumer that becomes a narrow KERNEL CONTRACT at a later rung. They are
 * allowlisted in the ratchet until that contract exists; the list only shrinks.
 *
 * - `app/approvals/{page,actions}.ts` + `core/approvals-inbox.ts` — the approvals inbox lists
 *   (`listPendingClaims`) and decides (`decideClaim`) claims. Cross-module approvals substrate is
 *   KERNEL (ADR-0080 open decision 6); needs an approvals contract, not the pack facade. Same
 *   disposition as the identical attendance-corrections entries at rung 2.
 * - `core/report-registry.ts` — the report builder reads the claim-type catalog
 *   (`listClaimTypes`). Cross-module readers stay kernel (open decision 6); they should consume
 *   pack report descriptors/contracts, defined when the reporting seam is cut.
 *
 * Below the ratchet's radar (schema-table access, not module imports — recorded for honesty):
 * `core/payroll.ts` writes `claim_request` rows directly (marks reserved claims paid at
 * generation, detaches them on draft delete, reverses payment on unlock-reset), and
 * `core/claims.ts` imports payroll vocabulary the other way (`resolveBatchScopeFilter`,
 * `resolveBatchCutOffWindow`, `calendarWindowFor`) — pack→kernel imports, legal today. Both edges
 * are the Payroll rung's (7) to restructure.
 *
 * ## Entitlement hook (D11 criterion 5 — NOT wired)
 *
 * ADR-0077's `tenant_module` / `isModuleEnabled()` primitives do not exist yet. The hook point is
 * `id: 'claims'` below matching the future catalog row: when 0077 lands, the gate resolves this
 * pack via `modulePackById('claims')` and fails closed (D3). Whether `claims` depends on
 * `payroll` (or degrades to reimbursement-export-only) is the catalog's `depends_on` question,
 * answered at the entitlement wiring (ADR-0080 open decision 8). No entitlement machinery is
 * built here by design.
 */
import { Receipt } from 'lucide-react';
import { registerPack, type ModulePack, type NavLinkDescriptor } from '../registry';

// The claims sidebar presence, moved VERBATIM from components/sidebar.tsx at rung 3 — unlike
// attendance's collapsible node this is two FLAT rows in two different groups, so the pack
// contributes `navLinks` (group-tagged standalone rows) instead of a `nav` node:
//   - "/claims" sat in the top day-to-day group between the Attendance node and Feedback,
//     visible to every employee (self-service);
//   - "/admin/claims" sat in the Administration group between Leave config and Payroll (the
//     group is gated adminOnly wholesale, so the row itself carries no per-row flag — unchanged).
// hrefs, labelKeys, the shared Receipt icon ref and (absence of) visibility flags are the
// sidebar's verbatim; only the mounting moved (the sidebar places these rows via the registry).
const CLAIMS_NAV_LINKS: NavLinkDescriptor[] = [
  { group: 'main', href: '/claims', labelKey: 'claims', icon: Receipt },
  { group: 'admin', href: '/admin/claims', labelKey: 'claimsConfig', icon: Receipt },
];

export const claimsPack: ModulePack = {
  id: 'claims',
  kind: 'module',
  navLinks: CLAIMS_NAV_LINKS,
  // Pack-owned satellite tables (D5/D11 criterion 2 — documentation, not DDL). Audited from
  // db/schema.ts 2026-07-23. payroll_input.claim_allowance is a KERNEL column the pack writes
  // through the D9 contract, not a satellite of this pack.
  satelliteTables: [
    { table: 'claim_type', note: 'tenant claim-type catalog (code, name, taxability, receipt rule)' },
    { table: 'claim_item', note: 'sub-items under a claim type' },
    { table: 'claim_policy', note: 'effective-dated budget/limit policy per type (grade-rated)' },
    { table: 'claim_request', note: 'the claim lifecycle row: submit → decide → payout (batch link, paid stamp)' },
    { table: 'claim_attachment', note: 'receipt files behind a claim request' },
  ],
  serviceFacade: 'packs/claims/service',
};

// Static module-load registration (ADR-0080 D8 wiring convention). Idempotent under dev HMR.
registerPack(claimsPack);
