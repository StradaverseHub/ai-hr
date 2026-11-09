# Explicit registry relation alias

Run42392912609 against frozen87a4c577b passed12 native controls and failed10
stage2 cases with actual PL/pgSQL `column reference c.implemented is ambiguous`.
The function's local composite variable `c` collided with the metadata query's
relation alias in `finish_event`. Retain that failure; the172 canonical regression
passes remain.

Use an explicit distinct relation alias in this metadata aggregate. Conditions,
event/tenant predicates, target variables, privilege/admission checks and all
projection/settlement effects are unchanged. Existing positive real-LOGIN projection
and fault/refusal cases execute the function and must reach their intended state
checks, rather than an incidental ambiguity error. No global PL/pgSQL conflict
preference is changed.

Dependent unnumbered stage3 predecessor body binding must be repinned explicitly
after inspecting these exact bytes. The same combined native selector must pass;
this source is not a numbered or installed migration.
