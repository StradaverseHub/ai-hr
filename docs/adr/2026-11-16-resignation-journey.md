# Resignation journey on shared Configuration

Status: accepted direction, 16 November 2026; updated 17 November. Staging is conditional on complete verification, accepted Board-first integration and guarded queue admission. Production is not authorized.

## Decisions

The owner reviewed the supplied resignation HTML and AIHR merge mockups and authorized implementation, then held release for approval. The later direct coordination approval permits staging only after the work is complete and verified, with Movement releasing first. Movement is now accepted; the current owner-directed order releases the approved Board items before Resignation, then Audit, with Contract held. The renewed handoff review and latest engineering-convention checks must finish before that admission; no readiness is inferred from this approval. Configuration is shared: reuse Workflows, Templates (documents and emails), Assignment groups and named routing rules. Keep operational Leavers, checklists and source-filtered Personnel postings in Offboarding. Existing module and company permissions remain authoritative.

The owner explicitly chose **termination at completed clearance**, following the handoff. For new managed resignation journeys, accepting a resignation starts the configured acceptance-letter and Offboarding workflow; it does not call the old acceptance/termination command or freeze leave. Completed clearance raises one Termination posting. Authorized approval applies the existing employment movement and required leave/final-pay consequences atomically. There is one writer of employment truth, and a repeated clearance or posting approval cannot repeat it.

Previously accepted requests and pre-cutover in-flight requests keep their recorded outcome and owner. Do not replay acceptance, synthesize signed letters or move historical termination dates. Managed and legacy paths must be explicit and must not both present an actionable decision for the same request.

The handoff wins where its text and HTML differ: the decision form includes an editable agreed last working day and displays monthly salary cost change as well as the percentage. Replacement recruitment follows the durable HR follow-up described below, with HR recording the recruitment request reference.

## Owners and contracts

- Personnel owns approved employment, position, grade and basic salary through its current effective-dated movement writer. A retention offer contains proposed values only.
- Lifecycle owns the resignation journey, keyed by the existing resignation request UUID, with a new readable case number, history, optimistic revision and linked Offboarding case.
- The shared automation runner owns workflow selection, conditions, immutable started definitions and waiting runs. Offboarding registers its catalogue and injects authorized step executors; it does not fork the runner.
- The resignation aggregate is the single persisted owner of its letter instances, signatures, revisions and frozen released snapshots. It reuses existing shared pure signing/routing primitives and V9 document projection; it does not mirror mutable truth into the currently Probation-specific signing store. Shared document blocks own letter structure. Optional Offboarding capabilities provide recall, correction while held and invalidation of signatures after used merge values change. They must not alter other modules' behavior.
- Assignment groups and routing remain the current shared records. A role label or an FYI assignment is not a decision or salary-disclosure grant.
- Authentication owns email identity resolution and the applied relay. A business transaction queues immutable delivery intent; the private sender receives only a durable delivery ID and a single-attempt capability. SMTP never runs under a business lock. A started delivery with a lost receipt is uncertain and is not automatically replayed.

The public journey interface is `packs/lifecycle/service`; its resignation subdomain implementation remains internal to that facade. Web and worker consumers use the declared pack boundary. Reads authorize and narrow the native set before detail projection, page/count in SQL, and preserve tenant/company isolation. Inboxes project their bounded stored case set without one context query per item. Mutation authorization, state changes, audit and delivery intent share a transaction. The Lifecycle import guard covers the resignation aggregate, letter, clearance and proof implementations, with no outside-import allowlist debt. Cross-pack composition uses named operations through the facade; email admission fixes its operation and payload shape rather than exposing generic proof minting.

Private aggregate reads and derived state writes require short-lived, transaction-bound service proofs, following the organisation admission precedent. A domain-separated derived verifier is provisioned through the restricted owner; runtime SQL cannot read its key or mint proofs. Claims bind tenant, actor, operation, case and exact arguments. Native permission and transition checks still apply. Missing verifier material fails closed; provisioning and populated-upgrade checks are explicit release steps. Signed email intent binds exact recipients, content and released document snapshots, rather than trusting a reader's arbitrary JSON.

## Journey rules

A submission opens Decision. The configured decider accepts or proposes retention; configured FYI people may comment without acquiring decision rights. The acceptance path creates one linked Offboarding case. The retention path reviews and signs an e-letter, whose sole final employee Sign step is acceptance. Acceptance closes the resignation as Retained and creates the configured pending Personnel posting.

Missing decision configuration must not prevent recording the employee's resignation. Keep the case in Decision, record its repair flag and notify the actual configured GBS audience. A current repair assignee or scoped configuration administrator can explicitly run the currently Live workflows again while no decision is assigned. Earlier runs remain immutable evidence; this is not an automatic replay or a configuration-editing grant.

AIHR's existing requisition creates equipment/access requests for onboarding, not recruitment vacancies. Choosing a replacement therefore opens a durable HR follow-up in the resignation case, assigned to the configured People Ops recipients. HR records its recruitment request reference when complete. This does not create a fictitious replacement employee or claim an external recruitment integration.

An Offboarding case is managed only when the journey and case have matching tenant, company, employment and reverse links. Such cases retain the existing clearance checklist and returns, while their automatic document/email workflows belong to the shared resignation runtime. The earlier communication runner must not generate a second acceptance letter. Existing cases retain their earlier behavior. The Documents panel reads linked acceptance letters without copying them; unrelated manual clearance forms remain available. Checklist references to journey-owned letters require explicit configuration review, never guessed matching or automatic completion.

Assigned account users can decide, comment and complete ordinary tasks without an Employment or Person record. Shared letter actions retain the existing signing engine's verified Person requirement. Letter assignment excludes accounts without that identity, or reports an explicit configuration blocker for an ineligible named reviewer; it never fabricates a Person identifier.

A decline or lapse returns the same case for an accept-only decision. Owner withdrawal/rejection is a distinct path that can reopen an offer. Send back and recall clear signatures and return the document to its owner; sending round again restarts at the first step. A future signer cannot read a private letter before their turn. Released values and the generated letter date remain frozen.

The reply clock starts when the offer reaches the employee. Use the repository HR date owner and applicable working-day calendar; a date-only field is never converted through the host timezone. The offer is open on its reply-by date, with lapse after that date. Reminder and lapse processing is durable and idempotent. Blank reply window disables the date, reminder and lapse. Return/recall stops the clock, and a new employee round starts a fresh window.

An employee may submit a new resignation after Retained or Withdrawn. Each case and its pending posting retain their own snapshots. The Offboarding setting defaults to no second retention offer within 12 months of earlier acceptance (blank means no limit; explicit values are integers 1–60). This restricts offers, never the ability to resign again.

The Offboarding posting approver is a separate setting from Probation's. A change to a populated group moves pending Offboarding postings to that group. An empty group retains existing assignments with a warning and blocks new postings. A failed new posting points People Ops to the Offboarding Personnel postings setting; the failed signing transaction remains uncommitted until the configuration is repaired and the action is retried. Visibility is restricted to authorized, company-scoped People Ops and the posting approver group; only authorized People Ops can retry blocked runs. Group membership never bypasses the Personnel movement writer's permission.

## Compatibility and release

New stored fields are optional with backward-compatible defaults. Existing workflows, template versions, rich email content/assets, signatures, task types and source IDs must survive unchanged. Explicit default routing behavior for Offboarding must not silently change other modules' missing-recipient rules. Deleted or empty targets that cannot resolve an eligible person block with a specific repair action.

Offboarding-only triggers, decision/posting options and resignation/retention merge fields are scoped to their catalogue. A shared navigation destination does not rewrite other modules' engines or infer new authority. Keep Probation's mandatory-signature validation scoped to Probation.

Before staging, retain affected-module baseline evidence, execute new journey/permission/concurrency tests and existing cross-module regressions on the required standard GitHub-hosted runners, rehearse the additive migrations as the restricted owner on a populated baseline, verify the final frozen candidate through the current release gate, and follow the shared staging queue/lease. Source merge, installed build, rendered journey verification and human staging acceptance are separate states. Production is outside this authorization.

## Handoff fidelity corrections — 17 November 2026

The renewed source and rendered review found gaps in the first implementation. Fixes remain subject to hosted
behavior, compiler, migration and rendered verification; source integration alone is not a release witness.

- Letter group assignments freeze eligible account IDs and their actual Person IDs when routing is generated.
  A chosen routing holder remains immutable selection evidence. Any frozen eligible teammate can act on the
  pending step with their own identity; the first person “on it” is advisory, never an exclusive lock. Read
  projections and native effects both respect the frozen Person binding after an account is re-linked.
- Required local document fields use explicit native-authorized field IDs. Mapped Personnel fields stay read-only.
  Saves retain pinned field definitions, evaluate conditional visibility against the proposed values and preserve
  drafts on unrelated case refreshes. Used-value changes invalidate affected signatures; completed released
  values remain frozen. An incomplete draft may be saved, but required release checks are never bypassed.
- The prototype's three no-routing HR-signature choices do not correspond one-to-one to AIHR's existing
  `hrStep` enum. Optional Offboarding-only `offboardingHrSignature` represents PBP before release, HR before
  employee, or named HR before release. Explicit version routing remains authoritative. Existing records without
  the new field retain their prior `hrStep` behavior; no value is reinterpreted for another module.
- Letter-step conditions represent Update and Released explicitly and match each pending action in a parallel
  stage. The no-PBP skip uses the canonical company-scoped People BP resolver in execution and dry runs.
- Per-case communications inspect pinned workflow runs and the canonical renderer. Authorized tests queue an
  immutable copy only to the actual actor, with no CC. Request receipts provide idempotency and preserve
  uncertain outcomes. Required files and exact released attachments remain guarded. No legacy communication
  runner is restored, and SMTP remains outside the business transaction in the existing private worker.
- Configured Offboarding exit classification comes from the exact pinned Start offboarding workflow step and
  the linked native case. It is distinct from the resignation source and the employee's narrative; the existing
  employment writer retains ownership of recorded employment and leave consequences.

The correction migration reservation is 5788–5790. Existing 5783–5786 SQL bytes are preserved. Movement releases
first; its accepted source and actual ordered ledger must be integrated before the final release evidence.
The shared queue and staging lease remain mandatory. Contract's separate renewed hold and foreign migration
reservations do not authorize any action in this branch. Production and package publication remain outside scope.
