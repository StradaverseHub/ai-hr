This guide is for HR administrators who manage **who can do what** inside AI HR and who need to answer the question *"who changed this, and when?"*. By the end you'll know how to read and grant the four roles, the difference between a group-wide and a company-scoped grant, how a company admin can safely delegate within their own part of the group, how to revoke access, and how to use both the global **Audit trail** and the per-record **History** that read from the append-only event log.

> **Note** The pages described here live under **Admin** in the left sidebar. If you don't see them, your account doesn't carry an admin role — only `hr_admin` and `super_admin` can open `/admin/users` and `/admin/audit`. Everyone else is redirected to the dashboard.

## The four roles

AI HR has exactly four roles. They stack — a person can hold more than one.

| Role | What it means | Typical holder |
| --- | --- | --- |
| `employee` | Self-service only: own profile, payslips, leave, attendance | Every staff member |
| `manager` | Adds the **Approvals** inbox for their reports | Team leads, line managers |
| `hr_admin` | Adds the full **Admin** suite (Organization, Leave config, Payroll, Users & roles, Audit trail) | HR/operations |
| `super_admin` | Everything `hr_admin` has, **always across the entire group** | Platform owner |

Roles display as small rounded tags (the **RoleTag**), so on the Users page you'll see them written as `employee`, `manager`, `hr admin`, and `super admin`.

## Group-wide vs company-scoped grants

This is the most important concept on the page, because AI HR is **multi-company**: one tenant can hold several companies in a parent/child tree.

- A **group-wide** grant has no company attached. It applies across every company. `super_admin` is *inherently* group-wide — the system never scopes it to a single company.
- A **company-scoped** grant attaches an `hr_admin` to one specific company (and, by the group tree, its subtree). On the Users page a scoped role shows the company name next to the tag, like `hr admin · Acme Sdn Bhd`.

> **Note** Only `hr_admin` actually consumes a company scope today. If you pick a company for `employee` or `manager`, the system stores the grant as group-level anyway — so don't rely on company scoping for those two roles.

## Granting a role

1. In the left sidebar, open **Admin → Users & roles** (`/admin/users`).
2. You'll see a list of every user. Each row shows their avatar, name, email, and the role tags they already hold. The header shows the total user count.
3. Find the person, then use the inline form at the right of their row:
   - In the first dropdown, choose the **role**.
   - In the second dropdown, choose a **company** (the scope) — or leave it on **Group-wide**.
   - Click **Add role**.
4. The new tag appears on their row immediately.

**What you'll see depends on your own access.** The page tailors itself:

- A **group admin** (a `super_admin`, or a group-wide `hr_admin`) can grant *any* of the four roles, for any company or group-wide. The company dropdown includes a **Group-wide** option at the top.
- A **delegated (company-scoped) admin** sees a reduced form: the role dropdown offers only `hr_admin`, and the company dropdown lists only the companies they administer. In other words, a company admin can appoint other HR admins, but only inside their own subtree.

> **Tip** Provisioning of the underlying user accounts happens through your identity provider (WorkOS). The grey note at the top of the Users page explains this. AI HR is where you assign *roles* to people who already exist — it isn't where you create login accounts from scratch.

## Sub-delegation: a company admin assigning within their subtree

AI HR is built so you can hand off HR administration safely without giving away the keys to the whole group.

- A group admin scopes an `hr_admin` to, say, **Acme Sdn Bhd**.
- That person can now open **Users & roles** and appoint further `hr_admin` grants — but the form only lets them pick `hr_admin`, and only for **Acme** and any companies beneath it in the group tree.
- They can't escalate. They can't mint a `super_admin`, and they can't reach a sibling company outside their subtree.

This boundary is enforced by row-level security in the database, not just by hiding buttons — so even a crafted request can't cross the line.

## Revoking a role

1. On **Users & roles**, locate the role tag you want to remove.
2. Click the small **×** to the right of the tag (its tooltip reads **Revoke role**). It turns red on hover.
3. The grant is removed and the tag disappears.

**Who can revoke what:**

- A **group admin** can revoke any role tag.
- A **delegated admin** only sees the **×** on **company-scoped `hr_admin`** grants — the ones inside their subtree. Group-wide grants and other roles have no remove control for them.

> **Note** Revocation is genuinely permission-checked. If a delegated admin somehow targets a grant outside their subtree, the action fails with *"Not permitted to revoke this role assignment"* and nothing is changed or logged — the system never records a revoke for a row that still exists.

## The audit trail (`/admin/audit`)

Every state change in AI HR appends an entry to an **append-only event log** — nothing is ever edited or deleted in place. The Audit trail is your window onto that ledger.

1. In the sidebar, open **Admin → Audit trail** (`/admin/audit`).
2. At the top is a filter bar with four controls and a **Filter** button:
   - **Record type** — narrow to one kind of record, e.g. `Role assignment`, `Employee`, `Leave request`, `Payroll batch`. Leave on **All** to see everything.
   - **Search event** — free-text match on the event name.
   - **From** / **To** — a date window.
   - Click **Filter** to apply, or **Reset** to clear.
3. Below, events appear newest-first, 100 per page. Use **Older →** and **← Newer** at the bottom to move between pages; the indicator shows the current page number.

**Reading a row.** Each row is one event. From left to right you'll see:

- A small **coloured dot** indicating the actor type — a person (`USER`), the `System`, an `Agent`, or `External`.
- The **humanised event name** (e.g. `Role assigned`, `Role revoked`, `Company updated`) and **who** did it.
- The **record** it touched (often a clickable link, e.g. an employee or payroll batch).
- A **relative timestamp** (`just now`, `5m ago`, `3h ago`, `2d ago`). Hover to see the exact date and time.

Click any row to expand it. A small detail block shows what changed — for edits, a `from → to` diff per field; for other events, the relevant fields. A sequence number sits at the bottom of the detail.

> **Note** Sensitive values are masked in the audit view. Bank account numbers, IC numbers, tax numbers, and salary/pay figures render as `•••• 1234` (or `••••`) so the trail stays useful without exposing PII or financial data.

## Per-record History

You don't have to wade through the global log to investigate one person. Open any employee from **People**, scroll to the **Change history** section near the bottom of their detail page. It uses the same expandable rows as the Audit trail, but pre-filtered to just that employee's events — role grants, profile and bank changes, compensation, statutory edits, and more.

> **Tip** The **Change history** block is admin-only. Managers and employees viewing a profile won't see it.

## Troubleshooting & common pitfalls

- **I can only grant `hr_admin`.** You're a company-scoped (delegated) admin. That's by design — you can appoint HR admins inside your subtree but nothing higher.
- **The company dropdown is missing the company I need.** You only see companies you administer. Ask a group admin to widen your scope, or to make the grant for you.
- **The `×` to revoke isn't there.** You can only revoke company-scoped `hr_admin` grants within your subtree. Group-wide or higher grants need a group admin.
- **I scoped a `manager` to a company but it shows group-wide.** Expected — only `hr_admin` carries a company scope. Manager and employee grants are always group-level.
- **An event seems to be missing.** Check your filters first (Record type and date window are sticky across pages). Remember the log is append-only — entries are never removed, so widen the window rather than assuming it was deleted.
