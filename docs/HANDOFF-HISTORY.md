## P1 wave 3a (OneHR / Reward Desk parity) — staging release 28 October 2026

- Staging source `d78b726d297b41269a81746e08e58e152ff433bf` (alpha; wave 3a merged via PR #24 as `2be7536e9`, plus a docs-only commit), build `rygExbBHOW5osoinP7vIi`, deploy state ok, stale_build=0, service active, protected root 307 to sign-in, login 200. Witness: first-attempt run 40636758751 (60/61, runner-diagnostics skipped); PR run 40634438330 green on head `3e762e1ea`. Migrations none: 506 before and after (journal 506). The release adapter's final source checksum refused; `rsync -azic --omit-dir-times --dry-run` showed 0 differences, the same false refusal as the wave 2 release.
- Packages: D-P1-11 — APR-011 reason on every BU/BG/Group band change in the single writer (Talent Box, Group list with a new reason dialog, generic form, chat, fit Apply); the move cap now also holds on the calibration chat (business-exact: box and chat share one move; list pages, form and fit Apply stay uncapped). Fit Apply stores the server-recomputed deterministic fit reasons when none was saved, never client text or an AI verdict line. D-P1-21 — render pass (open Group Talent Box session in `scripts/dev-fixture-p1.ts`; three class-only fixes). D-P1-01 — no behaviour change: the reference moves Career Plan review one level up only under a unit/department exclusion rule AI-HR does not have; per-person removal already matches. `test/onehr-plan-reviewer-scope.test.ts` and ADR-0141 corrected, not deleted.
- DECISIONS: APR-011 (owner) overrides the reference's optional box justification. The unit/department exclusion rule is an owner scope decision (D-P1-22); its plan is in the migration docs (P1-04).
- STAGING_DEPLOYED_SHA was stale (`2e84be5c1`) after two other releases; corrected to `2ea539db2` after a content dry run showed the box matched, then set to `d78b726d2`.
- Not done: signed-in staging walkthrough (owner); main alignment; non-English text for two new labels; the career-plan save-path lock; production untouched.

## b953a339 Atelier floating sub-menu and collapse — staging release 28 October 2026

- Staging source `2ea539db2d2db3e2130f8b7a596d69be4b76ea63` (alpha, fast-forward from `1ebcf112c`), build `mG8VG5eKnOjDpKLXWTZt4`, deploy state ok, stale_build=0, service active, health 200, login 200, protected root 307 to sign-in. Witness: first-attempt `alpha-staging-ci` run 40633755683 (controller = candidate), accepted by `operator-release.mjs verify` and `deploy`. Migration none. `STAGING_DEPLOYED_SHA` now `2ea539d`. `main` not aligned (pending owner acceptance).
- Item closed: b953a339 (deployed, plan revision 2 after contest). The Atelier sub-menu is positioned over the page beside the rail (was an in-flow 15.5rem column that narrowed the page); tablets keep the rail visible; phones keep the in-flow panel. Atelier honours the shared `rail_collapsed` setting with a Collapse/Expand control: at 640px and wider the rail is 4rem of icons with names as title and accessible text, all section icons shown, module icons open the floating panel. The Ops/Strat switch stacks by CSS only in the collapsed desktop rail, so phones keep the existing guard.
- DECISIONS: collapse reuses Classic's cookie (one remembered preference across themes, stated in the plan). Guard `test/atelier-mobile-navigation.browser.test.tsx` reversed from "panel right of rail, beside content" to "content position and width unchanged when the panel opens".
- Corrections retained: alpha's docs prune `2b3e8c5a4` broke `test/r291-backup-and-restore-rehearsal.test.ts` and `test/statutory-forms-page.test.ts` on alpha itself (run 40629573756); both repaired here to read the condensed documents. Run 40630860902 failed only the new collapse test in WebKit (measured mid-transition); repaired. Green run 40632194620 was refused by verify because `STAGING_DEPLOYED_SHA` still named `6e0c067a0` after the d28501b8 release (owed from that round); set to `2e84be5c1` and rerun. The adapter again stopped on the root-directory timestamp alone (`.d..t...... ./`); `rsync -c -O` showed zero file differences, so installer status/cleanup did not run and the previous build is retained.
- Also this window: d28501b8 was contested (reporter wants overwrite of processed/closed ordinary payroll without recalculation) and re-planned as revision 2, opening with the correction owed from revision 1; awaiting approval. Plan and mockup in docs/mockups/d28501b8-r2-*.
- Not done: signed-in staging walkthrough (owner); main alignment; previous-build cleanup; production untouched.

# Historical handoffs

Round-by-round transcripts have been removed from active documentation. They mixed past source, deployment observations and pending work, and must not drive a current session.

For a specific historical investigation, recover the pre-cleanup log:

```sh
git show a6657ddf6bdb8fc545d0d4bfca434255cd26452e:docs/HANDOFF-HISTORY.md
```

Use Git history and the board for task status, authenticated release/installation records for deployment evidence, and [ADRs](adr/README.md) for durable decisions. Read [repository policy](REPOSITORY-AND-ENVIRONMENTS.md) before changing branches or targets. Add new lasting decisions to an ADR; keep release observations in their evidence system rather than growing this file again.
