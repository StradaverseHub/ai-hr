# Recruitment — parity and verification report (slices 1–6, 2026-11-11)

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

## GitHub Actions focused run 42792007535 (commit 69a7afb3b, slices 1–4, 2026-11-10)

| Job | Result |
| --- | --- |
| Whole-repo `typecheck` | PASS |
| `linux-build` (production build) | PASS |
| Selected tests, no-DB batch (27 files, 521 tests) | 26 files PASS; `provider-analysis-policy` 9 FAIL (owner provider-data approval stale, expected) |
| Selected tests, DB batch (19 files, 394 tests) | 14 files PASS, including `recruitment-slices-service` (15), `recruitment-service`, `company-referrers` (93), `partner-roles`, `module-gate`, `module-job-source-security`; 5 files FAIL, 44 tests |

DB-batch failures: `assistant-conversation-evaluation-fence`, `assistant-conversation-lifecycle`,
`human-module-planner`, `module-agent-evaluation-progress` and `module-agent-prompt-release`. The logged causes are
`AiPrivacyGateError` ("needs a reviewed data-protection policy") and fixture evaluations that stay `incomplete`
because their provider calls are refused, plus downstream timeouts. Consistent with the stale owner approval, as in
run 42772917480; not individually re-proven. They can only be proven clean after the owner re-records the approval.

## Slice 5 — candidate records and privacy (2026-11-10, uncommitted)

Owner choice: candidate records and privacy. Observed read-only first (EV-026…EV-031). Migration 4405 (idx 3805) after
a fresh peer survey (no other claim on the number, index or timestamp). Built by a builder agent, reviewed by a
separate reviewer agent, fixed, then checked by the lead.

Review findings and outcomes:

| Finding | Severity | Outcome |
| --- | --- | --- |
| Removal raced with a concurrent upload, ID save or talent-pool add, which could leave personal data on a removed candidate | Medium | Fixed: removal holds a per-candidate advisory lock; every guard that reads the removal state takes it shared first; the service locks before its retention check. Test proves a removal waits for a concurrent write |
| The removal exception trusted the function owner plus a session setting any caller can set | Medium (design) | Fixed: a private marker table only the removal function writes (no app grants), checked through a definer predicate; the candidate branch is clear-only and the scorecard branch keeps ratings and result. Tests prove the app role cannot read or write the marker and a session setting no longer opens it |
| Duplicate check scanned the whole company | Low–medium (scale) | Fixed: four indexed equality lookups; EXPLAIN on 200k candidates uses all four indexes, no sequential scan |
| A duplicate check confirmed whether a chosen ID number or email existed without a trace | Low | Fixed: each flag appends an event with company, job, match count and route only |
| Retention check and removal not atomic | Low | Fixed with the lock above |
| Talent-pool add bypassed the repeat-application error mapping | Low | Fixed; concurrency test |
| Inline file downloads | Low | `Content-Security-Policy: sandbox`, nosniff, no-store on every response |

The restated guards (application, scorecard, offer, offer value, offer approval) were diffed against their previous
definitions: identical apart from the removal branch; the hardened approval transitions are intact.

Checks by the lead on a private Postgres 16 cluster, under the resource lock:

| Check | Result |
| --- | --- |
| DB: `recruitment-candidate-privacy` (cases 19–27 and the race, marker and audit tests), `recruitment-privacy-rules`, `recruitment-slices-service`, `recruitment-service`, `company-referrers`, `module-catalog-drift`, `module-gate`, `partner-roles`, `invitation-privesc`, `draft-action-atomicity`, `module-job-source-security` | PASS, 11 files, 332 tests |
| No-DB set (33 files incl. the two personnel DOM files missed in run 42792007535) | PASS except 9 `provider-analysis-policy` (stale owner approval, expected) |
| Scoped `tsc` over 25 changed TypeScript files; ESLint on the same | PASS, 0 errors; clean |
| AI source manifests | Regenerated |

Rendered (local dev server, fictional data): the Candidate tab for HR Admin (profile, restricted salary and ID, resume
with the permission note, tags, consent history); the interviewer's view of the same candidate (profile and resume
only); Settings › Privacy listing one candidate past retention, removal blocked until the confirmation box is ticked,
then removed — afterwards a scan of every text column of every recruitment table and the event log found neither the
name nor the email, and stage counts were unchanged; Settings › Tags; the duplicate warning for an administrator (the
matching candidate, matched fields and the two choices) and for a recruiter ("may already have this candidate, ask
an HR administrator", no details), with the audit events carrying ids and counts only. Server log: no errors.

## GitHub Actions focused run 42831274035 (commit 16ed2b44e, slices 1–5, 2026-11-10)

| Job | Result |
| --- | --- |
| Whole-repo `typecheck` | PASS |
| `linux-build` (production build) | PASS |
| Selected tests, no-DB batch (30 files, 554 tests) | 29 files PASS, including the DOM files `r374-no-basic-salary-forms`, `ui-audit-role-layout`, `create-employee-dialog`, `draft-record-tabs`; `provider-analysis-policy` 9 FAIL (stale owner approval, expected) |
| Selected tests, DB batch (20 files, 406 tests) | 15 files PASS, including `recruitment-candidate-privacy` (12), `recruitment-privacy-rules` (20), `recruitment-slices-service` (15), `recruitment-service`, `company-referrers` (93), `module-job-source-security` (64), `partner-roles`, `module-gate`; 5 FAIL, 44 tests |

The DB failures are the same five AI files with the same count as run 42792007535 (`assistant-conversation-evaluation-fence`
11, `assistant-conversation-lifecycle` 5, `human-module-planner` 18, `module-agent-evaluation-progress` 4,
`module-agent-prompt-release` 6). Logged causes: `AiPrivacyGateError`, fixture evaluations left `incomplete` because
their provider calls are refused, and downstream timeouts. Consistent with the stale owner approval; not individually
re-proven.

## Slice 6 — recruitment reports (2026-11-11, uncommitted)

Observed read-only first (EV-032…EV-034). Built by a builder agent, reviewed by a separate reviewer agent, fixed,
then checked by the lead. Migration 4406 adds four report indexes (idx 3806) after a fresh peer survey.

Review findings and outcomes:

| Finding | Severity | Outcome |
| --- | --- | --- |
| Migrations 4400–4406 are timestamped below `4600`/`4601`/`4800`, which `origin/main` and `origin/alpha` now carry; after a merge they would be skipped on any database that applied 4800 | High (integration) | Open: renumber above the watermark when the branch is brought up to date with `main` (needs the owner's go-ahead) |
| A dashboard's snapshot could live for minutes (per-statement timeout only), and a timeout showed an error page | Medium | Fixed: 20-second budget per dashboard, 5-second statements, timeouts shown as "narrow the period" in 6 languages |
| Each dashboard rebuilt the job scope and application set several times | Medium (scale) | Fixed: scope computed once; statements per dashboard 12→7, 9→5, 8→4, 7→5 (asserted in tests) |
| Years outside 2000–2100 caused server errors | Low | Fixed: refused as an invalid period |
| Interview pass rate counted progress made before the interview | Low | Fixed: only progress at or after the interview counts |
| Requisition figures shown for a mix of administered and non-administered companies | Low | Fixed: hidden with a note unless every selected company is administered |
| Team dashboard credit rule unstated | Low | Documented on screen and in code |

No access leak and no personal data were found: team members see only their own jobs, interviewers and approvers
are refused, and no name, contact, restricted value, scorecard text or offer value reaches a result.

Checks by the lead (private Postgres 16 cluster, resource lock): DB tests `recruitment-reports` (cases 28–34 and the
review fixes), `recruitment-report-rules`, `recruitment-candidate-privacy`, `recruitment-privacy-rules`,
`recruitment-slices-service`, `recruitment-service`, `module-gate`, `module-job-source-security`, `company-referrers`,
`partner-roles` — PASS, 10 files, 288 tests. No-DB set (33 files) PASS except 9 `provider-analysis-policy` (stale
owner approval, expected). Scoped `tsc` over 20 changed files: 0 errors. ESLint clean on touched files (one existing
error in `lib/product-context/destinations.ts` `classifyPage`, not from this change). AI manifests regenerated.

Rendered (fictional data): Overview (KPIs, trend chart with an accessible table, stages, sources, per-job progress),
Positions (per-job figures, rates showing "—" with no hires, stage funnel), Interviews (held vs previous period,
feedback rate, results), Team (recruiter work counts with the credit note) for HR Admin; an interviewer has no Reports
tab and is sent back to Candidates; a 0099–9999 period is refused without an error page (its message still says the
start is after the end — wording nit). Server log: no errors.

## GitHub Actions focused runs 42877080472 and 42880744657 (commit 1323e3489, slices 1–6, 2026-11-11)

| Job | Result |
| --- | --- |
| `linux-build` (production build) | PASS |
| Selected tests, no-DB batch (31 files, 567 tests) | 30 files PASS; `provider-analysis-policy` 9 FAIL (stale owner approval, expected) |
| Selected tests, DB batch (21 files, 422 tests) | 16 files PASS, including `recruitment-reports` and every other recruitment file; the same 5 AI files FAIL with the same 44 tests and causes as runs 42792007535 and 42831274035 |
| Whole-repo `typecheck` | FAIL twice: the compiler ran out of its fixed 12 GB heap (`.github/ci/typecheck.sh`, `--max-old-space-size=12288`) after about 11 minutes; no type error was reported. Commit 16ed2b44e passed the same job |

Diagnosis: the new report files cost the same to type-check as existing recruitment files (≈8.8 million
instantiations each, scoped `--extendedDiagnostics`), and the scoped check passes with 0 errors. The whole program
has grown past the CI compiler heap; this slice tipped it. Raising the heap or switching the type check to a bounded
compiler profile is a shared-workflow change that needs the owner's review. Until then the whole-repo type check for
slice 6 is NOT VERIFIED.

## Not verified

The whole-repo type check and production build for slices 2–4, the DB-backed AI Centre tests, every screen in a
language other than English, mobile widths, and any reference write-path behaviour (U-003).

### Type-check memory fix — runs 42937473282 and 42938942472 (2026-11-11)

The out-of-memory failure is repository-wide: two other candidates hit it on 2026-11-10. Owner-authored commits
a921293e6 and 5e7d80ff6 on the combined release line split the check into three compilers (product without `test/`,
noCheck declarations, tests against the declarations). They were cherry-picked unchanged as f6ecc044e and 2c528fc0f;
the Playwright type import from ee659f43d (Codex) followed as 21521d536, because the split test project no longer saw
`vitest.browser.config.ts`. The workflow was dispatched from this branch so the candidate's own `typecheck.sh` ran.

| Run | Commit | Product `tsc` | Declarations | Tests | Result |
| --- | --- | --- | --- | --- | --- |
| 42937473282 | 2c528fc0f | PASS, 9.3 GB peak | PASS, 6.0 GB | FAIL: 15 TS2769 in 12 `*.browser.test.tsx` files (`animations` unknown on `ScreenshotOptions`); no recruitment file | FAIL |
| 42938942472 | 21521d536 | PASS, 8.6 GB peak | PASS, 6.1 GB | PASS, 7.8 GB | **PASS** |

The whole-repository type check is therefore **PASS** for this branch's code as of 21521d536 (slices 1–6). The three
commits are identical in content to the combined release line's, so they merge cleanly when that line reaches `main`.

## Slice 7 — Employee referrals (2026-11-11, uncommitted)

Observed read-only first (EV-035…EV-038; the tenant's e-mail domains on the referral settings page were not recorded).
Built by a builder agent, reviewed by a separate reviewer agent, fixed, and rendered by the lead.

Review findings fixed before commit: referrals accepted under a company-only Recruitment grant that no HR page could
reach (now the same tenant-wide rule as HR); submission did not itself check employment in the job's company (it
relied on row security, which the superuser-owned test database bypasses); voided, blacklisted and resigned
employments counted as active; the marker-bound owner policies were never exercised by any test; refusals could be used
to probe who applied without limit (now counted in the daily attempt cap); interviewers could read the referral reason
directly (column grants); a full-scan protection-period query; no lock against a concurrent job close; a UTC-unsafe
day-cap test and a timing-dependent concurrency test.

| Check | Result |
| --- | --- |
| DB + no-DB tests on the private Postgres 16 cluster (fresh template): recruitment-referrals (18), referral-rules (7), candidate-privacy, slices-service, recruitment-service, recruitment-reports, module-gate, module-catalog-drift, partner-roles, pack-drift, i18n-coverage, migration-journal-ordering, navigation-workspaces, function-access, setup-copilot-destinations | PASS, 15 files, 270 tests (builder-reported; the reviewer independently ran 5 files, 59 tests, PASS on the first version) |
| Production-like owner test: tables and definer functions owned by the NOSUPERUSER, NOBYPASSRLS `ai_hr_owner` in a rolled-back transaction; fails if the referral policies are dropped | PASS |
| Scoped `tsc` over 26 touched files | PASS except a pre-existing missing `fontkit` declaration in `lib/payslip-pdf-fonts.ts` |
| ESLint on changed files | Clean; remaining errors in `components/sidebar.tsx`, `app/layout.tsx`, `lib/product-context/destinations.ts` are identical at HEAD |
| AI source manifests | Regenerated; both `--check` PASS. The owner's provider-data approval must be re-recorded |
| Whole-repo type check, build, CI | See run 42955441606 below |

Rendered on the private render database (fictional people), as HR admin and as an employee:

- HR turns on "Show on the referral portal" for a job; the database refuses the same change without an administrator
  (even from a superuser connection).
- The employee portal lists the job with location, employment type, recruitment type and job level; the page data
  has no salary, team or counts.
- A referral without e-mail or mobile is refused with an alert beside Send, keeping the typed values; a valid one
  appears under My referrals as "In Review"; referring the same person again (e-mail in different case, trailing
  space) shows only the generic refusal while the audit event records `similar_application`.
- HR sees "Referred by … on …" and the reason on the application. The employee gets a 404 on the HR application page
  with none of its data in the response.
- A user with no employment sees "Referrals are open to current employees of companies that use Recruitment" on every
  referral page, with no job data.
- The referral protection period saves from Recruitment settings.

Open: the last working day counts as employed (matches login blocking; the employee record shows "Resigned" that day).

### GitHub Actions focused run 42955441606 (commit 5f6c1dd89, 2026-11-11)

Dispatched from this branch so its split type check ran.

| Job | Result |
| --- | --- |
| Whole-repo type check (three compilers) | PASS: 9.2 GB, 6.0 GB and 8.4 GB peaks, all exit 0 |
| Production build (`linux-build`) | PASS |
| Selected tests, no-DB batch (33 files, 578 tests) | 32 files PASS, including recruitment-referral-rules, recruitment-rules, recruitment-hiring-rules, recruitment-privacy-rules, recruitment-report-rules, recruitment-pack-drift; 1 FAIL: `provider-analysis-policy` (9 tests) |
| Selected tests, DB batch (23 files, 445 tests) | 18 files PASS, including recruitment-referrals (18), recruitment-candidate-privacy (12), recruitment-slices-service (15), recruitment-service (11), recruitment-reports (16); 5 FAIL, 44 tests: `assistant-conversation-evaluation-fence`, `assistant-conversation-lifecycle`, `human-module-planner`, `module-agent-evaluation-progress`, `module-agent-prompt-release` |

The 6 failing files and 53 tests are the same set as in every run since the AI source manifests changed
(`AiPrivacyGateError`: the owner's provider-data approval must be re-recorded for the new digest). No recruitment
test failed.
