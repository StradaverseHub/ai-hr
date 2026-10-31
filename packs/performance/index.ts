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
 * - Routes: `app/(app)/performance/**` (cycle list + new-cycle form, cycle detail/calibration, review
 *   detail, attachment download, actions). There are no separate admin config routes — cycle
 *   administration lives in these same screens, gated in-service.
 * - No shared `components/` widgets: the module's client components are colocated under
 *   `app/(app)/performance/` (e.g. new-cycle-form.tsx).
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
 * app/(app)/performance/**, and it has no row in this pack's nav; (3) consumers — the approvals inbox
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

/**
 * The performance sidebar presence. D-P1-32 PT-X5 (APR-025 D4) consolidated the five performance rows (My
 * Performance, the manager-up Performance row, Calibration, and the journey's Talent and Development entry
 * points) into EXACTLY TWO entries; Rewards keeps its own rows (packs/rewards).
 *
 * - Performance & Talent (`/performance/home`): employees and leaders. No role flag: the Performance module gate
 *   (MODULE_OF_HREF in components/sidebar.tsx) is its only gate, the same as the area's Dashboard tab, which is
 *   open whenever the module is (packs/performance/onehr/tab-model.ts). Every other place in the area is a tab
 *   below it, so `ownedSubpaths` keep this entry lit across the area's employee and leader routes.
 * - Performance admin: OneHR performance administration only. components/sidebar.tsx gates it by
 *   canAdministerOnehr and points it at the admin area's first tab for the latest cycle the viewer administers
 *   (app/(app)/layout.tsx); `/performance` (the cycle list) is the address when there is no cycle. It owns every other
 *   /performance route (the cycle pages and the admin area).
 *
 * The `group` tag is the pack's placement declaration; the sidebar places each row by
 * lib/navigation-workspaces.ts.
 */
export const PERFORMANCE_AREA_OWNED_PATHS = [
  '/performance/home', '/performance/my', '/performance/team', '/performance/assessments', '/performance/feedback',
  '/performance/competency', '/performance/plan', '/performance/calibration', '/performance/workspace',
  '/performance/assessment', '/performance/onehr', '/performance/review', '/performance/department', '/performance/led',
  '/me/performance',
];
const PERFORMANCE_NAV_LINKS: NavLinkDescriptor[] = [
  { group: 'main', href: '/performance/home', labelKey: 'performanceTalent', icon: Target, ownedSubpaths: PERFORMANCE_AREA_OWNED_PATHS },
  { group: 'manage', href: '/performance', labelKey: 'performanceAdmin', icon: Target, ownedSubpaths: ['/performance'] },
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
    { table: 'performance_assessment_catalogue', note: 'scoped defaults for new cycles; existing review snapshots remain independent' },
    { table: 'performance_onehr_cycle', note: 'native performance cycle aggregate; ADR-0103' },
    { table: 'performance_onehr_review', note: 'native performance review aggregate; ADR-0103' },
    { table: 'performance_onehr_panel', note: 'native performance panel aggregate; ADR-0103' },
    { table: 'performance_onehr_calibration', note: 'native performance calibration aggregate; ADR-0103' },
    { table: 'performance_onehr_calibration_entry', note: 'native performance calibration_entry aggregate; ADR-0103' },
    { table: 'performance_onehr_plan', note: 'native performance plan aggregate; ADR-0103' },
    { table: 'performance_onehr_evidence', note: 'native performance evidence aggregate; ADR-0103' },
    { table: 'performance_onehr_result', note: 'native performance result aggregate; ADR-0103' },
    { table: 'performance_assessment_participation', note: 'opening eligibility snapshot and HR cycle overrides; ADR-0103' },
    { table: 'performance_assessment_draft', note: 'actor-private working copies of assessment answers; ADR-0103' },
    { table: 'performance_assessment_conversation', note: 'actor-private review journey conversation; ADR-0103' },
    { table: 'performance_calibration_conversation', note: 'actor-private cohort conversation and held department edits' },
    { table: 'performance_assessment_guide_use', note: 'personal guide rate reservations and anonymous HR usage projection; no conversation storage' },
    { table: 'performance_assessment_ai_use', note: 'successful draft usage with per-actor field limits at Malaysia midnight' },
    { table: 'performance_assessment_file_text', note: 'derived file text cache; visibility always follows the native attachment' },
    { table: 'performance_assessment_summary', note: 'reviewer-owned summary cache of submitted competency evidence' },
    { table: 'performance_assessment_insight', note: 'reviewer insight cache; live assignment and submitted-fact fingerprint are rechecked' },
    { table: 'performance_assessment_talent_remark', note: 'shared optional BG overall remark, independently revised and locked with its person/cohort' },
    { table: 'performance_assessment_reviewer_remark', note: 'each approver owns their overall remark; confirmed authorship is retained' },
    { table: 'performance_kpi_library', note: 'scoped KPI definitions and scoring templates; ADR-0103' },
    { table: 'performance_assessment_attachment_link', note: 'KPI attachment provenance using the native attachment store; ADR-0103' },
    { table: 'performance_assessment_talent', note: 'shared human talent decisions across calibration tiers; ADR-0103' },
    { table: 'performance_assessment_talent_history', note: 'locked yearly talent history for standing promotion rules; ADR-0103' },
    { table: 'performance_assessment_career_profile', note: 'current career profile with yearly plan snapshots retained separately; ADR-0103' },
    { table: 'performance_assessment_rating_record', note: 'sign-off and calibration record sealed at cycle archive; ADR-0103' },
    { table: 'performance_assessment_release', note: 'component visibility grants independent of finalization; ADR-0103' },
    { table: 'performance_calibration_group', note: 'named calibration group, the group chief seat anchor; retired, never deleted (WP-B2)' },
    { table: 'performance_calibration_group_member', note: 'dated calibration group membership, one live group per employment (WP-B2)' },
    { table: 'performance_leader_seat', note: 'dated BU CEO, BG CEO and group chief seats that grant calibration access (WP-B2)' },
    { table: 'performance_hod_assignment', note: 'dated per-person head of department; never department.head_employment_id (WP-B2)' },
    { table: 'performance_onehr_calibration_entry_retired', note: 'department-review entries retired when a person changes HOD, decisions kept (WP-B2)' },
    { table: 'performance_assessment_unit_exclusion', note: 'cycle exclusion rule: a company or exact department not taking part in a cycle; ended, never deleted (D-P1-22, ADR-0150)' },
    { table: 'performance_assessment_unit_exclusion_pin', note: 'employments a closed cycle\'s exclusion rules covered on its close day (D-P1-22 D8)' },
    { table: 'performance_assessment_release_notice', note: 'append-only ledger of release notices, one per review, component, step and recipient; no band (WP-E)' },


  ],
  serviceFacade: 'packs/performance/service',
};

// Static module-load registration (ADR-0080 D8 wiring convention). Idempotent under dev HMR.
registerPack(performancePack);
