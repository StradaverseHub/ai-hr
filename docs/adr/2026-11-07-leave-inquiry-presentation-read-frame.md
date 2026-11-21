# Leave inquiry: native read admission and a coherent presentation frame

Status: first repair checkpoint prepared; hosted verification required. This is not a
staging or production release witness. A second bounded-picker checkpoint remains required.

The immutable test-only source is `d0ee92473a88435951d7928c9bb0ac7556fa3483`.
Its completed hosted run `42380211127` passed the whole compiler and the native
5,000-employment cost case. The controls case failed because an already-revoked HR
principal still obtained one company through the context reader. That original failure
is retained; an empty response is not substituted for the required native refusal.

The same run proved that ordinary context/membership/canonical-money reads finished
while real tenant Access and Payroll History writer locks remained held: 62.9ms and
67.8ms respectively, with independently expected balance 10 and available 9. Native
read-only enforcement also passed. There was no justification to remove financial
command or source-dependency barriers.

On the old Employment ANY policy, context All and context single each took about
1,017ms and returned 5,000 employees with 27 fields, roughly 4.05MB. Records context
took 988ms with the same population. First/deep balance membership took 1,202/6,905ms;
each issued 200 SELECTs, including 50 identical type-catalogue reads. Selected canonical
hydration took 1,841ms and 69 queries. These are instrumented component measurements,
not browser latency or production capacity claims. Candidate measurements must record
the actual policy: migration 3001 is a separately owned optimization, and its benefit
must not be attributed to this change.

## Decision and invariants

Every owned inquiry read uses a database-enforced repeatable-read, read-only carrier
and proves the stored current native login and grants before protected company or
employee reads. False admission throws `InquiryQueryError('Forbidden')`; storage errors
remain errors. A command carrier borrowed by an internal composition retains its
current-authority Access barrier. Presentation admission grants no write, provider-call,
financial effect or settlement authority. SQL budgets are bounded, never increased.

The original actor identity remains mandatory. Session, query, company selection and
window inputs are copied before asynchronous work. The authorized population is stored
privately and cannot be enlarged by mutating the returned context or returned rows.
Every later standalone balance-pair, record-page or hydrated balance-page read treats
an old context as selection intent and freshly re-admits it. Borrowed Tx ports require
the original physical transaction captured with the private context; even another
valid RR/RO snapshot cannot reuse its metadata. Both actual inquiry pages compose authorization, membership and canonical
hydration within one snapshot. Concurrent authority, company or type edits therefore
permit an admitted coherent snapshot or refuse the next read; they cannot splice old
membership into newer financial facts.

The new metadata projection is exactly the old employment/person/company population
and old LEFT joins. Assignment requires `valid_to IS NULL AND superseded_at IS NULL`;
it deliberately has no new valid-from cutoff, active-only restriction or generic
Workforce substitution. It returns the ten fields these pages consume instead of 27.
Ended employment, absent assignment and future open assignment semantics remain intact.
This checkpoint still enumerates that minimal full population. Sending only a bounded
picker page, and reading only the chosen selected identity when possible, is the next
required checkpoint; this projection alone does not finish the performance work.

The exact eligibility/historical-row calculation is mechanically shared with the
unchanged legacy membership port. The new presentation reader privately reads the type
catalogue once per physical invocation, then retains the existing 100-employment profile,
ledger and pending-request chunks. There is no cross-request catalogue or authority cache.
Money, borrower/source context, as-of dates and financial writers are unchanged.

One `Intl.Collator(locale, {sensitivity:'base'})` supplies the same ICU comparator as
repeated localeCompare calls. Primary direction and every old tie remain unchanged,
including default-locale identity ties. The max heap still computes complete membership
and an exact total before canonical page hydration. No population cap or approximate
count is introduced. Complete export and its existing 10,000-row refusal remain intact.

## Frozen verification plan

The original focused performance selector remains a sole-file job, preserving its
explicit hosted-only admission and fixture isolation. It repeats actual SQL plans,
component timings, field/byte counts, policy attribution, held-writer money and native
read-only controls. The changed revocation expectation now requires domain refusal and
independently zero protected SELECTs.

`leave-inquiry-presentation-focused-tests.json` adds native population and authority
proofs, six-locale Unicode/deep-order parity against the original localeCompare algorithm,
coherent concurrent company/type/authority edits, actual selected/unselected company
transfers through standalone ports, cross-snapshot borrowed-context refusal, canonical
figures, scope/export and
rendered translated picker/header behavior. Existing date, hidden/archived, shared-source,
reconciliation and entitlement tests remain required. Source wiring guards assert the
new single frame without dropping their query/scope/selected-row guarantees.

Root owns hosted dispatch, whole compiler/build, evidence retention and integration.
All planned jobs finish against the frozen source before repair. A source-only review
cannot mark this checkpoint passing, and a focused pass cannot authorize staging.
