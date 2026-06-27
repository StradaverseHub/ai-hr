# ADR-0055 — Organization-based public-holiday hierarchy

**Status:** Accepted · **Date:** 2026-06-26 · **Extends:** ADR (state-specific holidays, "2C")

## Context

Public holidays were resolved geographically only: a national row (state = null) or a state-specific row, matched against the employee's resolved work state. Real Malaysian groups need a holiday calendar that varies by **business group / company**, not only by state — same location, different subsidiaries observing different days.

## Decision

A holiday row now carries a **single-axis scope**: **National** (no state, no company), **State** (state set), or **Business-group** (company_id set). Resolution precedence is:

```
Business-group override  →  State PH  →  Country default
```

- Single-axis is enforced at the service **and** by a DB CHECK (a row is national, state-scoped, or company-scoped — never two at once).
- The admin Holidays page gains a **scope selector** (National / State / Business-group) + a company picker, with scope badges built from a **static i18n key map** (`scope.national` / `scope.state` / `scope.group`) — never a dynamic `scope.${type}` key (those escape the i18n coverage test).
- The existing national/state read paths are byte-identical when no business-group row applies; this is purely additive over the state engine.

## Consequences

- Migration `0112` adds `holiday.company_id` (nullable FK) + the single-axis CHECK.
- Leave and attendance share the same holiday resolver, so a business-group override is honoured identically across both.
- Out of scope: per-employee holiday overrides (the location-level `state` override in ADR-0054 already covers the common case).
