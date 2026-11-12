# Pure custody replay: causal terminal reasons and atomic row commit

Exact4d90 source-only successor correcting the COMPLETE two-P2 batch confirmed
by root and independent Next review. Original4d90 stays frozen/unrun; its two
defects were established by source reasoning, not a relabelled hosted failure.
No filesystem/native/API/controller/workflow/classifier/kernel/policy/admission
implementation or local behavior is added. Staging and production remain held.

## Actual kernel reason semantics

Qualified cb1 emits group-stop-before-reap BEFORE cleanup. Its later code
preserves that stop reason, may replace it with group-uncertain if settlement
fails, changes complete to session-escaped only when actual settled escaped
descendants were observed, and finally may refuse protocol after event failure.
It never improves command-failed/deadline/etc to complete.

The pure replay now enforces that exact admitted stop/result relation:

- With quiescent/reaped present: terminal retains the stop reason, except
  complete+escaped must become session-escaped; protocol-refused may reflect
  actual event failure. An escaped already-failed command keeps command-failed.
- Without quiescent/reaped: terminal must be group-uncertain or protocol-refused.
- Stop cannot already be group-uncertain/session-escaped: cb1 creates those
  cleanup reasons only AFTER that packet. The fixed K.REASONS vocabulary and
  all actual packet types remain unchanged.

Existing command-exit/admitted/reaped/escaped and source-shaped guards still
apply. These are FORMAT constraints over source-specific native packet shapes,
not proof that an event append/ACK/native result really occurred. In particular,
actual event failure AFTER stage-ended write can still alter the separately
returned native result; the future independent native receiver must compare
that actual return/custody, never obtain permission from a packet alone.

## Atomic accepted-prefix image

stageCandidate returns an UNCOMMITTED image. Actor-parent, stage/packet order,
monitor identity, loss and causal terminal checks all complete BEFORE changing
actors/stages/packet arrays/monitor IDs/loss/owner fields. Explicit commit
frontiers then publish only the accepted row. Existing owner-close and root-pin
branches likewise mutate only after all their guards. There is no callback,
I/O or caller-selected commit broker.

A rejected row can no longer leave a phantom stageResults entry or entered
actor/monitor state behind. Only the VALID complete prefix contributes derived
rows/closure/loss/kernel/stage results. Raw bytes, LF count, bytehash, framing
and failure issue still describe the ENTIRE original input, including invalid
rows and later bytes. No raw failure bytes are discarded to get a prefix match.

## Controls and whole-source custody

All62 existing intentions (including the38 original protocol intentions) remain;
add FOUR controls,66 total: a failed stop within otherwise full passing final
archive refuses; actual cb1 preserve/degrade/escaped matrix; malformed owner
row preserves exact accepted-prefix image; invalid FIRST kernel packet likewise
preserves that image. The invalid-owner model also retains a later raw close
row without accepting it. These are prepared synthetic format controls, not
executed native RED/GREEN or process receipts.

The original whole233 inverse/control remains byte-identical as an artifact.
Its existing intention now FIRST restores complete current files to actual4d90
using the new immutable whole4d90 preimages/descending zero-based inverse edits,
then performs ALL original4d90-to233 whole-file equality/hash assertions. No
old hash is recaptured, no older source model is rewritten to accept current.
The documentary current map rehashes exactly the two affected files, retains
all other36-parent-map members, and preserves complete3631 suite identities.

All46 classifier controls, runtime/classifier/plan/kernel and source admission
remain exact4d90.35/30 basenames, crypto-only module dependency,128rows,1024
inclusive-LF row bytes,131072 ledger bytes,122/123 bounded CLI fixture rows,
all existing6s closes and all native-unimplemented authority boundaries remain.
The no-start launch-fence gap remains explicit: root-only matching rows are
FORMAT, not evidence that the native launch seam was never entered.

Root+independent FULL review precedes upload or hosted66 controls. No repository
module, compiler/test/model, native process, provider, DB or API was executed
locally. Only source/Git/byte inspection, external syntax AST and static inverse
reconstruction occurred. Actual semantic/CLI witnesses and architecture/browser/
worker qualification remain OPEN; this correction grants no native authority.
