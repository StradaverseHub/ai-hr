# Visibility optimization and current data-permission proposal

Disposition: **reject the old patch as-is; the policy-preserving SQL prototype passes
scoped native compatibility review. Implementation remains with the security owner.**
No foreign source was edited and no overlapping migration was allocated. System
Optimization remains outside release admission; both original500-user targets fail.

## Actual owner and reviewed identity

Owner branch: `codex/approved-board-security-20261102`.
Actual checkout: `/private/tmp/aihr-approved-security-20261102`.
The proposal advanced during review from0f635883/66a1d0e2 to the published,clean
`300fc52f1556361de8b976092a9088f6b90b3c15` snapshot used for the native probe.
A subsequent read observed cleanbc7e06b2062b1606d48144328e00ba574b228d4f;
`git diff300fc..bc7e -- db/migrations/0936_data_permission_profiles.sql
 db/migrations/0938_data_permission_enforcement.sql` is empty. Evidence is still
identified as300fc; it is not relabelled onto a later application commit.
Latest read-only observation isd407d190b98db6a46c68ef65072a0e129b8a6e98,with foreign
WIP in core/payroll.ts and0941_financial_letter_actions.sql,preserved untouched.
The complete visible_employment_ids declaration/body remains byte-identical to300fc
(5937-byte section SHA256b857cee6f5d1bf1a1df479dca8f1767b8e2ed4dbb1c3b6efb7317788a1f53206).
Adjacent0938 read/profile helpers have changed their isolation checks,so the complete
file and owner contract are no longer identical. This requires current-source owner
integration and qualification;300fc native evidence is not transferred wholesale.

Subsequent read-only observation6cc977ef1fe81d01c110305075e0fcfb5248aad7 has the same
reviewed5937-byte visibility section. Foreign WIP is0941_financial_letter_actions.sql
and deploy/access/financial-letter-capability-bindings.ts; it is untouched. The parent
coordination snapshot142 still reports Roles/Actions/Data Permissions unfinished.
This is ownership coordination and source freshness, not a frozen handoff or transfer
of300fc test evidence to the later complete contract.

Relevant source:

- `db/migrations/0936_data_permission_profiles.sql`: typed subject projection,
  rules,live principal/profile/assignment evaluation and versioned administration.
- `db/migrations/0938_data_permission_enforcement.sql`: both visibility functions,
  restrictive read policies,prospective write validation and transaction-birth rules.
- 0938 file SHA256 at300fc:
  `a4e9361ff9863c81ce66ac1aacd97589c5a3f86a2ac8226040586ba196b24047`.
- Visible-function body SHA256:
  `28d07820f74c1f96028da856e12c851e301cf3a44e64907984338899af7973fb`.

The earlier performance predecessora7e62cb8 is a different function contract and
cannot guard or replace this new body.

## Semantics that must remain complete

|Boundary|Required behavior from this exact proposal|
|---|---|
|Final visibility filter|Apply `data_permission_matches(id) OR` the exact own-employment exception to the complete legacy visibility set,including manager and HOD results. Restricting only the admin arm would widen the proposal.|
|Own exception|Retain its explicit employment/user tenant join,current tenant and actual user binding. Do not substitute a broader Personnel grant,claimed Person or an abbreviated self test.|
|Data-match evaluation|Retain live principal/account eligibility,valid nonvoid target/Person,assignment/profile/revision checks and the complete typed-rule owner. No assignment preserves legacy matching only through that owner; disabled,retired or missing active revisions do not grant non-own rows.|
|Rule language|Preserve AND across typed predicates,OR within their values,unknown-field failure,company hierarchy direction,effective assignment/date and all17 fields. The compatibility probe samples gender and unknown gender; it does not certify every field transition.|
|Freshness|A newly assigned,disabled,retired or revised profile must affect a later statement on the same physical transaction. Cache plans,not profile or permission results.|
|Function boundary|Retain SQL language,STABLE,SECURITY DEFINER,`pg_catalog,public,pg_temp` search path and current owner/ACL contract. The old prototype's PL/pgSQL/public declaration is not adopted.|
|Adjacent native owners|Leave restrictive policies,transaction-birth returning exceptions,scope fingerprints,prospective writes and role/recovery guards intact. They are not optional shortcuts and are not fully qualified by this read-only probe.|

The header's reference to independent team behavior must not be interpreted as
permission to remove the actual final manager/HOD filter. Any intended policy
change belongs to its owner; this optimization preserves the supplied code.

## Concrete native evidence

Owned test-only branch `codex/performance-security-compatibility-probe-20261102`
starts at the already-public300fc proposal; its only added file is
`test/performance-security-visibility-compat.test.ts`. It does not integrate foreign
source into the performance candidate.

Exact probe935b58547feb2c2fb5a7c6fe4250c19a3e397c2e /
[41429150346](https://github.com/StradaverseHub/ai-hr/actions/runs/41429150346)
PASS:563 comparisons,500 actual principals and24 existing hierarchy/HOD contexts.
A private SQL prototype keeps the owner's exact final predicate in BOTH branches,
and uses the entire current owner query as fallback. The public function definition
and complete pg_proc attributes remain unchanged; both private helpers are dropped.

The probe demonstrates a real incompatibility: a manager's female-only profile
excludes a male report under the current function,while the old unscoped fallback
includes that report. It also compares exact ordered results after assignment,
disabling,retiring,removing the active revision,changing revisions and removing the
assignment,including a HOD case,unknown gender and malformed grant/error outcomes.
This is stronger than transferring the earlier563 checks from the pre-profile model.

Same-run100-read bursts on the ordinary reader:

|Pair|Current security owner|Policy-preserving prototype|
|---|---|---|
|First|4119.33ms|330.26ms|
|Second|4113.66ms|332.79ms|

These are component measurements,not whole-system speed or500-user acceptance.
They do not qualify fallback timing under the new security model or its full write
and creation-returning contract. Earlier pre-profile fallback timings cannot fill
that gap. Artifacts: `/private/tmp/aihr-security-compat-935b-attempt1`.

## Review-only patch and exact implementation dependency

Prepared,not applied:
`/private/tmp/aihr-security-visibility-compatible-300fc.proposed.patch`.
Patch SHA256:
`56f8f238949f302537993cdb50462f89799fb55b53f90dc9ac5c0c4d25d3fdff`.
Proposed body SHA256:
`2a256b585decea345fa9bd9c01ede0d99087af78adbfb8295716785973e914a4`.
Derivation receipt:
`/private/tmp/aihr-security-visibility-compatible-300fc.proposal-identity.json`.

The patch is deterministically reproduced from the tested SQL template and its
native-guarded owner body. It changes only that body: declaration and all other
statements in0938 remain exact. It is not a new migration or an applied public
function. The owner must incorporate it into its final proposal,or hand back an
exact frozen implementation seam,before this task changes overlapping SQL.
If the referenced file/body/dependencies change,reconcile them rather than forcing
the patch. No approval for a different source or new literal binding is inferred.

After owner integration: inspect the actual public catalog attributes and ordered
results,qualify the owner's full profile/void/identity/revision/company/date cases,
creation/UPSERT returning and closed native write paths,then affected populated
upgrade/compiler checks. Reconcile all reservations and actual applied history.
Only a frozen integrated source with justified component evidence proceeds to the
original unchanged500-user1s/5s HTTP/browser pair. Noveri remains next; no queue or
deployment action follows this review.
