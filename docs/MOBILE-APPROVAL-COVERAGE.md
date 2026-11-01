# OneHR+ approval coverage

Owner direction, 1 November 2026: every approval type should be actionable in the mobile app, with its full review context. Layout redesign includes Approvals, Leave and Me. This expands the earlier mobile declutter scope; it does not waive assignment, module, self-approval, confirmation or evidence requirements.

The owned review source now implements native workspaces for all 15 task kinds. This is **implementation, not installed-app acceptance**. The earlier simulator build is still installed; the new backend routes have not been deployed. The expanded list is opt-in so older clients keep their existing web paths.

| Task kind | Native review source | Canonical behavior retained |
| --- | --- | --- |
| Leave | Implemented | Dates, policy context, whole/per-date decisions and rejection reasons. |
| Leave cancellation | Implemented | Original request, cancellation dates and expected approval step. |
| Attendance | Implemented | Original/proposed clock times, overtime, attachments and current stage. |
| Claim | Implemented | Amount/currency, type, date, custom fields and protected receipts. |
| Replacement leave | Implemented | Source days/hours, canonical eligibility/formula and credit consequences. |
| Profile change | Implemented | Before/after values, documents/photos, field policy and rejection reason. |
| Resignation | Implemented | Last working day, explicit termination consequence and canonical acceptance. |
| Manager review | Implemented | Advisory recommendations and comments. |
| HR review | Implemented | Advisory decision, extension date and termination classification. |
| Notice acknowledgement | Implemented | Full content/version, attachment membership and acknowledgement. |
| Performance review | Implemented | Standard ratings/compensation recommendation and OneHR assessment forms. |
| Assessment work | Implemented | Assigned scorecard approval/return, KPI moderation and competency review. |
| Career plan | Implemented | Career/goals, manager feedback, conversation/date and agreement. |
| Calibration | Implemented | Authorized person facts, prior decisions, current tier/axes, per-person decisions and cohort locking. |
| Rewards review | Implemented | Scoped people/checks, available decision actions, reasons/acknowledgement and senior-pay redaction. |

Large calibration/reward populations use paged person selection. The full authorized source still binds the decision digest; pagination is presentation, not an authorization or workflow boundary. Independent cycle administration and reward configuration remain with their existing owners; inbox task support does not grant those privileges.

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

Verification evidence is preserved by exact candidate and run:

| Candidate / run | Result and limits |
| --- | --- |
| 98aad / 41318654371 | Native compiler/exports passed; TOIL refusal mapping/fixture and root typing failed. Repaired afterward. |
| 457c / 41319025608 | Cancelled while pending; no application evidence. |
| 9bfe / 41319340176 | Both exports passed; runtime-schema import, document-event timing and known TOIL issues failed. Preserved before repair. |
| 18774 / 41320532487 | Selected behavior checks, native compiler and exports passed. Root compiler found the misplaced resignation last-day guard. |
| e356 / 41321350284 | 140 checks passed, two failed. New scorecard/KPI/competency, career, department-calibration and standard-review route cases passed. Prototype-key validation and reward-reviewer fixture failed; root compiler retained the resignation error. Native compiler/exports passed. |
| e356 native cloud builds | Android e2e396c9 failed Gradle configuration before Kotlin compilation; iOS 82771011 failed the SDK 57 required initializer signature. Neither native module is accepted by these failures. |

The subsequent repair candidate moves the resignation guard into the locked decision, validates raw command keys before Zod record parsing, gives the synthetic reward reviewer its required BU assignment, repairs native module configuration/signature, and adds large-review navigation and widget entry checks. Follow-up verification is pending; do not relabel the failures as passing or as deployed/installed evidence.
