# Measured Assignment work in employee organisation reads

Status: original-only evidence retained; controlled representation comparison pending.

Source `9166c9c7e34336871251066b1f13981b4de5d6f2`, based on candidate
`c5c8f402f752163ebb3815daf70afb0f48e6adba` with migration 3001 applied, passed
selected tests and whole compiler in
[run 42378163379](https://github.com/StradaverseHub/ai-hr/actions/runs/42378163379).
The `focused-development-evidence` artifact contains
`employee-choice-organisation-plan.json`. All data is fictional. One native app
backend (PID 116), 4 hosted CPUs (Intel 8370C), JIT on, work_mem 4 MB and multiplier 2 were
observed; policies, function definitions, grants and session settings stayed unchanged.

The 50k fixture has one represented 500-row Business Unit subset and an unrepresented
unit. Whole initial ports measured 5038/4983 ms, department/active 9721/9694 ms,
department plus unit 9626 ms and empty unit 18415 ms. Correct IDs, exact totals, bounded
rows, selected identity and represented options all passed. A component PASS is
therefore separate from the unmet 1000 ms practical target.

Actual plans, not estimates, identify two expensive paths:

| Native statement | Actual measured work |
| --- | --- |
| Department/active page | 5274 ms execution; 40,000 Assignment index probes averaging 0.122 ms, 788,394 shared-hit blocks; predicate `employment_id=ANY($20)`. Planning 1.64 ms; JIT 48.6 ms. |
| Department+unit page | 5170 ms execution; the same 40,000 Assignment probes despite only 400 matching active identities. |
| Business Unit options | 3978 ms execution with no JIT. Assignment bitmap-index membership produces 50,000 index tuples twice, once per catalogue unit, with 1,866,358 shared-hit blocks. |
| Empty unit page/count | 7045 ms page plus 6948 ms fallback count, each with 50,000 Assignment probes. JIT contributes 721/627 ms; it does not explain most of the work. |

These hot Assignment nodes read no disk blocks. The initial bounded page itself
takes 517 ms; the newly exercised Business Unit options path adds about 4 s to every
ordinary port. This fixture difference explains why the earlier no-unit benchmark
was much faster. Container CPU deltas track this cached work; cumulative memory
peak was about 1.10 GB within the unchanged job budget, with no memory-pressure events.

The next isolated comparison may replace only the exact Assignment positive array
membership with `employment_id IN (SELECT unnest((SELECT app.visible_employment_ids())))`
inside the disposable database. It must guard the complete policy/metadata/native
function identity, retain every other policy and grant, restore the original in
finally and repeat full DTO/authority/history controls. Employment 3001 and all query
objects/settings stay fixed. No numbered migration or production adoption is decided.

The diagnostic also inventories actual Assignment index definitions, predicates and
valid/ready/immediate flags. No index is added in this membership-only control.
Separate query/index controls, including a selective current-assignment index if
the measurements support one, remain possible after these results. They must retain
the exact NULL-ended/unsuperseded population, including future NULL-ended assignments
and ended employments where the caller did not request active-only results.

Membership representation does not fix query structure. The department/BU predicate
currently sits outside a per-employment lateral OFFSET0 boundary; count/window work
also precedes the bounded page. The comparison records residual Assignment loops
and WindowAgg rows explicitly. A later, separate set-wise narrowing/count-before-
projection query proposal requires its own semantic and actual-plan evidence;
it is not implemented by this experiment.


## Retained first comparison failure and bounded recovery

Frozen comparison source `597ddf70fbef133d5e912cd7d1aacb922915a0bf` ran in
[run 42381351810](https://github.com/StradaverseHub/ai-hr/actions/runs/42381351810).
Both selected tests and compiler finished with failure; this run is not a qualified
comparison. Its `employee-choice-assignment-membership-plan.json` and
`db.vitest.json` remain the original evidence. All eight original whole-port cases
completed their independent DTO/ID/count/options assertions, and both separately
bounded native authority variants passed (2565/5581 ms). The artifact records only
`performanceVariants=["original"]`; no wrapped performance or actual-plan result
was obtained.

The test process started at 14:25:21 UTC. The JSON suite start was 14:25:44.143;
first pre-port telemetry was 14:29:16.074 (about 212 seconds later), and final
original-port telemetry was 14:30:46.577. The original case timed out after
300012.7 ms while its async work continued; wrapped and actual-plan cases then
failed on policy lock timeout after 667.5/304.1 ms. This is an aggregate fixture plus
measurement lifecycle failure, not evidence that the wrapped policy is slower.
The compiler separately reported TS2769 for a nullable department fixture argument;
the repair explicitly narrows that argument before inserting the same existing row.

Recovery gives fixture preparation, each performance variant, each plan variant,
and each authority variant separate 300000 ms cases. No assertion or SQL/lock limit
is removed or increased. A timed-out case terminates the owned app client, blocks
later database cases and drains its async body/finally before further restoration;
setup failure also closes any partially created single client and harness pools.
The normal successful path continues to use one physical native app backend with
unchanged policy/function/settings checks. The whole affected file and compiler
must run again against a new frozen source identity. Query/index variants remain
unimplemented, and no production adoption follows from this recovery.
