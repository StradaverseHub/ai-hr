# Performance check-in cancellation parity

Owned cancellation tree starts at exact composed goal89cb66977819b8f91842fdcc6d0919c0a8d302c5. It is an isolated held stack, not a release candidate. The goal branch remains separately frozen while cancellation progresses.

## Native inventory and authority

The mounted native form is app/performance/page.tsx → cancelCheckInAction → cancelCheckIn. The true business owner requires a scheduled performance_checkin and current assertCanDecide(subjectEmploymentId,'check-in') under native row visibility. Historical managerEmploymentId is not authority. The native guard retains the super-admin own-subject exception, unlike goal approval's unconditional subject ban. Ordinary same-person employees are refused. Real unlinked USER administrators can act through native scope; SYSTEM has no Assistant human-review path and the native SYSTEM command has no new user-only guard.

The native wrapper now delegates to cancelCheckInTx within the same supplied transaction. It locks the row, checks native current authority/state, writes status cancelled and the same native event, and returns the exact inserted event UUID. Date/participant/status plus xmin form the private stale-source witness; shared notes are not read into the Assistant projection. The command does not complete the check-in, edit shared notes or send notifications.

## Per-kind shared-ledger adapter

checkin-cancellation-custody-adapter.ts uses the existing createReviewCustody engine, the same physical encrypted review/body ledger and existing protocol/lifecycle/crypto. This adapter binds genuine tenant/user/nullable actor person/employment/company/checkin. It omits the generic assigned adapter's unconditional actor-person/subject-person inequality ONLY for this kind, after the native owner and exact SQL predicate enforce the real exception. The generic assigned source file and every previous action's self rules remain unchanged.

0737_assistant_performance_checkin_cancel.sql is coordinator allocated (idx716/version7/when1793330000074/breakpoints:true), UNAPPLIED PROVISIONAL DEVELOPMENT ONLY. The SQL binding dispatches all older kinds unchanged to its predecessor; only the new kind uses explicit current principal/native scope/true subject binding with the native super-admin exception. Old CHECK expressions occur once in ELSE; the new branch uses the canonical strict legacy-column-null rule. Receipt proof binds current cancelled row, exact actor/type/subject/native event, and top-transaction row/event writes at completion. A terminal receipt confirms the native cancellation and current accessible cancelled record; it does not claim shared notes are unchanged since the event.

Descriptive registry metadata adds performance_decider/performance_checkin. A USER may ask for native choices; those labels grant no authority. The ordinary native guard, fresh principal/Assistant grant/module/global and per-action pauses remain prerequisites before private projection/unwrap. No provider/fact-reader/authentication/runtime redesign, new storage engine, global self-rule change, pay/rating outcome or external notice.

## Human workflow and verification

The dedicated Assistant page shows exact employee/company/date and scheduled→cancelled. Preparing has no effect; the human separately confirms the exact saved review. Existing same-origin packet parsing, principal-scoped component lifetime, response substitution refusal, expiry, abort, replay/recovery, erasure and payload budgets are retained. No notes, generated text or proposed dates enter the human intent.

Authored tests cover native/self-super-admin versus same-person ordinary denial, current manager, unlinked USER, SYSTEM/peer/foreign actor/tenant refusals on active records, changed date and note-only xmin drift, bounded private projection with long notes, unchanged native notes, exact event/current outcome proof, pending retirement, whole-transaction completion rollback, dedicated-family hybrid CHECKs including date, shared real eleven-role native/offer/prepare/confirm probes, strict consent and six-locale review/recovery screenshots. Authored coverage is not yet hosted success, an authenticated journey, installation or acceptance.

Global release hold stays. Do not move main/alpha, merge protected branches, deploy, or infer accepted migration allocation from this source claim.
