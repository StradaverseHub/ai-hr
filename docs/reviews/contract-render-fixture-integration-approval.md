# Approval needed: isolated Contract render-test integration

The user requires approval before merging or releasing. Automatic approval review applies that hold even to a local merge between the two owned implementation branches. Two attempts were rejected before execution; no changes were transferred through an alternative method.

The concrete action is a normal merge of prepared peer `17a545c014e58b366b84243ca3fdcec945047a71` into the isolated `codex/contract-screens-20261117` review candidate. This is not a merge to main, alpha or staging and installs nothing. Those protected branch and release approval holds remain in place.

Read-only comparison at candidate `47fe6350b9c20237d345d2fd4c26ca8f7f294d5a` confirmed that `app`, `core`, `lib`, `components`, `messages` and `packs` are byte-identical to the peer. The effective new source is only `test/contract-shared-render-review.dom.test.tsx`: actual route context, supported testing-library selectors, and a single owning step in the fictional preview. The identical nullable waiting-owner API fix is already present on both branches. The normal merge preserves the candidate's newer 5919 migration; it does not replace the candidate with the older peer snapshot.

These fixture corrections are needed for the final whole-repository test compiler and accurate selected navigation in the screenshot packet. They do not change business permissions, signing behavior, emails, workflows, pay, employment facts or production UI.

The [unapplied review diff](contract-render-fixture-integration.patch) is a review artifact only; it has not been applied to the test. The peer's complete capture/type check **passed** in hosted run **43974925512**: all eleven captures and whole-repository typecheck (job **133676574203**). Existing production build and functional checks have separate receipts; do not label the current candidate's test compiler complete until this integration is approved and its evidence is retained correctly.

Automatic approval review's final stated reason was: “Despite the narrower isolated-branch scope, this is still the same repository merge the user required waiting to approve; the justification cannot override that explicit hold.” No further integration attempt is authorized by this document.

Requested approval: **integrate this one prepared test-fixture branch into the isolated review candidate only**, while continuing to wait for separate approval before any main/staging merge or release.
