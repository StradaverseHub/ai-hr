This guide is for HR administrators (`hr_admin` and `super_admin`) who own the people record and the organisation structure in AI HR. By the end you'll be able to set up companies, departments, positions and cost centres; hire and import employees; maintain each person's compensation, Malaysian statutory profile and reporting lines; run effective-dated transfers; and terminate employment — all from the **People** and **Admin → Organization** screens.

## Before you start: companies, departments, positions, cost centres

Every employee is hired *into* a company and assigned to one of that company's departments, so build the structure first.

1. In the left sidebar, open **Admin → Organization**. You'll land on a page titled **Organization** with three areas: **Group structure** (a read-only tree of all legal entities), **Companies**, and the add-company form at the bottom.
2. The **Companies** list shows one expandable panel per legal entity. Each panel header shows the registration number, the country badge (e.g. `MY`), a count summary like `2 dept · 3 pos · 1 cc`, and — for Malaysian companies — a `Statutory complete` (green) or `Statutory partial` (amber) badge.

### Add a company

At the bottom of the **Companies** card, fill in **Legal name**, **Country** (two-letter code, defaults to `MY`) and **Currency** (three-letter, defaults to `MYR`), then click **Add company**.

### Edit a company and its statutory identity

Click a company panel to expand it. Inside you'll find:

- **Details** — edit **Legal name**, **Reg. no**, **Country**, **Currency**, then **Save details**.
- **Group parent** — pick a **Parent company** (or `None (group root)`) to nest this entity under another, then **Set parent**. This is what draws the **Group structure** tree.
- **Statutory identity (MY)** — for Malaysian companies, record **EPF employer no.**, **SOCSO employer code**, **LHDN E-number**, **MyInvois TIN** and **SSM registration no.**, then **Save statutory identity**.

> **Note** The green/amber readiness badge keys on three identifiers: **EPF employer no.**, **SOCSO employer code** and **LHDN E-number**. Payroll filings and reports depend on these, so fill them in before your first payroll run.

### Departments, positions and cost centres

Each expanded company panel has three columns at the bottom:

- **Departments** — type a name and click **Add**.
- **Positions** — type a title and click **Add**.
- **Cost centres** — enter a **Code** and a **Name**, then **Add**.

To change an existing entry, use the inline editor on its row. Removal is two-tier:

| State | Control shown | Meaning |
| --- | --- | --- |
| Not referenced anywhere | **Delete** | Hard delete — safe because nothing points to it. |
| In use (assigned to staff) | **Archive** | Soft-hide; existing assignments and history stay intact. |

The same logic applies at company level: a company **in use** offers **Archive company**; an unreferenced one offers **Delete company** (with a confirmation dialog). Archived rows appear dimmed and can be brought back with **Unarchive**.

## Hiring an employee

1. In the sidebar, click **People**. You'll see the employee table (Name, Department, Company, Status, Hired) with a search box and an employee count.
2. Scroll to the **Hire an employee** panel at the bottom and expand it.
3. Fill in **Full name**, **Email**, **Company**, **Department**, **Employment type** (`Full-time`, `Part-time`, `Contract` or `Intern`) and **Hire date** (defaults to today).
4. Click **Hire**. The new person appears in the table and is given an employee code automatically. On hire, standing leave entitlements (annual, sick, hospitalisation) are granted per the company's country pack — annual leave is pro-rated for the months remaining in the hire year.

> **Tip** Both the **Company** and **Department** dropdowns are populated from **Admin → Organization**. If a department is missing, add it there first.

## The employee detail page

Click any name in the **People** table to open that person's record. The header shows their employee code, email, company, hire date and a status badge. As an admin you can edit the following sections.

### Personal details

Edit **Full name**, **Email** and **Phone** (use the `+60…` format), then **Save details**. A person record is shared across all of that individual's employments, so this updates the canonical identity everywhere.

### Compensation — "Update pay"

The **Compensation** card shows the current basic salary, allowance and the date it took effect. To change it, enter a new **Basic salary (MYR)** and **Allowance** and click **Update pay**. Pay history is preserved — a new effective-dated record is created rather than overwriting the old figure.

> **Note** The **Update pay** form is hidden once an employee is terminated.

### Statutory (Malaysia)

Maintain the fields payroll and filings depend on:

- **IC number**, **EPF number**, **SOCSO number**, **Tax number** (LHDN).
- **PCB category** — `1` Single, `2` Married/spouse not working, `3` Married/spouse working.
- **Children (PCB relief)** count.
- **Bank** and **Bank account** for payment.
- **EIS eligible** and **Tax resident** checkboxes.

Below that, the **TP3** section captures a mid-year joiner's prior-employer figures — **Applies to year**, **Net remuneration**, **EPF claimed** and **PCB paid** — so MTD is calculated correctly. Click **Save statutory** when done.

### Assignment history and change history

**Assignment history** lists every department/position period with its valid-from → valid-to dates (the current row is highlighted and ends at `Present`). **Change history** is the audit trail of edits to this record. Together they let you reconstruct exactly what was true on any past date — nothing is overwritten in place.

## Reporting lines (administrative, functional, project, dotted)

The **Reporting lines** card has two columns: **Reports to** (this person's managers) and **Direct reports**.

1. To add a line, use the form at the bottom: pick a **Manager** and a **Line type**, then **Add reporting line**.
2. **Line type** options:

| Type | Use for |
| --- | --- |
| `Administrative` | The primary, solid-line manager. |
| `Functional` | A functional/discipline lead. |
| `Project` | A project or temporary assignment. |
| `Dotted` | A secondary, advisory relationship. |

3. To end a relationship, click the **×** next to a manager in **Reports to**.

> **Note** Administrative lines are cycle-checked: if the manager already reports (directly or indirectly) to this person, the line is rejected to prevent a loop. Other line types allow matrix overlaps.

## Effective-dated transfers

Use the **Transfer** card to move someone to a new department from a chosen date.

1. Select the **New department** and an **Effective date** (defaults to today).
2. Click **Transfer**.

The current assignment is closed on that date and a new one opens — so the **Assignment history** table shows a clean, non-overlapping timeline. Reporting and payroll then read whichever assignment was in force on any given day.

## Terminating employment

In the **Terminate** card, pick a **Termination date** (defaults to today) and click **Terminate employment**. A confirmation dialog asks you to confirm by name. On termination the open assignment is closed on that date, and the **Update pay**, **Transfer**, **Terminate** and add-reporting-line forms disappear for that record. The person's status badge switches to `terminated`.

> **Tip** Termination doesn't delete anything — payslips, leave history and the EA form remain available for statutory and final-pay purposes.

## CSV import (dry-run, then commit)

For onboarding many people at once — for example a day-one migration — use the importer.

1. On the **People** page, click **Import CSV** (top right; admins only). The **Import employees** page opens.
2. Pick the **Target company** (it defaults to your active company, or the entity with the most departments).
3. Paste your rows into **CSV data**, or click **Load sample** to drop in a template you can edit.
4. Expand **Column reference** to see what's recognised:
   - **Required:** `full_name`, `email`, `department`, `hired_on`, `ic_number`, `basic_salary`
   - **Optional:** `phone`, `position`, `cost_center`, `employment_type`, `monthly_allowance`, `bank_name`, `bank_account_no`, `epf_number`, `socso_number`, `tax_number`, `tax_category`, `num_children`, `eis_eligible`, `is_resident`
5. Click **Validate**. This is a dry-run — nothing is written yet. The **Preview** table shows each row as `Ready` (green, sometimes with amber warnings) or with its errors in red, plus a header count of ready vs. with-errors rows. Missing columns are flagged at the top.
6. Fix any issues in your CSV and **Validate** again (any edit clears the previous preview, so you always import exactly what you last checked).
7. When you're happy, click **Import N valid** to commit. Only valid rows are written; invalid ones are skipped. The result banner reports imported / skipped / failed counts and lists any failures by row.
8. Click **View people** to see the new joiners, or **Import another** to clear and start again.

> **Note** Department, position and cost-centre values in the CSV are matched against the **Target company's** catalogue by name/code, so make sure those exist in **Admin → Organization** first. `bank_name` and `bank_account_no` should be supplied together.

## Common pitfalls

- **"Add company" / dropdowns empty.** Build companies and departments in **Admin → Organization** before hiring or importing.
- **Amber "Statutory partial" badge.** A Malaysian company is missing one of EPF / SOCSO / LHDN employer identifiers — expand the panel and complete **Statutory identity (MY)** before payroll.
- **Can't delete a department/position/company.** It's referenced by staff or history, so only **Archive** is offered. Archive instead of forcing a delete.
- **Reporting line rejected.** You created an administrative cycle — choose a different line type or a manager who isn't already below this person.
- **Import rows skipped.** Check the failure list in the result banner; common causes are a missing required column, an unknown department name, or a malformed `ic_number` / `hired_on` value.
- **Edits not taking effect on a terminated employee.** Pay, transfer and reporting-line controls are intentionally hidden after termination.
