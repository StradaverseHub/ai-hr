# Native contract serialization recovery

Both planned bcae checks finished. Canonical notification/reminder run42392036172
passed172 tests across17 files. Native run42392098914 passed all11 stage1 controls,
then failed during stage2 fixture contract installation; its11 projection cases
did not execute. Preserve those distinct results and the original source.

The fixture's owner client also belongs to Drizzle. The installed postgres-js
adapter replaces JSON/JSONB serializers114/3802 with identity serializers. Passing
`tx.json(contract)` therefore sent an array to the wire string encoder. This is
an owner-fixture encoding error, not evidence that any native projection passed.

Serialize the closed canonical contract to text explicitly and keep its existing
parameterized `::jsonb` cast. Before installation commits, independently read every
stored contract field from PostgreSQL and require exact sorted equality, including
NULL categories, boolean guards, audience and implemented flags. Worker connections
remain direct postgres clients with their own serializers; no serializer is changed
globally. Native API SQL, audience/privilege/batch fences, application renderer and
reminder behavior are unchanged.

Rerun only the actual combined native capability selector at unchanged budgets.
Retain the172 canonical regression passes. This remains an unnumbered disposable
prototype; no installed schema or release acceptance is claimed.
