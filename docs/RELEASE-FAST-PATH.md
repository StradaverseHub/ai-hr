# Release fast path (ADR-0175 Phase 0)

This checklist adopts [ADR-0175](adr/0175-first-time-right-releases.md) Phase 0 for builders, integrators and release operators. It adds earlier checks only. Every existing control still applies:
- the full gate on main;
- CI admission;
- the owner's direct binding approval;
- the queue and lease;
- recovery policy;
- human acceptance;
- separate production authority.

None of the commands below produces release evidence.

## 1. While building: select tests, don't hand-pick them

```sh
node --import tsx scripts/release/select-focused.ts --base origin/main
```

- The selector prints the impact selection: changed tests, import consumers, source readers, mandatory guard and tenant tests, prior failures, and the release-proven guards. It also prints the exact commands to push one CI-only ref per chunk and dispatch `alpha-focused-checks`.
- `--dispatch <your-branch>` runs those commands. Add `--typecheck` (and `--build` when interface or build files changed) for the first chunk.
- **`tier=full` means the selector requires the whole suite.** This is expected for an integration or release diff: on 4 November the AI v2 release diff selected 2,974 files in 47 chunks, which is about what its 40 hand-picked union runs cost. Dispatch every chunk **before** the binding packet, so guard failures surface before the owner approves. The 4 November full gate found `r394-route-loading` and `ai-management-contract` failures only after binding.
- Browser tests (`*.browser.test.tsx`) are not dispatchable through focused checks. When the selector reports interface changes, they run in the full gate or through `alpha-staging-browser-checks`.

## 2. Before writing a binding packet: preflight

```sh
node scripts/release/preflight.mjs --base origin/main --staging-watermark <applied max when>
```

Take the watermark from the latest recorded staging ledger (the queue hand-back or `MIGRATION-ALLOCATION.md`). The preflight reports:
- **generator/scope:** whether the AI manifest generator and scope files are byte-identical to main. If not, CI admission refuses at plan and build, as on 2 November (41457586769) and 4 November (41768537723). Restore main's generator before asking for approval.
- **closures:** the provider and module-agent digests for HEAD and main, and the **approval delta**: every closure file added, changed or removed, with its kind. Put this list in the packet.
- **migrations:** whether main's journal is an exact prefix, and whether every new `when` and `idx` is above main and the watermark. If one isn't, renumber (step 4).

Exit status 1 means the gate or migrator would fail. Fix it before the packet.

## 3. Freeze scope at the packet

Once the packet draft starts, new findings go to the next release unless they block safety. If a fix changes the closure, a new packet and the owner's direct approval are needed, exactly as before. Re-run the preflight first.

## 4. Number migrations at landing

```sh
node scripts/release/migrations-renumber.mjs --base origin/main --staging-watermark <when>          # dry run
node scripts/release/migrations-renumber.mjs --base origin/main --staging-watermark <when> --write  # clean tree
```

- Only unapplied entries after main's exact prefix move. SQL bytes are unchanged; the files are only renamed.
- The script lists every file that names an old tag. Update those files and `MIGRATION-ALLOCATION.md`, then run the populated upgrade and the affected tests.
- Tests should read the journal rather than pin tail literals.

## 5. During the full gate

- Start diagnosis when the **first** job fails. Don't wait for the run to finish.
- Dispatch nothing until every planned job has finished.
- Keep every failed run as it is. Never use `gh run rerun`, and never retry until green.
- If the failure is eligible for `aihr-focused-recovery/v1` (failed no-DB units only, unchanged candidate), dispatch the focused recovery runs **in parallel** on distinct CI refs at the same SHA, instead of one after another.
- A known-unreliable test belongs in the [flaky test register](FLAKY-TESTS.md). Registration does not make it non-blocking.

## 6. Record the measure

For each release, record in the release record or log:
- the ready-candidate time and the installed time;
- the number of full gates, and whether the first one passed;
- the recoveries used;
- the approval rounds;
- the queue wait.

ADR-0175's target is one gate, at most one recovery, and under 90 minutes.
