# ADR-0168: Bounded reusable payroll formulas

Status: proposed in the approved Formula Builder review branch; no deployment authorized.

## Context

Payroll administrators need reusable conditional calculations and source explanations that work in both a
visual editor and text editor. A different preview evaluator or arbitrary scripting would make payroll
results inconsistent or expose private data. Existing fixed and structured Pay Item calculations remain
supported and retain their established behavior.

## Decision

A closed VB-style language compiles to a typed version1 statement/expression tree. Both editors serialize
this same tree, retain comments and support nested conditions, assignments, typed variables, explanations
and Return. Sources are named registry calls with literal source identities, not executable JavaScript,
SQL, imports or network operations. Explicit source/token/node/depth/step/output limits bound execution.

The evaluator uses fixed12-scale BigInt decimal arithmetic, 18 integer digits and half-away-from-zero
rounding. It receives synchronous, prefetched typed facts from the payroll source owner. Simulation and
real payroll use the same provider and evaluator. Missing, ambiguous, out-of-scope or unauthorized facts
block the calculation. Current calculated, unprorated and original input values are separate maps;
historical reads require exact employee, period, cycle and run identities.

The tenant catalog owns stable public Formula IDs, immutable saved revisions, immutable test receipts,
activation events and configured accumulation-group revisions. A saved revision contains source, typed
program, dependency snapshot, content hash and evaluator/registry versions. Activation requires the exact
latest revision's successful receipt, current dependency fingerprint and unchanged selected test sources.
It atomically checks and updates the full legacy/builder Pay Item dependency graph under catalog lock.
Raw input and historical reads are validated but do not create output-order edges. An inactive linked
formula blocks a new calculation; historical evidence is retained.

Pay Items select an active tested Formula ID using native input-kind/rule storage. Dependencies are
server-materialized and database-checked against the active immutable revision. Explicit optional
`pay_component.formula_context` bindings own ordinary-rate divisor, hours per day and rate multiplier.
They can be configured before linking, allowing a real-context formula test without inventing26/8/1.5.
They have no defaults. Missing requested bindings block. The effective source snapshot preserves their
values in protected evaluation evidence.

Personal source values and explanation text belong in private test/evaluation tables. Ordinary payslip
metadata contains only stable formula/revision/hash/evaluation references and the paid result. Reading a
receipt or trace rechecks company/workforce scope, exact Personnel Field permissions and report-category
grants using the viewer's current carrier; broad audit events contain control metadata only.

## Consequences

Catalog edits and source permission changes can invalidate old test authority without rewriting evidence.
Changing a formula creates a new revision; activation never mutates a processed payslip. Previously used
IDs cannot be renamed/deleted. Operators can deactivate them. Configured accumulation changes require
saving and testing a new revision. A future grammar or registry expansion must preserve versioned evaluator
compatibility and both editors. No general-purpose scripting escape hatch is provided.

Migration0800/sequence1793330000200 is append-only and unapplied. Standard GitHub Actions owns application
tests, whole TypeScript/build and clean/populated ordinary upgrade rehearsals. Rendered component review
and staging acceptance are distinct gates; this ADR authorizes neither deployment nor integration.
