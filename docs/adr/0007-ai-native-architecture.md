# ADR-0007: AI-native architecture & the self-improvement loop

- **Status:** Accepted — *stances binding now; implementation deferred to Phases B–E*
- **Date:** 2026-06-05
- **Deciders:** Founder (solo) + Claude (acting architect)

## Context

The [north star](../architecture/north-star.md) is an AI-native, self-improving HR platform:
an assistant, agents that take on human roles, a self-improvement loop, external market/
compliance watch, and connectivity to outside systems. The AI *features* are deferred behind a
stable HR core — but several architectural commitments must be made **now** so the foundation
stays AI-ready and safe. Retrofitting access-control-aware AI, audit of AI actions, or a governed
external boundary into a system that didn't plan for them is painful and dangerous.

This ADR records the binding stances. Each capability earns its own discovery, threat model, and
ADRs when scheduled.

## Decision

1. **One AI Gateway — no direct model calls.** Every model invocation flows through a single
   module owning model routing (cheap→expensive by task), caching, cost budgeting, PII redaction,
   prompt-injection defense, and audit. Feature code never imports a model SDK directly.

2. **Agents are principals, not backdoors.** An agent has an identity, is assigned roles, and is
   scoped by the *same* RLS/ABAC ([ADR-0004](0004-authorization.md)) as a human — it can never
   see or do more than its granted scope. Every agent action is a governed service call, audited
   as a domain event with `actor.type = AGENT` ([ADR-0006](0006-event-and-audit-substrate.md)).
   This makes the human–agent matrix fall out for free and means our existing authorization
   *already* governs AI.

3. **Access-control-aware retrieval.** Any retrieval/RAG filters by the requesting principal's
   tenant + RLS/ABAC scope *before* content reaches the model — an employee's assistant can never
   surface another's salary. Vector/derived stores are per-tenant isolated; sensitive fields are
   redacted unless the principal is authorized.

4. **A Signals / Insights substrate.** Everything the AI *flags* — an improvement, an anomaly, a
   detected compliance change, a market event — is a first-class, audited record carrying: source/
   provenance, evidence, confidence score, status (`proposed → reviewed → actioned | dismissed`),
   and human disposition. Signals are reviewed, never auto-applied.

5. **A governed tool / integration gateway is the only path outward.** All external connectivity
   and all agent actions go through a typed tool registry with a per-tenant credential vault and
   full audit. External/ingested content is **untrusted by default** (prompt-injection / data-
   poisoning posture), sandboxed, and can never by itself trigger an action. No feature makes
   ad-hoc outbound calls.

6. **Human-in-the-loop by default; "self-improving" = propose → approve.** The system observes
   and *proposes*; humans approve. Nothing auto-modifies compliance or payroll logic. Proposed
   changes pass an evaluation/safety harness (sandbox / A-B / reversible) before production. Every
   AI decision carries a confidence score, reasoning trace, audit entry, and human override.
   Consequential actions (termination, compensation) are never fully autonomous.

7. **Compliance rules are effective-dated data, not hardcoded.** Statutory rates, retention
   periods, and entitlements live in a machine-readable, effective-dated registry
   ([ADR-0001](0001-bitemporal-effective-dating.md) applies) so a watcher can compare
   current-vs-external and flag drift with provenance, and so corrections are auditable.
   Authoritative sourcing + human verification are mandatory before any compliance signal reaches
   a customer.

## Consequences

- (+) The AI future is unblocked by today's foundation; these stances cost little now and prevent
  expensive, dangerous retrofits.
- (+) Authorization and audit already cover agents — AI is not a privilege-escalation backdoor.
- (+) Cost, safety, and provenance are structural, not bolted on.
- (−) Indirection now: an AI Gateway and tool gateway must exist before the *first* AI feature,
  even a small one. Accepted — the alternative is ungoverned AI.
- (−) Discipline cost: features must resist calling models or external APIs directly (enforced in
  review).
- (−) Access-control-aware retrieval is harder than naive RAG — and is the only acceptable option
  for PII.

## Alternatives considered

- **Let features call model SDKs / external APIs directly, govern later.** Rejected: no cost
  control, no injection defense, no audit; ungoverned AI over PII is a breach waiting to happen,
  and retrofitting a gateway across scattered call sites is costly.
- **Naive RAG over all tenant data.** Rejected: it would leak across the RLS/ABAC walls the rest
  of the system enforces.
- **Autonomous self-modification / auto-applied compliance changes.** Rejected: wires legal and
  financial liability to model output. Propose→approve with an eval gate is the safe form.
- **Defer all AI-readiness decisions until AI work starts.** Rejected: access-aware retrieval,
  agent-as-principal, and audit-of-AI are foundational; deciding them late forces a reshape of
  authorization and the event model.
