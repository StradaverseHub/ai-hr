# Domain Model — Slice 0 ("the spine")

This is the data model for the walking skeleton. It realizes
[ADR-0001](../adr/0001-bitemporal-effective-dating.md) (bitemporal),
[ADR-0002](../adr/0002-multitenancy-rls.md) (tenant isolation),
[ADR-0003](../adr/0003-organizational-model.md) (identity + reporting graph), and
[ADR-0006](../adr/0006-event-and-audit-substrate.md) (event log).

**Every table** has `tenant_id uuid NOT NULL` and is governed by RLS. It is omitted from
per-table column lists below for brevity but is always present.

## ERD

```mermaid
erDiagram
    TENANT ||--o{ COMPANY : "has"
    TENANT ||--o{ PERSON : "has"
    TENANT ||--o{ APP_USER : "has"
    TENANT ||--o{ DOMAIN_EVENT : "records"

    PERSON ||--o{ EMPLOYMENT : "holds"
    COMPANY ||--o{ EMPLOYMENT : "employs"
    COMPANY ||--o{ POSITION : "defines"
    COMPANY ||--o{ DEPARTMENT : "defines"
    COMPANY ||--o{ COST_CENTER : "defines"
    DEPARTMENT ||--o{ DEPARTMENT : "parent of"

    EMPLOYMENT ||--o{ ASSIGNMENT : "versioned by"
    POSITION ||--o{ ASSIGNMENT : "filled by"
    DEPARTMENT ||--o{ ASSIGNMENT : "scopes"
    COST_CENTER ||--o{ ASSIGNMENT : "charges"

    EMPLOYMENT ||--o{ REPORTING_LINE : "as subordinate"
    EMPLOYMENT ||--o{ REPORTING_LINE : "as manager"

    LEAVE_TYPE ||--o{ LEAVE_POLICY : "configured by"
    LEAVE_TYPE ||--o{ LEAVE_REQUEST : "categorizes"
    EMPLOYMENT ||--o{ LEAVE_REQUEST : "files"
    EMPLOYMENT ||--o{ LEAVE_LEDGER : "accrues"

    APP_USER ||--o{ ROLE_ASSIGNMENT : "granted"
    APP_USER }o--o| PERSON : "may map to"

    PERSON {
        uuid id PK
        text full_name
        text primary_email
        text phone "nullable, PII"
    }
    COMPANY {
        uuid id PK
        text legal_name
        char country "ISO-3166, 'MY'"
        char currency "ISO-4217, 'MYR'"
        text registration_no
    }
    EMPLOYMENT {
        uuid id PK
        uuid person_id FK
        uuid company_id FK
        date hired_on
        date terminated_on "nullable"
    }
    ASSIGNMENT {
        uuid id PK
        uuid employment_id FK
        uuid position_id FK
        uuid department_id FK
        uuid cost_center_id FK
        text employment_type "Full-time|Part-time|Contract|Intern"
        text status "Active|On leave|Probation|Offboarding|Terminated"
        date valid_from
        date valid_to "nullable = open"
        timestamptz recorded_at
        timestamptz superseded_at "nullable = current record"
    }
    REPORTING_LINE {
        uuid id PK
        uuid subordinate_employment_id FK
        uuid manager_employment_id FK
        text line_type "administrative|functional|project|dotted"
        date valid_from
        date valid_to "nullable = open"
    }
    POSITION {
        uuid id PK
        uuid company_id FK
        text title
        text job_family
    }
    DEPARTMENT {
        uuid id PK
        uuid company_id FK
        uuid parent_department_id FK "nullable"
        text name
    }
    COST_CENTER {
        uuid id PK
        uuid company_id FK
        text code
        text name
    }
    LEAVE_TYPE {
        uuid id PK
        text code "'ANNUAL'"
        text name
        boolean paid
    }
    LEAVE_POLICY {
        uuid id PK
        uuid leave_type_id FK
        jsonb accrual "rate, cap, carry-forward"
        date valid_from
        date valid_to "nullable"
    }
    LEAVE_LEDGER {
        uuid id PK
        uuid employment_id FK
        uuid leave_type_id FK
        text entry_type "accrual|debit|adjustment"
        numeric days "signed"
        uuid source_request_id FK "nullable"
        date effective_on
    }
    LEAVE_REQUEST {
        uuid id PK
        uuid employment_id FK
        uuid leave_type_id FK
        date start_date
        date end_date
        numeric days
        text status "pending|approved|rejected|cancelled"
        uuid decided_by_employment_id FK "nullable"
        timestamptz decided_at "nullable"
    }
    APP_USER {
        uuid id PK
        text workos_user_id
        uuid person_id FK "nullable"
    }
    ROLE_ASSIGNMENT {
        uuid id PK
        uuid app_user_id FK
        uuid company_id FK "nullable = tenant-wide"
        text role "employee|manager|hr_admin|super_admin"
    }
    DOMAIN_EVENT {
        uuid id PK
        text aggregate_type
        uuid aggregate_id
        text event_type
        text actor_type "USER|SYSTEM|AGENT"
        uuid actor_id "nullable"
        jsonb payload
        timestamptz occurred_at
        bigint sequence
    }
```

## Key entities

- **Person** — global human identity within a tenant; holds PII. The seam for future
  cross-border data siloing.
- **Company** — legal entity (country, currency). Multi-company lives inside one tenant.
- **Employment** — durable Person↔Company relationship. A Person may have several at once.
- **Assignment** — the *effective-dated version* of an Employment (position, department,
  cost center, type, status). Transfers and status changes **close + insert**, never
  update. See temporal patterns below.
- **Position / Department / Cost Center** — org structures within a Company.
- **Reporting line** — typed, effective-dated edge; manager and subordinate may be in
  different companies; administrative lines are cycle-guarded.
- **Leave type / policy / ledger / request** — Slice 0 ships Annual only. Balance is the
  signed sum of **leave_ledger** entries (append-only): `accrual (+)`, `debit (−)` on
  approval, `adjustment (±)`. Approval checks projected balance ≥ 0 before debiting.
- **App user / role assignment** — login identity (WorkOS-sourced) and its tenant- or
  company-scoped roles, used by RLS for ABAC.
- **Domain event** — the append-only audit/integration substrate.

## Temporal query patterns

These two patterns recur everywhere and will be provided as helpers/views:

- **Current assignment** for an employment:
  `valid_from <= today AND (valid_to IS NULL OR valid_to > today) AND superseded_at IS NULL`.
- **As-of** a date `D` (reconstruct history):
  `valid_from <= D AND (valid_to IS NULL OR valid_to > D)` — and, for true "as we knew it
  then," constrain via the domain-event log / `recorded_at` (full system-versioning
  deferred per ADR-0001).

## Integrity rules (enforced in DB where possible)

- No overlapping **open** assignments for one employment (exclusion constraint on
  `employment_id` + valid range).
- `leave_request.end_date >= start_date`; approval is a guarded transition
  (`pending → approved`) that writes a ledger debit + a `leave-request.approved` event
  atomically.
- Reporting-line insert runs the cycle check (ADR-0003) for `administrative` lines.
- All FKs are intra-tenant (composite FKs include `tenant_id`) so RLS and referential
  integrity agree.

## Open questions for review

1. Should **Department** be effective-dated (versioned tree) in Slice 0, or is an
   effective-dated *employee↔department* assignment sufficient (current proposal)?
2. Is **Position management** (seats) needed in Slice 0, or can Assignments be "jobless"
   until the recruiting/headcount slice? (Proposed: keep Position, minimal.)
3. Leave accrual cadence for Slice 0: **grant-on-hire pro-rated** vs **monthly accrual via
   a scheduled job** (the latter introduces a cron dependency).
