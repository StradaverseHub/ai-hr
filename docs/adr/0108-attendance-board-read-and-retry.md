# ADR-0108: attendance retry identity, duration and earned-credit projections

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

Status: Accepted for the approved October board round; verification and release pending.

## Decisions

Web Clocking owns one pending command at a time. A transport, non-JSON, authentication or server failure cannot prove the command failed. The browser retains its FormData, request ID, direction and photo, blocks fresh intents and checks a receipt scoped to the signed-in employee before retrying the same command. A known validation refusal on the first submission allows a new attempt. After any uncertain response, a refusal of a later retry does not prove the original attempt has finished, so recovery keeps its original identity and receipt lookup until confirmed. Optional camera failures retain the selected action and Skip Photo; required photo failures retain the requirement. Receipt lookup accepts no employment ID. New web commands carry a server-derived equality binding for the original authenticated user and own employment; it is not an authorization credential. A login renewed into a different account cannot replay the pending command against that account. Existing native clients keep their existing contract. Unknown server errors return an uncertain 500 rather than a false validation refusal. Pending commands warn before leaving; recovery after a deliberately closed tab is not promised.

Semi Flexi and Full Flexi both use the configured required duration for late/early evaluation. Fixed start/end differences do not create penalties. Missing evidence remains incomplete; a complete short day keeps its under-minutes. Fixed shifts retain their time comparisons. Existing attendance records are not rewritten by deployment. The existing authorized recompute path preserves clockings and approved overtime, refuses closed payroll coverage using the actual attendance cut-off window, and marks processed runs when attendance penalty figures change as well as when work/OT/day type changes.

The HR Credits table is a projection of actual toil_accrual lots. Consumption/restoration events own each request-to-lot amount; approved date rows or immutable submission date-weight provenance describe remaining usage in chronological order. Different lot event sequences are not comparable; the projection follows the consuming writer's expiry/worked-date/id order. Partial cancellation projects those net lot amounts over the surviving approved dates. This is a current display allocation, not a new financial writer or a claim that an original per-date allocation was stored. Replacement Leave deliberately has no per-date approval rows. Its submission now retains the canonical calculated date weights (up to the existing 400-day detail bound) as immutable event provenance without adding a financial writer. The reader intersects that snapshot with approved surviving split spans and requires the survivor weights to match its stored charged days. Later schedule or holiday changes cannot invent a different usage calendar. Legacy multi-date requests without retained date rows or this provenance show their unattributed used amount explicitly instead of inventing dates. Reversed and paid-out lots remain explicit. A fully used lot stays fully used after its expiry date; only unused remainder expires. Totals use the full filtered set before pagination. The movement ledger and wind-down settlement actions remain accessible.

Attendance configuration forms retain independent save scopes. The shared navigation guard joins the existing unsaved-change registry, warns for a dirty form when leaving and when submitting a different form, and excludes GET filters and download links. Existing detail return destinations remain their own lists; top-level setup destinations return to Attendance Settings.

## Verification required

Real browser/DOM camera and uncertain-response flows, own/other receipt access, production-shaped Semi Flexi and fixed-shift controls, closed/processed payroll recompute, real leave approval/cancellation allocation projections, six-locale rendering, and the exact shipping commit's full gate/build/shadow. No green claim is made by this decision record.

Allowance and workflow editors disable the submitted draft while their save is pending. A successful save acknowledgment must never rebase newer edits that were not part of the saved payload.

Same-path legacy Schedule Group saves carry a per-submit nonce, echoed only on successful persistence. The guard consumes the matching receipt once for that form and rebases to its submitted snapshot, preserving other forms and edits typed while the response was pending. Old success URLs, unrelated refreshes and refusal redirects cannot acknowledge an unsaved draft.

Next 16.3.8's client server-action reducer rejects a redirecting action with a handled
redirect even after scheduling the destination's seeded RSC navigation. Its RedirectBoundary
intentionally remounts the caller subtree when that rejection reaches a form transition.
Stable overtime band keys cannot preserve independent forms through that remount. Schedule
General/Attendance/Overtime therefore submit through a narrow client event handler, outside
React's native action-form transition/reset. It catches only an already-handled Next redirect;
ordinary errors and unhandled redirects still reach the error boundary. Existing server actions,
validation and redirect destinations remain authoritative. The pending Save button is disabled,
while draft inputs remain editable; the receipt acknowledges only the submitted snapshot.
These three edit forms require hydrated JavaScript to submit. Other legacy settings forms retain
their existing native action behavior, including redirect remounts. Different-path internal
redirects still leave the page via Next's reducer; the capture guard warns about other dirty forms
before submission. External redirects may additionally trigger the browser's unload warning.
Real browser verification of the shipping Next/React bundle remains required.

This is based on the installed Next 16.3.8 source: `server-action-reducer.js`
rejects with `createRedirectErrorForAction` and separately returns the seeded or fallback
navigation result; `createRedirectErrorForAction` marks the rejection `handled`.
`redirect-boundary.js` remounts even handled redirects. The bundled React DOM
`startHostTransition` requests a reset for native function actions; the protected forms
instead prevent the submit default and start a client transition with no form action.
DOM regressions invoke the wrapper's action, emulate its handled redirect and assert
node/value preservation, while separately asserting the native fallback retains its action.
They cannot establish real RSC reconciliation behavior or replace a browser run.


Retaining the Schedule Group subtree exposed an old duplicate writer: General's full rule editor
held stale Attendance and Overtime values and could overwrite their successful independent saves.
The sectioned page now gives General identity, status, description, the deduction switch and ladder
boundaries/rates; Attendance owns its six timing values and two Include Grace flags; Overtime owns
early inclusion and rounding. Other full RuleForm callers keep complete-form semantics. These
section writes lock the rule, read current rows, merge an explicit service allowlist and write in
one transaction through the existing validator/event writer. General preserves current rounding
for each unchanged From boundary; new bands start with no rounding. Week, shift pool and dated
rotation facts are outside these section contracts.

Overtime retains its mounted field body and the displayed structural ladder (From, To, pattern and
both rates, excluding generated row IDs). A General reshape cannot erase an independent draft.
A changed structural identity immediately shows translated reload guidance; the reload uses the
existing unsaved registry and asks before discarding drafts. The service refuses stale Overtime
identities atomically instead of partially applying settings to a different ladder. An unchanged
ladder can acknowledge its rounding save without making another form dirty.

The navigation guard's lifetime follows pathname/router identity, while a ref provides the latest
translation. A same-path catalogue refresh must not reset baselines or pending nonce receipts.
The action wrapper remains busy until the action settles AND its React transition commits; finally
alone is too early when the destination render suspends. Ordinary rejected actions still propagate
to the boundary, whose unmount cleanup restores the imperative busy attribute. Static regressions
cover these contracts; execution and real Next RSC/browser reconciliation remain unverified.
