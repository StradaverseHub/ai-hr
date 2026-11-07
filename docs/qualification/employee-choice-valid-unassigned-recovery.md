# Valid unassigned fixture recovery

Run42391808278 against exact `c2f5c019e414e3876fc3268443de183dffb4d560`
passed two controls and failed two during native fixture setup with23502:
Assignment.department_id is required. Preserve this failure and the earlier
Criteria failures. No production query or model constraint is changed.

The empty-company employee now has only real closed and superseded Assignment
history, so its current read projection legitimately has NULL department/unit.
The impossible open Assignment with a NULL department is removed. An independent
native assertion retains the required department column and proves zero current
Assignments; the actual public reader must include this employee with NULL
organisation, company-only representation and unchanged total/facets. Existing
unassigned, historical transfer, ended, hidden Person and future cases remain.

Rerun only `test/employee-choice-facet-setwise.test.ts` at unchanged budgets.
The retained controlled speed report still misses its target and does not justify
adopting the facet query. No schema/migration, installation or deployment occurs.
