# Private email-document HR notices — exact approval proposal

Status: UNAPPLIED. Concrete completion write rejected by automatic approval review on17 November2026: “This migration persistently rewrites multiple shared worker, execution, delivery, mail-context, and queue security functions via same-OID wrappers and adds a new HR-notice event path; the user approved bounded emailDocumentReady recovery, not this broader HRNotice security-boundary change.” No retry or alternate execution. The accepted unregistered source draft has been moved out of active migrations into the companion review artifact. Specific human approval of this exact HRNotice boundary is required before resuming that rejected write.

Original status: UNAPPLIED. No active migration, worker hook or grant accompanies this proposal. The earlier email-document approval covers document creation/readiness, but this proposal asks approval for the additional persistent internal notification admission below. Allocation 5963 / idx5363 / when1794841005963 belongs to this implementation only after approval.

## User-visible result

An email-attached document sends its next actual HR reviewer, approver or BP signer a OneHR link when their turn begins. A send-back alerts the actual nonemployee document owner. It never sends an employee invitation while any currently pending HR prerequisite remains. The existing explicit SendEmail step sends that employee invitation after HR readiness. Parallel canonical routing is unchanged. No Contract stage, closure, posting, pay or Offboarding changes occur.

## Exact native boundary

Add internal-only `emailDocumentHRNotice` to the native Contract event CHECK; do NOT add it to the authored Workflow trigger catalogue. Its `workflow_versions` is always `[]`. No new kernel job kind. Each notice is tied to the immutable email pin, canonical Letter, canonical Signing document, current round/revision, pending HR route step (or actual returned owner), frozen account UID AND Person PID, unchanged employment/person/company and Lifecycle entitlement.

`app.contract_shared_email_hr_notice_source(letter, signingRevision)` is private; it derives recipients from native pending canonical route rows, excludes the actual employee PID irrespective of role label, and rejects stale signing revisions or source identity/entitlement changes. Returned-owner eligibility must also match its frozen UID/PID route row. The recipient list is bounded by canonical maximum30 route rows; no tenant-wide scan.

`app.contract_shared_email_hr_notice_emit(letter)` is private. Initial preparation calls it only AFTER immutable pin.documents binds the canonical Letter, under the actual held SendEmail effect and job seal. Later progression calls it from a Contract-only AFTER canonical Signing update trigger only when a new actual action has been appended; the action's UID/PID must equal the real current actor and be validated by the existing canonical owner. No GUC impersonation or substitute identity. A protected initial system event remains a true NULL-human child of its actually held job; a later human action remains its real UID/PID. Unrelated subjects and outcome/declined Letters return without changes.

`app.contract_shared_worker_event_held` / `event_check` receive ONE additional branch requiring that private source receipt plus actual kernel job capability/seal. The existing branches remain delegated unchanged. A human-source notice requires its original verified UID/PID; a true-system initial child requires the already-held parent seal. No general system enqueue permission or business effect is added.

`app.contract_shared_email_hr_notice_page(case, afterUID)` is private, reads ONLY the held internal event and rechecks actual pending native UID/PID/source at delivery. Mail is fixed OneHR link text, no PM answers, salary, IC/passport/bank/tax, attachments, authored templates or authored workflows. Page at most30 actual route recipients. Occurrence/key includes Letter, canonical revision and actual UID/PID; retries cannot duplicate it.

The existing private mail-context/eligibility/target adapters recognize ONLY this exact sealed event + occurrence and allow only these native nonemployee recipients, fixed subject/body and actual Letter portal link. `contract_shared_effect_held` rejects every authored business effect for this internal event: no GenerateDocument, SendEmail workflow execution, approval, posting, pay or Offboarding. `automation_email_queue_rich` validates the fixed notice key/words/empty CC/no assets. SMTP target rechecks current pending/returned-owner eligibility; notices for completed/changed recipients are cancelled/held before SMTP.

The worker short-circuits to the reviewed helper in the companion TS artifact BEFORE authored runtime dispatch, marks this internal event processed after its bounded page, and never calls runAutomationEvent/resumeAutomationRun. Root5960 emailDocumentReady remains separate and exclusively resumes the same waiting SendEmail pin; this notice cannot resume any run.

## Native callback and lock order

Source Employment SHARE → Letter → Signing → Form (when present) → Flow. Initial hook runs after bind; canonical progression runs after the already authorized native Signing change in the same transaction and reuses those locks. Reads take the shared Access barrier, never exclusive Access. No Personnel/Payroll writes or table privileges to app. No direct public EXECUTE on emit/source/page/proof.

## Required evidence before completion

Actual HR Review→BP Sign sends two native notices, exact send-back owner receives one; parallel HR+Employee still holds Employee; unique employee self-binding does not turn an HR notice into an invitation. Replay is idempotent; stale round/step/UID/PID/source/company and unsealed direct calls deny. Forms never place answers in event/job/mail. True-system initial document has no fabricated human. Tests verify no authored workflow execution, no extra business writes, root5960 same-step recovery independence, and ordinary Contract/Probation behavior unchanged.

Companion artifacts: `5963-email-document-hr-notice.proposal.sql.txt` names and specifies the source predicate and admission changes; `5963-email-document-hr-notice.proposal.ts.txt` is the bounded worker hook. These are review text, not registered executable migrations. Native wrappers will be finalized against the parent's frozen5960/5932 owners after exact approval; no alternate existing-event bypass is authorized.
