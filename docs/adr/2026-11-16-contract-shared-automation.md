# Contract Management on shared HR Automation

Status: owner-approved direction, 16 November 2026; implementation and verification in progress.
Extends `2026-11-15-probation-shared-automation.md`. Installation is a separate verified release.

## Decision

The owner reviewed the Contract Management tracker, Renew/Convert/End decisions, consequence preview, case progress,
letter review/signing, Personnel postings, manual pay confirmation, access/settings and shared Workflows, then
authorized implementation and staging integration. The supplied Contract handoff owns the detailed intended
behaviour; the reviewed navigation overrides its placement of shared builders under On/Off Boarding.

- HR Automation owns the shared Workflows, document/email Templates and Assignment groups with named routing.
  Extend the existing shared engine and module catalogue; do not create another workflow engine.
- Contract Management owns its case/period, decisions, pending posting queue, pay-entry confirmations, access,
  fallback-group choice, posting-approver-group choice and stalled-case threshold.
- New decisions are Renew, Convert to permanent and End. Conversion creates no probation. Decision approval is
  configured in workflow layers; remove default Rewards review and separate mandatory PBP confirmation for new runs.
- Document generation waits for the document's Review/Approve/Sign routing. A separate signature-wait workflow step
  is not offered for new Contract workflows. Text and live merge values freeze at first signature (or release for
  Review/Approve-only documents). Exactly one owner is required. Send-back resets the current round, retaining audit.
- Missing employee sign-in holds that employee's signature; fallback may not substitute a signer. HR with Record
  declines records an employee decline only while the renewal employee signature is pending.
- Pending Personnel postings change records only on authorized approval. Renewal closes the old contract period,
  not the employment. Native Personnel ownership, effective dates, source revisions and movement history remain.
- Contract never writes salary for new flows. People Ops enters salary in native Payroll, then an authorized
  posting approver/admin records the separate confirmation. Changed-pay cases stay open until that confirmation.
- Signed Contract letters remain on the case. Preserve historical employee-file copies and their evidence.
- Endings hand off to the canonical Offboarding module once the letter releases. Until clearance exists, the owner
  selected manual termination entry by People Ops in Personnel Management. Do not implement simulated clearance or
  automatically create ending postings. Leave an idempotent clearance-completed seam for a later build.
- Contract notifications use OneHR email only. Leave/task-limit-aware round robin, extra notification channels and
  Probation catch-up remain deferred. Do not claim those capabilities in copy without implemented evidence.

## Identity, access and cutover

Preserve tenant, company, person, employment, case, document and period identities. Roles grant named capabilities;
assignments scope them by company/business group and dates. Superior access defaults to own-team view/submit only.
Current-pay visibility is independent of submitting proposed terms; a proposer may enter an agreed salary without
receiving the protected current salary. The server omits current pay from every unauthorized projection.

Use an explicit version-2 flow adapter for new work. An old accepted-contract automatic effect and a new posting must
never both apply. Inventory active legacy states and receipts before cutover; retain existing subtype, retirement
custody and signed evidence rather than silently simplifying legacy cases. Old runs pin their old definition.

Posting group/admin authority is distinct from native movement-editor and Payroll write authority. Correcting a
posting keeps it pending unless the actor also holds approval authority. Group changes must not implicitly approve
or apply pending work. Signed employment outcomes remain human actions; models propose none of these decisions.

## Verification and release

Prove decision/date/amount validation, permission denial, stale actions, routing order/parallelism, owner send-back,
first-signature value freezing, missing-employee holds, posting idempotency, conversion without probation, manual-pay
closure, new-period pay carry-forward, scheduler deduplication and shared-module regressions. All changed read paths
require set-based pagination and the repository's 70-company/1,000-employment fixtures. Apply new migrations as the
restricted owner with a populated baseline and fresh ledger watermark checks.

Run hosted focused checks, whole type checks and the authenticated release gate against the frozen candidate. Follow
the staging queue/lease and verify actual source, build, ledger, health and rendered journeys. Staging authorization
does not authorize production installation or an invented human acceptance. Legal confirmation of simplified
signature evidence remains a production go-live prerequisite.
