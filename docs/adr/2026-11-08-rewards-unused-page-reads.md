# Rewards configuration loads only the setup data it renders

Source candidate, not executed or accepted. Exact parent: `ff4dc941998914d6496007f7bce40b0d8d997702`.

The configuration route no longer renders its legacy review-creation form: it links to
independently approved Rewards plans. It nevertheless awaited policy memberships and
shared-policy contents, and requested business-unit and cycle catalogues whose results
were unused by the returned page. Shared-policy contents use native review-creation
authority with an exclusive Access advisory lock and `FOR SHARE`; this route had no
rendered need for that consumption call.

Remove only those two unused awaits and their imports, plus the unused creation-form
import. Request `rewardSetupChoices(...,{fields:[]})`, retaining its exact authorized
company projection, scope/whole-group branch, route guards, call order and error behavior.
The existing `rewardConfigurationListView` is still invoked with the returned company
IDs and original URL filters, including when the company list is empty. Its native
observation WRITE and subsequent presentation snapshot remain unchanged. Rendering,
policy-origin badges, dates, options, actions, errors and approved-plan link are whole.

The existing shared-policy service, native consumption/revalidation, policy privacy,
FORCE RLS, legacy creation form, all other Rewards pages and every command remain whole.
This does not adopt the separate uninstalled Libraries/PAT durable-audit prototype or
change suspension-observation semantics. The synchronous native observation can still
wait on actual audit contention; this change makes no whole-page wait-free or speed claim.

Retain all 15 expanded cases and their original assertions in the existing DOM selector.
Two additive page cases configure rejecting unused-service mocks and verify nonempty
provenance/filter/approved-plan rendering and empty-company behavior, exact company IDs,
company-only fields and continued facade invocation. These are DOM/mock-boundary controls,
not native audit proofs. The affected hosted proposal is solely the same DOM selector,
now 17 expanded cases, after root and independent FULL source review. Existing native
results retain their own source identities; the separate nine-case native fixture repair
is outside this change. No repository code, tests, compiler, build or database ran locally.
