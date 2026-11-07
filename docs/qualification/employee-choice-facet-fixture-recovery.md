# Native sparse-facet fixture recovery

Source recovery from frozen `7b6e8f3334e775d50b3d526e450b897fc74f3fa3`.
No local application/DB/runtime/compiler/build check ran. Production remains held.

Both planned runs completed before this repair. Focused run42390540243 retained
133 DB passes,2 DB failures,7 no-DB passes and a Linux build pass. Its two failures
are real `23514` fixture refusals from `check_assignment_label_criteria`, not a
permission or migration fault. The guard validates every non-superseded Assignment,
including closed history, against its recorded company. Do not weaken this guard.

The sparse fixture had two invalid company/label constructions:

- Gamma's Assignment records the base company, but its new ended-only BU belonged
  to the other company. The BU now belongs to the base company.
- The closed historical Assignment of the NULL-organization employee records the
  empty company, but referenced empty catalogue index0, which belongs to the base
  company. It now references index2, whose department and BU belong to the empty
  company. Its historical dates, closed status and employment identity remain.

The legitimate transfer case is unchanged: current Employment belongs to the other
company while the open Assignment and its department/BU retain the original recorded
company. NULL/open/future/closed/superseded, ended employee, hidden Person,
Assignment-denied partners,160 unrepresented departments,64 unrepresented BUs,
three companies, exact expected IDs/labels and seven represented tuples remain.
No production query, historical baseline, schema, constraint, RLS, permissions,
expected assertion or deadline changed.

Controlled run42390546115 completed native/plan assertions, but the new facet query
was slower (~1.3–1.4s versus its controlled ~1.2–1.35s baseline) and did not meet the
whole-port sub-second target. This fixture recovery does not claim a query benefit
or qualify adoption. Preserve the original results and investigate actual plans.

Rerun only `test/employee-choice-facet-setwise.test.ts` using the adjacent sole-file
manifest. Its actual native constraints and independent full parity/plan/authority
assertions remain intact. Retain other valid hosted evidence; a source fixture fix
is not an executed result or staging-release witness.
