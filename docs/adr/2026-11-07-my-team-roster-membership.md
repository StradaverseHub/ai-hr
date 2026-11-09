# Team-linked Roster resolves membership before presentation facts

Status: source candidate, hosted qualification pending; no staging or production acceptance.

`resolveMyTeamRosterScope` previously called the complete `readMyTeam` projection to return only
company IDs, employee IDs, padded date bounds and roster edit permission. Every team-linked grid,
picker or bulk preparation could therefore read roster cells, attendance, leave requests and
per-employee leave balances before the bounded Roster reader began.

For the current membership/search route contract, resolve the same `resolveMyTeamScopeTx` authority
owner inside one enforced REPEATABLE READ / READ ONLY snapshot. Resolve the stored calling-person
link through the team identity owner, prove that actual login snapshot before reading membership,
and retain native tenant/company/reporting/department/subject permission predicates. Capture caller
context and nested query inputs before awaits. Search retains the exact lowercase substring over
`name + space + employeeCode`; company ordering, explicit empty scope, selected employment, edit
permission and padded week/month bounds remain unchanged. No data or permission result is cached.

The former full projection checked membership again after its independently owned source reads.
The minimal path instead has one authority/data snapshot, so it does not need that multi-transaction
race detector. A concurrent uncommitted role change cannot block the read; the next admitted snapshot
observes a committed revocation. It still refuses unauthorized or invalid input.

Current URL parsing intentionally retires the old Today tile filter. Direct programmatic callers
with a non-members tile retain the complete canonical `readMyTeam` path because the status depends
on its derived attendance/leave facts. This is an explicit compatibility limit, not a claim that
retired status-filtered projections have become cheap. No derived status or leave calculation is
reimplemented. The complete My Team screen and every command/approval barrier are unchanged.

Qualification covers independent known direct/all/search/selected/empty scope, stored-person behavior,
padded dates, parity with the populated complete canonical view, absence of roster/balance hydration,
actual Access role writer overlap and next-snapshot revocation, captured nested inputs, foreign and
department refusals, native RR/RO mode and persisted-write SQLSTATE 25006. Existing My Team model,
route, Roster linkage and export tests remain required. This is component evidence, not a whole-system
performance or zero-Busy release receipt.
