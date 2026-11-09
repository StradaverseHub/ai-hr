# Mobile Clock staging source-binding review

Reviewed Clock source is `daeca3427372722cd0a7e16ef1a09515ff3d5794`, based on verified staging, main and alpha `5aa20706fb7219e28bd077307d7d892996640e1a`. Scope is the mobile Clock backend for staging. The source adds no database migration.

## Proposed binding

The static closure contains 1,485 files. The proposed digest is `9691d83b3b3af907d288ba6e04e3658ff7babb6dff384c80b48b63199ac23bd5`. The existing approved binding is `d225b958ee491f82a63f58280dc5d89aa87643c7775d82e9c95de6d5088abb82`.

| Covered files | Change |
| --- | --- |
| `core/attendance-clock.ts`, `core/attendance.ts` | The authenticated mobile carrier records the canonical punch and evidence flags in one transaction. Existing own-employment scope, device admission, signed-integrity requirements, corrected-day protection and idempotency continue to apply. Web and legacy commands retain their existing evidence requirements. |
| `core/attendance-clock-read.ts`, `lib/clock-review-reasons.ts` | A closed reason vocabulary is read from the same subject-scoped audit event for the employee’s receipt and authorized attendance review. |
| `messages/{en,ms,ta,th,vi,zh}.json` | Attendance review labels for the local HR page. |

The new mobile endpoint and attendance review page do not invoke an AI provider. The reason codes are displayed in the mobile receipt and HR attendance detail. Provider transports, disclosure transforms, destinations, consent, access scopes, and evaluation or promotion records are unchanged.

## Owner decision requested

Renew only the exact source digest for the same 29 already-approved input contracts. Keep both pending contracts blocked. Preserve every contract ID, status, reviewer, evidence reference and timestamp. Regenerate the module-agent source manifest after the literal renewal. This request covers the exact binding for the reviewed Clock source. The staging rollout follows the existing release gate and queue.
