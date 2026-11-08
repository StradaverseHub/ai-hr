# Explicit Draft presentation transaction course

Source implementation of only the reviewed Draft slice from
2ea980f2908afbd9ceac73fef3e6b5be5c6bef57. ESS facts/workspace, browser leases,
fixtures, v2, CI profiles, connection pools and all production callers stay at
their original source. This is an unadopted named reader, not full Draft page or
architecture acceptance.

The original SELECT/asData body is now owned once by the private
readEmployeeDraftRowTx. The legacy getEmployeeDraft still opens canonical
withTenant with its default Read Committed semantics and delegates to exactly
that query. A whole-file inverse reconstructs the complete original Draft owner
SHA2568c5b61aea0ca026fd07043e9106918d65c946a08548444799f8bc24b82dd51db,
including every create/save/discard/complete writer and all prior imports. No
query predicate, DTO field, normalizer, numbering rule or command path is copied
or changed. The exact old query-body bytes are independently sealed too.

getEmployeeDraftPresentationTx borrows an actual canonical Tx. Before the same
row query it calls the existing assertAiPresentationPrincipalTx, which requires
native RR/READ ONLY, exact tenant/user/person/roles/grants and current principal
snapshot. That principal proof supplies no business effect or provider-send
authority. Native0510 tenant/company/author and0579 restrictive Workforce RLS
still adjudicate the actual row. An author is not assumed to be HR, and an HR
role string does not manufacture company access. Missing/invisible stays null;
the existing page may offer Create, and no404 behavior is added.

The separate getEmployeeDraftPresentation wrapper uses existing canonical
withTenant(readOnlySnapshot:true,readSignal) for a standalone snapshot. Both new
entry points capture roles and individual grant entries before their first wait.
An explicit read signal is checked before admission and before/after the actual
principal and row queries. Settlement/cancellation of a running statement remains
the existing carrier's responsibility; these checks alone are not a native
cancel/drain lease. No native handle, verified flag, generic transaction broker,
pool option, alternate URL, second connection or hidden nested wrapper is added.
The borrowed course opens zero transactions itself. The standalone wrapper opens
one ordinary admitted transaction. No production caller adopts either purpose.

Presentation linearizes at its admitted snapshot. A previously admitted RR read
may finish against that snapshot; the next fresh probe must refuse a committed
revocation or see a canonical committed save. Legacy RC freshness remains its
own existing course. No statement-level freshness or immediate revocation of an
already admitted snapshot is claimed.

## Authored native controls, not yet executed

test/employee-draft-presentation-tx.test.ts contains10 ordinary real-DB cases:

1. Complete independent nonempty Draft DTO parity across legacy/standalone/
   borrowed owners. Actual session_user/current_user must be ai_hr_app, neither
   table owner nor superuser/BYPASSRLS. Repeated borrowed reads retain actual
   PID/full backend start/virtual transaction/native snapshot and RR/RO mode.
2. Real company-scoped, unassigned, absent and foreign-tenant null outcomes.
3. Canonically created linked author's read after actual HR-to-employee change,
   with a colleague's Draft still invisible.
4. Forged carrier identity, exemption/override, stale native grant move, fresh
   new-company access and archived-login refusal.
5. Admitted snapshot completion across real grant revocation, next fresh refusal.
6. Same snapshot across a separately committed canonical save; both next legacy
   and presentation reads see the complete independently expected updated DTO.
7. Real RC and RC/RO purpose refusal; actual DML and FOR UPDATE refuse25006 inside
   real nested-driver rollback while the valid outer RR/RO read remains usable.
8. A real open Access writer plus Draft row lock does not block display. Native
   diagnostic bounds are300ms lock/3s statement. The unchanged canonical save
   still refuses55P03 behind that Access barrier; after release it saves and
   appends the original audited update. Display reads take no advisory locks.
9. Caller array/grant mutation cannot change queued standalone/borrowed identity.
10. Abort before entry and after an actual delegated principal statement prevents
    the row SELECT and DTO publication; the actual settled carrier remains usable.

All business records use the existing canonical create/save/hire/config/company
writers. Owner connections only seed native login/grants, hold independent writer
actors, revoke/archive fixture principals and inspect evidence. No permission or
data result is mocked. The cancellation observer delegates to the real principal
statement and counts only whether a subsequent actual select was attempted.
Business-effect comparisons retain complete rows and native xmin versions for
Drafts, codes, counters, people, employments, assignments, compensation, events,
notifications and delivery.
They do not claim complete schema/ACL inventory or a production restore witness.

test/employee-draft-presentation-source.test.ts contains one complete source/body
inverse control. That is static reconstruction, not native semantic acceptance.
No special CI job profile is introduced: ordinary hosted DB classification and
the existing nonowner application fixture own these tests. This slice does not
mint a browser/native lease or qualify peak1 connection accounting for a composed
probe. Such adoption still requires the reviewed source/process/native lifetime,
statement cancellation, role/cohort/realm and aggregate budget design.

After root plus independent source review, run the two new selectors and the
affected existing Draft wizard/family/discard/activation/authority regressions on
standard GitHub-hosted Actions. Retain their actual source/controller/counts and
failed/affected-only recovery rules. Whole compiler, AI source admission, full
browser/module/worker qualification and release evidence remain separate gates.
No provider call, approval refresh, local behavior test/compiler/build/database,
upload or deployment occurred. No new PASS or release eligibility is declared.
Production remains held.
