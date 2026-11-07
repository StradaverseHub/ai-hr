# Native Next CI review recovery

Prepared child of da0e3a4039f882250c7b0980e5d8b4da55ea4517. No hosted checks
or installation have run for this recovery. Production remains held.

Independent source reviews found five material integration gaps before upload:

1. The owner had stripped GitHub credentials only before Vitest; the earlier
   candidate classifier and migration subprocesses still inherited them. The
   candidate environment owner now removes CI/platform/provider credential names
   before classifier, both migration paths and test children. The API provisioning
   process retains its authentication. Canonical preparation additionally closes
   all four database URLs. Real subprocess controls use fictional credentials and
   require their absence without logging their values.
2. Packet integrity did not independently regenerate canonical source preparation.
   A fixed, bounded subprocess now loads the exact clean candidate preparation in
   the sanitized environment, writes only a private bounded record, and the owner
   calls the existing canonical source-input binder for lock/package/preparation
   bytes before issuing a build prerequisite. Candidate code never imports into
   the token-bearing API owner. A tiny typed Git fixture exercises actual child
   execution, source drift refusal and redacted credential refusal; it is not an
   application build or runtime proof.
3. Operator verification compared the build against a local plan whose controller
   defaults to `local`. Verification and revalidation now use the independently
   authenticated controller/baseline binding over the source-derived inventory.
   The regression covers the local operator case without hosted controller env.
4. The new native consumer refused supported same-repository PRs. Its separate
   nonrelease scope now authenticates PR number, alpha base, both repository IDs,
   actual head/ref, actual merge controller, run/job/artifact head identity and the
   exact `refs/pull/N/merge` provenance. Original release scope still refuses PRs.
   API observation of run42397692582/PR230 confirms API run/job head SHA is the PR
   source head, while the pull endpoint provides a different merge SHA. That run
   was skipped and supplied no actual executed controller/fixture proof; it is
   evidence for metadata shape only. Foreign head/base/merge/PR/ref and artifact
   cases refuse. Moving source/merge identities require a new frozen invocation.
5. Existing bounded-suite capacity scope rejected the newly introduced job name
   before setup. It now includes the exact native-test job under the same trusted
   source/controller/event/first-attempt guards; wrong jobs and every prior hostile
   scope case remain refused. No capacity floor or resource limit is lowered.

The private packet/binding still stays outside uploaded evidence. The native-only
packet kind, legacy release branch restriction, exact same compiled-artifact
comparison, physical DB/host conjunction and full source inventory remain intact.
A future actual native wrapper must accept the optional PR controllerRef inside
its closed expected-binding schema; heads retain their existing expected fields.

After frozen root/independent review, run hosted controller regressions and the
affected disposable-role test. Then integrate the separately reviewed real Next
fixture and exercise the actual joined capability. No source test, synthetic
metadata case, declaration of a future selector, or commissioning subset establishes
browser/load/installation/release acceptance. Cross-source native recovery remains
explicitly refused until a fresh authenticated replacement route is implemented.
