/**
 * The Performance module pack (ADR-0080 D8/D10/D11 — retrofit ladder rung 4).
 *
 * This file is the pack's DECLARATION + registry wiring and is deliberately client-safe (the
 * sidebar imports it to mount the nav row): lucide icon refs and flat data only. The pack's
 * service surface lives in `./service` (the facade); importing it here would drag db/client into
 * the client bundle.
 *
 * ## Pack surface (audited 2026-07-23; physical file moves are OPTIONAL per D11 and not done here)
 *
 * - Service (implementation file, reachable from outside ONLY via `packs/performance/service`):
 *   `core/performance.ts` — the whole module in one service (ADR-0013 Phase A + ADR-0022 Phase B):
 *   review cycles (draft → open → calibration → closed) with eligibility rules and stages,
 *   the review lifecycle (self → manager → submitted → acknowledged, reviewer reassignment),
 *   goals/OKRs + review-goal links, 1:1 check-ins, peer (360°) feedback, calibration sessions,
 *   AI manager-review drafts, review attachments, and the comp seam (enact/decline of
 *   merit/bonus recommendations — see the below-the-radar note).
 * - Routes: `app/performance/**` (cycle list + new-cycle form, cycle detail/calibration, review
 *   detail, attachment download, actions). There are no separate admin config routes — cycle
 *   administration lives in these same screens, gated in-service.
 * - No shared `components/` widgets: the module's client components are colocated under
 *   `app/performance/` (e.g. new-cycle-form.tsx).
 * - The boundary is enforced by test/performance-pack-drift.test.ts (D11 criterion 4, shrink-only
 *   ratchet seeded in test/pack-drift-allowlist.json under "performance").
 *
 * ## NOT this pack: `core/employment-review.ts` stays employment-spine (kernel)
 *
 * Audited decision. The probation/contract/internship review workflow (0110) shares the word
 * "review" but is an EMPLOYMENT-LIFECYCLE surface, not appraisal: (1) domain — it resolves the
 * review type from the CURRENT open assignment row, its decisions are confirm/extend/terminate of
 * the employment itself, and its tables (`employment_review`, `employment_review_reminder`,
 * `review_document`) reference employment/resignation, never `review_cycle`; (2) surface — its UI
 * mounts on the personnel admin profile, /me, and the approvals inbox, none under
 * app/performance/**, and it has no row in this pack's nav; (3) consumers — the approvals inbox
 * (`core/approvals-inbox.ts`), the dashboard, `lib/review-letter-build.ts` and
 * `scripts/review-sweep.ts` are all spine surfaces, so packing it would mint four kernel→pack
 * debts on day one. Its ONLY tie to this pack is the `currentAdminManager` helper — see the debt
 * table below.
 *
 * ## Audited kernel-contract debt (D9) — who still reads the pack's core directly and why
 *
 * These outside callers are deliberately NOT rerouted through the facade: each is a legitimate
 * cross-module consumer that becomes a narrow KERNEL CONTRACT (or spine vocabulary) at a later
 * rung. They are allowlisted in the ratchet until then; the list only shrinks.
 *
 * - `core/employment-review.ts` — imports `currentAdminManager` (exported for reuse by 0110): the
 *   current administrative-line manager of an employment, i.e. a REPORTING-LINE read that happens
 *   to live in `core/performance.ts`. Reporting-line/direct-superior reads are spine vocabulary
 *   (post-R65 the direct-superior reads live in `core/read.ts`); the helper's future home is the
 *   org/reporting-line spine (the D6 vocabulary pattern, like attendance's `isoWeekday`). Once it
 *   moves, the entry drops and kernel↔pack coupling here is zero.
 *
 * Below the ratchet's radar (schema-table access and pack→kernel imports, not outside-in module
 * imports — recorded for honesty):
 * - THE PAY SEAM (the rung-3 analogue, documented per one-seam-per-rung — rung 3 already landed
 *   this ladder's contract work): a finalized review carries a merit/bonus recommendation that
 *   `enactCompAction`/`declineCompAction` write through the KERNEL engines — merit rides
 *   `setCompensation` (effective-dated comp) and bonus rides `setPayrollInput` (additional-
 *   remuneration MTD), reading `payroll_batch`/`payroll_input` directly for draft-batch checks.
 *   Today this is a legal pack→kernel import (the performance module never writes pay itself);
 *   its future home is the Payroll rung (7), where payroll's write surface gets its contract
 *   shape and this enactment path either stays on kernel comp/payroll engines or registers
 *   through a payroll-input contract like claims' `PayrollInputContributor`.
 * - `core/reporting.ts` reads `performance_review`/`performance_goal`/`review_cycle` rows for the
 *   two performance report datasets (`core/report-registry.ts`, category 'performance'). Pure
 *   schema reads, no module import. Cross-module readers stay kernel (ADR-0080 open decision 6);
 *   they should consume pack report descriptors/contracts when the reporting seam is cut.
 *
 * ## Entitlement hook (D11 criterion 5 — NOT wired)
 *
 * ADR-0077's `tenant_module` / `isModuleEnabled()` primitives do not exist yet. The hook point is
 * `id: 'performance'` below matching the future catalog row: when 0077 lands, the gate resolves
 * this pack via `modulePackById('performance')` and fails closed (D3). No entitlement machinery
 * is built here by design.
 */
import { Target } from 'lucide-react';
import { registerPack, type ModulePack, type NavLinkDescriptor } from '../registry';

// The performance sidebar presence, moved VERBATIM from components/sidebar.tsx at rung 4 — like
// claims this is flat rows, not a collapsible node; unlike claims it is a SINGLE row in the
// Manage group (which is why rung 4 added 'manage' to NavLinkDescriptor's group union):
//   - the row sat in the Manage group after Approvals (1b35f17b: the group's whole-group gate was
//     dropped when Personnel became every-employee, so the row carries its own managerUp flag —
//     managers/admins see Manage → Performance; employees reach their own reviews via /me).
// href, labelKey, the Target icon ref and the managerUp flag are the sidebar's verbatim; only the
// mounting moved (the sidebar places the row via the registry).
const PERFORMANCE_NAV_LINKS: NavLinkDescriptor[] = [
  { group: 'manage', href: '/performance', labelKey: 'performance', icon: Target, managerUp: true },
];

export const performancePack: ModulePack = {
  id: 'performance',
  kind: 'module',
  navLinks: PERFORMANCE_NAV_LINKS,
  // Pack-owned satellite tables (D5/D11 criterion 2 — documentation, not DDL). Audited from
  // db/schema.ts 2026-07-23. employment_review / employment_review_reminder / review_document
  // stay OUTSIDE (employment-spine, see the header decision); payroll_input rows written by the
  // comp-enactment seam are KERNEL, not satellites of this pack.
  satelliteTables: [
    { table: 'performance_onehr_cycle', note: 'native OneHR cycle aggregate; ADR-0102' },
    { table: 'performance_onehr_review', note: 'native OneHR review aggregate; ADR-0102' },
    { table: 'performance_onehr_panel', note: 'native OneHR panel aggregate; ADR-0102' },
    { table: 'performance_onehr_calibration', note: 'native OneHR calibration aggregate; ADR-0102' },
    { table: 'performance_onehr_calibration_entry', note: 'native OneHR calibration_entry aggregate; ADR-0102' },
    { table: 'performance_onehr_plan', note: 'native OneHR plan aggregate; ADR-0102' },
    { table: 'performance_onehr_evidence', note: 'native OneHR evidence aggregate; ADR-0102' },
    { table: 'performance_onehr_result', note: 'native OneHR result aggregate; ADR-0102' },

    { table: 'review_cycle', note: 'appraisal cycle: draft → open → calibration → closed, eligibility rules, stages, rating scale, merit budget' },
    { table: 'performance_review', note: 'one review per snapshotted employee per cycle: self → manager → submitted → acknowledged + comp recommendation' },
    { table: 'performance_goal', note: 'goals/OKRs (ADR-0022): continuous or cycle-bound, status + progress' },
    { table: 'review_goal', note: 'review ↔ goal links (goal-setting stage)' },
    { table: 'performance_checkin', note: 'scheduled 1:1 check-ins between manager and report' },
    { table: 'peer_feedback_request', note: '360° feedback requests against a review' },
    { table: 'peer_feedback', note: 'submitted 360° feedback (rating + strengths/improvements)' },
    { table: 'calibration_session', note: 'per-cycle calibration session (open → committed)' },
    { table: 'calibration_entry', note: 'proposed/committed rating adjustments within a session' },
    { table: 'performance_attachment', note: 'evidence files behind a review (per stage)' },
  ],
  serviceFacade: 'packs/performance/service',
};

// Static module-load registration (ADR-0080 D8 wiring convention). Idempotent under dev HMR.
registerPack(performancePack);
