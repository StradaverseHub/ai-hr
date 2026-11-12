# Off-cycle requests draw on one balance per company (board b945f0cc)

Date: 12 November 2026. Status: accepted by the board item owner (plan approved on item b945f0cc: "Use one balance per
company as requested"); source on branch `claude/board-rewards-offcycle-20261112`, not installed.

## Context

[ADR-0099](0099-rewards-review-and-payroll-handoff.md) funds ad hoc and mid-year requests from the posted annual review
they belong to (one company and one business unit), with the Standard and JG H remainders kept separate. Leaders asked
for one off-cycle balance per company, switched on once the year-end cycle closes.

## Decision

**One balance per company and cycle.** Off-cycle requests of a cycle draw on one company balance:

- *Year-end remainder* (frozen): the sum, over the company's posted annual reviews of the cycle, of both plans' frozen
  increment remainders (`reward_unit.funding_cents`, written once at annual posting and never changed).
- *Held*: the sum of the reservations (`reward_unit.reserved_cents`, both plans) of the company's requests in approval
  (BG CEO, Group Rewards, CTRO or EC step) or approved.
- *Consumed*: the same for requests already posted to Payroll.
- *Available* = remainder − held − consumed (never shown below zero).

Drafts, returned, rejected and withdrawn requests hold nothing. Standard and JG H requests draw on the same balance;
EC-plan awards still never draw on it (they need a budget exception, as before). A request is checked against the
available balance less every *other* request, so its own reservation is never counted twice.

**Reconciliation without double counting.** No stored amount changes. Each annual review's frozen remainder is counted
once (per company and cycle) and each request's own reservation is counted once, in exactly one of held or consumed by
its status; the per-plan figures are summed. Requests that were submitted under the separate Standard/JG H balances
therefore keep their reserved and consumed amounts, and the company balance starts from exactly what remains. The
database computes every balance (`app.reward_offcycle_balances`, `app.reward_offcycle_company_funding`); no model or
page calculates money.

**Annual parent locks.** A submission, approval or posting of a request locks every posted annual review of its
company and cycle in id order (`app.reward_offcycle_company_funding(unit,true)`), so concurrent decisions against the
same company balance serialize; requests of different companies do not wait for each other.

**Switched on once the year-end cycle closes.** Group Rewards (whole-group configuration authority) opens a cycle's
off-cycle year (`reward_offcycle_year`) only when every annual review of the cycle has final EC approval and has been
handed to Payroll (posted), and sets the mid-year submission window. Both saves follow the direct-save rule of
[board 60f1fdcd](2026-11-12-rewards-direct-configuration.md): "Review before saving" (high impact), a reason and one
change-log row (area `offcycle`); no second person.

**Dates.** No off-cycle request can be submitted or approved from 1 October through 31 January (Malaysia dates);
returns, rejections and withdrawals stay available. A mid-year set is submitted only inside the mid-year window. A
request approved with an effective date from 1 October to 31 December is recorded as a year-end exclusion for that
year (`offcycle.yearEndExclusion`); the year-end review already excludes such pay changes through its exclusion window.

**Routes** (business approvals; unchanged by 60f1fdcd): a mid-year set goes BU CEO → BG CEO → Group Rewards and is
returned or decided as a whole; an ad hoc request goes BU CEO → BG CEO → Group Rewards → CTRO, continuing to the
Executive Chairman when the current or new grade is JG 22 or above; a budget exception (ad hoc only, never inside a
mid-year set) goes BG CEO → Group Rewards → CTRO → EC whatever the grade, and returns to the BG CEO. The subject of a
request never sees it in their list and cannot decide it.

**Limit Controls.** An off-cycle request uses its reward year's Limit Controls (increase thresholds, promotion increment,
grade steps and highest grade). A Draft request follows the current version; submission keeps the version it was
checked with in `reward_unit_limit_pin` (`app.reward_offcycle_limit_pin`); requests submitted before this change keep
the baseline. With no version the checks are exactly the previous ones.

## Consequences

- `app.reward_funding` (0524) stays for its existing callers; the off-cycle service reads the company functions.
- The over-balance check (OC-11) compares the request's Standard + JG H total with the company's available balance;
  without a budget exception it blocks, with one it is an exception for the approvers.
- Open question recorded for the owner: an approved budget exception still reserves its full amount, so it can use up
  the company balance (shown as 0 available, never negative). Whether exceptions should instead be funded outside the
  balance is a money policy decision not taken here.
