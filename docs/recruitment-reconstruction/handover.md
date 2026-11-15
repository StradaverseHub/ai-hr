# Recruitment reconstruction — handover checkpoint (2026-11-10)

## State

- Checkout `claude/rea-web-app-reconstruction-2c12ee`, fast-forwarded to `f07f32dcd` (`origin/main` = `origin/alpha`).
- Discovery: 1 route observed (vendor login), 2 linked routes not visited, the authenticated product not observed.
- Implementation: none. Verification: none run.
- Parity report: not produced, because nothing is comparable yet.

## Commands that worked

- REA `capture_browser_scenario`, launch mode with `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, headless, 1440×900, en-US, Asia/Kuala_Lumpur, capturing `url`, `screenshot`, `accessibility`, `dom` plus `console`, `page-errors` and `network` events.
- Read downloaded vendor bundles as text only (Python regex). Executing them is refused by policy and must stay refused.

## Update — slice 1 built (uncommitted)

The Recruitment pack, migrations 4400/4401, `/recruitment/*` screens, the Recruiting Partner role and
6-locale labels are in the working tree. Results are in `parity-report.md`. Open items:

1. ~~AI Centre binding decision~~ — decided and built (counts only); see the next section.
2. Commit and push, then run `alpha-focused-checks.yml` on GitHub Actions for the whole-repo type check and full tests.
3. Render the screens with a seeded fixture company.

## Update — AI Centre binding, counts only (built, uncommitted)

The owner chose "counts only, no candidates", then authorized updating the frozen planner-prompt oracle (2026-11-10).

- `recruitmentPipelineCounts` (packs/recruitment/data.ts, exported via service.ts): one row per administered
  company with its name and nine whole-number counts. It selects no candidate, application, job, person or user.
- Bound as `recruitment = authorized_recruitment_pipeline_counts` (lib/ai/module-agents.ts): read-only declaration
  (no prepare or confirm effect), job presentation that refuses any non-count value, reader case, three specialist
  findings, follow-up code `read_recruitment_counts`, fictional holdouts (one carries a poisoned candidate name),
  questions in 6 locales, finding and field labels in 6 locales, AI Centre switch `module:recruitment` (in 4401).
- Both generated source manifests regenerated with the repo scripts.
- Tests updated: count pins 20→21, question suites 144→150, findings 56→59, the frozen read-plan system literals
  (test/provider-workload-policy.test.ts, owner-authorized; exactly one appended capability, fingerprint recomputed
  from the literals), and the WP7 legacy comparison now covers only modules its base declares.

Open:

1. **Owner provider-data approval.** `lib/ai/provider-data-approvals.ts` approvals no longer match the regenerated
   source digest, so 9 provider-analysis-policy tests fail and AI provider egress for those features stays blocked
   until the owner records approval. Slice 1 alone already required this (it changes covered sources).
2. **Prompt evaluations.** The read-plan prompt and suites changed; any released prompt candidate needs re-evaluation
   under the new suite digests before promotion.
3. Database-backed AI tests (permission parity, read session, source security, native outcomes): NOT RUN here.
   They belong on GitHub Actions after commit and push.

## Update — slices 2–4 built, reviewed and rendered (uncommitted, 2026-11-10)

Hiring-team access and interviews (4402), offers with approval and the hire hand-off (4403), job requisitions and the
talent pool (4404), with their screens in 6 languages. Results and the review findings are in `parity-report.md`;
deviations D-005…D-012 in `discrepancies.md`.

Open:

1. **Owner decisions:** D-008 (should whoever starts an approval round also be barred from approving it?) and D-009
   (should approvers see the candidate's name?).
2. **Owner provider-data approval** (unchanged from slice 1): the regenerated manifests no longer match the recorded
   approval.
3. Commit, push and run `alpha-focused-checks.yml` once for the whole-repo type check, production build and the
   DB-backed AI tests.
4. Retire the private render cluster (`/private/tmp/aihr-recruit-render-2c12ee`, port 55440) and the local
   `recruitment-render` preview entry when rendering is no longer needed.

## Update — slice 5 built, reviewed and rendered (uncommitted, 2026-11-10)

Candidate profile with restricted salary and ID, resume and attachment files, duplicate detection and the
repeated-application window, manual tags, PDPA consent, retention and confirmed removal (4405). Results in
`parity-report.md`; decisions D-013…D-016 in `discrepancies.md` wait for the owner (sensitive questions not collected,
no smart tags, no merge, retention defaults 6/24 months per company).

## Update — slice 6 reports built, reviewed and rendered (uncommitted, 2026-11-11)

Four fixed dashboards (Overview, Positions, Interviews, Team) with role scoping, a time budget and indexes (4406).
Decisions D-017…D-019 wait for the owner.

**Before any merge:** `origin/main` and `origin/alpha` now carry migrations 4600, 4601 and 4800 with later timestamps
than this branch's 4400–4406. Bring the branch up to date with `main`, then renumber 4400–4406 into a free block above
the highest applied and claimed timestamps (peer survey first), or the recruitment migrations will be skipped.

## Update — slice 7 employee referrals built, reviewed and rendered (uncommitted, 2026-11-11)

Employee portal under /me/referrals, the refer form, My referrals, the per-job portal setting and the per-company
protection period (4407, idx 3807). The whole-repo type check is fixed on this branch by the combined release line's
compiler split (cherry-picked). Decisions D-020…D-024 wait for the owner (no rewards, no notifications, generic
refusals with an attempt cap, 20 attempts a day). The migration renumber warning above now covers 4400–4407.

## Update — main merged, migrations renumbered (2026-11-12)

`origin/main` (`2a2495919`) is merged into this branch, and the block moved above main's watermark with unchanged SQL
bytes: `44NN_<name>` → `52NN_<name>`, idx 38NN → 46NN, when 17933300041NN → 17933300049NN (NN = 00–13; for example
`4401_recruitment_core` is now `5201_recruitment_core`). New `5214_recruitment_consume_invitation_access_lock`
keeps main's Access lock in `app.consume_invitation` (5000) with the recruiting partner in guard A. Earlier sections and
the other files in this folder keep the old numbers as history; the full mapping is the top entry of
`docs/MIGRATION-ALLOCATION.md`. A local database migrated with the old numbers must be rebuilt, not upgraded.

## Update — migrations renumbered above main's 5400–5640 block (2026-11-14)

Main's journal now ends at `5640_lifecycle_v9_email_hold_company_tenant` (idx 5040, when 1793330005340), above the
`5200`–`5220` block, so the block moved again with `git mv`: `52NN_<name>` → `57NN_<name>`, idx 46NN → 51NN, when
17933300049NN → 17933300054NN (NN = 00–20; for example `5201_recruitment_core` is now `5701_recruitment_core` and
`5220_recruitment_candidate_email` is now `5720_recruitment_candidate_email`). Code, tests, SQL comments and the current
documents name the new numbers; the earlier sections here and the dated sections of `parity-report.md` keep the numbers
of their time as history. The full mapping and the survey are the top entry of `docs/MIGRATION-ALLOCATION.md`. A local
database migrated with the 52NN numbers must be rebuilt, not upgraded.

## Checkpoint — paused after slice 19 (2026-11-15)

State at `70ad780fe` (pushed; branch `claude/rea-web-app-reconstruction-2c12ee`):
- Built, reviewed, rendered and committed: slices 1–19. Migrations `5700`–`5720` (idx 5100–5120, when
  1793330005400–1793330005420). Latest CI on `bde982fbe` (runs 43582353939, 43582378924, 43583984796): type check and
  build pass; the only failures are the six AI files waiting on the owner's provider-data approval.
- Slice 19 (candidate e-mail) was tested with faked transports; queuing was not rendered because the local server has
  no embedded sign-in or active relay (see parity report). Careers receipts were moved to slice 21 (D-064).
- `origin/main` was 43 commits ahead on 2026-11-15; its newest migration `5660_pay_component_bonus_epf_bonus_2012`
  (idx 5060, when 1793330005360) still sorts below this block, so the next merge needs no renumber. Recheck the journal
  tail and the allocation document at merge time; `5660` must reach an installation before `5700`–`5720`.
- Nothing is on staging. Staging only on the owner's request, through the shared staging queue.

Next, in order (owner decisions D-063, 2026-11-14; plan in `specification.md`):
1. Merge `origin/main`, re-run the recruitment CI set (scratchpad lists are gone; rebuild the list from
   `test/recruitment-*` plus the cross-cutting and mail suites named in the slice 19 parity entry).
2. Slice 20 — interview invitations, reminders, cancellations and offer e-mails (spec written, cases 133–136).
3. Slice 21 — verified applicants (one-time e-mail code, strict per-address and per-IP limits), signed accept links
   for interviews and offers, and careers receipts (spec to write).
4. Slice 22 — optional anonymous candidate survey after hire or rejection.
5. Slice 23 — referral rewards: fixed per job, payable after probation, HR-approved, one-off payroll earning; agency
   fees tracked and approved only.
6. Slice 24 — AI match summary suggestions only (no ranking, scoring or rejecting; no AI interviews); needs the owner
   to re-record the provider-data approval.
7. Slice 25 — agency portal, reusing slice 21's verification.

Owner items still open: re-record the provider-data approval; the open discrepancy decisions; the last-working-day
rule; move raw Moka evidence to private storage; a data-processing agreement covering candidates before any company
switches candidate e-mail on.

Local environment (disposable): private Postgres cluster at `/private/tmp/aihr-recruit-render-2c12ee` on port 55440
(drop `ai_hr_test_tpl` before each DB test run; run tests through `scripts/local-resource-lock.py --test-slots 1`);
render database `ai_hr_dev` rebuilt from `ai_hr_test_tpl` + `db/seed.ts` + the render fixture (the fixture script lived
in the session scratchpad and must be recreated); launch entry `recruitment-render` on port 3020 (stopped). The bulk
import worker runs as `node --import tsx scripts/bank-import-runner.ts` (not with `--conditions=react-server`).

## Next actions, in order (original plan)

1. Resolve B-001: the owner signs in to a Moka **test tenant** in the built-in browser pane. Then use read-only observation (`read_page`, screenshots, network list) per role and journey, recording EV-0xx entries.
2. Resolve B-002 and B-003 with the owner.
3. Write `specification.md` per observed journey, then build vertical slices following `architecture.md`. The first slice is the pack, catalog row, default-off gate, nav item, `SCREENS` entry, i18n in 6 locales and the registry tests.
4. Verify on GitHub Actions (`alpha-focused-checks.yml`), not local slots.

## Checkpoint — slice 20 built and verified (2026-11-15)

State at `48843bac6` (pushed; branch `claude/rea-web-app-reconstruction-2c12ee`):
- `origin/main` (`1299e6724`) merged at `12b68a8df` without a renumber (main's newest, `5660`, sorts below `5700`).
- Slice 20 built: migration `5721` (idx 5121, when 1793330005421), invitations with a server-rendered live preview, automatic
  reminders, withdrawal on cancellation, cancellation e-mails, "Send offer by e-mail" with "In e-mail" offer fields. Decisions D-065.
- CI: type check and build pass on `5b9b4cf0d`; all unit tests pass; the DB tests pass after the last test fixes (run 43695948469 for the
  affected files). Results and the fixes CI found are in `parity-report.md`. The only known failures remain the AI files waiting on
  the owner's provider-data approval.
- Not rendered (case 136): no local render cluster, and queuing needs an installation with the embedded sign-in and an active relay.
- Nothing is on staging.

Next, in order: slice 21 (verified applicants with a one-time e-mail code, signed accept links for interviews and offers, careers
receipts; spec to write), then slices 22–25 as listed in the previous checkpoint. Owner items unchanged, plus a review of D-065.

## Checkpoint — slice 21 built and verified (2026-11-15)

State at the head of `claude/rea-web-app-reconstruction-2c12ee` (pushed):
- Slice 21a (`5722`): e-mail code before applying while the company's candidate e-mail is on; careers receipts. Slice 21b (`5723`):
  response links in invitations and offer e-mails. Decisions in D-066. Results in `parity-report.md`.
- CI: type check and build pass; every recruitment unit and DB test passes; the only known failures remain the AI files waiting on
  the owner's provider-data approval.
- Not rendered: slices 19–21's e-mail and careers verification screens need an installation with the embedded sign-in and an active
  relay. Nothing is on staging.
- `origin/main` has moved since the last merge (`1299e6724`); merge it before the next slice and recheck the journal tail: the
  recruitment block now ends at `5723` (when 1793330005423).

Next, in order: slice 22 (optional anonymous candidate survey after hire or rejection; spec to write), slice 23 (referral rewards),
slice 24 (AI match summary suggestions; needs the owner's provider-data approval), slice 25 (agency portal, reusing slice 21a's
verification). Owner review: D-065, D-066.
