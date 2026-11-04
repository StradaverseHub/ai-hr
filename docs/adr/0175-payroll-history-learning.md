# ADR-0175 — Payroll history learning: deterministic baselines, evidence first

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Status:** Proposed on branch `claude/payroll-history-learning` (phases P1 and P2). Production is held; nothing here authorises a deployment.
- **Number:** provisional. A scan of every origin ref on 4 November 2026 found ADR-0174 claimed on another branch (`0174-company-tenant-integrity.md`); reconcile at integration.
- **Date:** 2026-11-04
- **Relates to:** [ADR-0076](0076-payroll-anomaly-layer-design.md) (the anomaly layer; its phase 1b self-baseline needed history), [ADR-0084](0084-propose-adjudicate-learn.md) (models propose, deterministic services adjudicate, outcomes are learned), [ADR-0170](0170-teras-ai-operating-architecture.md) (the AI Centre architecture and its disclosure classes), [ADR-0030](0030-audit-log-pdpa.md) (PDPA erasure).
- **Migration:** `2012_payroll_learned_baseline` (AI Centre block 2000–2019; see [migration allocation](../MIGRATION-ALLOCATION.md)).

## 1. Context

The payroll loops compared each person with one prior month, against placeholder thresholds. ADR-0076 left the self-baseline detector for "when there is history". Closed runs and imported payroll history now give that history. The owner's rules: the model never does money maths; learning never changes calculation code, permissions or disclosure rules; nothing crosses tenants; every applied change is a person's, versioned and reversible; a block is never downgraded.

## 2. Decision

1. **Baselines are deterministic statistics, computed by a service in integer sen.** Per person, basis (regular month, month total, bonus run) and component (payslip lines and pay items): the nearest-rank median, P10 and P90, the non-zero count, a month mask and a fixed flag (`core/payroll-learning/baseline-math.ts`). No model computes, chooses or changes one.
2. **What is learned from.** Closed runs only; only months before the month being judged (no look-ahead); only effective payslips (a superseded import copy never counts). Set aside: a net-swing flag found a real problem, an exception fixed at the source, a correction after the run, a manual statutory figure, the months before a salary change, the first and last month with the company, and any part month (unpaid leave, absence or proration) (`core/payroll-learning/history.ts`).
3. **Thresholds (owner decisions of 4 November 2026).** Under 3 clean closed runs: nothing is shown. **From 3**, an evidence line ("Usual for this person: within / above / below range from N runs") for payroll HR. **Stable from 6**: only a stable baseline may ever be used to hide a flag (phase P4, as an `info` with its reason; a block never). A baseline is *rebasing* after a salary change and *contradicted* when the two latest months move outside the earlier range; neither shows evidence or hides anything.
4. **No agent read.** Baselines are readable only by payroll administrators of the company, under their own login (FORCE row-level security). The tenant's agent principal reads the mode and the run log (counts), never a baseline. Learning runs under the authority of the group administrator who switched it on, re-read at every run; a sponsor who lost that authority stops it.
5. **Bands-only disclosure to the AI.** The AI read `payroll_learning_status` (an `operations_status` topic) gives counts per status and company only, as bands, under the small-group rule: no count under 5, plus complementary suppression. No amount, range, person or id reaches the model.
6. **Retention.** A leaver's learned baselines are deleted 3 months after their final pay closes (payslips untouched), by a purge that runs with every learning run; person erasure deletes them at once; they cascade with the employment.
7. **Proposals only.** The learning mode is per company: off (default), evidence (switched on by a group administrator, off by any payroll administrator) or classify (reachable only through an approved proposal backed by a backtest, phase P3). Each change is a new version, audited as a configuration event the Audit loop's pack captures, and undone by setting the earlier mode again. Learning stops while the tenant's stop switch is on.

## 3. Consequences

- Payroll HR sees, beside each flag, what is usual for that person, from history the service can show its working for. Nothing changes a figure, check, flag or severity in P1–P2.
- The anomaly layer's self-baseline (ADR-0076 phase 1b) and the classification and backtest phases (P3–P4) build on the same stored baselines.
- Costs: one recompute per company after a run is closed, unlocked or reset or a history import is confirmed or reverted (the 15-minute payroll tick), and a nightly backstop. A new version is written only when a result changes.
- Open: the spec lines that teach the AI the new topic wait for the next spec version; Thai, Tamil and Vietnamese copy needs native review.
