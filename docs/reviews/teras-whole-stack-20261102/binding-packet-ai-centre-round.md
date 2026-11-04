# Binding packet: AI Centre round (staging fixes, stored chats, pay averages, leave from chat)

> **For a fresh owner approval, given directly in the coordinator session `teras-noveri-handoff-54e696`.** Nothing
> approval-bearing has been written for this closure. A relayed approval is refused, and no earlier approval transfers.
> - The current binding on main `dfbcf85b1` (provider `e8692840…`, module-agent `935877b9…`, approved
>   2026-11-02T15:30:00Z) does **not** cover this candidate: 19 closure sources changed and 5 joined.
> - If the candidate code head changes before the binding is written, every value below is recomputed and this packet
>   is reissued.

## Candidate
- **Branch:** `claude/noveri-staging-fix`. **Candidate code head:** `eae7be76824afcf460019eada434fb9454e11c62`.
  Any commits on top before the binding are docs only.
- It fast-forwards from main `dfbcf85b1` (53 commits).
- **What it carries:**
  - the staging-acceptance fixes: issues 1–7, 9, 11, 12 (Inbox badge), 13, 15 and 18;
  - issue 8 with 18 item 1: stored chats, migration 0952;
  - 13b: pay averages;
  - 10 with 23: a leave application prepared from chat, with leave types named in six languages;
  - 19: the Azure content-filter fix;
  - 20–22: the role description, consistent "prepared" wording, and the admin pay-refusal destination;
  - the scored evaluation.
- Coordinator review notes are in `RESUME/TERAS-RELEASE-STATUS.md`.

## What changes for the provider (the model)
Every item is fictional-data only on staging. Production stays held until counsel advises (ADR-0169 §5.1).

| Change | Closure files | What the model now receives |
|---|---|---|
| Instruction text, spec v9 → v12 | `core/harness/spec.ts` | Text only. v9: short structured replies, ask rather than guess, "Yes, I can", pay refusals that link where the person can already see pay, and the reading of the leave "withheld" flag. v10: one numbered question when details are missing. v11: the role note and the "prepared … for you to review" rule. v12: the person's screened words carry the neutral label "Message from the signed-in person to the HR assistant:". Digests are recorded in `HARNESS_SPEC_DIGESTS`. |
| The caller's role note | `core/harness/runner.ts` | The caller's role kinds and company count (for example "HR administrator for 3 companies"), derived from their roles and grants. No names, no ids. The tool offer is unchanged. |
| Admin pay-view note | `core/harness/runner.ts`, `lib/product-context/destinations.ts`, `core/product-context/tools.ts` | For payroll-access callers on an other-person turn: a page path and title they can already open. No figure, no identifier. |
| Pay averages (13b) | `packs/payroll/pay-averages.ts`, `packs/payroll/service.ts`, `core/semantic-model/entities-metrics.ts`, `core/semantic-model/{types,generate}.ts`, `core/explainers/capabilities.ts` | New read `pay_aggregates`, offered only to callers with payroll access. Headcount, average and median of basic pay, each as `bands` (a placeholder plus its band; the exact value is restored only for the person). Company and department names are `minimum`. Withheld groups carry a reason only. Suppression rules: fewer than 5 people, a complement of 1–4, complementary suppression, identical values. Company ids are dropped before the model. ADR-0169 §8. |
| Leave application from chat (10, 23) | `core/proposals/leave-apply.ts`, `core/proposals/suggested.ts`, `core/proposals/leave-type-match.ts`, `core/assistant-actions/own-leave-apply-form.ts`, `core/harness/tools.ts`, `core/semantic-model/entities-recommend.ts` | The caller's own eligible leave-type names, as numbered options when one question is needed, and the tool's "ask" result. The model only proposes. The signed proposal and the leave service decide at Confirm. |
| Overclaim check | `core/harness/reply-checks.ts` | No new data. "prepared … for you to review or confirm" is allowed only when a proposal was issued this turn; all other claim words are still refused. |
| UI strings | `messages/{en,ms,zh,vi,ta,th}.json` | Card titles and labels. "AI Centre" naming. |
| Action classification | `lib/ai/agent-capability-inventory.ts` | No provider data. The new chat, stored-chat and leave-apply server actions are classified. Also in the module-agent scope. |

**Not provider-visible:** stored chats (issue 8). Words are encrypted at rest, FORCE RLS applies per login, and withheld turns store no words. Their files are outside the closure except for the inventory classification. ADR-0169 §9.

**No new contract record.** All of the above flows through the reviewed `teras_harness_turn_v1` contract. The owner's approval of this packet extends its reviewed data scope to the pay-average bands, the role note, the pay-view note and the leave-type options described above.

## Digests
Computed write-disabled, on an isolated `git archive` copy of the committed source.

| Scope | Current binding (main `dfbcf85b1`) | Candidate before the binding (`eae7be768`) |
|---|---|---|
| Provider-data closure | `e8692840739a125c8f5f04c4be9a43cc6022bd2f81533a747a76f414d5716913`, 1255 files | `e5db5f47017219e3f2aa27957d60a838253f817321e1ec58ef50ffaf73500a5b`, 1260 files (5 added, 0 removed, 19 changed) |
| Module-agent scope | `935877b90d4cbe43b4f8158c35daccef2f22abbde69f1fb689117b8bee39968e`, 457 files | Stale on the candidate (`lib/ai/agent-capability-inventory.ts` changed). Generated last, after the approval literals are written. |

- **Added to the closure:** `core/assistant-actions/own-leave-apply-form.ts`, `core/proposals/leave-apply.ts`,
  `core/proposals/leave-type-match.ts`, `core/semantic-model/entities-metrics.ts` and `packs/payroll/pay-averages.ts`.
- **Changed:** the files in the table above.
- `provider-data-review-gate` is red on this head until the binding, as it must be.

## Focused CI on the candidate
Filled in as the runs complete.
- `41536404022` (49 files, typecheck, build).
- `41536409491` (49 files).
- `41536414763` (47 files).
- Earlier evidence on the round is kept in the release log, including the failures.

## Exact binding (written only after a fresh owner approval)
In this order, on the candidate head:
1. **`lib/ai/provider-data-source-manifest.ts`**, generated: `e8692840…` → `e5db5f47017219e3f2aa27957d60a838253f817321e1ec58ef50ffaf73500a5b`.
2. **`lib/ai/provider-data-approvals.ts`**: all 25 occurrences of `"sourceDigest": "e8692840…"` become `e5db5f47…`.
   - The 24 historical records keep their status, reviewer, evidence and reviewedAt byte-for-byte.
   - Both pending records stay byte-identical.
   - `teras_harness_turn_v1` keeps `"reviewer": "human:zenlam repository-owner provisional"`. Its `evidence` becomes
     `docs/reviews/ai-provider-owner-approval-2026-10.md#ai-centre-round-binding`, and its `reviewedAt` is the actual UTC
     time of the fresh approval.
3. **`docs/reviews/ai-provider-owner-approval-2026-10.md`**: append `## AI Centre round binding`, stating:
   - the closure move (`e8692840…` → `e5db5f47…`, 1255 → 1260 files);
   - the changes above and the extended data scope;
   - the route and actual time of the fresh approval;
   - that it covers this closure only;
   - that counsel's advice is still required before any real data.
4. **`lib/ai/module-agent-source-manifest.ts`**, generated LAST.
5. Both `--check` commands. Then focused CI including `provider-data-review-gate`. Then the full release qualification
   on main (`docs/STAGING-RELEASE-QUEUE.md`, handoff §6).

## Release notes for the installation
- Migration `0952_teras_chats` (idx 763, when `1793330000352`, sha256
  `e320362770eedfafd2e9260d82713b1c669f056a296db979a1f5295e785b401b`). Re-check the live ledger and watermark before
  admission. The ticket is `risk: isolated`.
- The AI retention timer must be enabled on staging, so that expired chats are actively deleted
  (`deploy/systemd/AI-RETENTION.md`).
- `TERAS_PROPOSAL_SECRET` and `AI_CONFIG_SECRET` must be present. Without `AI_CONFIG_SECRET`, no chat is stored.
- After arrival, turn the conversation worker on for the three fictional staging tenants (handoff §6.6).
