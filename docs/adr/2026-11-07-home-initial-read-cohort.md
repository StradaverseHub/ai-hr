# One fresh initial Home stream

Status: candidate; native, rendered and capacity qualification pending. Production is held.

Personal Home initially issued Today, Calendar and a seven-card sharing request.
Each independently loaded its route runtime and resolved a fresh session before
native reads. Eight-worker preflight still timed out at the unchanged 2.8-second
card deadline even with no recorded queue refusal or database timeout. Native
ORM loading alone passed the two-worker preflight but did not close this gap.

Today and Calendar now opt into the existing initial stream. All nine initial
cards share one fresh session resolution; every card still calls its original
native owner, repeats its subject/scope checks, uses its existing transaction and
returns the exact existing projection. No fact or permission cache is introduced.
Calendar carries the exact initial display month. Subsequent month selection,
explicit retry/refresh, clock completion and independent card views retain their
existing individual endpoints. Deadlines, per-frame limits and failure isolation
remain unchanged. A disconnected response cancels eligible nested reads and
does not evict an executing transaction.

The old two-card default and all old explicit selections remain unchanged. New
clients explicitly request the additional cards and optional Calendar month.
An older server rejects this new request during validation with HTTP400 before
running any owner. Only that new-card400 path uses the already existing individual
read endpoints;401,403,503 and malformed streams fail without automatic fallback.
Those fallback readers retain fresh authentication, scope checks and cancellation.
No command or uncertain business effect is retried by this transport.

Qualification must render all nine initial results from one request, retain
healthy siblings when another fails, prove old-client and old-server behavior,
reject foreign subject/month and private-field leakage, and rerun the unchanged
strict browser preflight before capacity testing. The load driver must replay the
actually observed combined request and apply full Today/Calendar validators to
its frames, including independent foreign-subject denial. Fewer requests alone
do not establish correct facts, acceptable latency or staging readiness.

## Summary and Time Off snapshot compositions

The native exclusive Access-writer probe found that Summary's profile quick-action
metadata and Time Off's current figures still waited behind that writer. Their
standalone presentation roots now own enforced REPEATABLE READ / READ ONLY
transactions, following the admission semantics of the Personnel snapshot ADR.
Committed revocations deny the next snapshot; an already admitted read may finish.
No permission or data result is shared across requests.

Time Off calls the same balance, eligibility, entitlement and pending-reservation
owners in one carrier. Only their pure composition seams admit the new snapshot
proof. The legacy current-card Read Committed entry point keeps its contract;
borrowed mutable command carriers still require current authority and the Access
barrier. Summary's new profile-policy snapshot is display metadata for a quick
action. Profile submission, approval and binary photo readers keep their existing policy
contracts. No provider egress, admission, settlement or write uses this read proof.

Qualification must preserve exact canonical figures and history availability,
refuse forged identities and mutable snapshot carriers, and complete both views
while an exclusive Access writer is held. The original failed writer probe and
browser traces remain evidence; source changes alone do not close qualification.

Greeting metadata also uses an enforced own-subject snapshot. Photo existence is
queried through the same native RLS and profile visibility rule in that carrier,
selecting only the photo ID. No image bytes enter Home. The existing binary photo
read and every photo/profile write retain their separate current-policy contract.
The legacy borrowed greeting identity transaction remains Read Committed; the
standalone and initial greeting presentation roots use the snapshot entry point.
The writer probe now includes Greeting, Today and Notices as well as the original
seven readers, so its coverage includes every initial Home card.

## Code readiness before worker traffic

The isolated trace found a cold request entering its Home handler after 2,484 ms,
before authentication or card queries could complete. Importing through Next's
instrumentation layer did not remove the app-route initialization delay. That
failed experiment remains separate from this candidate.

The real `/health` probe now initializes the Home route's definitions in the
app-route runtime, then performs its existing database round trip. It invokes no
Home handler, session, tenant read or provider. The response vocabulary, two-second
probe deadline and cache remain unchanged. One underlying initialization/database
operation remains shared until actual settlement, including after health polls
time out; a slow import cannot release several delayed database probes at once.
Readiness-only code remains outside the governed AI behavior source inventories.

Four-worker experiment 42364894981 completed its browser preflight with no Home
card, page Busy, browser or recorded PostgreSQL lock failures. Healthy nine-card
streams completed in approximately 164–1,122 ms. Module initialization took
527–989 ms before traffic; the first worker's complete readiness wait was about
9.45 seconds. This startup cost is recorded separately, not removed from the
evidence. Independent review repairs passed affected checks and the whole compiler
in 42367077846. Neither result establishes sustained 500-user capacity.

Traffic admission must consume readiness for every worker before sending it a
user request. A deployment health check alone, with a direct tunnel already
forwarding to a listening Next process, does not provide that guarantee. Actual
routing admission remains an integration and installation prerequisite. The
isolated runner withholds driver traffic until each worker passes health and
login checks; installation acceptance must prove the corresponding real boundary.
Staging release qualification and production deployment remain held.
