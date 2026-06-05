# ADR-0003: Organizational & identity model + typed reporting graph

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** Founder (solo) + Claude (acting architect)

## Context

Requirements include: one human working for multiple companies at once, multiple
reporting managers, cross-company managers, and a matrix org (administrative / functional
/ project / dotted lines) of unbounded depth. A single `employee` table with a
`manager_id` column cannot represent any of this.

## Decision

Adopt a **Person → Employment → Assignment → Position** identity model (the shape used by
enterprise HRMS platforms), all scoped by `tenant_id`:

- **Person** — the global human identity within a tenant. Holds PII (name, contact).
  One Person can hold many Employments. This is also the seam for future data-residency:
  identity can be shared while jurisdiction-sensitive attributes are siloed.
- **Company** — a legal entity within the tenant (country, currency, registration no.).
- **Employment** — the durable relationship between a Person and a Company (hire date,
  termination date). Multiple concurrent Employments model multi-company employment.
- **Assignment** — the **effective-dated version** ([ADR-0001](0001-bitemporal-effective-dating.md))
  of *what* an Employment is at a point in time: position, department, cost center,
  employment type, status. A transfer = close the current Assignment, insert a new one.
- **Position** — a seat within a Company (title, job family). Supports headcount/budget
  later; an Assignment points at a Position.
- **Department**, **Cost Center** — organizational structures within a Company.

**Reporting lines are a typed, effective-dated graph**, not a column:

- A `reporting_line` edge has `subordinate_employment_id`, `manager_employment_id`,
  `line_type ∈ {administrative, functional, project, dotted}`, and `valid_from` /
  `valid_to`.
- Manager and subordinate may be in **different companies** (cross-company reporting).
- **Cycles are prevented at write time**: before inserting an `administrative` edge, a
  recursive check (as-of the effective date) rejects the edge if the proposed manager is
  already a descendant of the subordinate on the same line type. "Unlimited depth" is
  supported but bounded by a sane recursion guard (real orgs are < ~30 deep).

## Consequences

- (+) Multi-company, multi-manager, matrix, and cross-company reporting all fall out
  naturally.
- (+) Org history is queryable as-of any date (edges and assignments are versioned).
- (−) "Who is this person's manager?" is now a graph query with a `line_type` and a date,
  not a column read. We provide read-model views/helpers to keep call sites simple.
- (−) More tables and joins than a naive model. Justified by the requirements; the
  alternative does not work at all.

## Alternatives considered

- **`employee.manager_id` adjacency.** Rejected: single manager, single company, no
  history, no line types.
- **Dedicated graph database (Neo4j).** Rejected for Slice 0: adds a second datastore and
  operational burden for a solo team; Postgres recursive CTEs handle org-sized graphs
  comfortably. Revisit only if graph traversal becomes a proven bottleneck.
