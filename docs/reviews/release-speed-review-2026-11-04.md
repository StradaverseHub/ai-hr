# Release speed review — 4 November 2026

Status: **accepted by the owner on 4 November 2026 ("Okay go ahead"); recorded as [ADR-0175](../adr/0175-first-time-right-releases.md), with Option A for AI approval.** Phase 0 tooling: `scripts/release/preflight.mjs`, `scripts/release/select-focused.ts`, `scripts/release/migrations-renumber.mjs`, the [fast path](../RELEASE-FAST-PATH.md) and the [flaky test register](../FLAKY-TESTS.md). Phase 1 controller changes are still proposals. Original status: **review and proposal only.** Nothing in this document changes a workflow, `.github/ci/*`, the release controller, the staging queue, a manifest or an approval file. Each control change below is a proposal that must be reviewed and validated under [CI policy § Change control](../CI-STAGING-VERIFICATION-POLICY.md#change-control) before use.

Sources: the running log `ai-hr-builders/RESUME/TERAS-RELEASE-STATUS.md` (2–4 November), GitHub Actions run and job records read through the API on 4 November 2026 at 05:58 UTC, and the controller source on main `aa260e8d0`. Times are Kuala Lumpur time (UTC+8) unless marked Z. Figures marked *log* come from the log and were not re-measured.

---

## Part 1 — Plain-language report for the owner

### The short answer

The release does not take 4–5 hours because the checks are slow. **The full check takes about 20 minutes.** It takes 4–5 hours because:

1. **We run the full check four or five times per release, and it has not passed first time once.** In the two releases measured (Noveri on 2 November, AI v2 on 4 November) the full check ran 9 times and passed 0 times. Each failure starts a loop: find the cause, fix it, sometimes ask you to approve again, then run the full check again.
2. **Almost every failure could have been found earlier and more cheaply.** Most were "rule-book" tests that check the whole repository, and our own test selector already lists most of them as tests to run on every change. The builders picked tests by hand instead and missed them. The rest were two checks that could be run before your approval, three tests that break at midnight or on certain weekdays, and three unreliable tests in areas we had not changed.
3. **When one unreliable test fails at the end, our tools can't rerun just that area.** You ruled on 30 October that only the failed area should be rerun. The tool that does this only covers one kind of test. A single unreliable Firefox test on 4 November therefore needed a code fix and a whole new full check, and that is still not finished more than an hour later.
4. **Releases wait for each other.** Only one release can use staging at a time, and other releases have the same failure loops. On 4 November AI v2 waited about 3 hours for a Codex release to land.

### What the AI v2 release actually spent its time on

From the moment the final AI v2 code was ready and green (07:53, 4 November) to the failed release check (12:46): **4 hours 54 minutes. It is still not installed.**

| Where the time went | Time | Share |
| --- | ---: | ---: |
| Waiting for staging and for the Codex release to land on main | 3 h 03 m | 62% |
| Checks running on GitHub | 1 h 23 m | 28% |
| Your approvals (preparing the packet, then your reply) | 15 m | 5% |
| Fixing and merging | 13 m | 4% |

After 12:46 the session has spent more than an hour diagnosing the unreliable Firefox test (about 28 diagnostic browser runs, 8 of them failing). After that it still needs a fix, a new full check (about 20 minutes) and the install.

Your approvals were fast: 13 minutes for the first one and under 2 minutes for the second. **Approval time is not the bottleneck on the day.** Its real cost comes earlier: five binding packets were prepared over the two days, and each one meant re-checking the code.

The earlier Noveri release (2 November, 21:58 → 3 November about 02:00) shows the same pattern. Its timeline is in Appendix A.2: four full checks and a recovery, 2 h 9 m of checks running, 51 m of fixing, then the install.

### Why this happens, ranked by hours lost

| Rank | Root cause | Hours lost (measured releases) | Fixable without changing release controls? |
| ---: | --- | --- | --- |
| 1 | Full checks fail at the end for reasons that could be caught earlier, so each release runs 4–5 full checks instead of 1 | about 2–2.5 h per release | Mostly yes |
| 2 | Releases queue behind each other's failure loops (staging is one-at-a-time) | about 3 h on 4 Nov; the AI v2 release was held about 9 h in all | Falls when cause 1 is fixed |
| 3 | Rerunning only the failed area is possible for just one kind of test, so a late unreliable browser test costs a fix plus a new full check | about 1.5–2 h when it happens (it happened in both releases) | No: needs a reviewed controller change |
| 4 | AI approval is tied to about 1,400 files, including every translation file and the dependency lockfile. Any change there, even one unrelated to what the AI sends, needs a new packet and approval | 4–5 packets per release, about 20–40 min each; one extra full check | Partly |
| 5 | Builders hand-pick which tests to run while they work | 476 AI check runs in 40 h, 139 failed; 254 temporary branches created to get around a one-run-per-branch limit | Yes |
| 6 | Database change numbers collide between parallel branches | 3 renumberings for AI v2, 4 for PR #218, each 30–60 min; one near-miss where a change would have been silently skipped | Yes, with a script; a lease needs a control change |
| 7 | Model scoring is hand-checked | 10–15 min per eval, about 11 versions | Yes |

### What we propose

The safety rules stay exactly as they are: tenant isolation, your approval of every AI data flow, evidence tied to the exact build, failures never relabelled and no rerunning until green. The proposals make the first full check pass, and make a late failure cheap.

**Top 3 changes**

1. **Make the first full check pass ("first time right"), saving about 1.5–2.5 hours per release.** Choose builder tests with the repository's existing automatic selector, which always includes the rule-book tests. Run a 5-minute pre-check before the packet is written: the AI approval checks, database numbering and the date-sensitive tests. 12 of the 16 failures found by those nine full checks would have been caught this way. Most of this needs no release-control change and can start now.
2. **Let recovery rerun a failed browser area once, and a small fix area, saving about 1–2 hours whenever a late failure happens.** Extend the existing reviewed recovery routes so that one failed browser area is rerun once, with the original failure kept on record. If it fails again, recovery stops and a fix is required. Allow a fix that touches only a few files to be checked by rerunning only what it affects. This is the tool support your 30 October ruling needs. It is a controller change, so it needs review and a validation run first.
3. **Approve once, on a candidate that has already passed, saving about 1 hour and at least one full check per release.** Generate the approval packet from the code, including a short list of what changed since your last approval and whether what is sent to the AI provider changed at all. Allow the full check to run before your approval (in "rehearsal" mode, which can never install). You then approve a candidate that is already known to pass, and after your approval only the approval-affected checks rerun. Your approval still names the exact build.

With all three in place, a typical release from ready code to installed should take **about 60–90 minutes**: 5 m pre-check, 20 m full check, 5–10 m approval, 10–20 m recovery if needed, then the install. Waiting for other releases falls with it, because their loops shrink too.

**Other changes:** a script that renumbers database changes automatically when work lands; scorecards computed by a script instead of by hand; a register of unreliable tests that are still run but must be fixed by a deadline; and smaller, more frequent releases with scope frozen once the packet starts.

### Decisions needed from you

1. Approve the draft ADR (Part 3), or tell us what to change.
2. Choose how AI approval works going forward (Proposal P4): **Option A** (recommended first): you approve every change, with a short automatic "what changed" summary. **Option B**: you approve only changes to what is sent to the provider, and other code changes are bound automatically by a payload-equivalence proof. Option B is faster but changes what your approval covers.
3. Confirm that "rerun a failed area once; if it fails again, stop and fix" is within your 30 October rule and is not "retry until green".

---

## Part 2 — Technical appendix

### A. Measured timelines

#### A.1 AI v2 (Phase 1 + Phase 2), 3–4 November

Critical path from code-complete candidate `2109062e8` (union ci47–ci86, eval 41740712701 and timing 41740721786 all green by 23:53Z on 3 November) to the failed release gate. All times are UTC.

| UTC | Step | Evidence | Category |
| --- | --- | --- | --- |
| 23:53 → 02:56 | Owner decision 20 ("Both together"). Staging held by Codex batch 53 (epoch 35, installing); 53 failed, 54 completed at 3b3f94ccd. In parallel: history-learning design, which found 2 pre-existing payroll defects (new scope), fixed at 05cfba8f6. | log; Codex alpha gate 41763369538 dispatched 02:50:56Z | waiting (3 h 03 m) |
| 02:56 → 03:08 | Payroll-defect CI | 41763969639 | CI |
| 03:08 → 03:16 | Merge main 3b3f94ccd → f9fdccd61 | log | fix/merge |
| 03:16 → 03:26 | Post-merge CI, 3 runs in parallel | 41766077994 / 41766081547 / 41766084935 | CI |
| 03:26 → 03:38:57 | Packet finalised, then owner approval 23 | log | approval |
| 03:40:08 → 03:50:11 | Full gate **refused**: unreviewed generator. The `plan` job failed at **03:41:06** (58 s after dispatch), but the run kept going because `typecheck` took 9.2 m. | 41768537723 | CI |
| 03:50 → 03:51:52 | Generator reverted (8fa316bad); closure moves to 5212672b; owner approval 24 | log | approval |
| 03:52:32 → 04:12:25 | Full gate **failed**: `r394-route-loading` (5 pages lack loading.tsx) and `ai-management-contract` | 41769768119 | CI |
| 04:12 → 04:14 | Fix aa260e8d0 (test and app files; closures unchanged) | log | fix |
| 04:14 → 04:25 | Focused CI on the fix | 41771986255 | CI |
| 04:26:38 → 04:46:10 | Release gate on main **failed**: Firefox `lifecycle-v9-html-gaps` keyboard poll. The job had already failed at **04:31:45**. | 41773236616 | CI |
| 04:46 → now (05:58+) | Flake diagnosis: 28 `alpha-staging-browser-checks` runs (ci130–ci157), 8 failed (individual targets not checked here) | runs list | fixing |

Totals for 23:53Z → 04:46Z (4 h 54 m): waiting 183 m, CI 83 m, approvals 15 m, fixing/merging 13 m.

Wider context:
- The Phase 1 candidate was bound and green at 17:34Z on 3 November (41683805444). The owner then paused staging because the Codex Entra release was using it. That Codex release ran 5 full gates, 4 of them failed, between 13:46Z and 18:10Z (41647282869, 41656907749, 41664865869, 41674693100; the pass was 41683594993). Its install then failed (ticket 53) and succeeded on 54, landing about 02:50Z.
- During that hold the release scope grew: a second review (11 + 13 findings), Phase 2 integration and hardening, and the "both together" decision. That work is product work, but it explains why the AI v2 release took "many hours over two days".
- AI v2 full gates: 5 in total (41693210410 CI-only, 41710756333 refused unbound by design, 41768537723 refused, 41769768119 failed, 41773236616 failed). **0 passed.**

#### A.2 Noveri, 2 November (UTC)

| UTC | Step | Evidence | Minutes |
| --- | --- | --- | ---: |
| 13:58 → 14:07 | Gate 1 **refused**: generator differs from the controller's | 41457586769 | 9 CI |
| 14:07 → 14:09 | main fast-forwarded to the aggregate | log | 2 admin |
| 14:09 → 14:36 | Gate 2 **failed**: `payroll-pack-drift`, `leave-pack-drift`, `ai-management-contract`, `company-referrers`, `rewards-cancel-custody` | 41459296654 | 27 CI |
| 14:36 → 15:46 | Repairs, two focused rounds (the first failed and needed another fix), owner rebinding at 15:30 | 41465481045/41465522939 failed; 41472414945/41472460099 passed | 32 CI, 32 fix, 6 approval |
| 15:46 → 15:53 | main fast-forwarded | log | 7 admin |
| 15:53 → 16:17 | Gate 3 **failed**: two Kuala Lumpur midnight races in tests | 41475967412 | 24 CI |
| 16:17 → 16:30 | Diagnosis, then a deliberate wait until after 00:30 KL | log | 13 fix |
| 16:30 → 16:51 | Gate 4 **failed**: one no-DB teardown rejection; all 3,225 tests passed | 41482125188 | 21 CI |
| 16:55 → 17:11 | Focused recovery v1: 4 **sequential** runs of about 3 m, then controller-only | 41486121242, 41486649320, 41487206242, 41487783828, 41488501143 | 16 CI |
| 17:13 | `verify-recovery` PASSED; then ticket, lease epoch 29, deploy-recovery, arrival | log | — |
| ≈18:00 | Owner acceptance failed (missing `TERAS_PROPOSAL_SECRET`, a product/config defect) | log | — |

Totals from the first gate to recovery verified (3 h 15 m): CI 129 m, fixing 51 m, approval 6 m, admin 9 m.

#### A.3 Full-gate anatomy (verified job data)

| Run | Jobs | Wall | Runner-minutes | Longest job | Jobs queued > 60 s (max) |
| --- | ---: | ---: | ---: | --- | --- |
| 41769768119 | 87 | 19.9 m | 642 | DB unit, 16.1 m | 27 (8.6 m) |
| 41773236616 | 87 | 19.5 m | 640 | DB unit, 15.1 m | 27 (8.5 m) |
| 41693210410 | 86 | 25.9 m | 784 | DB unit, 14.8 m | (10.2 m) |
| Codex 41683594993 | — | 47.8 m | — | — | under heavy contention |

- 75 test units (67 DB, 8 no-DB) plus 3 browser engines. `test_parallelism` defaults to 48, the maximum choice, so about 27 units wait for a slot. Wall time is roughly the longest DB unit plus one queue wave.
- The browser jobs take 3.3–4.4 m, `build` 4.8–7.9 m (Turbopack cache) and `typecheck` 1.1–9.2 m (whole-cache).
- **Correction to the brief:** the gate takes 20–26 m when runners are free. It takes 40–48 m only under contention, as with Codex's gates on 3 November while about 1,000 focused runs were also queued. It is not about an hour every time.

#### A.4 Focused-check volume, 2 Nov 12:00Z → 4 Nov 08:00Z (verified)

| Stream | Runs | Success | Failure | Cancelled | Median wall | Total wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AI (claude/aiv2, noveri, teras) | 476 | 312 | 139 | 25 | 10.5 m | 84 h |
| Codex | 542 | 220 | 300 | 20 | 8.9 m | 75 h |

254 distinct AI candidate refs had a `-ciNNN` suffix. These are CI-only branches at the same SHA, created because `alpha-focused-checks` has `concurrency: alpha-focused-${candidate_ref}`. GitHub keeps only one pending run per group, so a second dispatch on the same branch would replace the first pending one.

#### A.5 Model evals (verified)

The eval runs (41588270355, 41615455375, 41679463324, 41740712701) each took 10.4–11.5 m. The timing run 41740721786 took 15.6 m. They run in parallel, so a version costs about 16 m of wall time. **Correction to the brief:** that is not about 30 m. The log records about 11 spec versions (v13–v23) and 6 gate misses, each followed by a fix round. The coordinator recomputed scores from artefacts by hand and found two errors that way (HR 89.9 against 90.0; a wrong "before" module-agent digest).

### B. Failure taxonomy of every full gate in both releases

| # | Run | Failure | Class | Earliest cheap detection |
| --- | --- | --- | --- | --- |
| 1 | 41457586769 | generator ≠ controller | admission | pre-binding preflight (P1) |
| 2–5 | 41459296654 | payroll-pack-drift, leave-pack-drift, ai-management-contract, company-referrers | repository guard | selector always-run set (P2): 3 already listed, company-referrers to add |
| 6 | 41459296654 | rewards-cancel-custody (`5000` inside a random id) | flaky assertion | flake register (P7) |
| 7–8 | 41475967412 | mobile-v2-leave, ai-delivery-native-fixtures (midnight KL) | time-dependent test | time-pinning guard (P7) |
| 9 | 41482125188 | no-DB teardown rejection | flake, unrelated | recovery v1 (worked) |
| 10 | 41693210410 | r394-route-loading | repository guard | already in `ALWAYS_RUN` |
| 11 | 41693210410 | weekday-dependent leave fixture | time-dependent test | P7 |
| 12 | 41710756333 | unbound manifest (by design) | admission | rehearsal mode (P3c) |
| 13 | 41768537723 | generator ≠ controller | admission | P1 |
| 14–15 | 41769768119 | r394-route-loading (again), ai-management-contract | repository guard | already in `ALWAYS_RUN` |
| 16 | 41773236616 | Firefox keyboard poll, unrelated file | flake, unrelated browser | browser recovery v3 (P3a) |

In total: 7 guard failures (6 of them already in the repository's always-run list), 3 admission refusals, 3 time-dependent tests and 3 flakes. **13 of the 16 failures would have been caught before a full gate, or recovered without one.**

### C. Verified facts about the current controls

1. **The automatic selector already exists and already includes the guards.** `scripts/gate-affected-plan.ts` `ALWAYS_RUN` names `ai-management-contract`, `r394-route-loading`, `module-catalog-drift`, `i18n-coverage`, `function-access`, the boundary guards and `today-in-myt-drift`. `guardFiles()` also adds every `*pack-drift*`, `*-guard` and `*-drift` test. `scripts/gate-impact.ts` (ADR-0114) adds import-graph and source-reading consumers, and the cross-source recovery route already imports it (`.github/ci/repair-impact.mjs:62`). The AI builders didn't use it; they hand-picked "within one hop" unions.
2. **AI manifest admission** (`.github/ci/ai-manifest-admission.mjs`) runs in both the `plan` and `build` jobs. It byte-compares the three generator/scope inputs with the controller's copies, then runs both `--check` commands. Unbound code therefore cannot reach the test matrix, so a pre-approval full gate is impossible. The generator check is fully determinable before binding.
3. **The provider closure** (`scripts/ai-provider-data-source-manifest.mjs`) is a whole-file transitive import closure from about 30 roots, including `package.json`, `pnpm-lock.yaml` and the `messages/*.json` catalogues. About 27 approval records carry the same `sourceDigest` literal (`lib/ai/provider-data-approvals.ts`), so any byte change in any of the 1,412 files makes every record stale. The PR 210 authenticator strings (2 November) moved the binding without changing anything the AI sends.
4. **Existing recovery routes:**
   - `aihr-focused-recovery/v1` covers an unchanged candidate with failed no-DB units only, and requires browsers, build, compiler and migrations to have passed.
   - `aihr-browser-capacity-recovery/v2` (`browser-recovery-policy.mjs`) covers a Firefox unit that executed **zero** batches because of the 20 GiB disk guard. It refuses an executed test failure.
   - `aihr-cross-source-recovery/v2` (`repair-recovery-policy.mjs`, `docs/CI-REPAIR-RECOVERY-V2.md`) is implemented but pending independent review. It supports modified *existing* product TypeScript files and refuses changed test inventory, new files and any affected browser unit.

   None of them covers the 4 November case: an executed Firefox failure, or a fix that adds `loading.tsx` files.
5. `validateFocusedMetadata` checks `head_branch ∈ {main, alpha}` and the controller SHA, not the `candidate_ref` name. Recovery focused runs can therefore be dispatched in parallel on distinct CI refs at the same SHA. The four sequential 3-minute runs on 2 November could have run in parallel in about 4 minutes. *(Inferred from source; confirm with a read-only `verify-recovery` on a test case before relying on it.)*
6. `.github/ci/check-migration-order.mjs` enforces an append-only journal with increasing `idx`/`when` **relative to the PR base**. A long-lived branch whose base is old can still carry a `when` below main's or staging's current watermark (the 0952 near-miss). The populated-upgrade rehearsal catches the effect, not the cause.

### D. Proposals

Each proposal lists the time saved (from the measured releases), the risk, and the control that keeps it safe. **Now** means no release-control change: builder tooling, scripts outside `.github/ci`, docs and process. **Controller** means a reviewed controller change plus the validation witness in §E. **Policy** means an owner decision and an ADR.

#### P1 — Pre-binding admission preflight (Now)

A read-only script, `scripts/release/preflight.mjs` (proposed), runs in the candidate before the packet is written:
- byte-compares `AI_MANIFEST_INPUTS` against `origin/main` (the next controller), exactly as `admitAiManifests` does;
- reports the closure digest and the delta from main's bound digest;
- checks every new migration `when` and `idx` against `origin/main`'s journal and the last recorded staging watermark;
- runs the always-run guard set (P2) and the time-pinning guard (P7) through one focused dispatch.

- **Saves:** 1 full gate plus 1 approval round in each measured release (#1 and #13; about 10–30 m CI plus 15–40 m rework each).
- **Risk:** none to release safety. It is advisory, and admission still runs in CI.
- **Control:** the CI admission is unchanged; the preflight only moves the discovery earlier.

#### P2 — Automatic test selection for builders and integrators (Now; workflow fan-out is Controller)

Replace hand-picked unions with `scripts/gate-impact.ts`/`gate-affected-plan.ts` in plan mode against `origin/main`, then dispatch the selection in 64-file chunks.
- Extend the always-run set in the *wrapper* (not the controller's selector) with the tests that recurred in this release: `company-referrers`, `definition-of-done-registry`, `agent-capability-inventory`, `rule-version-migration-upgrade`, `setup-copilot-destinations`, `ai-centre`, `provider-data-review-gate`, `i18n-coverage` and the naming guard.
- After a release proves the list, propose adding it to `ALWAYS_RUN`. That is a selector change, so it needs full validation under ADR-0114.
- **Controller follow-up:** let `alpha-focused-checks` accept more than 64 files and fan out internally (a matrix inside one run). That removes the need for `-ciNNN` branches and the one-pending-run-per-group cancellation.

- **Saves:** 7 of 16 gate failures, about 1–1.5 h per release, and a large share of the 139 failed AI focused runs.
- **Risk:** the selector is conservative (an unknown change selects the full suite), so runs may be bigger. That is acceptable.
- **Control:** the selector only ever *adds* tests; the full gate is still required.

#### P3 — Bounded recovery that matches the 30 October rule (Controller)

- **(a) Browser recovery v3, single shot.**
  - **Admits:** an unchanged candidate and controller with exactly one failed browser engine unit that *executed* tests, where every other job passed.
  - **Reruns:** the complete engine unit once, in the existing pinned Playwright image, from the reviewed controller.
  - **The verifier requires:** the original failure retained with its report; latest execution history containing exactly one recovery run for that unit and candidate, so a second attempt refuses; the same files and assertions; and a recorded flake-register entry (P7).
  - **If the recovery fails:** recovery is closed and the source must be fixed.
  - **Saves:** about 1.5–2 h in the 4 November case.
  - **Risk:** a real intermittent defect ships. Mitigations: the single shot; the unit must be outside the candidate's impact set (computed by `gate-impact.ts`); and the flake must be fixed before that area's next release.
- **(b) Cross-source recovery v3.** Finish the pending independent review of v2. Extend it to *new* files resolved by the impact plan, test-only deltas, and **binding-only deltas**: approval literals and generated manifests only, where `provider-data-review-gate`, typecheck and a fresh canonical build are the affected set. Browser units affected by the delta are still refused unless (a) applies.
  - **Saves:** the 03:52–04:46Z loop (about 55 m) would have been a 10–20 m recovery.
- **(c) Unbound rehearsal mode** for `alpha-staging.yml`.
  - **Runs:** generator and scope byte-equality as today, then the full plan, build and test matrix, while the `--check` result is recorded rather than blocking.
  - **Labels:** the run is `REHEARSAL_NOT_RELEASE`. `verify` and `deployment-hold` refuse it, and no grant can be built from it.
  - **After the owner binds:** the binding-only delta goes through (b).
  - **Saves:** the owner approves a candidate already known to pass; it removes the post-binding gate-fail loop.
  - **Risk:** someone treats a rehearsal as evidence. Control: a distinct run name, artefact namespace and refusal tests, in the same way `controller_only` is handled today.
- **(d) Now: dispatch recovery runs in parallel** (fact C.5), and start diagnosis when the first job fails rather than when the run finishes. Repairs are still dispatched only after every planned job finishes, as policy requires. This saves 10–15 m per failed gate (04:31 → 04:46 on 4 November).

#### P4 — Faster AI approval without weakening it

- **Option A (Now):** generate an **approval delta**: the files changed since the last approved digest, classified as contract or entity, spec or tools, transform, egress or transport, locale catalogue, lockfile, or other. Add a **payload snapshot diff**: run the existing fictional-fixture harness turns through `provider-model`/egress serialisation and compare the exact provider payloads with those at the last approval. The owner still approves the exact digest. The packet says "payload unchanged: 14 files, locale and UI only" or lists the changed fields.
  - **Saves:** about 20–40 m per round, and fewer errors.
  - **Risk:** none. Approval semantics are unchanged.
- **Narrow the closure (Controller, generator change):**
  - move AI-sent strings fully into `messages/ai-centre/*` so app-wide translation edits leave the closure;
  - replace whole `pnpm-lock.yaml` with the resolved package subset reachable from the egress roots.

  Both need a reviewed generator, because admission refuses generator drift.
  - **Saves:** spurious rebinds such as the PR 210 strings.
  - **Risk:** a missed dependency path. Control: the generator still fails closed on unresolved imports.
- **Option B (Policy):** two digests.
  - **Disclosure-surface digest** (contracts, entities, transforms, spec, tool catalogue, egress and transport): owner approval as today.
  - **Integrity digest** (the rest of the closure): bound automatically by a CI **payload-equivalence witness**. Every approved contract has fixture coverage, and payloads are byte-identical to the approved snapshot.
  - **Saves:** most re-approvals.
  - **Risk:** a helper change alters a payload on a path the fixtures don't reach. This narrows what the owner's approval literally covers, which is why it is the owner's decision. We recommend Option A first, and B only after the snapshot coverage has been measured.

#### P5 — Migration numbering (Now; lease is Controller)

- **Now:** a `scripts/migrations-renumber.mjs` that rewrites only *unapplied* entries above `max(origin/main, recorded staging watermark)` and updates the MIGRATION-ALLOCATION entry. Tests that pin the journal tail (five upgrade tests in PR #218) should read the journal instead of literals. Rule: number at landing, not at branch start.
- **Controller:** a `plan`-job check that every new `when` is above main's *current* maximum (not just the PR base), and a `reserve-migrations` command on the staging queue. Allocation then becomes a lease with an owner and expiry, instead of a 1,519-line hand-edited document.
- **Saves:** 30–60 m per renumbering (7 renumberings across AI v2 and PR #218), and removes the silent-skip risk.
- **Risk:** low. Applied SQL bytes and journal prefixes stay immutable, and the renumber touches only unapplied entries.

#### P6 — Full-gate speed (Controller, small gains)

- Add `64` and `80` to the `test_parallelism` choices. 27 units currently queue for a slot.
- Split the 3–4 longest DB units (15–16 m) using the existing duration data.
- Both change the plan or scheduling identity, so they need a fresh whole witness.
- **Saves:** about 5–8 m per gate.
- **Risk:** account-wide runner contention. Measure first; no paid runners.
- **Caching is already in place** (whole typecheck cache, Turbopack cache). Don't propose it again.

#### P7 — Flake and time-bomb policy (Now for the register and guard; recovery use depends on P3a)

- **Register** (`docs/FLAKY-TESTS.md`): test, file, first failure run, evidence of pass and fail on the same SHA, owner and due date.
  - A registered test **still runs and still fails the run**. Nothing is skipped, quarantined out of the gate or relabelled.
  - Its only effect: P3a may be used once per candidate, and only when the test is outside the candidate's impact set.
  - An entry past its due date blocks releases that touch that area.
- **Time-pinning guard:** extend `today-in-myt-drift` (or add a sibling guard) to refuse module-level `new Date()`/`Date.now()` captures in tests and fixtures. This class caused 3 failures (2 midnight races, 1 weekday fixture).
- **Saves:** about 30–45 m per incident.
- **Risk:** none to coverage.

#### P8 — Packet and scorecard generation from code (Now)

`scripts/ai-binding-packet.mjs` (proposed) writes the packet from:
- `--check --list` output before and after;
- the P4 delta;
- the contract registry diff;
- new migrations with SQL hashes;
- the union run IDs (from the API);
- the eval scorecard computed from the run artefacts, including the 44-shared-turn gates, per-role bars and safety faults.

The coordinator reviews the result; nobody retypes numbers.
- **Saves:** 20–40 m per round, and errors.

#### P9 — Smaller, more frequent releases (Policy and process)

- Release a slice as soon as it is green and bound.
- Freeze scope once the packet draft starts. New findings go to the next release unless they block safety.
- AI v2 carried 12 migrations, +120 closure files and a 1,716-file union; Phase 1 alone was ready and green at 17:34Z on 3 November.
- Prefer fixed staging windows (for example every 3 hours, announced in the queue status) so sessions plan around each other instead of polling.
- **Speculative integration:** while a predecessor batch installs, merge its exact source into your candidate and run the union and rehearsal, so the next release is ready when the lease frees. Discard the work if the predecessor fails.
- **Saves:** most of the 3 h wait on 4 November, and the 9 h hold that let the scope grow.
- **Risk:** wasted CI if the predecessor changes. This is acceptable, because no evidence transfers.

### E. Phased plan

#### Phase 0 — now (no release-control change)

| Step | Owner | Done when |
| --- | --- | --- |
| P2 selector wrapper plus the extended always-run list in builder briefs | Coordinator | Builders dispatch from the wrapper; no hand-picked unions |
| P1 preflight script | Coordinator | Run once on the next candidate before its packet |
| P3d parallel recovery dispatch; diagnose on first failed job | Release operator | Next recovery uses parallel CI refs |
| P5 renumber script; tests read the journal | Coordinator plus migration owners | PR #218 and the permissions series renumber with the script |
| P7 flake register plus time-pinning guard; fix the Firefox keyboard poll | Test owners | Guard green on main; register has the 4 known entries |
| P8 packet and scorecard generator | Coordinator | Next packet generated, then reviewed |
| P9 scope freeze and smaller releases | Owner and coordinators | Agreed in the ADR |

Expected after Phase 0: 1–2 full gates per release instead of 4–5, and roughly 2–2.5 h per release.

#### Phase 1 — reviewed controller changes

P3a, P3b, P3c, P2 fan-out, P5 watermark check, P6 parallelism and the narrowed closure from P4.

**Validation witness, per [CI policy § Change control](../CI-STAGING-VERIFICATION-POLICY.md#change-control), for each controller revision:**
1. Freeze an owned controller branch descended from main's trusted controller. Only the named recovery, policy and workflow files and their tests may differ.
2. Add refusal fixtures for every new path:
   - a second recovery attempt;
   - a recovery run on a foreign or rerun attempt;
   - a changed source, runtime or classifier;
   - a dropped assertion;
   - a browser unit inside the impact set;
   - a rehearsal run offered to `verify`;
   - a binding delta that touches a non-approval file.
3. Run `alpha-staging.yml` with `controller_only=true, diagnostics_only=true` on the identical frozen controller and candidate. All existing integrity controls plus the new refusal tests must pass.
4. Exercise each new route read-only (`verify-browser-recovery` or `verify-repair`) on a real retained failure. It must return `DIAGNOSTIC_NONINSTALLABLE`, `pendingReview:true`, `installationEligible:false`. Candidates: 41773236616 for P3a, 41769768119 with aa260e8d0 for P3b.
5. Independent review of the frozen controller and its hosted results, recorded with the reviewer identity.
6. A fresh complete first-attempt whole validation witness under the new policy versions (`aihr-staging-ci/v18`, `aihr-browser-recovery/v3`, `aihr-cross-source-recovery/v3`). No earlier pass is relabelled.
7. Adopt the controller into main and alpha through normal history-preserving integration, as for PR 204 and ff17d9fc.

Expected after Phase 1: 1 full gate plus at most one bounded recovery; about 60–90 m from ready code to installed.

#### Phase 2 — owner policy decisions

P4 Option B, the P5 allocation lease in the queue, and P9 staging windows and speculative integration. Each needs an ADR addendum and, where it touches the queue, the queue's own commissioning and validation record.

---

## Part 3 — Draft ADR for owner approval (as submitted; the accepted text is ADR-0175)

> **ADR-0175 — First-time-right releases with bounded recovery and single binding**
>
> - Date: 2026-11-04
> - Status: **Proposed**, awaiting the owner's approval.
> - Relates to: ADR-0114, ADR-0169 §5.1, [CI recovery policy](../CI-STAGING-VERIFICATION-POLICY.md), [staging queue](../STAGING-RELEASE-QUEUE.md).
>
> **Context.** Two measured staging releases (2 and 4 November 2026) ran 9 full gates with 0 first-time passes. 13 of 16 gate failures were detectable before a full gate or recoverable without one. The full gate itself takes about 20 minutes. Releases took 4–5 hours because of repeated gate–fix–rebind loops and queueing behind other releases with the same loops. The owner's 30 October rule (rerun only failed areas) lacks tool support for browser failures and small repairs.
>
> **Decision.**
> 1. *Selection.* Builders and integrators choose focused tests with the repository's deterministic impact selector. Its always-run guard set is mandatory in every focused selection. Hand-picked unions are not used as release preparation.
> 2. *Preflight.* Before a binding packet is drafted, the candidate passes a read-only preflight: AI manifest generator and scope byte-equality with the next controller, migration `when`/`idx` above main and the recorded staging watermark, the always-run guards and the time-pinning guard.
> 3. *Single binding.* Scope freezes when the packet draft starts. The packet is generated from code, with an approval delta and a provider-payload snapshot diff. The owner approves the exact digest, as today. A reviewed rehearsal mode may run the full gate before approval; rehearsal results can never authorize installation.
> 4. *Bounded recovery.* After a complete frozen gate, recovery reruns only failed or invalidated units, through reviewed, versioned routes:
>    - one single-shot rerun of a failed browser engine unit outside the candidate's impact set;
>    - cross-source recovery for small repairs, test-only deltas and binding-only deltas.
>
>    A second failure closes recovery. Original failures are always retained; no run is relabelled; `gh run rerun` is never used; no unit is retried until green.
> 5. *Flakes.* Unreliable tests are registered with evidence, an owner and a due date. They are never skipped or made non-blocking. Registration only permits the single-shot recovery in 4. An overdue entry blocks releases touching its area.
> 6. *Migrations.* Unapplied migrations are numbered at landing by a script. Allocation moves to a queue-held reservation with an owner and expiry. Applied SQL and journal prefixes remain immutable.
> 7. *Cadence.* Prefer small releases of green slices and announced staging windows. Speculative integration on a queued predecessor is allowed; its evidence never transfers.
>
> **Unchanged.** Tenant and company isolation tests and RLS; the owner's direct approval of every AI data-flow digest (unless the owner separately adopts the two-digest option); exact-source, exact-controller, first-attempt evidence; the complete full gate before staging; the shared queue and lease; human staging acceptance; separate production authority.
>
> **Validation.** Each controller change follows CI policy change control: a frozen controller, refusal fixtures, a controller-only diagnostic, a read-only diagnostic exercise on real retained failures, independent review, then a fresh whole witness under a new policy version.
>
> **Measure.** For each release, record the time from ready candidate to installed, the number of full gates, first-time pass (yes/no), recoveries used, approval rounds and queue wait. Target: one full gate, at most one recovery, and under 90 minutes from ready candidate to installed. Owner goal (unchanged): under 10 minutes for automated verification plus deployment.

## Addendum — Phase 0 measurements (4 November 2026, after acceptance)

- **Preflight replay.** On the 4 November binding commit 4ba3b25a8 against 3b3f94ccd, `preflight.mjs` reports `generator/scope: DIFFERS`. That is the refusal CI raised at plan and build in 41768537723. On 3ceeb26ef it reports identical generators and a 186-file approval delta (6 locale catalogue, 7 schema, 18 disclosure/entity, 7 spec/harness/tools, 1 transport, 14 AI code, 106 HR core, 4 pack, 23 other). With the watermark set to 1793330001500 it flags all twelve 2000-block migrations as skippable, which is the ordering rule agreed with PR #218. Each run takes about 9 seconds.
- **Selector on the release diff.** `select-focused.ts --base 3b3f94ccd` on the AI v2 release diff returns `tier=full`: 111 full-verification reasons, 2,974 files, 47 chunks. The selection includes `r394-route-loading`, `ai-management-contract`, `company-referrers`, `payroll-pack-drift` and `module-catalog-drift`. Integration diffs of this size need the whole suite. The fast path therefore dispatches every chunk before the packet, at about the cost of the 40 hand-picked union runs that were made instead.
