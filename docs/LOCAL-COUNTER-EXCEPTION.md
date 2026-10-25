# Bounded counter-failure evidence review

The human directly authorized failed-only repair/retesting for AI dev 2's current release in turn `01a17427-5b92-7513-8d5e-6c2a175bb83a`. Completed authentic passing checks must be retained, failures repaired and retested, and all unexecuted required checks still executed. This does not turn incomplete work into a pass.

The current frozen full run on `3c51317ea43ded103e782c37b55eccf9fdeae05c` has a demonstrated gate-counter defect: anchored grep cannot match the ANSI-coloured Vitest summary. Its `check_counted` function overwrites the original process exit with one; that original exit was not separately recorded and stays UNKNOWN. The original canonical receipt must remain FAIL. No claim that a raw Vitest process returned zero follows from its passing case reports alone.

`scripts/local-counter-exception.mjs` independently reviews complete reports: exactly one passing file/case summary and terminal footer, exact unique file membership, positive per-file cases summing to the summary, no failed/skipped/todo cases or unhandled-error sections. It strips display CSI sequences for review while hashing the original bytes. Its separate controller review requires the exact complete no-DB plus modulo-16 DB layout and only the known counter failures, preserving original failed counts/exits.

`scripts/local-counter-exception-evidence.mjs` first refuses an active, interrupted or unrestored run. After terminal cleanup, it binds the clean company-repository candidate, exact frozen wrapper, original failed receipt, pinned recovery code, restored contents/configuration/identities, independent source classifier, all 1,944 files, all raw reports and source/artifact hashes. It reads no application data, executes no tests or database commands, and makes no network calls. Use the frozen candidate's tsx loader for the classifier import.

Both return **releaseAuthorized: false**. They never write a gate receipt. The collector is an evidence foundation, not an installed exception release policy. Fresh counter regressions and their source/command/exit evidence, separate compiler/build/browser/walkthrough claims, a reviewed staging-only operator, current baseline/branch checks and verified arrival remain required before an exceptional release can be accepted. A genuine test failure, different candidate or different counter symptom refuses this bounded policy and needs review against actual new evidence; no generic cross-commit reuse is enabled.

Nine small built-in Node test groups exercise report/controller refusal boundaries using private text fixtures. The report reviewer also accepted the actual completed no-DB raw log: 963 files and 12,620 cases, exact membership, raw SHA-256 `3bbd19cb0bd5f3124f12507668b167292d3b725778d9bef8f0916b2cd9ed08ea`, original process exit UNKNOWN. This is not full-run evidence; all 16 database batches were still running at preparation. No active candidate, wrapper, receipt or background process was changed.

## Prepared acceptance and staging operator

The separate acceptance module requires a clean final candidate that is the **single normal child** of observed `3c51317e`, with exactly two changed files whose bytes match reviewed counter commit `29ee93b3`: `scripts/gate-chunked.sh` and `scripts/gate-counted-output.test.mjs`. No arbitrary source repair or generic reuse is accepted. It validates the exact 21-check counter regression command/exit/hash proof; original runtime/configuration hash and failed learning/receipt; complete retained test reports; separate whole TypeScript on `3c`; and the original build/walkthroughs on `fdc` plus all three browser engines on `a3`. Source comparison proves that retained product/build/browser inputs are unchanged apart from the named attendance test. Controller copies collected after those executions are labelled as such, not contemporaneous source hashes or new runs.

The acceptance binds the original local walkthrough adapter and its unchanged browser/assertion region, all 64 queue screenshots, five fixed receipt-state screenshots and five correction screenshots. It records original raw Vitest process exits as UNKNOWN and the canonical result as FAIL. Its new outcome is `ACCEPTED_WITH_OWNER_EXCEPTION`, distinct from a full PASS receipt. The operator never changes the original gate receipt.

The prepared operator uses actual candidate release builders and a fresh System Testing identity. It verifies the current staging baseline, company repository and aligned main/alpha refs; freezes source/evidence again before announcement, source transfer and launch. Control SSH and the derived official rsync command both use the same private configuration and `aihr-staging` alias. Official source arguments and exclusions remain intact, including `/scratchpad/`. A five-minute rsync timeout propagates as a transfer failure and prevents build launch; it does not turn a partial transfer into success. Private SSH configuration must remain outside the uploaded candidate. No Actions, branch mutation, main/live deployment, service restart or board completion is performed.

A successful remote build is mirrored as immutable private exception evidence outside the source tree. Identical mirror retries are accepted; conflicting bytes refuse. A mirror failure saves the exact envelope for retry without rebuilding. Release learning retains the exceptional outcome and cannot create a new full PASS baseline. Active service restart, health, migration/source/build arrival, branch integration and actual resource handback remain the release owner's separate work.

The operator and acceptance are **prepared, not executed or release-verified**. Their policy still needs independent source review and actual terminal evidence. Small tests cover 21 distinct report, file-reader, provenance, browser/walkthrough and mocked operator/transport boundaries across the recorded runs. One private fixture initially used macOS's `/var` alias and was correctly refused by the canonical-path guard; only that failed fixture was repaired/retested, with the other 13 passing groups retained. No application tests, databases, network calls or real deployment were executed by these regressions.

Invoke only after the existing full run is terminal and restored, the reviewed two-file counter repair is committed on the allowed final candidate, and independent review has completed:

```text
node --import <candidate>/node_modules/tsx/dist/loader.mjs \
  <controller>/scripts/local-counter-exception-operator.mjs \
  verify <candidate> <terminal-final-02-directory> <counter-29ee-worktree> <private-ssh-config>
```

The release owner selects `deploy` only after a valid verify result and existing release coordination. This documentation is not deployment proof or a new authorization beyond the direct owner exception.
