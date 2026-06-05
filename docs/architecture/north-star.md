# North Star — an AI-native, self-improving HR platform

Records where `ai-hr` is *ultimately* going, so every near-term decision can be checked
against it. The HR core is the **foundation**; the differentiator and end goal is an
AI-native system that observes itself, watches the outside world, and continuously
**proposes** improvements — with humans in control.

> **Ambition in the architecture; restraint in the build order.**
> The core HR functions must be stable and available *first*. Nothing here justifies
> destabilizing them.

## The end goal (founder's intent)

- A **self-improving** system.
- Captures **market watch** and flags improvements.
- Flags **compliance changes** and the actions they require.
- Stays ahead — **AI-ready by design**.
- Future enhancements made *with* AI.
- **Connects to and searches across external systems**.

## We are not starting from zero

The foundation already laid *is* the AI substrate:

- **Domain-event log** ([ADR-0006](../adr/0006-event-and-audit-substrate.md)) — the corpus of
  every decision, its rationale, and (linked) its outcome.
- **Bitemporal history** ([ADR-0001](../adr/0001-bitemporal-effective-dating.md)) — replayable
  "as we knew it then" context.
- **Governed service layer + `actor = USER | SYSTEM | AGENT`** — agents act and are audited
  like humans, enabling the **human–agent matrix** (compare human vs agent on the same task).
- **Access-controlled data** ([ADR-0002](../adr/0002-multitenancy-rls.md) /
  [0004](../adr/0004-authorization.md)) — the prerequisite for safe AI-over-PII.

## Capability map (the AI layer, decomposed)

1. **Assistant / copilot** — natural-language access to HR; retrieval over the tenant's *own*
   data; access-control-aware.
2. **Agentic automation** — agents that take on tasks/roles (triage, onboarding, approvals)
   with human-in-the-loop; learn from the substrate and from human overrides.
3. **Self-improvement loop** — observes the event log; mines processes; detects
   anomalies/bottlenecks/errors; **proposes** improvements (config, policy, workflow) for human
   approval. *Never self-deploys to payroll or compliance.*
4. **External intelligence (market & compliance watch)** — scheduled watchers monitor
   *authoritative* sources (regulators, government portals) and market sources; detect change;
   map it to internal impact; raise **Signals**. Accuracy, provenance, and human verification
   are mandatory.
5. **Connectivity / integration gateway** — a governed, audited tool layer (MCP-style) for
   outbound connectivity and search across other systems (accounting, payroll providers,
   LHDN/MyInvois, job boards, comms). Agents act **only** through registered, permissioned,
   audited tools.

## Architectural enablers (build later; design the seams now)

- **AI Gateway** — *all* model calls flow through one module: model routing (cheap→expensive),
  caching, cost control, PII redaction, prompt-injection defense, and **every AI call audited**.
  Features never call model SDKs directly.
- **Access-control-aware retrieval** — retrieval filters by the requesting principal's RLS/ABAC
  scope *before* the model sees anything; per-tenant isolated vector stores.
- **Signals / Insights substrate** — a first-class aggregate for flagged items (improvement,
  anomaly, compliance change, market event): source, evidence, confidence, status
  (`proposed → reviewed → actioned | dismissed`), and human disposition. Itself audited.
- **Policy-as-data / compliance registry** — machine-readable, *effective-dated* representation
  of the rules we honor (statutory rates, retention periods, entitlements) so a watcher can
  compare current-vs-external and flag drift. (Ties to the payroll kernel + rule-packs direction.)
- **Tool / integration gateway** — typed registry of external tools + per-tenant credential
  vault + audit; the only path for outbound and agent actions.
- **Agent runtime** — define (role, tools, guardrails, model), run (triggered/scheduled),
  govern (confidence, reasoning trace, human gates).
- **Evaluation & safety harness** — proposed improvements are sandboxed / A-B tested /
  human-approved / reversible **before** they touch production. A self-improving system without
  an eval gate is a liability, not a feature.

## Governance (binding once AI acts)

- **"Self-improving" = self-*observing* and *proposing*; humans approve.** Nothing
  auto-modifies compliance or payroll logic.
- **Compliance & market signals require authoritative sources + provenance + confidence +
  human verification.** A wrong "the rate is now X" is *legal liability*, not a bug.
- **External content is untrusted** (prompt-injection / data-poisoning posture); ingestion is
  sandboxed; scraped text can never steer an agent into an action.
- **AI-over-PII**: access-aware retrieval; no training on customer data without lawful
  basis/consent; purpose limitation; **bias monitoring** for HR decisions; human-in-the-loop
  for consequential actions.
- Every AI decision carries a **confidence score, reasoning trace, audit entry, and human
  override.**

## Sequencing (HR core first; layer AI in stages)

| Phase | Focus | Risk posture |
|---|---|---|
| **A — Stable HR core** *(current)* | Slice 0 spine → core HR modules. Substrate + seams make it AI-ready. **No AI features yet.** | Lowest |
| **B — Assistant (read-only)** | AI Gateway + access-aware RAG; answer questions over the tenant's own data. | Low (read-only) |
| **C — Agentic (assist → act with approval)** | Agents draft/suggest; humans approve; capture overrides. Signals substrate lands here. | Medium |
| **D — Self-improvement loop** | Process mining + anomaly detection → improvement Signals → human approval → eval harness → rollout. | High (gated) |
| **E — External intelligence + connectivity** | Tool/integration gateway; compliance & market watchers — **narrow and authoritative first** (a few MY statutory sources), expand cautiously. | High (gated) |

Each phase ships only after the previous one is stable. **Solo reality:** this is a multi-year
arc — possibly a platform play larger than one founder can fully build. The value of recording
it now is that *nothing we build today blocks it,* and we can raise resourcing against a clear
north star.

## What this changes in the near term

Almost nothing in Slice 0 *code* — and that's the proof the foundation is right. It adds:

1. an **explicit AI pillar** to the roadmap (this document);
2. a set of readiness **stances**, now formalized as
   [**ADR-0007**](../adr/0007-ai-native-architecture.md) (AI Gateway, access-aware retrieval,
   Signals substrate, tool gateway, human-in-the-loop, untrusted-external posture);
3. a standing check on every near-term decision — *"does this keep us AI-ready?"* — which, by
   substrate, it does.

> Status: **north-star intent, to be refined.** This captures direction, not a committed
> feature spec. Each phase earns its own discovery, threat model, and ADRs when scheduled.
