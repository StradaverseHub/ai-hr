# Delivery v2 advisory prototype

This is the first executable design experiment for the [replacement architecture](../../docs/adr/2026-11-17-continuous-assurance-delivery.md). It models evidence needs by potential effects instead of requiring every check for every change.

It does not select or run application tests, verify approval/reviewer identities, consume release evidence, contact reporters, create jobs, activate features or install anything. Every result has `releaseAuthorized:false`, `exposureAuthorized:false` and `evidenceVerified:false`. Supplied fields are proposals, including `scope.status: bounded`.

## Try the synthetic example

```sh
node scripts/delivery/assurance-plan.mjs < scripts/delivery/example-contract.json
```

The intentionally incomplete payroll-preview contract reports missing reporter approval, independent scope review, observation signals and recovery design. Its all-ones/all-twos SHAs identify synthetic input, not real source. A populated contract produces `ready-for-evidence-design`, never a release-ready claim.

The input has exact fields; malformed contracts, unknown effects and added authority flags refuse. Effects combine: privacy plus financial behavior requires both sets of evidence. Irreversible-action controls cannot disappear because code is described as reversible. Unknown impact requires discovery rather than permission to ship.

## Hosted validation

`.github/workflows/delivery-v2-shadow.yml` runs dependency-free Node controls on a standard hosted Ubuntu runner, with read-only repository permissions and no application credentials. The push trigger is restricted to owned `codex/delivery-system-revamp-*` branches and prototype/workflow paths. Manual dispatch also requires an exact expected SHA. It uploads only a synthetic advisory example, which is not a release receipt.

The controls cover refusal of forged authority/malformed inputs, stale reporter approval, self-review, irreversible effects and exhaustive obligation monotonicity across the nine-effect inventory. They validate the prototype's behavior, not classification completeness, actual business correctness or production safety.

Next qualification requires historical defect replay, independent effect/closure verification and a complete isolated issue-to-outcome pilot. Active release machinery remains authoritative until a replacement is qualified and adopted per the architecture.
