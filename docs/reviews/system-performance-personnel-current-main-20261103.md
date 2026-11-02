# Personnel projection composition on current published main

## Candidate and scope

App-only candidate `3eab8c7b8e9d435597f2d2c46d0a085cc043878d` on
`codex/performance-personnel-main-20261103` is based on freshly fetched main
`dfbcf85b1f03e6e3266df6244694079a98e17dc9`. Alpha remains
`6ea88936539c361a17a6f802c5b1e7bcc4ce1e39`. The candidate is two commits ahead of
main; it does not transfer the diverged umbrella performance branch.

The Personnel page obtains its page rows, exact filtered total and status facets
from one materialized evaluation of the existing authorized Workforce projection.
It retains current main's exclusive Access configuration lock. Database client,
lock implementation, public SQL, migrations, authentication/session, eager whole-list
chooser and literal human provider approval bindings remain unchanged. The five-file
diff comprises page, reader, native regression and the two generated manifests.
The proof-gated private current-actor prototype is not integrated here.

## Hosted checks and immutable evidence

Original red `9336feb5b78db55d913b2343d62cf0ec7af2dc92`,
[41487290324](https://github.com/StradaverseHub/ai-hr/actions/runs/41487290324),
retains the old composition and fails only the final native projection count:
three evaluations where one is expected. Exact rows, order, counts, status/filter
and scope controls pass before that assertion. The failure remains preserved.

Green candidate [41488356642](https://github.com/StradaverseHub/ai-hr/actions/runs/41488356642)
uses controller `16ee39a13da7b1e34ea338268742f3961f3288f7`. Its artifact explicitly
pins candidate `3eab8c7b8e9d435597f2d2c46d0a085cc043878d`, rather than the
controller SHA displayed as the workflow head. All 123 checks across ten selected
files pass (52 non-database, 71 database). The fresh whole compiler passes (`next typegen`, then `pnpm exec tsc --noEmit`,
exit0, 7m03.93s). The whole workflow is SUCCESS; focused evidence is not a release receipt.

The native fixture uses actual `ai_hr_app`, 512 visible and seven foreign fictional
employments, 25 page rows, independent ordered expected IDs and exact old-reader /
facet parity. Empty/foreign scope refuses. Native PostgreSQL statement statistics
prove one projection evaluation. Four alternating-order matched timings:

|Round/order|Former composition|Single projection|
|---|---:|---:|
|0 / former first|489.30ms|155.88ms|
|1 / composed first|73.30ms|46.77ms|
|2 / former first|74.23ms|62.85ms|
|3 / composed first|74.49ms|33.20ms|

Mean 177.83→74.67ms is 58.01% lower within this component fixture. The first pair is
substantially slower than later pairs; retain all four and do not extrapolate the
mean to user-visible page speed or capacity. Every paired result asserts equality.
This is neither a 500-user nor million-Personnel benchmark. Standard hosted runner,
PostgreSQL profile2, JIT on; database peak 1,192,570,880 bytes, no OOM/cap events.
Private evidence: `/private/tmp/aihr-personnel-main-{red-9336,green-3eab}-attempt1`.

The existing task-scoped approval covers only regenerating the same two metadata
files. Provider digest `3ac474015bba493d9756c9972de4f42421d2b261fabb66085cf6ce79c61352e2`;
module digest `327d3182c2f9a6549a062f2b8e1a485020b4bdb69f0fddbbb5aae2b3905c2e17`.
Both static checks pass. No human binding refresh or provider access is authorized
by this evidence.

## Remaining admission and dependency hold

Fresh fetch still resolves published security owner to incomplete
`605baf23cac704409386ae55bbf37f5fd1f66d5b`. Its 0941 migration requires absent
`app.access_current_capability_source(text,uuid)`; two compiler contracts remain
absent: `lib/access-action-presentation.ts` and
`deploy/access/function-action-contract.ts`. These contracts are also absent on
current main. The original failed native integration remains 4b2032670 /41465947112.
Do not copy unpublished local owner commits or edit owner functions. A complete
published dependency and frozen compatible integration precede combined correctness
qualification, then a justified unchanged original500 pair.

The exclusive tenant lock, eager chooser and native full wide projection remain
scaling concerns. Existing retained Home evidence also shows slow initial server
response and 2.8-second client aborts; no deadline is relaxed. Both original500
profiles at 29f806a remain failed (0/2 accepted); this candidate does not replace their
evidence. No full-load retry, main/alpha integration, release admission, provider
binding update, staging queue/lease or deployment has occurred.
