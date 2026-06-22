# ADR-0039 — Configurable leave approval policy (Leave 2.0 · 2B-2)

Status: Accepted · 2026-06-23 · Sub-ADR of [ADR-0038](0038-leave-2.0.md) §2B

## Context

2B-1 shipped a multi-step approval **state machine** (`leave_approval_step` + a step-aware
`decideLeave`) gated by a per-company `company.leave_multi_approval` boolean, but the chain itself was
**hardcoded** in `generateApprovalSteps` as `[direct_manager, hr_admin]`. ADR-0038 §2B always intended
the chain to be **data, not code** ("an ordered list of approver levels … scoped by leave-type and/or
grade") and flagged that 2B-2 may warrant its own sub-ADR. This is it.

## Decision

A stored, per-company approval **policy** defines the chain. The 2B-1 state machine is unchanged — it
is already N-level capable; 2B-2 only changes how the level list is *sourced*.

- **`leave_approval_policy(company_id, leave_type_id nullable, levels jsonb)`**, UNIQUE
  `(company_id, leave_type_id)`. `levels` is an ordered array of level **kinds**.
- **Level kinds (2B-2):** `direct_manager` and `hr_admin` — the two already authorized in `decideLeave`.
  The kind is stored as an open string so future kinds need no migration.
- **Resolution at request time** (`resolveApprovalChain`): a leave-type-specific policy
  (`company_id` + `leave_type_id`) → the company default (`leave_type_id` NULL) → a built-in fallback of
  `[direct_manager, hr_admin]` (so an opted-in company with no saved policy behaves exactly like 2B-1).
  A `direct_manager` level is still dropped when the employee has no current administrative manager
  (no dead step), so an HR-only chain falls out naturally.
- **`company.leave_multi_approval` stays the on/off gate.** The policy defines the *shape*; the boolean
  decides whether the chain runs at all. The admin editor writes both in one save.
- **RLS:** catalog pattern — readable tenant-wide (the requester, an ordinary employee, must read it to
  generate steps), writable only by `is_admin_for(company_id)`.
- **Authorization is unchanged:** an `hr_admin` level is cleared only by HR; a `direct_manager` level by
  the manager or an admin. Adding a level kind in future means teaching `decideLeave` how to authorize it.

## Deferred (not in 2B-2)

- **Named-role levels** (`role:<name>`) and **skip-level** (manager's manager) — both need new
  authorization/resolution; the open-string `kind` leaves room.
- **Per-leave-type editor UI** — the schema supports `leave_type_id`, but the 2B-2 editor edits the
  company default only.
- **Grade scoping** — waits on 2E (grade doesn't exist yet).

## Floor invariant (ADR-0038 §5)

An approval chain is **workflow, not entitlement**. No policy can reduce a statutory entitlement; the
floor logic (`max(floor, policy)`) is untouched. The chain only governs *who signs off*, never *how much*.
