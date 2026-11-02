# AI source manifest admission correction — 2 November 2026

This is a separate controller correction based on accepted source
50ea247177a9fe1373d3e79d9c742f0fc399ebb7. It does not modify generated application
manifests, source scopes, provider approval records, database records, or release evidence.

## Finding and correction

The module manifest was generated before the final provider approval sourceDigest update.
The provider manifest was current, but the module manifest (which includes the provider
approval file) was stale. Existing application tests did not run canonical freshness checks.
Their original results and coverage remain recorded; they do not establish manifest freshness.

Both canonical `--check` commands now precede full CI planning and canonical build creation,
including build-only execution. Independent operator source binding checks both again for
normal, focused-recovery and repair-recovery admission/revalidation. A failure never regenerates
a manifest, edits an approval, rebinds evidence, or changes governance records. Trusted controller
and candidate generator/scope bytes must agree; changing that contract requires controller review.
Clean exact candidate identity is checked before and after both commands.

The adversarial fixture uses the actual canonical generators: generate provider then module,
update only provider approval bindings afterward, demonstrate that provider freshness still passes
while module freshness refuses, then regenerate the module and demonstrate both pass. It also
covers provider-only drift, simultaneous stale manifests, dirty/foreign candidates and replacement
generators. Source-binding regression exercises the real independent operator entry point.

## Generation order and governance

Complete covered source edits first. Generate the provider transform manifest, obtain and record
any required exact provider approval bindings, then generate the module manifest LAST. Run BOTH
checks against the final frozen candidate. Any subsequent covered edit repeats this sequence;
a generator is not a substitute for required human provider approval.

Correcting a module digest changes the governance identity. Existing source-bound candidates,
evaluations, promotions, consents and governed jobs must remain subject to their ordinary source
checks. No compatibility exemption, SQL retagging, receipt resealing or implied consent is allowed.

The isolated baseline correction d8e29ff7100917a5bc322b124128c3ac77277572 remains a diagnostic
review packet, not a required intermediate deployment. MOBILE's forward candidate
8b676f25c006dd9a95dfd30bb6005e558923980a has its own consistent module digest
cd6fb6f0e62360812369a1c26e4237530d07eedbc320009b5dd214a6aa9fbb4d. Do not replace that digest
with the baseline's computed digest. Forward adoption requires its own exact source/provider review
and authenticated qualification; it does not retrospectively repair baseline identity or old evidence.

This controller branch's inherited module manifest remains stale deliberately: the controller-only
hosted diagnostic is not an application qualification, full gate PASS, deployment or retirement approval.
Original gate/source/controller/baseline identities remain unchanged. No protected branch, installation
or governance record is changed by this patch.
