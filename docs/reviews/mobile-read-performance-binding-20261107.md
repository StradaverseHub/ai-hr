# Mobile read performance — exact source binding review

Reviewed code: `8f979a23706120766e19e5b8ebf82d63ce6d4e55`, based on aligned `main`/`alpha` source `2b90f2e45ecafd732e9e772d8edc243ee98b09bc`.

Proposed provider transform digest: `81c8f6c7a25028da15e5984fa4245da267d2e798ccdb2ae2b69748e872498095` across 1,458 covered sources. The accepted parent digest is `13b38cf5f2b52b1eadff341c2f1ef1c14262e3255c7d3d6bff8baab270afcf80`.

## Covered change

Only `core/read.ts`, `core/attendance.ts` and `core/claims.ts` differ inside the provider transform closure. Their pending-request readers gain an optional batch of request IDs. When provided, the IDs narrow the existing SQL predicates before working-date, workflow and attachment hydration. Calls without that option keep their previous behavior. Tenant RLS, assignment/delegation checks, company scope and decision owners remain unchanged. No projection field, serializer, prompt, model destination, provider transport or AI operation is added.

The mobile-only display owner uses the selected page's IDs. Its Home count and page can share an identical verified-context read while it is in flight, with a two-second join window and bounded admission. The full context and module selection participate in the key; completed responses and failures are removed. Commands and decision authorization do not use this coordinator.

The independent presentation response repair accepts PostgreSQL-shaped tenant UUIDs, including the repository's deterministic legacy demo ID. Tenant identity continues to come exclusively from the verified session; generated command request IDs retain their existing validation.

## Approval scope

There are 28 existing approved records and two pending records. The proposal changes only the approved records' exact source digest and the generated transform manifest. Their contract IDs, status, reviewer, original evidence and original review timestamp must remain unchanged. `structured_canonical_records_v1` and `attendance_trend_analysis_v1` remain byte-identical and blocked. This refresh authorizes no new AI data, disclosure destination, permission or autonomous employment/pay decision.

The literal approval registry has not been refreshed. It remains stale and fails closed until an explicit owner disposition for this exact digest is recorded. Previous approvals are not approval of this source.

## Verification and release boundaries

The focused real mobile approval, claim, delegated-approver and design journeys, plus the in-flight isolation/retry suite, passed in run `42363911030`; its whole compiler check was still running when this packet was prepared. The legacy design contract regression passed in `42363526053`. These are development evidence, not a release gate or installed acceptance.

Full qualification, shared staging queue admission, exact source/build arrival and authenticated native acceptance remain required. Production, package publication, app stores and Firebase are excluded.
