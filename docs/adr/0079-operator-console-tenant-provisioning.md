# ADR-0079 — Operator console: click-to-provision a new customer

**Status:** Accepted
**Migrations:** 0294 (`operator` enum value), 0295 (predicate, policy tightening, request queue)

## Context

There was no way to create a customer from the product. Onboarding meant someone with shell access
running commands by hand. Everything *after* the first step already worked — the one-time activation
link that lets a new admin set a password and sign in (`app.consume_invitation`, 0151/0281), and
invite-everyone-else from the existing Users and roles screen. Only the first step was missing.

Stated plainly, because it shapes everything below: **nothing is deployed or installed when we onboard
a customer.** All customers share one installation. "Provisioning" means creating rows — the tenant, one
company, the Malaysian starter catalogs, and the first admin login. The console is a form plus a
progress view over a row-creation job. No servers, no infrastructure.

## Decision

### 1. A request queue, not a privileged web path

Migration 0001's `tenant_isolation` policy means `ai_hr_app` can never insert or list a tenant. That is
the strongest isolation guarantee in the system, and **this feature does not touch it.** There is no
`SECURITY DEFINER` create-tenant function reachable from the web tier, and no grant that would let one
exist.

Instead:

| Actor | Role | Does |
|---|---|---|
| Web tier | `ai_hr_app` | INSERTs an intent row into `tenant_provision_request`. That is all it can do. |
| Runner | owner (`MIGRATION_DATABASE_URL`) | Provisions, and writes the terminal status back. |
| Web tier | `ai_hr_app` | Polls the table, renders progress. |

`scripts/provision-runner.ts` runs as a one-minute cron tick (deploy/DEPLOY.md §5b), the same shape as
the four existing sweeps. The owner credentials never reach the application; the application never
learns how to make a tenant. The cost is that a customer is ready up to a minute after the click, which
is accepted.

### 2. The operator tier

`operator` is an installation-level role, added as an enum value in its own migration (0294) because a
new enum label cannot be *used* in the transaction that adds it. 0295 then defines `app.is_operator()`
(mirroring `app.is_group_admin()`, reading `app.current_grants()`), and — critically — **tightens
`role_assignment_write` so no web-tier session can grant `operator` at all.** Without that conjunct, any
customer's group admin could promote themselves to the installation tier: the 0099 policy's group-admin
branch grants *any* role. Operator grants come only from `ai_hr_owner`.

All role comparisons in that policy use text literals (`role::text = '…'`), never `::role` casts,
following 0099's precedent.

### 3. Reveal-once is a privilege, not a convention

`activation_url` is **excluded from the app role's column-level SELECT grant.** No session — operator
included — can read it with a query. The only path is `app.claim_activation_url()`, which nulls the
column in the same `UPDATE … RETURNING` that returns it. A leaked query, an over-broad `select()`, or a
future debug endpoint cannot surface it, and two concurrent claims cannot both win (`FOR UPDATE` on the
pre-image subquery).

Consequence worth knowing: an unqualified drizzle `.select()` on this table **fails**. `core/operator.ts`
names its columns for that reason.

### 4. All-or-nothing, including the terminal status write

`provisionTenant()` and the `status = 'done'` update happen in **one owner transaction.** This closes a
real window: `tenant.name` has no unique constraint, so if provisioning committed and the status write
followed separately, a crash in between would leave a real tenant whose activation URL was lost and a
request still reading `pending` — and the next tick would provision a *second* tenant for the same
customer. Because the request table is tenant-free, the owner writes both halves together.

The two catalog seeders (`seedPayrollCycleCatalog`, `seedProfileOptions`) were hard-bound to the app
singleton and each opened its own transaction on a different connection and role. They gained an
optional injected handle (the `seedGuides` precedent). Default behaviour is unchanged for every existing
caller; that refactor is what makes the one-transaction guarantee real rather than aspirational.

### 5. `claimed_at` and the stale-claim rule

A runner killed mid-flight (deploy restart, OOM) would otherwise leave an eternal spinner with no exit.
The claim commits *before* provisioning begins, so a row still `running` after 10 minutes either
finished or rolled back completely — never a third state. The next tick flips it to `failed` with
"provisioning interrupted, submit again".

**Guidance for the editable-scheduled-actions plan:** its "Run Now" pattern has this identical hole and
should adopt this same `claimed_at` rule rather than inventing a second mechanism. That plan and this
one share the operator primitives (`operator` value, `is_operator()`, the policy tightening,
`isOperator()`); this feature landed first and created them, so that build reuses them and drops its
duplicates.

### 6. What a starter customer contains

One company named after the customer (MY, MYR), Malaysian statutory leave types, national + state public
holidays, the payroll cycle catalog, the profile-option catalogs, and the built-in help guides. No demo
people, no demo transactions.

**The first admin is not an employee** — person + `app_user`, no employment row. Headcount and payroll
start at zero, and per 0279 a person with zero employments is never auto-blocked, so an employment-less
admin is the one shape that is safe here. The two decisions are coupled, and both halves of that
predicate are pinned by test.

**No pre-created `role_assignment`.** `app.consume_invitation` inserts one unconditionally and
`role_assignment` has no uniqueness on `(app_user_id, role, company_id)`, so pre-creating it would leave
the activated admin holding two identical grants. The test asserts exactly one, post-activation.

The placeholder subject is `provision:<uuid>`, **never email-derived**: `app_user.workos_user_id` carries
a global unique index (0151), so an email-derived placeholder collides the moment an address is reused.

### 7. Sharing with the demo seed

`db/seed.ts` calls the shared catalog and admin-chain layer, so real customers and the demo cannot drift
on starter settings. It does **not** call `provisionTenant`, and `provisionTenant` grows no demo knobs.
The demo keeps its fixed ids, its two-company ADR-0009 structure, approval policies and sample data.
A "byte-identical demo tenant" claim was considered and dropped as unverifiable; what is shared and
drift-proof is the catalog and admin-chain layer, because there is only one definition of it.

## Policy stances

- **Duplicate customer names are allowed.** Real company names collide, the operator is one trusted
  human, and an index would permanently forbid reusing a legal name. With no index there is no 23505
  path to handle anywhere.
- **One email address can be first admin of one customer.** Enforced by the runner, not the web tier,
  because the collision is cross-tenant and only the owner connection can see it. This prevents a worse
  failure: `consume_invitation` rebinding the same subject into a second tenant would hit the global
  unique index *after* provisioning reported success, at a moment no screen is watching.
- **Lost or expired links** are answered by the Reissue action, not by falling back to the CLI — the
  console exists to eliminate the CLI. `app_invitation.expires_at` is NOT NULL, so every link does die.

## Deferred (explicitly out of scope for v1)

- **Suspend / delete customer.** Deletion is a data-protection exercise of its own and deserves its own
  request. Nothing was built for it — not even a disabled flag.
- **WorkOS organization linkage.** `tenant.workos_org_id` gets a unique placeholder
  (`org_pending_<uuid>`). Sign-in resolves per *user* today (`app.principal_by_subject`), so the column
  is inert and nothing breaks.
- **Mid-flight per-step progress.** Provisioning completes in seconds inside a one-minute tick, so a 5s
  poll would never observe an intermediate step, and steps written outside the transaction would
  describe rows that may roll back. `current_step` is written only on failure.
- **A `job_run` breadcrumb.** 0280's read gate lets every customer's group admin read the whole
  `job_run` table, so a row naming a new customer would leak onboarding activity cross-tenant.

## Consequences

- Onboarding becomes: type a name and an email, wait under a minute, reveal a link, send it.
- The console is at `/operator`, deliberately **not** under `/admin` (which is customer-facing), with no
  nav entry. It is gated in-page on `isOperator` **and** not-the-demo-deployment — the gated consultant
  demo runs the identity switcher live behind `SHARE_PASSWORD`, so without that second condition a
  tester could reach a screen that creates real customers. `db/seed.ts` additionally withholds the
  operator grant when `ALLOW_DEMO_SESSION` is set.
- The 5-second refresh poller is genuinely new code; no interval poller existed in this codebase before.
  It mounts only while a request is in flight.
