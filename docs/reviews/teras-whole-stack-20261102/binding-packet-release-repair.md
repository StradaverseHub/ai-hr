# Binding packet: Noveri release repair on top of main 41ec7fd8

> **For review, then a fresh owner approval in the Noveri session.** Nothing approval-bearing has been written for this closure.
> - The current binding on main 41ec7fd8 (provider `ac138e6c…`, module-agent `c140847e…`, approved 2026-11-02T12:07:19Z) does **not** transfer: five provider-closure sources changed.
> - If the candidate head changes before the binding, every candidate value below is recomputed and this packet is reissued.

## Why
The full release qualification on main 41ec7fd8 (alpha-staging run 41459296654: plan, typecheck, migrations, controller tests,
the bounded 8192 build and all three browsers passed) failed five test chunks. The release operator directed repairs on
`claude/noveri-release-repair`, cut from main 41ec7fd8, in separate commits, with no allowlist growth and no weakened assertion.
Runs 41457586769 (guard refusal), 41459170159 (cancelled) and 41459296654 stay on record as they are.

## Candidate
- **Branch:** `claude/noveri-release-repair`. **Candidate code head:** `f2ccf38ac278fbb3cc542f716c9942eefbd63f06` (commits below); packet commits on top are docs only.
- **Repairs:**
  1. `test/payroll-pack-drift.test.ts`: `core/setup-copilot/copilot.ts` imported `core/payroll-readiness` directly; it now takes the
     `ReadinessCheckKey` type from `packs/payroll/service` (bb15756ed). Run 41465522939 then showed a second importer,
     `core/product-context/setup-readiness.ts`, now also through `packs/payroll/service` (f2ccf38ac). Every file changed since
     6ea889365 was then checked against both ratchets' implementation lists (30 payroll, 25 leave modules): no direct importer remains.
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
| Scope | Current binding (main 41ec7fd8, both `--check` pass) | Candidate before binding (f2ccf38ac; the test-only commits are outside both scopes) |
|---|---|---|
| Provider-data closure | `ac138e6c84a4f7b5929959e95ae3592fbe25c90e95c2291c4125804aa27fd330`, 1255 files | `e8692840739a125c8f5f04c4be9a43cc6022bd2f81533a747a76f414d5716913`, 1255 files (93268aea6 computed `6d3f3ab7…` before the second payroll fix; superseded) |
| Module-agent scope | `c140847e07c0b0aaca0028ace69c09985182ebd466742acac77deb4213eff9a3`, 457 files | unchanged source; its `--check` passes on f2ccf38ac. It changes only when the approval literals and provider manifest are written, and is generated last. |

- Changed provider-closure sources: `core/company-refs.ts` (93268aea6), `core/proposals/leave-cancel.ts` (3432c661d),
  `core/read.ts` (3432c661d), `core/setup-copilot/copilot.ts` (bb15756ed), `core/product-context/setup-readiness.ts` (f2ccf38ac). Closure file set unchanged (0 added, 0 removed).
- `provider-data-review-gate` is red on this head until the binding, as it must be.

## Focused CI (recorded as run; filled in as runs complete)
- **41465481045** on 93268aea6: 64 files (the Teras and review set plus `proposal-leave-cancel-roundtrip` and
  `r301-cancel-approved-leave`), typecheck PASS, build PASS at the admitted 8192 heap (`hosted-linux-16g-8192`); 63 of 64 files
  pass; the one failure is `provider-data-review-gate`, red by design until the binding.
- **41465522939** on 93268aea6: 19 files; 18 pass. `payroll-pack-drift` still failed on `core/product-context/setup-readiness.ts`,
  a second direct importer the first fix missed. Fixed in f2ccf38ac. The rewards test passed here, but it was still the old
  regex, so this run says nothing about the 26f0e7812 fix.
- **41468605659** on b203e9474 (docs-only over code f2ccf38ac): 64 files, typecheck PASS, build PASS at the admitted 8192 heap
  (`hosted-linux-16g-8192`); 63 of 64 files pass; the one failure is `provider-data-review-gate`, red by design until the binding.
- **41468651139** on b203e9474: 19 files, SUCCESS 19 of 19, including `payroll-pack-drift`, `leave-pack-drift`,
  `ai-management-contract`, `company-referrers` and `rewards-cancel-custody` with its value-bounded amount check.
- After the binding: both `--check` commands, then focused CI including `provider-data-review-gate`, then the release
  operator's full qualification.

## Exact binding (proposed; written only after a fresh owner approval)
In this order, on the candidate head:
1. **`lib/ai/provider-data-source-manifest.ts`**, generated: `ac138e6c…` → `e8692840739a125c8f5f04c4be9a43cc6022bd2f81533a747a76f414d5716913`.
2. **`lib/ai/provider-data-approvals.ts`** (current sha256 `47a69b6f94b152a15a4bb579495b550c8cdee26d6c18671bba4defb0df7bf470`):
   all 25 occurrences of `"sourceDigest": "ac138e6c…"` become `e8692840…`; the 24 historical records keep status, reviewer, evidence
   and reviewedAt byte-for-byte; both pending records stay byte-identical; `teras_harness_turn_v1` keeps
   `"reviewer": "human:zenlam repository-owner provisional"`, and its `evidence` and `reviewedAt` are set at write time to the anchor
   and the actual UTC time of the fresh approval, never to 10:15:26Z or 12:07:19Z.
3. **`docs/reviews/ai-provider-owner-approval-2026-10.md`** (current sha256 `e7517fe7136c0ec3edffcd5fbd57aaa9ca86e2dbb6f061278790d13340873c27`):
   append `## Noveri release repair binding`, stating the closure move (`ac138e6c…` → `e8692840…`, 1255 files), the five changed
   sources and why, the route and actual time of the fresh approval, and that it covers this closure only.
4. **`lib/ai/module-agent-source-manifest.ts`**, generated LAST.
5. Both `--check` commands, then focused CI including `provider-data-review-gate`; then the release operator's full qualification.
