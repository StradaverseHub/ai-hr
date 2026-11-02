# Binding packet: Noveri release repair on top of main 41ec7fd8

> **For review, then a fresh owner approval in the Noveri session.** Nothing approval-bearing has been written for this closure.
> - The current binding on main 41ec7fd8 (provider `ac138e6c…`, module-agent `c140847e…`, approved 2026-11-02T12:07:19Z) does **not** transfer: four provider-closure sources changed.
> - If the candidate head changes before the binding, every candidate value below is recomputed and this packet is reissued.

## Why
The full release qualification on main 41ec7fd8 (alpha-staging run 41459296654: plan, typecheck, migrations, controller tests,
the bounded 8192 build and all three browsers passed) failed five test chunks. The release operator directed repairs on
`claude/noveri-release-repair`, cut from main 41ec7fd8, in separate commits, with no allowlist growth and no weakened assertion.
Runs 41457586769 (guard refusal), 41459170159 (cancelled) and 41459296654 stay on record as they are.

## Candidate
- **Branch:** `claude/noveri-release-repair`. **Candidate code head:** `26f0e781` (commits below); packet commits on top are docs only.
- **Repairs:**
  1. `test/payroll-pack-drift.test.ts`: `core/setup-copilot/copilot.ts` imported `core/payroll-readiness` directly; it now takes the
     `ReadinessCheckKey` type from `packs/payroll/service` (bb15756ed).
  2. `test/leave-pack-drift.test.ts`: `core/proposals/leave-cancel.ts` imported `core/leave` directly. The facade `packs/leave/service`
     also carries the leave write paths, which `test/proposal-object.test.ts` forbids `core/proposals` to import, so the card now
     reads the leave type's give-back rule through a new read-only `readCancelApprovedSettingTx` in `core/read.ts`, the module that
     already applies the same `cancelApprovedSettingOf` for the /leave offers. Same rule, same transaction, fail closed (3432c661d).
  3. `test/ai-management-contract.test.ts`: `core/teras-wiring/model-client.ts` registered as a governed `hr_assistant` caller,
     issued by `core/teras-wiring/turn.ts` (`resolveActiveAiConfig(tx,ctx,'hr_assistant')`, `bindAiSpendTaskTx`, only
     `gatewayModelClient`), each call prepared under `teras_harness_turn_v1` before the shared `converse` gateway. A new optional
     `issuerSeams` replaces the `governedAiConfig` issuer default for that entry only (04a2cee01, test-only).
  4. `test/company-referrers.test.ts` §1: `teras_outcome_record.company_id` declared in `COMPANY_REFERRERS` as `other`. The outcome
     record is append-only audit, so a company with outcome rows refuses deletion; a private-to-asker row the caller cannot see makes
     the step-4 foreign key fire, which `deleteCompany` already reports as the same refusal. No schema change. No `existsFunction`:
     it would need a migration after 0929, and any timestamp above …329 would overtake the reserved 0930–0935 (…330–…335) (93268aea6).
  5. `test/rewards-cancel-custody.test.ts:70`: **not a privacy leak.** The only match was `5000` inside the random company id
     `d3285d0c-d242-40bd-89bc-b2a350002564`; the persisted payload held no name, salary or amount, and the code that builds it
     (`rewards-cancel-review-store.ts`, `rewards-cancel-contract.ts`, `module-action-server.ts`) is unchanged since 6ea889365. On the
     release operator's decision the amount now matches only standing alone, `(?<![\w-])5000(?![\w-])`: a JSON value still matches,
     digits inside a hex id or a UUID segment (`-5000-`, which a plain `\b5000\b` would still match) do not, with a pinned case
     for both sides. The name and `basicSalary` alternatives are unchanged (26f0e7812, test-only).
- **Not changed:** no read, permission, provider transport, payload, contract, migration or allowlist.

## Digests (computed write-disabled, in an isolated copy of the committed source)
| Scope | Current binding (main 41ec7fd8, both `--check` pass) | Candidate before binding (93268aea6; unchanged by the test-only commits) |
|---|---|---|
| Provider-data closure | `ac138e6c84a4f7b5929959e95ae3592fbe25c90e95c2291c4125804aa27fd330`, 1255 files | `6d3f3ab7fe02e2f7905b1a1c33b612a147cd649da0e90a73935db5a3f89e4452`, 1255 files |
| Module-agent scope | `c140847e07c0b0aaca0028ace69c09985182ebd466742acac77deb4213eff9a3`, 457 files | unchanged source; its `--check` passes on 93268aea6. It changes only when the approval literals and provider manifest are written, and is generated last. |

- Changed provider-closure sources: `core/company-refs.ts` (93268aea6), `core/proposals/leave-cancel.ts` (3432c661d),
  `core/read.ts` (3432c661d), `core/setup-copilot/copilot.ts` (bb15756ed). Closure file set unchanged (0 added, 0 removed).
- `provider-data-review-gate` is red on this head until the binding, as it must be.

## Focused CI (recorded as run; filled in as runs complete)
- **41465481045** on 93268aea6: 64 files (the Teras and review set plus `proposal-leave-cancel-roundtrip` and
  `r301-cancel-approved-leave`), typecheck, build at the admitted 8192 heap.
- **41465522939** on 93268aea6: 19 files (the five failing files, `r302-cancel-approved-fixes`, the 13-file PR 210 set).
- A rerun of the 19-file set on the head with the rewards test fix follows.

## Exact binding (proposed; written only after a fresh owner approval)
In this order, on the candidate head:
1. **`lib/ai/provider-data-source-manifest.ts`**, generated: `ac138e6c…` → `6d3f3ab7fe02e2f7905b1a1c33b612a147cd649da0e90a73935db5a3f89e4452`.
2. **`lib/ai/provider-data-approvals.ts`** (current sha256 `47a69b6f94b152a15a4bb579495b550c8cdee26d6c18671bba4defb0df7bf470`):
   all 25 occurrences of `"sourceDigest": "ac138e6c…"` become `6d3f3ab7…`; the 24 historical records keep status, reviewer, evidence
   and reviewedAt byte-for-byte; both pending records stay byte-identical; `teras_harness_turn_v1` keeps
   `"reviewer": "human:zenlam repository-owner provisional"`, and its `evidence` and `reviewedAt` are set at write time to the anchor
   and the actual UTC time of the fresh approval, never to 10:15:26Z or 12:07:19Z.
3. **`docs/reviews/ai-provider-owner-approval-2026-10.md`** (current sha256 `e7517fe7136c0ec3edffcd5fbd57aaa9ca86e2dbb6f061278790d13340873c27`):
   append `## Noveri release repair binding`, stating the closure move (`ac138e6c…` → `6d3f3ab7…`, 1255 files), the four changed
   sources and why, the route and actual time of the fresh approval, and that it covers this closure only.
4. **`lib/ai/module-agent-source-manifest.ts`**, generated LAST.
5. Both `--check` commands, then focused CI including `provider-data-review-gate`; then the release operator's full qualification.
