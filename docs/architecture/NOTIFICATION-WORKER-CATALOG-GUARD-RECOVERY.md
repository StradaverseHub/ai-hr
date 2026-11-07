# Native catalogue type guard recovery

Frozen `a42ed60e4f4de8258894b0350198d7b7cac4f148` reached actual native LOGIN
admission in hosted run 42390898436. Four controls passed; six cases failed because
the privilege inventory evaluated `has_sequence_privilege` on a TOAST relation.
Retain the failed source, log and artifact. A WHERE conjunction does not establish
evaluation order for a function requiring a particular catalogue object kind.

Guard that function inside CASE: only actual non-system sequence relations invoke
it. Every privilege and non-system sequence remains checked; the allowed native
API set, LOGIN/backend/transaction binding, grants and failure states are unchanged.
An added real-LOGIN control proves native TOAST rows exist, a real sequence USAGE
grant refuses with 42501, and removing that grant permits opening and failing a
native run. It does not accept a different incidental error as authorization proof.

This remains an unnumbered disposable CI prototype, with the same sole native
selector and budgets. Native qualification and any dependent stage2 function-body
binding must use the repaired bytes; no installed schema or production operation
is performed.
