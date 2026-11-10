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

## Next actions, in order (original plan)

1. Resolve B-001: the owner signs in to a Moka **test tenant** in the built-in browser pane. Then use read-only observation (`read_page`, screenshots, network list) per role and journey, recording EV-0xx entries.
2. Resolve B-002 and B-003 with the owner.
3. Write `specification.md` per observed journey, then build vertical slices following `architecture.md`. The first slice is the pack, catalog row, default-off gate, nav item, `SCREENS` entry, i18n in 6 locales and the registry tests.
4. Verify on GitHub Actions (`alpha-focused-checks.yml`), not local slots.
