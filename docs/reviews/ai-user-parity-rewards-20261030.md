# Rewards parity inventory and cancellation seam

Baseline: 3a2a015683c0a1ad8ec6f341186f7fa12a5fcdad. Development only; global release hold applies.

## Verified native owners
- `/rewards`: `packs/rewards/service.ts` owns entry recommendations/facts, unit lump choice, pay-window keep, source refresh, route decisions, off-cycle creation and posting. Engine calculations remain deterministic. No separate Rewards nomination or claim entity was found; Claims is a separate pack.
- `/admin/rewards`: review creation, configuration, member roles, policy, calendar and cancellation use the same facade.
- `/admin/rewards/shared`: shared policy versions and company exclusions belong to shared-governance/policy-group services. Existing governance/Board owners retain this scope.
- `/admin/rewards/access`: grants, confidentiality and access requests remain native access handoffs.
- Existing Assistant coverage: `rewards.post` has source review, encrypted review store, dedicated UI and historical event reconciliation. Posting changes salary/grade/draft payroll inputs; it does not process payroll or pay money.
- Other Rewards writes remain backlog in `lib/ai/agent-capability-inventory.ts`; no false registered classification is added.

## First slice: cancellation transaction seam
`cancelRewardReviewTx` extracts the existing native command for composition in one future custody transaction. The original native wrapper delegates to it. The service still checks live company Rewards administration OR the unit GR seat, revision, deleted state and posted/withdrawn/rejected refusal. It retains parent funding serialization, conditional decision insertion and the cancellation audit event. It now returns the exact event identity and resulting revision for future proof binding.

This is preparatory native code, not an enabled Assistant cancellation action. No provider, registry, policy, custody or UI architecture changed. Human review must show whole-unit cancellation, revision, written reason, retained decisions/entries and funding reservation effect. Confirmation must recheck native authority and source under custody locks. Recovery must match actor, tenant, unit, exact event and cancelled revision; current withdrawn state alone is insufficient.

## Coordinator dependency
Request one executable migration slot, private name `assistant_rewards_cancel_review`, for a scoped subject/proof read function and action-kind/custody grant registration. No SQL number or journal identity claimed. Registry actor semantics must admit native GR seat users, including unlinked USER and SYSTEM paths only where actual native authority allows them; do not impose a blanket HR floor. Existing post custody uses a Rewards administrator path and must not be copied as cancellation authority.

## Verification
No local tests, collection, compiler, build, DB or dev server. Hosted focused evidence pending; unchanged native cancellation behavior and exact event/rollback behavior require focused DB checks before integration. Not installed, accepted or released.
