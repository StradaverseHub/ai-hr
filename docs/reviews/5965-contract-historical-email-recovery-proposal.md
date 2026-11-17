# Proposal only: historical pinned email recovery

Status: UNAPPROVED, UNAPPLIED. Migration5965 is reserved, not registered. This document grants no execution authority.

The current5960 recovery keeps the original job alive and uses its existing seal. The5935 SYSTEM owner gate additionally requires its original Personnel period to remain current. An independent approved Personnel posting can advance that period while an earlier optional email Form is still waiting. The same period check also governs SMTP, including original revision0 email after the first accepted decision. The email remains a legitimate independent task, but the current native gate refuses its retry/delivery.

Requested additional authority is one historical email unit only. It must not re-enable the old workflow tail or change the ordinary system gate. Admission would use a separate `historicalContractEmailUnit` entrypoint when the ordinary5935 gate refuses, never pass an arbitrary callback to a more permissive owner transaction.

The private native admission predicate must prove all of these facts from persisted owners:

- The original physical job remains live, uncancelled, with its current lease and exact input/plan seal; its private5932 SYSTEM source still matches the original event, case, employment and old period. No completed job is revived.
- An actual approved Contract Personnel posting for the same employment/company/person has completed native movement: `contract_shared_posting.applied_at` and `movement_group_id`, with the matching approved posting and movement receipt. Future approval alone is insufficient.
- The old case retains its immutable period source. Actual current employment still belongs to the same person/company; company entitlement, intake and source-conflict checks remain active. No caller-provided history or substituted subject is accepted.
- The immutable pin, original event/run association, exact waiting Send email cursor/step, email version, actual callback UID/PID and canonical document/file readiness match the private unconsumed internal child. Revision0 means the original predecision email only; later accepted terms are never merged into it.
- The unit can call only the exact Send email executor. It cannot run general workflow dispatch, notify, Generate document, approvals, postings, Payroll, Offboarding, or the original tail. Any remaining tail stays visible as unresolved attention.

The historical predicate must be an acyclic private leaf. It cannot call5960 `origin_held`, `event_held`, `effect_held`, or required-file validators which recurse through them. The normal5935 owner predicate remains unchanged. The separate entrypoint selects one exact child and invokes a fixed implementation, not caller-supplied SQL or a generic owner callback.

SMTP requires a separate private delivery receipt written by that fixed unit. It binds the actual queued delivery ID and full immutable payload hash to the pin/run/step/email version, actual callback UID/PID and original human or SYSTEM provenance. Existing SMTP lease/token, actual recipient UID/PID eligibility, revocation, template/assets and delivery capability checks remain mandatory. This receipt must be checked from the persisted queued delivery, not from an asserted `systemJobId` or caller context. Human-origin original revision0 email needs this same narrowly bound delivery rule; only SYSTEM needs the extra historical worker entrypoint.

Legacy uploads remain actual native receipts with their real authorized uploader. The historical fixed unit may consume one unseen matching observation after acquiring source → sorted documents → pin → template locks and revalidating all proofs. It may not invent a callback actor or change the job principal.

Required verification before activation: real SYSTEM caseOpened email/Form hold → first accepted decision → released agreement → actual Personnel posting/movement → HR Form completion/upload → one historical email queue and SMTP target; current workflow tail remains unexecuted. Repeat for human revision0 delivery. Refuse scheduled-only posting, expired/cancelled/completed job, changed lease/seal, foreign person/company/pin/actor, stale required file, changed payload or recipient, and every non-email effect. Preserve ordinary current-period system and human regression suites.

No SQL patch is active. The executable leaf and fixed entrypoint must be reviewed against the final assembled5935/5949/5957/5960/5962 source before a separate explicit approval authorizes their activation.
