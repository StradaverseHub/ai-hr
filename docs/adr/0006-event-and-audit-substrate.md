# ADR-0006: Append-only domain-event & audit substrate

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** Founder (solo) + Claude (acting architect)

## Context

Auditability is a top-level engineering principle and, for HR/payroll data, a regulatory
expectation (who changed what, when, on whose authority). It also underpins transaction
time ([ADR-0001](0001-bitemporal-effective-dating.md)) and future AI context. Bolting
audit on after the fact produces an incomplete, untrustworthy trail.

## Decision

Maintain an **append-only `domain_event` log** as substrate. **Every state-changing
service method appends a domain event after its write succeeds, within the same
transaction.**

An event records: `tenant_id`, `aggregate_type` (e.g. `employment`, `assignment`,
`reporting-line`, `leave-request`), `aggregate_id`, `event_type` (past-tense, dotted —
`employment.hired`, `assignment.transferred`, `leave-request.approved`),
`actor` (`{ type: USER | SYSTEM | AGENT, id }`), `payload` (JSONB: `before` / `after` /
`diff` for changes), `occurred_at`, and a monotonic `sequence`.

- **Same transaction** as the business write ⇒ no event without its change, no change
  without its event.
- **Append-only.** No `UPDATE`/`DELETE` on the log (enforced by RLS/grants).
- **Actor flows from the controller**, extracted from the authenticated session — never
  defaulted to `SYSTEM` to paper over missing plumbing.
- **PII discipline:** payloads store identifiers and changed field *names/old-values*
  needed for audit, but must not duplicate sensitive bulk PII unnecessarily; salary-class
  data (when it exists) is referenced, not embedded.

### When *not* to append
Pure plumbing writes (heartbeats, derived caches), read-only operations, and
high-volume per-item rows that already have a dedicated ledger. Skips are documented with
an inline comment.

## Logging tiers & taxonomy

"Log everything" is correct **only when each kind of event goes to the right tier.** Three
tiers, three purposes, three stores — conflating them poisons all three:

| Tier | What | Purpose | Store | Retention | Mutable |
|---|---|---|---|---|---|
| **1. Domain / audit events** (this ADR) | business state changes + security events | System of record | Postgres | Years (legal) | **Append-only** |
| **2. Observability logs** | requests, errors, latency, traces | Operate & debug | Logging backend | Days–weeks | Transient |
| **3. Interaction / behavioural events** | workflow-step events, page views, (optional) clicks | UX analytics, process mining, AI behavioural signal | Separate analytics store | Configurable, **deletable** | Yes |

**In Tier 1 (this substrate):** every consequential action — create/update/delete of HR
data, approvals and workflow transitions — plus **security events**: login success/failure,
MFA, password reset, SSO, permission/role changes, data export, and (a planned expansion)
**sensitive-data *reads*** — who viewed salary, bank, or medical/leave-reason data.

**Never in Tier 1:** button clicks, hovers, scrolls, page views, uncommitted form edits,
health-checks. These go to **Tier 3** *if* we want them — not into the immutable audit log.

## The substrate as the AI / agent learning loop

The strategic purpose of this substrate is not only audit — it is to be the **training and
context corpus for AI agents that progressively take on human roles** (the "human–agent
matrix"). That goal sharpens *what* is worth capturing, and it argues **against** raw
click-logging rather than for it:

- **Agents must learn decisions, not mouse mechanics.** To approve leave like a good manager,
  an agent needs the decision's *inputs* (requester, balance, coverage, history, policy) and
  its *outcome and rationale* — exactly what a domain event carries. A click trace records
  *that* someone approved, never *why*. Training on clicks builds a UI-driving RPA bot — the
  opposite of an agent that exercises the *judgement*. (You record a chess engine's *moves and
  positions*, not video of the player's hand.)
- **Capture rationale and outcomes deliberately.** Enrich consequential events with decision
  factors / reasons, and link decisions to later outcomes (did approving cause a coverage gap;
  did a hire succeed). Reasoning + outcomes are the high-value signal, richer than any UI stream.
- **Human overrides of the AI are gold.** Once agents make suggestions, every human correction
  ("no — do it this way") is a labelled example of where the agent is wrong. Capture overrides
  explicitly; one is worth more than millions of clicks.
- **Agents act through the governed service layer**, so every agent action is *itself* a domain
  event with `actor.type = AGENT`. The same substrate audits humans and agents, enabling direct
  human-vs-agent comparison and a trust-earning path toward more autonomy.
- **Process mining** (finding automatable workflows) runs off *workflow-step* events in Tier 3
  — coarse, semantic steps ("opened leave approval", "started payroll run") — not raw clicks.

### AI governance guardrails (binding once agents act)

- **Purpose limitation / lawful basis.** Employee data collected to *run* HR, repurposed to
  *train agents that replace staff*, may exceed the original purpose/consent (PDPA; stricter
  under GDPR). Requires explicit purpose statements, lawful basis, minimisation, likely consent.
- **Bias.** Agents trained on historical human HR decisions inherit human bias (hiring,
  promotion, leave). HR decisions are discrimination-regulated — design for bias monitoring,
  not blind imitation.
- **Human-in-the-loop.** Every AI decision carries a confidence score, reasoning trace, audit
  entry, and human override; consequential actions (termination, compensation) are never fully
  autonomous.
- **Behavioural data is privacy-loaded.** Tier-3 interaction data on employees is monitoring —
  keep it minimised, purpose-bound, deletable, and out of the immutable audit log.

> A fuller AI-agent strategy ADR is warranted when AI work is actually scheduled; this section
> records the *intent* and its design implications so the substrate is built to serve it.

## Consequences

- (+) Complete, trustworthy audit trail from day one; basis for transaction-time queries.
- (+) A natural integration seam: projections/read-models, and later AI context and a
  self-improvement loop, consume the log instead of polling tables.
- (−) Discipline cost on every write path; verified by grepping write methods against
  `events.append` calls in review.
- (−) The log grows quickly; partition by `tenant_id` / time and archive cold partitions
  (deferred until volume warrants).

## Alternatives considered

- **Full event sourcing as the source of truth for all aggregates.** Rejected as
  over-engineering for Slice 0: we keep current/temporal state in tables and use events as
  an authoritative audit + integration log. Event sourcing is scoped to money/org-history
  where replay genuinely pays off (revisit with payroll).
- **Database triggers writing audit rows.** Rejected as the *primary* mechanism: triggers
  can't capture business intent (`event_type`, actor semantics) cleanly. A trigger may
  still backstop tamper-detection later.
