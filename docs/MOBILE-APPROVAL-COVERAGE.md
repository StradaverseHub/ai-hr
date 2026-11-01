# OneHR+ approval coverage

Owner direction, 1 November 2026: every approval type should be actionable in the mobile app, with its full review context. Layout redesign includes Approvals, Leave and Me. This expands the earlier mobile declutter scope; it does not waive assignment, module, self-approval, confirmation or evidence requirements.

Implementation checkpoint (not acceptance): replacement leave, manager/HR reviews, claims with local document viewing, profile changes, resignation and notice acknowledgement are now implemented on the owned review branch. Hosted fixes and native rebuild/rendered verification are still in progress. None of these new paths is released or accepted. Performance review, assessment work, career plan, calibration and rewards review remain unimplemented natively.

The original inventory comes from `PendingTaskKind`, `TASK_KINDS`, the pack task providers and the shipped mobile decision allowlist. **Listing a task does not mean that mobile can decide it.** The current app supports three native kinds; the server supports four. All other rows currently open their canonical web workspace.

| Task kind | Current native app | Existing owner and required review |
| --- | --- | --- |
| Leave | Supported | Leave pack: request, dates, balance/policy context, whole/per-date decisions and rejection reasons. |
| Leave cancellation | Supported | Leave pack: original request and cancellation dates, expected approval step. |
| Attendance | Supported | Attendance pack: clock corrections and overtime, original/proposed times, reason and workflow stage/participant. |
| Claim | Server supported; app currently web-only | Claims pack: type, amount/currency, date, custom fields, receipt review and reason. Restore a complete native detail rather than exposing a bare decision button. |
| Replacement leave | Web-only | Leave pack: canonical leave-credit/TOIL owner, source days/hours and credit consequences. |
| Profile change | Web-only | Profile owner: authorized before/after field values, document/photo context, current field policy and reason. |
| Resignation | Web-only | Offboarding owner: last working date and termination consequences; explicit confirmation. |
| Manager review | Web-only | Employment-review owner: recommendation and comments, rather than a generic approve/reject mapping. |
| HR review | Web-only | Employment-review owner: decision, extension date when required and HR comments. |
| Notice acknowledgement | Web-only | Notice owner: full published content/version and acknowledgement; this is not an approval of another employee. |
| Performance review | Web-only | Performance pack: assigned manager review workspace, ratings/evidence and workflow submission. |
| Assessment work | Web-only | Performance pack: open PM/TM parts and the assigned actor's scorecard/competency forms. |
| Career plan | Web-only | Performance pack: assigned reviewer of the shared plan, plan content and review conversation. |
| Calibration | Web-only | Performance pack: tier window, scope, participant evidence and tier decisions. |
| Rewards review | Web-only | Rewards pack: unit revision, approval/return/reject actions, required reason and acknowledgement. |

Implement these through typed mobile contracts and their existing service owners. The client must never invent an approval permission, decision value, score, monetary calculation or consequence. A type becomes supported only after its facts, attachments, form, online decision, stale-state handling, same-reference retry and acceptance evidence work on the installed app. Keep older installed clients compatible. Do not set `nativeDecision` or widen a route allowlist ahead of the corresponding guarded service and screen.

Acceptance for every type includes wrong-tenant/company/actor refusal, self-decision policy, module denial, changed assignment/step/revision, repeated submission, lost response, required reasons and attachment access. Do not perform real employee decisions during a visual review; use authorized synthetic fixtures and explicit human confirmation.


The expanded list is opt-in (`native=expanded`), so older clients retain their existing web paths.
Review commands retain manager recommendations and advisory HR decisions, including required extension
dates and termination classification. Request workspaces carry canonical before/after profile lines,
version-bound notice content, and the real resignation last-day/termination consequence. Decisions and
mobile retry receipts use the same owner transaction; only authorized synthetic test databases are mutated.

The native document viewer is new code pending native compiler/build acceptance. It restricts input to
PDFs in the protected cache, rasterizes with platform engines, bounds file/page/bitmap sizes, and has no
PDF hyperlink, remote-resource or export handler. JPEG/PNG use the existing protected download boundary.
Temporary files close on route blur, background, unmount, account change or parser failure. Android
screen-reader PDF text still requires an implementation/acceptance pass; no accessibility claim is made.

Evidence: the original TOIL run 41318654371 finished with native compiler/exports passing, one selected
integration failure and a root type failure; preserve it. The integration fixture exposed a legitimate
ordinary-workday refusal incorrectly mapped as a 500. The repair maps known TOIL refusals and tests a
same-reference retry after a valid rest-day correction. It also narrows the accepted result to the
actual canonical decision. Manager/HR run 41319025608 was cancelled while pending by Actions concurrency;
it supplied no application evidence. Its suites must be included in the aggregate verification.
Claims run 41319340176 is running at this checkpoint; its completed native compiler found a type-only
import used as a runtime schema in the review screen. Preserve this failure and repair after all planned
jobs finish, then rerun failed/affected checks. Do not relabel failed runs as passing.
