This guide is for the HR administrator setting up AI HR for the first time. It takes you from an empty database to a running Malaysian HR operation — company structure, people, statutory profiles, leave rules, roles, and your first payroll run — in the order that actually works. Work top to bottom: later steps depend on earlier ones (you can't hire into a company that doesn't exist, and you can't run payroll for an employee with no IC number).

## 1. First login and the identity / role concept

When you open the app you land on the **Dashboard**. The left sidebar is your map: Dashboard, My workspace, People, Org chart, Leave, Attendance, Approvals, Performance, and — for admins — an **Admin** group (Organization, Leave config, Users & roles, Audit trail) plus **Payroll**.

**How identity works.** Production logins are provisioned through **WorkOS** (SSO or invite). In a local/dev environment you'll see a small **Dev as** dropdown in the top bar — it lets you "act as" any seeded principal (for example *HR Admin · hr_admin*) to test what each role sees. Pick the `hr_admin` (or `super_admin`) identity before you start; the Admin and Payroll sections only appear for those roles.

**The four roles**, in increasing power: `employee` → `manager` → `hr_admin` → `super_admin`. You'll assign these in step 7.

**Note.** Every change is recorded with your identity in the **Audit trail** (`Admin → Audit trail`). Nothing is anonymous — by design.

## 2. Create your company structure

In the sidebar, open **Admin → Organization**. You'll see **Group structure** (a tree of every company) and a **Companies** list below it.

A typical Malaysian group has a holding company over an operating legal entity. Build it in that order:

1. Scroll to the **Add company** form at the bottom of the Companies card.
2. Enter the holding company in **Legal name** (e.g. `Demo Group Holdings Bhd`). Leave **Country** as `MY` and **Currency** as `MYR`.
3. Click **Add company**.
4. Repeat for your operating entity (e.g. `Demo Sdn Bhd`).
5. Click a company row to **expand** it. Under **Group parent**, set the operating entity's **Parent company** to the holding company and click **Set parent**. The Group structure tree now nests them.

**Inside each expanded company panel** you also manage its building blocks — these live *inside* the company, not globally:

- **Departments** — type a name (e.g. `Finance`, `Engineering`) and click **Add**.
- **Positions** — a job title (e.g. `Executive`) and click **Add**.
- **Cost centres** — a short **Code** (e.g. `HQ`) and **Name** (e.g. `Headquarters`), then **Add**.

**Statutory identity (MY).** Still inside the panel, fill the **Statutory identity (MY)** section for the entity that actually employs people: **EPF employer no**, **SOCSO employer code**, **LHDN E-number**, **MyInvois TIN**, **SSM registration no**. Click **Save statutory identity**. The panel header shows a `statutory ✓` badge once the three filing identifiers (EPF, SOCSO, LHDN) are present — these feed every monthly and annual report.

**Tip.** Build departments and positions on the *operating* company, not the holding shell — that's where people get hired.

**Note on deleting vs archiving.** A record that's referenced (a department with staff, a company with sub-companies) can't be deleted — the app offers **Archive** instead so history stays intact. Only an unused record shows a **Delete** option.

## 3. Add people

Open **People** in the sidebar. You have two ways to bring staff in.

### Hire one at a time

1. On the People page, expand **Hire an employee** at the bottom.
2. Fill **Full name**, **Email**, choose the **Company** and **Department**, set **Employment type** (`Full time`, `Part time`, `Contract`, or `Intern`), and the **Hire date**.
3. Click **Hire**. Standing leave (annual, sick, hospitalization) is granted automatically based on the company's policy and the Malaysian statutory floor.

### Bulk CSV import (day-one migration)

For onboarding a whole company at once, click **Import CSV** (top right of People), or go to `/people/import`.

1. Pick the **Target company**.
2. Paste your CSV into **CSV data**, or click **Load sample** to see the exact format. Expand **Column reference** to see required vs optional columns.
   - **Required:** `full_name`, `email`, `department`, `hired_on`, `ic_number`, `basic_salary`.
   - **Optional:** `phone`, `position`, `cost_center`, `employment_type`, `monthly_allowance`, `bank_name`, `bank_account_no`, `epf_number`, `socso_number`, `tax_number`, `tax_category`, `num_children`, `eis_eligible`, `is_resident`.
3. Click **Validate**. A preview table shows each row as `ready` (green) or with errors (red). Department names are resolved against the target company.
4. When the preview looks right, click **Import N valid** to commit. A green summary shows how many were imported, skipped, or failed.

**Common pitfalls.**

- `department` must match a department that already exists in the target company (case-insensitive) — create your departments in step 2 first.
- `hired_on` should be `YYYY-MM-DD`.
- `bank_name` and `bank_account_no` are both-or-neither — supply both or leave both blank.

## 4. Set each employee's Malaysian statutory profile

CSV import already captures the statutory basics. To review or fill them in for a hand-hired employee, open **People**, click the person's name, and use the **Statutory (Malaysia)** card:

| Field | What it's for |
|---|---|
| **IC number** | NRIC — required for any statutory filing |
| **EPF / KWSP number** | EPF member number |
| **SOCSO number** | PERKESO contributor number |
| **Tax number** | LHDN tax file number |
| **PCB category** | `1 — Single`, `2 — Married, spouse not working`, `3 — Married, spouse working` |
| **Children** | Number of qualifying children (affects PCB relief) |
| **Bank name / account no** | For the payment summary |
| **EIS eligible / Resident** | Checkboxes; affects EIS and PCB treatment |

Set the pay on the same page under **Update pay**: enter **Basic salary (MYR)** and any **monthly allowance**, then save.

**Note.** Payroll won't be fully ready for an employee missing their IC, tax number, EPF or SOCSO number — the report **Readiness** check (step 8/9) will flag exactly who and what's missing.

## 5. Configure leave

Open **Admin → Leave config**. The page has a **Leave types** card and a **Leave year** card.

**Leave types and entitlements.** A Malaysia pack seeds the standard types (annual, sick, hospitalization) with the statutory floor already wired in.

1. Expand a leave type to see its **Statutory minimum (MY)** (read-only — the EA 1955 floor by service band: under 2 / 2–5 / 5+ years) and its **Company entitlements** timeline.
2. To offer *more* than the floor, click **+ Add entitlement**, set **Days per year** (and, for annual leave, a **Carry-cap**), pick **Effective from**, and **Add**. Grants always apply the **greater** of the floor and your policy — a value below the minimum is recorded but never applied (you'll see a `below minimum` badge).
3. To add a custom type, use the form at the bottom: **Code** (uppercase, e.g. `ANNUAL`), **Name**, the **Paid** checkbox, then **Add type**.

**Open the leave year.** In the **Leave year** card, set the **Year** (defaults to next year) and click **Open leave year**. This posts every active employee's new entitlement at their current service band, carries unused annual leave up to the cap (the rest is forfeited), and resets sick/hospitalization. It's idempotent — re-running skips anyone already opened.

## 6. Attendance policy

Each operating company gets a default attendance policy when it's created, so check-in/check-out and overtime work out of the box. Open **Attendance** in the sidebar to see today's punches, statuses (`present`, `late`, `half day`, `absent`) and overtime. Exceptions are handled through **correction requests**: an employee who forgot to clock in submits a correction, and you or their manager approve or reject it from the **Attendance** page or the unified **Approvals** inbox.

## 7. Assign user roles

Open **Admin → Users & roles**. You'll see every existing user with their current role tags.

1. Find the user.
2. In their row, pick a **role** from the dropdown (`employee`, `manager`, `hr_admin`, `super_admin`).
3. For **HR Admin** grants, also pick a **company scope** — that company *and its sub-companies* — or **Group-wide**. Other roles are always group-wide.
4. Click **Add role**. To remove a grant, click the **×** next to its tag.

**Note.** New logins themselves are provisioned via WorkOS later; here you're managing roles for users who already exist. A scoped (delegated) HR admin can only appoint another `hr_admin` within their own subtree.

## 8. Run your first payroll batch

Open **Payroll** in the sidebar (the **Batches** tab).

1. In the **Create batch** form, choose the **Company** and a **Pay period** in `YYYY-MM` (defaults to the current month). Click **Create batch**.
2. Open the new batch from the list. While it's `draft`, you'll see **Inputs** per employee — enter **OT**, **Bonus**, **TP1**, **Zakat** as needed and **Save** (or click **Prefill OT** to pull overtime from approved attendance). A **leaver advisory** appears for anyone terminated in the period.
3. Click **Generate payslips**. The batch moves to `processed` and the **Payslips** table shows each person's **Gross**, **Bonus**, **EPF**, **SOCSO**, **EIS**, **PCB**, and **Net**, plus headline totals (gross, deductions, net, employer cost).
4. Review the statutory deductions. When you're satisfied, click **Close batch** (status `closed`) to lock it. A closed batch is immutable.

**Tip.** After processing you can download a **Payment summary** for manual bank upload from the batch header.

## 9. Statutory reports

Open **Payroll → Reports** (the **Reports** tab). Choose a **Company**, a **Report**, and a **Period** (or **Year** for annual forms), then click **Preview**:

| Report | Cadence | Covers |
|---|---|---|
| **CP39 — MTD / PCB (LHDN)** | Monthly | Monthly tax deduction statement |
| **EPF contributions (KWSP)** | Monthly | EPF employee + employer |
| **SOCSO + EIS (PERKESO)** | Monthly | SOCSO and EIS contributions |
| **Form E / CP8D — annual (LHDN)** | Annual | Year-end employer return |
| **Monthly statutory contributions (overview)** | Monthly | Combined snapshot |

Each preview shows totals, a **Readiness** panel listing any employee with missing statutory data, and the row table. Use **Download CSV** to export, and **Record generation** to log the run in the audit trail. From a report row you can open an individual employee's **EA form** for the year. The **Compliance worklist · CP22 / CP22A** at the top of the page surfaces new-hire and cessation filings driven by the event log.

**Note.** These are Layer-A reports — human-readable summaries to remit from or hand to your accountant. A draft CP39 `.txt` is available for CP39 but is marked *DRAFT, not for submission*; byte-exact agency files arrive in a later release.

## You're live — checklist

- [ ] Logged in as `hr_admin` / `super_admin`
- [ ] Holding + operating companies created, parent set
- [ ] Departments, positions, cost centres added to the operating entity
- [ ] Statutory identity (EPF / SOCSO / LHDN) saved → `statutory ✓` badge
- [ ] People added (hired or CSV-imported)
- [ ] Each employee's IC, EPF, SOCSO, tax no., PCB category, children, bank set
- [ ] Pay set via **Update pay**
- [ ] Leave types reviewed, entitlements set, **leave year opened**
- [ ] Roles assigned in **Users & roles**
- [ ] First payroll batch generated, reviewed, and **closed**
- [ ] Statutory reports previewed with a clean **Readiness** check
