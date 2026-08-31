# ADR-0083 — HR operations as a control plane: closed-loop automation with graduated agent autonomy

- **Status:** Proposed (target operating model + build order — supersedes ADR-0074's operating model)
- **Date:** 2026-08-31
- **Supersedes:** [ADR-0074](0074-autonomous-payroll-control-tower.md) §"the reframe", §5's build order,
  and its items 2 and 7. **It does NOT supersede 0074's invariant** — the LLM still never computes the
  money, and that is restated below because it is the load-bearing constraint of both documents.
- **Builds on:** [ADR-0076](0076-payroll-anomaly-layer-design.md) (the detector/verdict/queue substrate,
  built and deployed), [ADR-0082](0082-ai-assistant-access-scoped-tool-calling.md) (the tool registry and
  loop that run inside the caller's own session), [ADR-0006](0006-event-and-audit-substrate.md) (the event
  log every action here is appended to), [ADR-0002](0002-multitenancy-rls.md) /
  [ADR-0004](0004-authorization.md) (RLS/ABAC — the reason an agent cannot read past its caller).
- **Deliberately not:** a rewrite. Everything below plugs into machinery that is already deployed.

---

## 1. Why this document exists

ADR-0074 set out to run a 3,000-person payroll with three people, and framed it as one number: the
auto-clear rate. Its keystone — the anomaly layer — has been live since r177 and the surrounding items
shipped through r229-r232: the nightly sweep, the cross-run Control Tower, the narrator, and the
employee-facing explanation agent.

Three things have become clear in the building, and together they change the target rather than the
tactics.

**FIRST: the auto-clear rate is a lagging indicator, and optimising it optimises the wrong end of the
pipe.** A payroll run is where bad input becomes visible, not where it originates. Detection at run time
is a smoke detector in a kitchen where people keep starting fires: valuable, and not a fire-prevention
strategy. Every finding a detector raises about a missing bank account or absent attendance describes a
record that was already wrong before the run began.

**SECOND: the model counts instances where the work is caused by classes.** The queue treats each verdict
as a unit to clear. But an employee with no bank account is flagged every cycle, for the same reason,
until somebody changes the record. Clearing that finding N times is N times the cost of fixing it once,
and ADR-0074 has no concept of recurrence: no "this is the seventh month", no fix-the-cause disposition,
and no metric that rewards elimination over disposal.

**THIRD, AND THE MOST CONSEQUENTIAL: payroll-run verification is a minority of HR operations time.**
0074's headcount arithmetic is exceptions ÷ throughput, which silently asserts that reviewing exceptions
is what the staff do. It is not. Query handling, record administration and onboarding/offboarding admin
dominate, and none of them appears anywhere in 0074's model — so a plan that perfects exception review
can succeed completely and leave the headcount roughly where it was.

> ⚠️ **A NOTE ON EVIDENCE, SO NOBODY CITES A NUMBER THIS DOCUMENT DOES NOT HAVE.** The demo tenant's
> anomaly findings were examined while drafting this and are **NOT evidence for any claim here**. They are
> seeded data: their distribution reflects the seed script, not a real payroll. Any statement in this ADR
> about where HR time goes is an industry prior, not a measurement of this system, and the first real
> tenant month should be treated as the first actual data point. **r232's HANDOFF entry recorded "tune the
> thresholds" as the top priority on exactly that mistaken basis; the correction is recorded there.**

---

## 2. Decision

Adopt **HR operations as a control plane**: one substrate that detects, explains, proposes and — under
graduated, per-action-type autonomy — *acts*, across every operational loop rather than only the payroll
run. The Control Tower stops being a payroll feature and becomes the first **domain adapter** on it.

### 2.1 The target, restated

ADR-0074's target was a ratio: 3 operators per 3,000 employees. Replace it.

> **HR operations ceases to be a staffed function.** Payroll runs as a background process with a monthly
> sign-off; HR administration becomes exception-only; the people who remain do employee relations,
> investigations, negotiation and judgement — not data.

This is both more aggressive and more honest than a ratio. More aggressive because a ratio implicitly
concedes a standing admin team. More honest because it names what does **not** go away (§7), instead of
leaving a reader to infer that "3" eventually becomes "0".

### 2.2 The pattern is domain-agnostic, and that is the whole insight

Strip the payroll nouns from what ADR-0076 built and what remains is not about payslips:

```
deterministic detectors  →  typed findings carrying provenance
                         →  optional LLM narration that CANNOT change a verdict
                         →  a work queue with human disposition
                         →  metrics that gate how much autonomy is granted next
```

Nothing there is payroll-specific. It is a control plane for operational HR, currently welded to
`payroll_batch` — which is precisely why it can only see one loop out of eight.

**So generalise the substrate and let payroll be an adapter.** A domain adapter supplies: what a *subject*
is (an employment, a joiner, a record), when evaluation is triggered (a run, a change, a schedule), its
detectors, and its available actions. Verdicts, findings, narration, the queue, the metrics and the
autonomy machinery are shared. Payroll's adapter is the existing code with a seam cut in front of it.

### 2.3 Shift left: readiness is continuous, not per-run

The single highest-leverage change, and it needs no new detectors.

Today evaluation runs **after** `generatePayslips`. Run the same checks **continuously against the
record**, not against a computed run, and express the result as a **fix list with an owner** rather than a
finding list with a severity:

- *"14 employees have no bank account. Payment will block. Here they are, with the last person who edited
  each record."*

A record is either operationally ready or it has a named gap. The same completeness that blocks a payslip
also blocks an EA form, a bank file and a statutory return, so one loop serves all of them. The economics
invert: **a fix is permanent; a review recurs every cycle.**

### 2.4 Track causes, not instances

Add a persistent **issue** keyed by (subject, detector) that survives across evaluations, carrying a
recurrence count and a resolution vocabulary that distinguishes *fixed at source* from *accepted this
time*.

- The queue sorts by **findings eliminated per fix**, not by severity.
- The headline metric becomes **elimination rate**, beside — not replaced by — MTTR.
- A chronic issue is visually distinct from a new one, because they demand different verbs.

### 2.5 The action layer — the part that actually removes headcount

Everything shipped so far is **read-only**. Read-only AI makes people faster; it does not remove them.
Agents must be able to act, and this is the shape that survives an audit:

- **Typed actions with preconditions, never free-form writes.** `SetBankAccount{employmentId, value,
  sourceDocumentId}`, not "the agent may update". A closed vocabulary is reviewable; a general write
  capability is not.
- **A reversibility class on every action type.** Irreversible actions never auto-execute, at any autonomy
  level, ever.
- **Blast radius is a first-class gate.** One subject and four hundred subjects are different risks and
  earn different thresholds independently.
- **Autonomy is granted PER ACTION TYPE, earned from measured agreement.** Not ADR-0074 item 2's single
  global confidence dial — that requires one accuracy claim covering unlike things. "Fill a missing SOCSO
  number from the statutory registry" can be autonomous long before anything touching a rate is.
- **Every proposal and execution is a domain event** (ADR-0006), so the whole thing replays.
- **A kill switch and a per-tenant daily action budget.** The failure mode of an agent with write access is
  not a wrong action, it is a thousand of them.

### 2.6 The learning loop learns fixes, not thresholds

ADR-0074 item 7 proposed override analysis → threshold tuning. **Reject that target.** A loop trained on
"which alerts do humans dismiss" learns to stop flagging: pointed at a missing bank account it concludes
that operators keep accepting it and lowers the sensitivity. That closes the loop in the wrong direction —
it suppresses the alarm instead of getting the bank details.

The learning target is **which fixes eliminated the most recurring findings**, which trains the system to
propose causes rather than to tolerate symptoms. Threshold tuning remains a manual, per-detector operator
setting (`payroll_anomaly_config` already holds it), not a learned one.

---

## 3. Build order — by HR time consumed, not by interest

1. **Generalise the substrate into domain adapters.** Payroll becomes adapter one; nothing changes
   functionally. This is the enabling refactor and should be small.
2. **The record-readiness adapter (§2.3).** Continuous completeness over every employee. Feeds payroll,
   statutory forms, bank files and onboarding at once — the loop that feeds every other loop.
3. **The action layer (§2.5)**, initially with autonomy set to zero everywhere: agents propose, humans
   approve one click. Autonomy is dialled up per action type only once agreement is measured.
4. **Tier-0 expansion.** Letters and certificates (employment confirmation, salary certificate, visa
   letter) are high-volume, near-template, and need no new risk model. The assistant already deflects the
   payslip and leave questions (ADR-0082, ADR-0074 item 5).
5. **The onboarding adapter.** Highest-touch HR process: document collection, validation against the
   documents, record population — human approves rather than types.
6. **The compliance adapter.** Statutory rates and forms change on a schedule, and because this system
   holds rules as DATA a change can arrive as a ruleset diff rehearsed against last month's payroll rather
   than a developer ticket. Few competitors can do this safely; it should not be left last.
7. **The exit adapter.** Final pay, clearance, EA, tax clearance — bounded and deadline-driven.

**ADR-0074 item 8 (MyInvois / e-filing) is re-rated UP.** It was previously judged not to move the ratio
because it is not exception work — which is exactly the blind spot §1 describes. It is recurring,
deadline-bound human time in a closed loop, and it should be scheduled on merit rather than dismissed by a
model that cannot see it.

---

## 4. What this keeps from ADR-0074, unchanged

- **The LLM never computes the money.** The deterministic, versioned, golden-tested statutory kernel
  remains the only thing that produces a ringgit figure. Agents orchestrate, detect, explain, draft and
  propose. This is what makes the whole design defensible to a CFO, an auditor and LHDN, and nothing here
  weakens it.
- **Classification stays deterministic.** Narration is additive prose over an already-computed verdict and
  can never revise it (ADR-0076 §2.6, built in r230, where the faithfulness guard *enforces* rather than
  requests that every number in the prose comes from the facts).
- **Human gates by default.** Autonomy is earned per action type from measured agreement; the Crawl → Walk
  → Run discipline of 0074 §7 is retained and made finer-grained.
- **Coverage is reported beside any clear rate.** A high rate on thin coverage is a thin result.

---

## 5. Consequences

- The Control Tower's staffing projection (r229) measures exceptions ÷ throughput, which under this ADR is
  an incomplete model of where time goes. It should be relabelled as what it is — an exception-load
  estimate — rather than presented as a headcount answer. Its three honesty gates stay.
- A generic substrate means the payroll adapter carries a seam it did not have. That is the cost of
  reaching the other seven loops with code that is already trusted.
- The action layer is the first place in this system where an agent writes. It needs its own security
  review, and it is the right place to spend that effort.
- Autonomy per action type means more configuration surface than one dial. That is the point: one dial
  cannot express "auto-fill an identifier, never touch a rate".

## 6. Alternatives rejected

- **Keep optimising the auto-clear rate.** Rejected: §1. It can succeed completely and leave the headcount
  unchanged.
- **A global confidence score gating auto-clear (0074 item 2).** Rejected: it needs one accuracy claim
  spanning unlike detectors, and it grants autonomy over money-affecting classes on the strength of
  agreement measured on trivial ones.
- **Build a separate agent per loop.** Rejected: five bespoke queues, five audit stories, five autonomy
  models. The substrate exists; adapters are cheaper and each new loop inherits a control plane that has
  already been through a gate.
- **Outsource the loop (EOR / managed payroll).** Genuinely removes the headcount and is what a share of
  the market does. Rejected as a product direction because it removes the customer too.

## 7. The ceiling, stated so no one promises past it

HR **operations** can approach zero staffed headcount. **HR cannot**, and any plan claiming otherwise
should be disbelieved. Three things survive every automation described here:

1. **A legally accountable signatory.** Statutory filings are signed by a person who carries the liability.
2. **Judgement.** Termination settlements, backdated corrections, garnishments, disputes, and every case
   whose facts are contested rather than missing.
3. **Someone an auditor can question**, who understands what the system did and why.

That is a fractional role — days a month of a finance or HR manager — not a department. The goal in §2.1
is deliberately worded to end the *staffed function*, not the profession.

## 8. Notes for the next reader

- **Do not cite the demo tenant's anomaly distribution for anything.** See the warning in §1.
- The first real tenant month is the first real data point. Before it lands, treat every claim about where
  HR time goes — including this ADR's — as a prior.
- The strongest structural advantages this product already holds, and which most of this plan spends:
  rules-as-data statutory rulesets, event sourcing on the money path, per-row RLS/ABAC, and a tool registry
  that executes inside the caller's own session rather than over a derived index. The last one is what lets
  an agent read without a second authorization system that must agree with the first forever (ADR-0007 §3,
  ADR-0082 §1).
