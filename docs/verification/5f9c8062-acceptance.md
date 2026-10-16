# Employee Master reports acceptance

Approved source: board item 5f9c8062 (full brief and catalogue approved 2026-10-15). This is an implementation acceptance map, not a PASS receipt.

| Outcome | Owner / affected journey | Verification |
| --- | --- | --- |
| Every declared Personnel field automatically reaches the catalogue, with exact labels, capabilities and disabled-file reasons | Shared Personnel registry c44575e0 → import/forms/report consumers | Add one registry descriptor and exercise all consumers; reconcile 11 tabs and all conditional/register fields |
| Restricted fields cannot be discovered or used for filters/counts/sorts/groups/exports | Company-aware category permission owner → catalogue/spec/runner | No-compensation user, stale/forged spec, hidden salary history and direct export |
| Current and dated values preserve their actual coverage | Employment/assignment/compensation/status/draft/register owners → master projection | Historical transfer/salary correction, rehire, missing historical profile, renamed labels and unfinished draft |
| Register rows align without multiplying unrelated data | Report section engine consumes typed owner grains | Family + salary + documents All records; per-column Latest override; distinct employee/person counts and currency/unit-safe sums |
| Typed AND/OR conditions, quick filters, three sorts and groups use one contract | Spec validator/engine → builder/count/preview/export/schedules | Nested truth/unknown, bad operand/depth/field, live count loading/error and stable ties |
| Preview first 50; exports contain every authorised result | Same snapshot runner → XLSX/CSV/PDF | More than 50 rows, real dates/numbers, leading zero text, formula injection, headings/totals/sections and oversized refusal |
| Private saved reports remain private from other administrators | Saved-report command policies + service → frontpage/direct ID/AI/export/duplicate/schedule | User A private + manager-role shared; B and administrator colleague; cross-tenant/company and revoked role |
| Save/reopen and row actions match owner or visible-admin rights | Builder/save actions/hub | Save without manual refresh, immutable owner, duplicate private/no schedule, last successful run ordering, first five + search |
| Four actual starter reports open and duplicate | Canonical status/date owners → master starter specs | Headcount/new hires/Resigned owner semantics/contract expiry; historical limits visible |
| Optional delivery only to opted-in currently authorised users | Existing job + managed mail owners → recurrence/occurrence execution | Weekly/monthly, fresh review after changes, suspension/revocation/consent withdrawal, mail failure/uncertain retry/no duplicate send |
| Existing non-master reports and old templates remain valid or explain incompatible specs | Legacy custom report registry/service/export/AI | Existing report contract tests; no legacy MASTER salary bypass |
| Actual experience works | Builder/preview/save/frontpage/export/schedule UI | Representative roles/data; wide/narrow/light/dark; keyboard reorder/focus; runtime translation and render logs |

The feature is not complete until all required outcomes above have execution evidence. No feature code, database test, app render or production claim follows merely from this checklist. Runtime-heavy verification is serialized by the parent.
