# Recruitment — reference reconstruction scope

Status: **core hiring path observed read-only (EV-007…EV-020, owner's live tenant); slice 1 build in progress.**
Mode requested: RECONSTRUCT_AND_VERIFY. Destination: a new "Recruitment" menu in AI HR.

## Inputs as supplied

| Input | Value | State |
| --- | --- | --- |
| REFERENCE_APP | `https://hire-r1.mokahr.com/login?redirectUrl=%2F` (Moka Recruiting ATS) | Reachable anonymously (EV-001) |
| REFERENCE_MATERIALS | not supplied | — |
| WORKSPACE | this repository, branch `claude/rea-web-app-reconstruction-2c12ee`, fast-forwarded to `origin/main` = `origin/alpha` = `f07f32dcd` on 2026-11-10 | Verified |
| ACCESS | Owner signed in to the built-in browser pane, 2026-11-10; the owner's live tenant (live data); one non-super-admin account | Partial: one role only |
| AUTHORIZED_REFERENCE_ACTIONS | default read-only | Applied |
| REQUIRED_STACK | existing AI HR stack (Next.js, Drizzle/Postgres, packs) | Assumed per default |
| LATER_INTEGRATION_TARGET | "Recruitment" menu in AI HR | From the request |

## Discovery inventory (breadth-first)

| ID | Route / feature | Classification | Evidence | Notes |
| --- | --- | --- | --- | --- |
| R-001 | `/login` (account + password, show-password toggle, privacy-policy consent checkbox, Forgot password, SSO, language switcher, Headhunter link) | OBSERVED | EV-001..003 | Vendor's own sign-in. Not a reconstruction target: AI HR keeps its embedded login (ADR-0117). |
| R-002 | `/forget_password` | OBSERVED (link only) | EV-003 | Not visited. |
| R-003 | `/headhunters/` | OBSERVED (link only) | EV-003 | External-agency portal; not visited. |
| R-004 | `/` (authenticated home) | OBSERVED redirect to R-001 when anonymous | EV-006 | Content UNKNOWN. |
| R-005 | Candidates, Interviews, Reports, Me (mobile footer nav) | INFERRED from i18n keys `hr.mobile.footer.nav.*` | EV-004 | Vocabulary only; route paths, roles and states UNKNOWN. |
| R-006 | Dashboard/overview, Jobs, Candidate management, Talent pool, Interview management, Offer management, Pending onboarding, Referrals, Headhunter members, Requisition management, Headcount, Reports, Settings | INFERRED from i18n vocabulary | EV-004 | 33,137 strings indicate a large product; none of these is confirmed reachable for any role. |

Incomplete crawling does not establish complete scope. Every authenticated feature is UNKNOWN until observed.

## Roles, environments

- Roles observed: anonymous only.
- Environment observed: headless Chromium 157, 1440×900, en-US, Asia/Kuala_Lumpur.
- Roles needed: at minimum a recruiter/HR admin, a hiring manager and an interviewer in a **test tenant**.

## Signed-in inventory (2026-11-10)

Observed routes: `/dashboard`, `/jobs`, `/jobs/<id>/{info,setting,manager,source}`, `/headcounts`,
`/candidates`, `/candidates/application/<id>/info`, `/interviews/overview`, `/talent_pool/all`,
`/settings/*` (inventory plus 20 pages read). Not visited: `/bi-reports`, `/notifications`, `/unarchived/jobs`,
`/heat_preservation/checkin`, offer and interview detail views, and every create/edit/submit path.
Roles observed: one owner account only. Recruiter, hiring-manager and interviewer views are still UNKNOWN.
