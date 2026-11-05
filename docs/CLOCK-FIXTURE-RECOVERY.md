# Finite fictional-clock recovery

This is the separately versioned `aihr-clock-fixture-recovery/v1` operator route.
Generic cross-source v2 continues to reject test changes. The ordinary v17 gate,
application producer workflows, unit inventory, runtime and PostgreSQL resource
contract do not change.

## Supported correction

The only application-candidate difference admitted by this route is one exact
insertion in `test/harness-ratchet/ratchet.test.ts`:

```ts
,clock:()=>new Date('2026-11-02T04:00:00Z')
```

It follows the unique existing `tools:provider` argument in the scripted fictional
runner. The intended fixture week is 2–8 November 2026. On 5 November, the legitimate
trusted system calendar matched a fictional absence date in the global `neverSent`
check. A fixed fixture clock corrects that collision. Production time remains real.
Every request-message privacy assertion, case, tool fixture and expected response
remains unchanged; no system-message exemption or skipped assertion is permitted.

The original fixture SHA256 is
`e642f5ba07683de7ce883fac37d934c03243a94b9e390f242c7c2e4a0913243e`.
The repaired fixture SHA256 is
`e766a0dd870749bfad7a9a6d9dd5538feb4439c9eb454e7ee87d78b199ebd25f`.
The verifier reads immutable Git blobs, checks ancestry and clean exact checkouts,
requires the complete one-file delta and unique insertion, and binds source/tree
identities and blob hashes. Different dates, additional changes, renamed files or
weakened assertions refuse.

## Preserved qualification

Let every planned original full-gate chunk finish first. Preserve its failure and
all reports on their original source/controller identities. Existing authenticated
v2 accounting then requires the entire failed original database unit in a fresh
owned database, identical assertion names and complete inventory, a fresh whole
compiler and a fresh canonical source-bound build. Only unaffected successful
units retain their original provenance. API inventories, artifact bytes, complete
latest execution history, runtime/resource evidence and prelaunch revalidation
remain mandatory. A focused pass or a build-only run alone never authorizes release.

The clock certificate has the distinct kind `AUTHENTICATED_CLOCK_FIXTURE_RECOVERY`
and embeds the actual v2 accounting plus strict source/controller proofs. It is
not relabelled as an ordinary v2 repair. Explicit grant admission checks the new
certificate and delegates the unchanged underlying accounting checks.

## Reviewed verifier plane

The verifier is a separate frozen checkout descended from trusted controller
`74db3bb7621c33de256372162a1961ee320baf6e`. Its complete changed-file inventory is
limited to the three integration owners, the new policy and refusal tests, this
document and the single integrity-test-list insertion in `alpha-staging.yml`.
Application code, migrations, runners, dependencies, classifiers and resource
policies cannot change in the verifier delta. Immutable blob hashes bind all
permitted bytes; the independent review pins the complete exact verifier commit.

Run the existing workflow on the exact verifier branch with `controller_only=true`,
`diagnostics_only=true`, `build_only=false`, and both `candidate_ref` and
`expected_sha` resolving to that verifier. The successful hosted integrity step must
include the new refusal tests. All application jobs are skipped. The verifier may
use its reviewed `codex/` branch; fresh application tests/builds still use the
original published producer controller. The separate verifier is not merged into
the clock-only application candidate, which would invalidate its finite delta.

The operator uses the existing target and lease controls:

```sh
AIHR_RECOVERY_CONTROLLER_RUN_ID=HOSTED_VERIFIER_DIAGNOSTIC \
AIHR_CLOCK_FIXTURE_REVIEWED_CONTROLLER=EXACT_INDEPENDENTLY_REVIEWED_VERIFIER_SHA \
node --import tsx .github/ci/operator-release.mjs verify-clock-fixture \
  /ABSOLUTE/REPAIRED/CANDIDATE ORIGINAL_FAILED_FULL_RUN \
  '{"originalPath":"/ABSOLUTE/ORIGINAL/CANDIDATE","focusedRunIds":[ACTUAL_RUN],"buildRunId":ACTUAL_BUILD_RUN,"candidateBranch":"EXACT_REPAIRED_BRANCH"}'
```

Without the exact reviewed verifier identity, verification remains visibly
noninstallable. `deploy-clock-fixture` additionally requires staging deployment
authority and the matching private queue lease. Source repairs receive new immutable
queue tickets; never claim the old candidate's prepared batch for new source.
Ordinary source/build/migration arrival, authenticated read-only installed journeys,
board milestones and branch handback follow the repository release procedures.
This route grants no employee decisions, mapping publication, re-tag execution,
production deployment, human acceptance or private package publication.
