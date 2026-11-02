# Commissioning a bounded model evaluation

This guide is for the evaluation maintainer and the private configuration operator. The current
focused controller has native-ledger spending verification wired. Its CLI still refuses paid
evaluation until approved private admission and isolated fixture provisioning are commissioned.
A working provider key, passing no-network tests or this document does not commission that runner.
Use [repository policy](REPOSITORY-AND-ENVIRONMENTS.md) for hosted checks and release authority.

## Find the owner

| Responsibility | Source owner |
| --- | --- |
| Requested model, frozen corpus and full outcome assessment | [evaluation contract](../.github/ci/eval/contract.mjs), [corpus contract](reviews/ai-eval-corpus-contract-20261103.md) |
| Admission before candidate execution and independent final verification | `admitFocusedEvaluation` / `runFocused` in [focused controller](../.github/ci/focused-checks.mjs) |
| Per-process lifetime allocation, with no refunds | [attempt budget](../.github/ci/eval/attempt-budget.mjs), [native adapter](../test/helpers/ai-eval-native-budget.ts) |
| Exact case-to-native-run correlation | [native witness](../test/helpers/ai-eval-native-witness.ts), composed through the original lifecycle and proof owners |
| Independent financial comparison and SQL readback | [native verifier](../.github/ci/eval/native-budget-verifier.mjs), [controller reader](../.github/ci/eval/native-ledger-reader.mjs) |
| Actual policy, private reviewed capability and one-use dispatch | [spend capability](../core/ai-spend-capability.ts), [native governance](../core/ai-governance.ts) |
| Complete request bound and exact transport enforcement | [fixed metered carrier](../lib/ai/providers/openrouter-fixed-metered-carrier.ts) |
| Authentic terminal billing and native settlement | [receipt owner](../lib/ai/spend-receipt.ts), effective functions in [spend migration](../db/migrations/0651_ai_spend_controls.sql) and its ordered successors |
| Fictional case execution and observations | [session](../test/helpers/ai-eval-session.ts), [HR snapshot](../test/helpers/ai-eval-hr-snapshot.ts), [grading](../test/helpers/ai-eval-grade.ts) |

These owners establish different facts. Keep the private catalogue, native policy and real proof
resolver authoritative; do not add a second price or permission owner to the evaluator.

## Private prerequisites

The approved run must identify its exact provider/model, endpoint, controller/source/plan, allocation
and controlled non-production configuration. Its protected delivery must not expose secrets to
setup steps, the classifier, logs or artifacts. Never paste credentials into a report or chat.

The existing provider key may be reused if its account and route meet the independently reviewed
contract. Key metadata and a unit-price list alone do not establish a complete request-dollar bound.
A weekly key limit above the approved allocation is not a per-evaluation cap. An additional dedicated
capped key can be a backstop, but does not replace native controls or prove the other invariants.

The private inputs are:

- A real, current independently reviewed capability and metered catalogue record for the exact
  configuration, fictional tenant, operation and endpoint. The native catalogue requires complete
  billing dimensions, bounded all-input/all-output semantics and controlled account/endpoint changes.
  Read the schema and resolver rather than copying a test record's fictional evidence hashes.
- `AI_SPEND_RECEIPT_KEY_ID` and `AI_SPEND_RECEIPT_SIGNING_KEY`, matching an active private native verifier.
  This establishes receipt authenticity; it does not certify pricing or safe provider controls.
- An explicitly authorized, isolated hosted-fixture provisioning and attestation mechanism. The
  carrier resets its disposable database and creates a fresh tenant, so earlier catalogue rows cannot
  be assumed to survive or match that tenant. Provision and verify after reset/seed, before inference.

[Staging receipt preparation](../deploy/AI-SPEND-RECEIPT-PREPARATION.md) describes a staging-only operator.
It must not be pointed at a hosted test database under a false staging label. No general hosted-eval
catalogue provisioning CLI is supplied by the current implementation. Test fixture installers are
explicitly fictional and cannot supply live financial review.

## Commission in order

1. Freeze the source, controller, runtime and one reviewed profile. The checked-in plans contain
   540 ceiling outcomes or 238 reviewer outcomes; see the corpus contract for repeats and scoring
   limits. The approved total allocation applies across attempts, not separately to each profile.
2. Establish budget fit before billing. Native metered reservation is the full reviewed bound
   `(C * P + M * Q) * 1000` nano-USD, where C/M bound every chargeable input/output token and P/Q are
   the enforced USD-per-million caps. The lifetime guard retains that full amount after dispatch.
   Check the profile's maximum dispatch population, including tool rounds, against the allocation.
   Estimated successful-token cost is not enough. An infeasible full profile requires an explicit
   owner decision before any spending; do not silently truncate cases or reduce repeats.
3. Commission trusted controller admission using current private authority; keep the wired default
   native-ledger verifier. Admission
   runs before candidate/classifier/database setup: verify a genuine provisioning commitment there,
   then attest the actual fresh fixture configuration before its first POST. Missing, stale,
   mismatched or unreviewed inputs must refuse without inference.
4. Keep evidence independent of candidate totals. The session now records exact native run/capability
   identities after the original proof owner validates dispatch; repeated prompt digests stay distinct.
   The controller independently reads every run/reservation in the admitted tenant across both focused
   worker databases, including held, failed or unreserved rows. It checks full retained bounds and exact
   attempt population. Case labels/POST counts remain consistency checks, not independent network proof.
   The trusted admission producer must nominate the fixture scope before candidate execution; never
   select it from a receipt. Native receipt reconciliation remains authoritative for charge authenticity.
   Do not sign candidate totals and call that independent verification.

   Only after trusted admission, the controller enables narrowly validated worker-ledger retention.
   Fresh and reused setup paths keep those disposable workers until the controller captures their
   ledger, including after a failed test process. Ordinary teardown is unchanged. The controller's
   existing finally cleanup removes its owned container/volumes; retained databases are not installed
   customer data. The reader uses the pinned owned container's SQL client, not candidate dependencies.
5. Run affected no-network and native positive/refusal tests on standard hosted Actions. Include
   missing/expired catalogue, wrong tenant/configuration, signer mismatch, duplicate dispatch,
   concurrency, billed failure/unknown settlement, fixture-reset invalidation and forged/replayed
   evidence. Retain original failures and rerun only failed or invalidated checks.
6. Only after those checks and actual private setup are verified, dispatch one admitted paid run.
   Preserve all attempted and unrun outcomes, actual POSTs, held reservations, errors and native
   billing evidence. Do not retry a failed trial until it becomes a successful sample. A runner retry
   or another profile needs explicit shared allocation accounting; it cannot recreate the full cap.
7. Assess execution, security, budget, factual quality and human review separately. No skipped tail
   qualifies as complete. Factual and pending locale review remain independent prerequisites;
   successful transport or mode/substring matches do not establish factual correctness.

## Stop and recovery

Missing authority, uncertain charges, unsafe observations or exhausted allocation stop further
inference. Retain holds and the original receipts; never convert unknown cost to zero. Investigate
through the native owners before any recovery. Protect private signer and database material outside
public source/artifacts. Configuring this evaluator grants no provider activation, staging mutation,
protected-branch integration or deployment authority.
