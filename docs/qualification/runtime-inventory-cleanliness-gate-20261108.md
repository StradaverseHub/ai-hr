# Execute the affected helper regression in the packaging controller

Exact parent1405393e86bb096dc9d91e419f3a7e2a13ce3a54 passed hosted controller-only
run42400539594. Retained logs prove806 CI-integrity assertions,57 bundle cases,
12 extractor,9 activation,12 focused-recovery extractor and12 repair extractor
cases passed, along with the existing staging/lease/release checks. The actual
strict clean-source guard passed and reconstructed the complete3557-file plan.
These claims remain bound to that source/run, not this follow-up.

The helper-cleanliness test changed in35c080cf was not invoked by that workflow.
It is registered in alpha-staging-diagnostics under a much broader build-transport
probe, which would also perform a new application build and VM transfer. Do not
claim its two-reader private-Git behavior passed from the narrower controller run.

Add that existing single-case Python suite to the normal packaging controller
checks next to its bundle/extractor owners. It proves both readers keep their real
private controller Git repositories clean, with their existing caller settings.
No test body/assertion, source helper, trust policy, resource, application, database,
release/deployment condition or existing check changes. The command fails the
existing step on any failure; it is not a new bypass or diagnostic receipt.

After independent review, run the actual controller-only route on the frozen child
with diagnostics_only=true. This must execute the previously unverified helper
case and both reader subtests, then pass the existing clean-source/full-plan guard.
There is no application build, installation or release authorization. Staging is
still gated on the whole architecture; production remains held.
