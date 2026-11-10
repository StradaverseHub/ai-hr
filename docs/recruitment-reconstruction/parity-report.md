# Recruitment — parity and verification report (slices 1–4, 2026-11-10)

Replica revision: uncommitted working tree on `claude/rea-web-app-reconstruction-2c12ee`, base `f07f32dcd`.
Reference baseline: Moka `hire-r1`, the owner's live tenant, one non-super-admin account, read-only (EV-007…EV-020).

## What kind of parity is claimed

Owner decision B-002: workflow and rule parity rendered in AI HR's design system. **No visual parity
is claimed or measured**, and no screenshot comparison was run. The reference's write paths were never
exercised (U-003), so behaviour on save, move and reject is specified from configuration screens and
labelled as such in `specification.md`.

## Denominators

| Measure | Count |
| --- | --- |
| Reference feature areas observed (F1–F12) | 11 observed or partly observed, 1 not visited (F12 Reports) |
| Feature areas in slice 1 | F1 (menu entry), F3 (jobs, minus sourcing), F4, F5 (pipeline core), F6 (reasons only), F10 (role) |
| Slice 1 acceptance cases | 9 |
| Cases with passing automated evidence | 9 at service/database level; case 1 menu visibility by source/registry tests only |
| Cases verified on a rendered screen | 0 (NOT RUN) |
| Comparisons run against the reference | 0. The reference cannot be written to; this is a live tenant. |

## Automated checks (builder-reported, independently spot-checked)

Builder (implementation owner) runs. Each ran under `scripts/local-resource-lock.py --test-slots 1`:

| Check | Result |
| --- | --- |
| `vitest --config vitest.nodb.config.ts` — 20 registry, nav, drift, i18n, destination and rule files | PASS (260 tests) |
| Related no-DB sweep — 48 files | 3 FAIL: `module-agent-governance`, `module-agent-actions`, `module-job-presentation` (Recruitment has no AI Centre binding; see the open decision below) |
| DOM/sidebar tests with a dummy `DATABASE_URL` | PASS (141 tests) |
| Scoped `tsc` over touched files and their imports | PASS |
| Whole-repo `tsc --noEmit` | NOT COMPLETED: local heap exhausted at 4, 6 and 10 GB. Per repo policy this belongs on GitHub Actions. |
| ESLint on changed files | New files clean; 4 errors and 1 warning reported on existing lines of `components/sidebar.tsx`, `app/layout.tsx` and `lib/product-context/destinations.ts` (pre-existing status not independently confirmed) |
| DB tests on a private throwaway Postgres 16 cluster, all migrations applied | PASS: `recruitment-service` (10), `company-referrers`, `invitation-privesc`, `partner-roles`, `module-catalog-drift`, `module-gate` |
| `next build`, rendered screens, shared-cluster gate | NOT RUN |

Independent checks by the lead (not the builder):

- Every recruitment table has row security enabled **and forced**, explicit grants, and the tenant + `can_admin_recruitment_for(company)` policy. The event table is insert/select only.
- The three security functions 4401 redefines (`manual_identity_reserve`, `consume_invitation`, `access_legacy_role_authority`) are byte-identical to their latest prior definitions in `0611_performance_partner_access.sql`, except for the added `'recruiting_partner'` literal.
- Pages call `requireModule('recruitment')`. The service runs inside `withRecruitmentTenant` and checks `app.can_admin_recruitment_for` before every company action, so refusal does not depend on the page.
- Migrations append only: `4400` (idx 3800) and `4401` (idx 3801). The journal prefix is unchanged.

## AI Centre binding (counts only) — 2026-11-10

Built in the working tree; see handover.md. Runs under the resource lock:

| Check | Result |
| --- | --- |
| No-DB AI + Recruitment registry files (51 files, 966 tests) | PASS, except 9 `provider-analysis-policy` tests that need the owner's provider-data approval (expected) |
| Scoped `tsc` over every touched file and its imports | PASS (0 errors) |
| DB-backed AI tests (parity, read session, source security, native outcomes) | NOT RUN (need a cluster; Actions) |
| Rendered AI Centre answer for Recruitment | NOT RUN |

## GitHub Actions focused run 42772917480 (commit e44710e6b, 2026-11-10)

| Job | Result |
| --- | --- |
| Whole-repo `typecheck` | PASS |
| `linux-build` (production build) | PASS |
| Selected tests, no-DB batch (26 files) | 25 PASS; `provider-analysis-policy` FAIL (owner provider-data approval stale, expected) |
| Selected tests, DB batch (27 files, 476 tests) | 22 files PASS; 5 FAIL, 27 tests |

DB-batch failures:

- `assistant-conversation-evaluation-fence`, `assistant-conversation-lifecycle`, `module-agent-evaluation-progress`
  and `module-agent-prompt-release` (26 tests): the logged cause is `AiPrivacyGateError` from
  `assertProviderDataContractReviewed`. The approval digest no longer matches, so provider calls are refused, along
  with the downstream "did not complete" errors and timeouts. Consistent with the stale owner approval; not
  individually re-proven.
- `module-job-source-security` > recruitment: a group HR admin's counts named another company in the tenant. That
  is an authorized administrative scope (same as Rewards). Fixed after the run: recruitment is added to the
  test's administrative scopes, and a new `recruitment-service` case proves that a company-scoped partner sees only
  their company and that no candidate, email, job title or job number appears. Re-run 42775945376 on
  commit 0e0c238b3: both files PASS (`module-job-source-security`, `recruitment-service`).

## Slices 2–4 — team access, interviews, offers, hire hand-off, requisitions, talent pool (2026-11-10)

Owner scope: core path plus requisitions and a basic talent pool; reports excluded (never observed). Built in the
working tree by a builder agent, then reviewed independently by a separate reviewer agent and by the lead.

Migrations 4402–4404 (idx 3802–3804) append after 4401. A peer survey after a fresh fetch found no other claim on
those numbers, indexes or timestamps. Other branches hold 4500–4502 with higher timestamps; whichever lands later must
be checked against the applied watermark.

Independent review findings and what happened to them:

| Finding | Severity | Outcome |
| --- | --- | --- |
| The offer guard let an operator (including the creator) approve an offer, or rewrite approvers or the pending step, with a direct write | High | Fixed in 4403: every approval-state change must be one of the service's transitions; DB tests added |
| Same gap for requisitions (`approval_status`) | High | Fixed in 4404 the same way; DB tests added |
| Editing a requisition during approval kept earlier approvals | Medium | Fixed: a required-field change while a round runs starts a new round; tested |
| Server actions logged raw database errors, whose messages carry bound values (candidate details, private offer values) | Medium (privacy) | Fixed: only the error kind and SQLSTATE are logged |
| A creator removed from the job kept database read access to the offer and its private values | Low | Fixed: the creator branch now also needs operate access on the job |
| Approver and team pickers offered another company's partner | Low | Fixed: role grants must be group-wide or for this company |
| The last approval of a requisition whose target date passed during approval failed | Low | Fixed: it is approved and stays a Draft (D-010) |
| Someone other than the creator who starts a round may approve it | Design | Open for the owner (D-008) |

Checks (lead), all on a private throwaway Postgres 16 cluster with every migration applied, under the resource lock:

| Check | Result |
| --- | --- |
| DB tests: `recruitment-slices-service` (cases 10–18 plus the new bypass tests), `recruitment-service`, `company-referrers`, `module-catalog-drift`, `invitation-privesc`, `draft-action-atomicity`, `module-gate`, `partner-roles` | PASS, 8 files, 236 tests |
| No-DB: recruitment rules and drift, i18n, navigation, registries, personnel hand-off sources, AI module bindings and prompts, provider review gate (30 files) | PASS, except 9 `provider-analysis-policy` tests (owner provider-data approval stale, expected) |
| Both AI source manifests | Regenerated; `--check` passes |
| Scoped `tsc` over all 40 changed TypeScript files (not `app/layout.tsx`, `components/sidebar.tsx`) | PASS, 0 errors |
| ESLint on recruitment, personnel and test files | Clean except one error in untouched `app/admin/personnel/new/wizard.tsx` |
| Whole-repo `tsc`, production build, shared-cluster gate | NOT RUN locally (GitHub Actions) |

Rendered screens (local dev server against the private cluster, fictional demo data, dev users switched with the
demo selector):

- HR Admin: Overview tiles, Candidates board, Interview schedule (today/upcoming), application Interview tab with
  scorecard link, Offer tab (private salary visible to an administrator; "Pay figures are entered by people"),
  Positions › Job requisitions, Talent pool, Settings, a scorecard (sum 17/25).
- Approver (an employee in the company flow): Approvals tab lists the offer and the requisition; the offer's private
  salary reads "Private — not visible to you"; approving both through the screen succeeded and the database shows
  each decision logged and the items approved. After the last decision the page now confirms instead of redirecting.
- Interviewer: the board shows only the interviewed application; another application returns 404; no Offer tab.
- Hire hand-off: "Start new hire" opened the existing new-employee form pre-filled from the application; nothing
  existed before HR pressed Create; afterwards the application shows the employee ID and links to the draft.
- Server log: no errors.

The demo seed (`db/seed.ts`) stopped partway on this branch with an attendance-workflow error unrelated to
recruitment; the core demo users and companies it creates first were enough for rendering. Not investigated.

## Not verified

The whole-repo type check and production build for slices 2–4, the DB-backed AI Centre tests, every screen in a
language other than English, mobile widths, and any reference write-path behaviour (U-003).
