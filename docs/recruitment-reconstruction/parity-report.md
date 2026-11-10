# Recruitment — parity and verification report (slice 1, 2026-11-10)

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

## Not verified

The rendered screens, the whole-repo type check, the DB-backed AI Centre tests, any hiring-manager or
interviewer access (deliberately not built, D-004), and any reference write-path behaviour.
