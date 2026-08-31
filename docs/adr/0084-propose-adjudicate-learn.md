# ADR-0084 — Propose · adjudicate · learn: making the AI operational rather than advisory

- **Status:** Proposed (operating pattern + build order)
- **Date:** 2026-09-01
- **Builds on:** [ADR-0083](0083-hr-operations-control-plane.md) (HR operations as a control plane — this
  is how its agents are allowed to think), [ADR-0074](0074-autonomous-payroll-control-tower.md) (the
  invariant, restated below), [ADR-0076](0076-payroll-anomaly-layer-design.md) (detectors, verdicts,
  queue), [ADR-0082](0082-ai-assistant-access-scoped-tool-calling.md) (the tool registry and session-scoped
  loop), [ADR-0034](0034-notification-engine.md) (the delivery substrate initiative needs),
  [ADR-0006](0006-event-and-audit-substrate.md) (the event log).
- **Deliberately not:** a licence for a model to compute money, and not a rewrite. Everything below is a
  seam on machinery that is already deployed.

---

## 1. Why this document exists

The owner looked at the Control Tower's "How it works" page and said that if the AI is only there to
explain things, there is not much value in it. **That is correct, and the page is not even the worst of
it.** Three findings, all checkable in this repository today:

1. **Every AI call in this product waits for a human to click.** The narrator fires when somebody presses
   "Explain in plain words". The assistant answers when asked. `core/pay-rule-ai.ts` and
   `core/report-ai.ts` are buttons on setup screens. The ONLY thing in the system that acts unattended is
   a deterministic cron. The ceiling on that architecture is *a faster human* — which is precisely the
   thing ADR-0083 §2.5 says does not remove headcount.
2. **Nothing the AI produces is ever measured.** There is no edge, anywhere in the codebase, from an AI
   output back to an AI input. No proposal's outcome is recorded. **The loop is open**, so nothing can
   improve without a developer editing a prompt, and no one can answer whether any of it helps.
3. **The roster under-reports.** `agentStatuses` shows 6 rows, 2 of them `llm`. There are in fact six AI
   call sites in `core/` (`payroll-anomaly-narrate`, `assistant`, `pay-rule-ai`, `report-ai`, `feedback`,
   `performance`). The AI story is both thinner than it should be **and** worse told than it is.

For scale, so nobody re-derives it: **11 detectors** (`core/payroll-anomaly-detectors.ts`), of which
exactly one — `net-swing` — takes a tunable parameter; the rest are binary presence checks. **10 assistant
tools.** Zero resolved verdicts, zero assistant grants and zero exchanges on production.

---

## 2. Decision

### 2.1 The pattern already exists. Name it and promote it.

This repository invented the same pattern three times without naming it:

- `narrationIsFaithful(prose, facts)` — the narrator may write anything, but every number in its output
  must appear in the recorded facts, and prose that fails is **discarded, not caveated**.
- `core/pay-rule-ai.ts` — *"the model's job collapses from generate a fragile expression string to classify
  a sentence into one of ~6 kinds + extract a number… we parse it and run the SAME pure `validatePayRule`
  the UI and the kernel use."*
- `core/report-ai.ts` — the same shape again, against `validateReportSpec`.

Call it **propose · adjudicate · learn**:

- **Propose.** A model emits a STRUCTURED object into a CLOSED vocabulary. Never free prose that matters,
  never a number that matters. Classification and extraction, not generation.
- **Adjudicate.** The same deterministic code the kernel and the humans already use accepts or rejects it.
  **Rejection is silent and free**, which is what lets the model be bold: a bad proposal costs a discarded
  row, not a wrong payslip.
- **Learn.** The outcome is recorded against the proposal, so the system's own accuracy is a measurable
  quantity rather than an opinion.

The first two are built, in three places, for setup screens. The third does not exist anywhere. **§2.3 is
therefore the keystone of this ADR, and the cheapest thing in it.**

### 2.2 The invariant, restated and widened

ADR-0074's invariant stands **unchanged**: the LLM never computes the money. The deterministic, versioned,
golden-tested statutory kernel owns every figure.

ADR-0084 widens it into the general form, because "stay away from payroll" is not a design:

> **A model may propose anything. Nothing a model produced reaches a human, a record, or a document until
> deterministic code that the kernel or the UI already depends on has re-derived it.**

Two corollaries that are not negotiable and are the reason this is safe to expand:

- **A model may never raise a `block`.** It may propose a `review`. Blocking a payroll run is a
  deterministic decision (ADR-0076 §2.5, `resolveDisposition` is derived, never scored).
- **Adjudication failure is silent.** No screen ever shows "the AI said X but we could not verify it".
  That sentence transfers the burden of verification to the reader, which is the one thing the harness
  exists to prevent.

### 2.3 The proposal ledger — the substrate for self-learning

One table, `agent_proposal` (see the as-built note below on the name), written by every automated
proposer in the product:

| column | what it records |
| --- | --- |
| `proposal_type` | closed enum — `anomaly_narration`, `pay_rule_draft`, `report_spec`, `readiness_nudge`, `anomaly_hypothesis`, `input_triage`, `close_fixed_upstream` |
| `subject_type` / `subject_id` | what it is about (a verdict, an employment, a claim) |
| `input_digest` | hash of the facts the model saw — identical inputs become comparable across time and model versions |
| `proposal` | the structured output, jsonb |
| `adjudication` / `adjudication_reason` | **the machine's verdict** — accepted, or which check refused it |
| `decision` / `decided_by_user_id` / `decided_at` | **the human's verdict** — approved, declined, or still open |
| `reversed_at` / `reversal_reason` | **later reality** — somebody undid it |
| `model` / `provider` | so a regression can be attributed to a model change |

⚠️ **THE THREE VERDICT COLUMNS ARE SEPARATE ON PURPOSE, AND COLLAPSING THEM DESTROYS THE ENTIRE SIGNAL.**
Machine-verified, human-approved and later-reversed are three different truths, and their combinations are
three different failures:

- **adjudication pass rate** = accepted ÷ all — *is the model even producing valid output?*
- **agreement rate** = approved ÷ (approved + declined), over accepted proposals only — *when it is valid,
  is it right?*
- **reversal rate** = reversed ÷ approved — *was approval too easy?* A high agreement rate with a high
  reversal rate means the humans are rubber-stamping, which looks like success in every other metric.

A single "was it good?" column cannot distinguish "the model was wrong" from "the model was right and the
human disagreed" from "everyone was wrong and reality corrected them a month later".

**As built (r236, migration `0452`, `core/agent-proposal.ts`).** Four corrections and one caveat, all
learned in the build:

- **The table is `agent_proposal`, not `ai_proposal`.** ADR-0083 §2.5's action types are what §2.8's
  autonomy criterion is measured over, and **none of them involves a model** — `close_fixed_upstream` is a
  predicate. A ledger that excluded deterministic proposers would exclude the one type whose measurement
  matters most. `provider` and `model` are nullable for exactly that reason.
- **`reversed_at IS NULL OR decision = 'approved'` was unsound and a test caught it.** For an undecided
  row the right branch is NULL, so the expression is `false OR NULL` = NULL — and **a CHECK rejects only
  on FALSE, never on NULL.** It admitted precisely the row it forbids while reading as though it worked.
  It is `IS NOT DISTINCT FROM` now. Any future constraint over a nullable column has the same trap.
- **Recording runs in its own transaction and never throws into the caller.** A rejection almost always
  happens inside an operation that then aborts; a row written in that transaction would roll back with it,
  and the ledger would hold successes only — the pass rate structurally 100%, which is the exact inverse
  of its purpose. The corollary is a caller requirement: **never record from inside an open transaction**,
  since `withTenant` takes a second pooled connection.
- **RLS splits read from insert, and the split is load-bearing in both directions.** Read is admin-only,
  because a tenant-wide read would let any employee enumerate what the system proposes about their
  colleagues — the surveillance surface ADR-0082 §2.7 refuses. Insert is tenant-wide, because §2.5's
  nudge sweep runs in a system context and §2.7's triage runs in the employee's own session, and an
  admin-only insert would make those writes match **zero rows, silently**.

⚠️ **THE CAVEAT, AND IT AMENDS §2.8.** For `close_fixed_upstream` the **agreement rate is structurally
1.0 and proves nothing**: the approval screen is a batch, so an operator who simply does not press the
button leaves no trace, and a decline is unobservable. **The metric that means something for this type is
the REVERSAL rate** — did the closure stick, or did the finding re-fire next cycle (§2.4)? So the autonomy
criterion for a batch action type is reversal-led, not agreement-led. Making declines observable would
need per-subject selection on the screen, which is a separate decision.

**What has no caller yet, deliberately:** `recordDecision`, `recordReversal` and `proposalRates`. The
first two belong with the surfaces that produce their signal (an admin saving a drafted rule; §2.4's
recurrence sweep), and surfacing the rates is Phase 3 item 5 — a rate rendered before there is data to
render is the "tune the thresholds" mistake in a new coat.

**This is also the answer to the question that started this whole arc** — whether the control tower
actually helps. Not a staffing ratio inferred from exception counts (ADR-0083 §5 already refuses to print
one), but three measured rates per proposal type.

### 2.4 Self-correction: adjudication as a typed contract, and recurrence as a signal

Every proposal type declares `adjudicate(proposal, facts) → { ok: true } | { ok: false, reason }`, and the
ledger stores the reason. Today this logic exists three times in three shapes; it becomes one contract with
three implementations, and every new AI surface must supply one to be registered at all — the same
discipline ADR-0083 §2.5 applies to action preconditions.

The deeper form of self-correction falls out of the ledger for free: **a verdict closed as `fixed_upstream`
whose finding re-fires next cycle proves the fix did not hold.** That is the system detecting its own
error without anybody reporting it, and it is the honest version of ADR-0083 §2.6's learning target —
*which fixes eliminated recurring findings* — measured rather than assumed.

### 2.5 Self-nudging: give the agents initiative

Readiness (r234) knows exactly who has a gap. Today a human has to go and chase them, every cycle, and
**chasing people is where payroll headcount actually goes.**

A scheduled `readiness-nudge-sweep` closes that loop, with a strict division of labour:

- **Deterministic code decides WHO and WHETHER.** Which gap, whose record, which recipient, whether the
  rate limit allows it, whether a nudge already went out. None of this is a model's decision.
- **The model decides only HOW IT READS** — the wording, in the recipient's own locale, specific to the
  one missing thing.
- **Adjudication:** the draft must contain no figure at all, must name only fields present on the gap
  record, and must resolve in the recipient's locale. Failure means the nudge sends in the deterministic
  template instead — the loop still closes, just less warmly.
- **Delivery is ADR-0034's engine** (in-app, email, push), not a new channel.

⚠️ **A KNOWN CONSTRAINT, NOT A SURPRISE TO DISCOVER MID-BUILD.** ADR-0034's v1 notifies the event's
SUBJECT; approver-facing routing needs a reporting-graph resolver that is explicitly deferred there. Most
readiness gaps are the employee's own to fix, so v1 of this sweep addresses the employee and is useful
without that resolver — but any gap that only HR can close waits for it. Two escalation sweeps already
ship (`leave-escalation-sweep`, `employment-review-reminder-sweep`) and are the shape to copy.

**Effectiveness is measured, not assumed:** a nudge whose gap closes within the window worked. That is a
`reversed_at`-free, unambiguous outcome, and it is why the nudge agent is also the best first tenant of
the ledger.

**As built (r237, `core/readiness-nudge.ts`).** Three corrections and one divergence:

- **The routing table is read out of the product, not assumed.** Only `no_bank_account` has an ESS path
  (`app/me/actions.ts` carries `bankAccountNo` through an approval), so it addresses the employee and the
  other five gaps go to `hrAdminsForCompany`. The ADR feared the deferred reporting-graph resolver would
  block HR routing; it does not — that resolver is for APPROVER (manager) routing, and HR admins were
  always resolvable.
- **It is off per tenant by default, and nothing in the UI can turn it on yet.** No screen reads
  `SETTING_CATALOG`; activation is an operator/DB action, the same shape as the `assistant` module.
- **A gap with nobody to tell is recorded as a REJECTED proposal**, which was not in the ADR and should
  have been: "we know about this and there is nobody to chase" is otherwise invisible, and it makes the
  adjudication-pass rate for `readiness_fix` mean something real.
- **DIVERGENCE: bodies are English-only.** §2.5 asked for the recipient's locale. ADR-0034's engine
  renders a notification body ONCE and STORES it, so per-reader locale is a change to THAT engine, not to
  this agent. Deferred deliberately rather than bolted on beside it.

⚠️ **And `readiness_fix` turns out to be the only proposal type in the product with a REAL agreement
rate.** `anomaly_narration` has no human decision and `close_fixed_upstream`'s is structurally 1.0
(r236). Here the human's verdict is observable in the record itself — the gap closed within the settle
window, or it did not. **This is the first place the ledger can come back unflattering**, which is what
§2.3 was built for.

### 2.6 Judgment-grade detection: hypotheses, not rules

Eleven binary presence checks cannot see *"this is odd"*. They can only see what somebody thought to write
down. A hypothesis detector proposes what a rule cannot:

- **Input:** one person's own pay-history deltas plus peer-group shape as **aggregates and z-scores**.
  Raw money does not leave the tenant, in line with the PDPA posture `report-ai.ts` already documents
  (*schema out, never data*).
- **Output:** `{ claim, evidenceRefs, expectedRange? }` — a structured hypothesis, never prose.
- **Adjudication:** deterministic code **re-derives every `evidenceRef`**. If it cannot, the hypothesis is
  discarded and never becomes a finding.
- **Ceiling:** severity `review` only, forever. §2.2's first corollary.

### 2.7 Input-side triage: the largest untouched surface

Every payroll error is born upstream — in a claim, a timesheet, an overtime entry, a change request. It is
the highest-volume judgment work in HR and it is currently 100% human and 0% assisted.

Triage proposes `{ verdict: 'ok' | 'query', policyRuleId, reason }`. Adjudication requires the
`policyRuleId` to exist in the closed policy catalogue and any referenced figure to match the source
record. **It never rejects anything** — it queues a query for a human, or it stays quiet.

### 2.8 What earns autonomy

r235 shipped `AutonomyLevel` as a union with one member, deliberately, because §2.5 of ADR-0083 requires
autonomy to be earned per action type from **measured agreement** — and there was nothing to measure. The
ledger is that measurement. An action type becomes a candidate when, over a meaningful number of
proposals on **production data**, its adjudication pass rate and agreement rate are high and its reversal
rate is low.

⚠️ **The thresholds are a decision this ADR deliberately does not fix**, because picking them before any
real data exists would repeat exactly the mistake the owner corrected in r230 — reasoning from seeded
demo rows as though they were a payroll. **And the grant remains a source change either way.** Widening
that union is never a configuration flip, whatever the numbers say.

---

## 3. Build order

Sequenced by what unblocks what, and constrained by one hard fact: **production has no data yet** — zero
resolved verdicts, zero assistant grants, zero exchanges. Every learning item is therefore blocked on the
earlier items generating real history.

**Phase 1 — make the loop observable, and give the AI initiative.** No production data required.

1. **The proposal ledger (§2.3)** and the `adjudicate` contract (§2.4). Retro-fit the three existing call
   sites onto it; they become the first tenants and cost nothing new.
2. **The readiness nudge agent (§2.5).** The headcount win, and it needs no learning to be worth having.

**Phase 2 — put AI where judgment is.** Needs Phase 1's substrate, not its data.

3. **Hypothesis detection (§2.6).**
4. **Input-side triage (§2.7).**

**Phase 3 — close the learning loop.** Needs production history from Phases 1–2.

5. **Agreement measurement per proposal type**, surfaced in the Control Tower beside the existing rates.
6. **Recurrence mining (§2.4)** — which fixes actually eliminated recurring findings.
7. **The first autonomy grant (§2.8)**, as a source change, with its own review.

**And one thing that is not a build:** the roster must stop under-reporting (§1 finding 3). Every AI call
site in `core/` belongs on the How it works page, `feedback` and `performance` included.

---

## 4. What this keeps unchanged

- **The LLM never computes the money.** ADR-0074's invariant, untouched and load-bearing.
- **RLS is the retrieval filter.** ADR-0082 §2 — an agent reads inside its caller's session, and no
  proposal in this document changes that.
- **`resolveDisposition` stays derived, never scored** (ADR-0076 §2.5).
- **Every action still goes through the existing service**, so the RBAC check and the domain event are the
  ones already trusted (ADR-0083 §2.5, as built in r235).

---

## 5. Consequences

- **A new table and a new contract** every AI surface must satisfy. That is friction by design: an AI
  surface that cannot state how it would be checked does not get built.
- **Cost becomes visible and grows.** Initiative means calls nobody clicked for. The ledger records model
  and provider per proposal, so cost per accepted proposal is answerable — and rate limits are a first
  build requirement in §2.5, not an afterthought.
- **The nudge agent sends messages to real employees.** It is the first thing in this product that
  contacts a person without a human pressing send. Rate limiting, an opt-out and a per-tenant kill switch
  are part of item 2, not a follow-up — and unlike ADR-0083 §2.5's deferred kill switch, **this one is
  genuinely load-bearing, because here there is no button.**
- **Three rates will look bad at first**, and that is the point. A measured 60% agreement is worth more
  than an unmeasured claim of usefulness.

---

## 6. Alternatives rejected

- **Let the model compute or adjust figures, with a checker afterwards.** Rejected: the checker would have
  to be the kernel, at which point the model added nothing but risk.
- **Learn thresholds from dismissals.** Already rejected in ADR-0083 §2.6 and restated here because it is
  the obvious idea: a loop trained on "which alerts do humans dismiss" learns to stop flagging.
- **A vector store over HR data.** Rejected in ADR-0082 §2 and unchanged — RLS is the filter; a second
  copy of the data is a second authorization system that must agree with the first forever.
- **Wait for production data before building anything.** Rejected: Phase 1 is exactly the work that
  *produces* the data, and waiting is how the loop stays open forever.

---

## 7. The ceiling, stated so nobody promises past it

This does not make payroll autonomous. It makes the system's own accuracy **measurable**, gives its agents
**initiative**, and puts AI where **judgment** is rather than where explanation is. Headcount falls when
work stops arriving at a desk — §2.5 stops the chasing, §2.7 stops bad input, §2.3 makes it provable.
Everything past that is earned, per action type, on evidence that does not exist yet.

---

## 8. Notes for the next reader

- **The pattern is older than this ADR.** Read `core/pay-rule-ai.ts`'s header before designing any new AI
  surface; it solved this problem properly in 2026-06 and the reasoning is better than a summary of it.
- **`narrationIsFaithful` is 9 lines and is the whole idea.** Generalising it is §2.4.
- **Do not read the zero counts on production as a defect.** The assistant module is simply not activated
  and no verdict has ever been resolved. Turning those on is two steps by hand, and it is what starts the
  clock on every metric in this document.
