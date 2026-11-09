# Native Next verification needs one joined capability

Status: prepared infrastructure source, unqualified and uninstalled. Base
93ac8f1386188c0ecfe765151d60f483566b876f. Production is held. This change is
not staging authorization or proof that the actual Next fixture has passed.

The former host-only singleton proves systemd/Nginx transport with a fictional
backend. A database-only singleton proves an independently owned PostgreSQL
cluster. Neither supplies the conjunction needed by a real authenticated Next
application, and three independently built cohorts are not the same artifact.

CI policy v20 registers a separate `linux-next-postgres-v1` profile for the whole
`test/runtime-next-admission-native.test.ts` file. It remains a DB-classified,
one-worker, complete singleton, with `job-host-and-postgres-cluster` isolation.
That selector/its native owner are supplied by the separately reviewed runtime
component; registering the future path does not manufacture its implementation.
All existing profile descriptions and resources retain their meanings.

The complete source plan includes every file. Scheduling separates ordinary
`test` jobs from `native-test` jobs. Ordinary tests still depend only on resolve
and plan. The native job additionally depends on the run's one canonical build.
A commissioning selection containing this profile schedules that build, retains
the complete omitted-unit inventory and remains incomplete development evidence.
No focused flags, narrowed source plan, caller-selected artifact origin or
replacement backend can supply admission.

The native job provisions its own physical PostgreSQL profile, actual distro
Nginx/systemd and nonroot Chromium. The unit owner separately authenticates the
current GitHub run, complete bounded job/artifact inventories, sole terminal
successful build job and its exact archive ID/digest/time. It downloads those
bounded bytes through the existing transport, uses the protected extractor and
validates all five packet members against independently obtained expectations.
The consuming run can still be in progress; this is deliberately not a release
run witness.

The original release packet inspector stays restricted to main/alpha. A separate
native-verification entrypoint reuses exactly the same byte/runtime/source checks
and can accept an owned codex controller branch. Its distinct result kind cannot
stand in for a release packet. Main/alpha release verification is unchanged in
that respect. Release and same-source recovery independently compare each native
unit's actual build binding against the canonical authenticated packet and
artifact, including build ID and archive/manifest/provenance hashes.

Private archives, packet members and the 0600 build binding live outside the
uploaded `aihr-ci` evidence directory. Only metadata joins the public unit report.
The two newly issued child inputs are `AIHR_NATIVE_NEXT_PACKET_DIR` and
`AIHR_NATIVE_NEXT_BUILD_BINDING`. Inherited inputs with that prefix refuse before
provisioning; a supplied path never authenticates itself. The trusted provisioning
step receives GitHub credentials and strips them before the test/application
child. Web units must independently use only their closed fictional app-role
configuration, never the owner/test/migration or GitHub credentials.

A hybrid binding contains all three prerequisites: actual host, actual cluster
and same-run canonical build. Omitting any one, switching job/profile, changing
source/controller/run/attempt, or substituting compiled bytes refuses. Bootstrap
role prerequisites also derive their job permission from the actual complete
unit/profile; a job-name string alone cannot open that route.

An empty native matrix can appear as a skipped `native-test` job only when the
complete source plan has no hybrid unit. A present native unit remains a required
successful job, with a complete report and zero skipped assertions. The full
verifier waits for it. Commissioning still produces no complete-suite receipt.

Cross-source repair currently has no authenticated replacement route for this
new native unit. It explicitly refuses to retain old compiled-runtime proof after
a source/build change. That recovery extension must be implemented and qualified
before relying on it; an unchanged suite list does not make an old binary proof
valid for a newly compiled binary. No blanket full-gate rerun or proof relabeling
is substituted for that missing recovery capability.

Required development checks: hosted controller/packet/manifest/admission/recovery
regressions and the affected disposable-role tests; then integration with the
real runtime component and its source hashes, actual hybrid commissioning,
complete native fault/permission/action/cache journeys, whole compiler/build,
browser preflight and the resource-bounded worker comparison. Passing controller
tests alone supplies none of those runtime claims.
