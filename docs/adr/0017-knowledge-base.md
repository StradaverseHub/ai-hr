# ADR-0017 — Knowledge Base

Status: **Accepted** · Date: 2026-06-14

## Context

The product needs an in-app **knowledge repository**: a place where a tenant's users upload documents,
read them, edit them, and download them — and where the system ships **default, comprehensive user
guides** for every module, written from three perspectives (employee, manager, HR admin) covering the
whole journey from an empty database to a running HR operation. New customers and new staff should never
face a blank product with no instructions.

This is distinct from statutory reporting (ADR-0010) and from system-user onboarding (ADR-0018, the
interactive first-login tour). The KB is durable reference content; onboarding is a one-time walkthrough.

## Decision

### 1. One table, two content kinds — `kb_document`

A single table holds both editable native articles and uploaded binary files, discriminated by `kind`:

- `kind = 'article'` — Markdown authored/edited in-app. Body in `body` (text). Viewable (rendered),
  editable inline, downloadable as `.md`.
- `kind = 'file'` — an uploaded binary (PDF, image, docx, …). Bytes in `content` (`bytea`),
  with `file_name`, `mime_type`, `size_bytes`. Viewable (inline where the browser can) / downloadable;
  not text-editable (you replace the file).

Shared columns: `tenant_id`, `title`, `slug` (stable id for system guides + clean URLs), `category`
(module tag — `getting-started` / `people` / `leave` / … / `general`), `audience`
(`all` | `employee` | `manager` | `hr_admin` — an informational filter, **not** an access control),
`is_system` (true for the seeded guides), `created_by_user_id`, `updated_by_user_id`, timestamps,
`archived_at` (soft delete — KB content is referenced and shouldn't hard-vanish).

### 2. Files live in Postgres `bytea` (for now)

Bytes are stored in the row, not an object store. Rationale: no object storage is provisioned for local
dev or the current target; keeping bytes in Postgres makes tenancy + RLS **uniform** (the file is
governed by the same row policy as its metadata) and keeps the deployment single-dependency. A service
guard caps uploads at **10 MB**; the `content` column is selected **only** on download, never in list
reads. This is explicitly swappable: moving to S3/R2 later means replacing `content` with a storage key
and a signed-URL fetch — no API or RLS-shape change. Documented as a known trade-off, not an oversight.

### 3. RLS — read-shared within the tenant, write-scoped to author or admin

The KB is *shared organizational knowledge*, so any tenant member may read all of it; `audience` only
filters the view. Writes are constrained:

```sql
SELECT  : tenant_id = app.current_tenant_id()                     -- everyone in the tenant
INSERT  : tenant_id = app.current_tenant_id()                     -- any member may contribute
UPDATE/DELETE : tenant_id = app.current_tenant_id()
            AND (app.is_admin() OR (created_by_user_id = app.current_user_id() AND is_system = false))
```

So a member edits/removes their own non-system documents; **system guides are admin-managed** (a normal
user can't clobber the official guide), and admins manage everything. `app.current_user_id()` already
exists (ADR-0004). Seeding runs as the owner role and bypasses RLS.

### 4. Domain events (substrate, ADR-0006)

Every write appends a `DomainEvent`: module `knowledge-base`, aggregate `kb-document`, events
`kb.document.created` / `.updated` / `.uploaded` / `.archived` / `.restored`. `subject_employment_id`
is **null** — KB documents are org-level content, not employee-scoped PII, so they're admin-only in the
audit read (consistent with ADR-0015's null-subject rule). The skip of subject-scoping is deliberate and
documented here.

### 5. Default guides are seeded, idempotent system articles

The "system automatically writes user guides" requirement is met by **seeding**: comprehensive Markdown
guides (authored to match the real app) live under `content/guides/<slug>.md` with a `manifest.json`
(slug, title, audience, category, order). `db/seed-guides.ts` upserts each as a `kind='article',
is_system=true` document keyed by `slug` — idempotent, so re-running never duplicates, and editing a
guide file + re-seeding refreshes it. They populate on `pnpm db:seed` (and a standalone `pnpm kb:seed`).
Authors them once via a multi-agent workflow that reads the actual module code so the navigation/labels
are real, not invented.

### 6. Rendering & editing

Markdown is rendered with `react-markdown` + `remark-gfm`, with element overrides mapped to the design
tokens (no raw-HTML pass-through → no stored-XSS from user Markdown). Editing is an inline editor
(textarea + live preview). Downloads go through a Route Handler that re-checks the session and streams
the article (`text/markdown`) or the file (original `mime_type`, `Content-Disposition: attachment`).

## Consequences

- A new tenant has a full library of role-specific guides on day one; staff have a self-serve reference.
- Uploads are bounded (10 MB, Postgres bytea) — fine for policies/handbooks/forms; large-media or
  high-volume document management is the trigger to move to object storage (one-column change).
- `audience` is a filter, not a wall: anything in the KB is readable tenant-wide. Truly confidential
  documents do not belong here — that's a deliberate scoping choice for a *knowledge* base.

## Alternatives considered

- **Separate tables for articles vs files** — more tables, duplicated RLS/event wiring, and the UI wants
  one unified library anyway. One discriminated table is simpler.
- **Object storage now** — correct at scale, but unprovisioned here; would add a dependency and split the
  security model. Deferred behind the swappable `content` column.
- **Runtime AI-generated guides** — non-deterministic, needs an LLM call path ai-hr doesn't ship, and
  would vary per render. Authored-then-seeded content is reviewable in PRs and stable.
- **Markdown via `dangerouslySetInnerHTML` + a sanitizer** — workable but easy to get wrong; a
  no-raw-HTML React renderer is safe by construction.
