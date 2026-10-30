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

## Completed source workflow and verification recovery
Cancellation is now registered at Approve tier with a dedicated unit/company review adapter on the existing encrypted ledger. `/assistant/rewards/cancel` provides bounded native choices, explicit human authorship, canonical before/after review and reason, separate consent, confirm, discard, own index and exact-event recovery. It is also offered independently on the Rewards Assistant task card through a fresh native cancellation witness, preserving the separate posting gate. The native fallback `/rewards` supports GR users without admin authority.

The native command appends an exact updated-row hash. SQL completion requires the same actor, tenant, unit, reviewed revision and top-level transaction for the withdrawn unit and cancellation event; historical current state alone cannot establish completion. The source digest is private and distinct from the public envelope commitment. Null actor PERSON is supported for a real USER; SYSTEM confirmation is refused. No employee or subject-person binding is fabricated; cancellation review includes no employee facts, monetary values or participant identities. The encrypted reason is linked to the real actor for existing erasure behavior. Internal legacy `rewards_posted_*` columns store this kind's event/revision only; cancellation-specific APIs and event proof never label it posting.

Provisional0731 adds only the allocated action kind, strict closed column rules and narrowly scoped SQL owners. Its bounded new-kind invariant uses a metadata/receipt whitelist and requires every other action-family column NULL. Every predecessor CHECK remains exactly once in ELSE. Coordinator-authorized shared one-file compiler fix, one-line provisional0724 category repair, portable guard fix and bounded provisional0726 repair are adopted separately; no parent feature bundles were imported.

Original e11d run41019699759:75 selected native/posting tests PASS, compiler FAIL inherited archiveTS2339. Original54da run41021657619:17 non-DB cases PASS; DB setup failed with OOMKilled:true while applying the doubled CHECK; compiler failed inherited archiveTS2339 and missing cancellation parity declaration. Original logs/artifacts retained privately on their exact SHAs. Recovery adds the declaration, an independent eleven-role Rewards group, stronger ciphertext/relink/hybrid/savepoint proofs and hosted twelve-screen six-locale capture. Full compiler and actual failed/affected areas are required on the final composed SHA. No local tests/compiler/build/DB execution and no release, installation or acceptance claim.
