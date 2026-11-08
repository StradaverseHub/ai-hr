# Rewards observer: restore the app baseline between independent mutations

Source-only recovery of `c545210345deb9d96e7974bacdd687aba7f1f7aa`.
No application, migration, financial formula, native observer SQL body, permission
grant, existing negative SQLSTATE or native case is changed. Production is held.

## Actual failure and the missing precondition

Hosted run42463745871 completed all24 native cases:22 passed and2 failed.
Authenticated unit artifact13610937214 has ZIP SHA256
`59bc9c0807a0c8ab5d64487306cda9c95187e8c7af932326b032a9d2b6d9c40f`.
The Bank proof reaches the COST mutation and expects55000 but receives42501.
Catalogue reaches its shared test PRE proof and surfaces its existing sanitized
PositionArchiveUnavailable; its exact underlying refusal is not yet established.
Both actions have the same five actual root-bound ACL observations: owner before
revoke=true, owner after COMMIT=false, first app effective=true, app direct=false,
app effective after the direct query=false. These do not prove a cache mechanism.

The old restore verifies the complete OWNER metadata/ACL image. It never proves
that the SAME app root can execute the original observer again before the next
independent COST counterexample. Consequently an EXECUTE failure can confound
that second expected full-profile refusal. Owner equality is insufficient as
the app-side precondition. The actual error origin remains a native question.

## Finite correction

After each completed execute/COST controlled mutation and its existing owner
restoration, require a same-app positive baseline BEFORE admitting its successor:

1. Check owner image restoration and absence of an outstanding mutation intent.
2. Preserve the FIRST app effective EXECUTE sample without requiring its value.
3. Read the complete CURRENT public pg_proc row in that same app transaction,
   compare it to the owner's exact original row, and verify its unchanged native
   PID/start/root xid/login/database. No private table or column is granted.
4. Require the following actual effective EXECUTE sample to be true.
5. Execute the unchanged original SECURITY DEFINER observer for this actual
   review/action/root, parse its complete closed PRE shape, and require success.

Every native operation retains the existing abort admission checks. Any failure
prevents the next mutation, preserves ordinary outer rollback/cleanup, and is
not converted into success. Reading the current exact public function profile is
the explicit restoration proof, not a forced cache flush, unrelated warm-up,
role switch, transaction restart or inferred invalidation guarantee. The first
negative observer invocation inside each mutation is unchanged, including the
55000 COST oracle and original EXECUTE check. Native runs must establish whether
the repaired baseline actually completes and separates the counterexamples.

Telemetry has its own closed restoration kind: two mutation labels, four stage
labels, one boolean and the existing validated native-root shape. The raw
pg_proc row, observer result/PRE and unknown environment/error/SQL values are
never published. These observations grant no authority or release qualification.

## Verification and limits

Retain the original19 contract/control intentions byte-for-byte, except the
later SQL template census changes50→53 because three fixed, scalar-free SQL
queries are added. All47 scalar boundaries and their94 mutation checks remain.
The prior two token-boundary controls remain; append one closed-restoration
schema control, for22 total. Preserve all11 diagnostic,2 ordinary native-frame
and24 singleton native intentions and the exact observer SQL body.

The accompanying source record carries whole c545 parent bytes for all three
changed existing owners, current hashes, all unchanged prior bindings and the
complete1671-member critical source map. No source behavior runs locally.
Independent source review precedes publishing; then run the22 hosted controls,
retain unaffected source-specific evidence only as policy allows, and rerun the
whole24-case native file after every planned chunk has finished. A source-control
pass does not prove native restoration, speed, page journeys or release readiness.
