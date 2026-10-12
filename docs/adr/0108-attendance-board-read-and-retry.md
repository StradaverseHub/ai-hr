# ADR-0108: attendance retry identity, duration and earned-credit projections

Status: Accepted for the approved October board round; verification and release pending.

## Decisions

Web Clocking owns one pending command at a time. A transport, non-JSON, authentication or server failure cannot prove the command failed. The browser retains its FormData, request ID, direction and photo, blocks fresh intents and checks a receipt scoped to the signed-in employee before retrying the same command. Known validation refusals allow a new attempt. Optional camera failures retain the selected action and Skip Photo; required photo failures retain the requirement. Receipt lookup accepts no employment ID. Unknown server errors return an uncertain 500 rather than a false validation refusal. Pending commands warn before leaving; recovery after a deliberately closed tab is not promised.

Semi Flexi and Full Flexi both use the configured required duration for late/early evaluation. Fixed start/end differences do not create penalties. Missing evidence remains incomplete; a complete short day keeps its under-minutes. Fixed shifts retain their time comparisons. Existing attendance records are not rewritten by deployment. The existing authorized recompute path preserves clockings and approved overtime, refuses closed payroll coverage using the actual attendance cut-off window, and marks processed runs when attendance penalty figures change as well as when work/OT/day type changes.

The HR Credits table is a projection of actual toil_accrual lots. Consumption/restoration events own each request-to-lot amount; approved date rows describe remaining usage in chronological order, preserving the recorded consumption order across credits. Partial cancellation projects those net lot amounts over the surviving approved dates. This is a current display allocation, not a new financial writer or a claim that an original per-date allocation was stored. Legacy multi-date requests without retained date rows show their unattributed used amount explicitly instead of inventing dates. Reversed and paid-out lots remain explicit. A fully used lot stays fully used after its expiry date; only unused remainder expires. Totals use the full filtered set before pagination. The movement ledger and wind-down settlement actions remain accessible.

Attendance configuration forms retain independent save scopes. The shared navigation guard joins the existing unsaved-change registry, warns for a dirty form when leaving and when submitting a different form, and excludes GET filters and download links. Existing detail return destinations remain their own lists; top-level setup destinations return to Attendance Settings.

## Verification required

Real browser/DOM camera and uncertain-response flows, own/other receipt access, production-shaped Semi Flexi and fixed-shift controls, closed/processed payroll recompute, real leave approval/cancellation allocation projections, six-locale rendering, and the exact shipping commit's full gate/build/shadow. No green claim is made by this decision record.
