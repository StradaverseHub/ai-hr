This guide is for HR administrators and compliance officers responsible for Malaysian statutory filing. It walks you through everything on the **Payroll → Reports** screen: the monthly EPF/KWSP, SOCSO/PERKESO, EIS and PCB figures; the annual EA form per employee; the Form E / CP8D employer return; the CP39 monthly MTD text file; the CP22 / CP22A new-hire and cessation worklist; and the CSV and bank payment exports. Crucially, it explains **what is a ready-to-submit file versus a draft or an advisory summary** — so you know exactly what you can hand to LHDN, KWSP and PERKESO, and what still needs a human check first.

You'll need an `hr_admin` or `super_admin` role. Reports are filed **per legal entity (company)**, so everything you generate is scoped to the company you pick.

## Getting to the Reports screen

1. In the left sidebar, open **Payroll**.
2. Along the top of the Payroll area, click the **Reports** tab. The page heading reads **Payroll · Statutory & compliance reports**.

At the top you'll see the **Compliance worklist · CP22 / CP22A** card, then an amber banner explaining the report layer, then the **Generate report** form, and at the very bottom a **Recent generations** audit table.

> **Note — the Layer-A banner.** Most reports here are **Layer-A**: a human-readable summary you remit from or hand to your accountant. The banner says it plainly: *"Byte-exact agency files (CP39 / KWSP / PERKESO / bank) come in a later slice, each sourced + verified."* Treat the on-screen tables and CSV exports as a reliable working summary, not as the agency's official upload file — with the two exceptions noted below (CP39 .txt and the payment summary).

## Generating a monthly statutory report

The **Generate report** form has four controls: **Company**, **Report**, **Period (YYYY-MM)** (or **Year (YYYY)** for annual reports), and a **Preview** button.

1. Pick the **Company** (the legal entity you're filing for).
2. Choose a **Report**. The monthly options are:
   - `Monthly statutory contributions (overview)` — every contribution at a glance: Gross, EPF (EE+ER), SOCSO (EE+ER), EIS (EE+ER) and PCB.
   - `CP39 — MTD / PCB (LHDN)`
   - `EPF contributions (KWSP)` — Borang A basis, split into Employee / Employer / Total.
   - `SOCSO + EIS (PERKESO)` — ASSIST basis, with EE and ER columns.
3. Enter the **Period** as `YYYY-MM`, e.g. `2026-07`.
4. Click **Preview**.

The page assembles the report from that company's **payroll batch** for the period. You'll see headline total tiles (one per money column), then a table with one row per employee.

> **Tip.** If you see *"No payroll batch found for … Run payroll for this period first."*, there's simply no batch for that company and month. Go back to the main **Payroll** screen, run and process the batch, then return here.

### Reading the readiness check

Above the table, a red box may appear: **"N employee(s) missing identifiers needed to file."** This lists employees whose required IDs are blank for that report — for example a missing `Tax no`, `EPF no`, or `SOCSO no`. Missing values also show as empty red cells in the table. Fix these before you file: open the person under **Personnel**, complete their statutory identity, re-run preview. A clean report has no red box.

## Exporting and recording a monthly report

In the report header row you'll find two or three actions:

- **Download CSV** — exports exactly the columns and rows on screen, named like `my.cp39_2026-07.csv`. This is the working file to send to your accountant or reconcile against the agency portals.
- **Record generation** — saves an append-only `statutory report` artefact and stamps it with the statutory tables version. Use this when you've reviewed the figures and want an audit record that "this report was produced for this company and period." It does **not** submit anything to any agency.
- **CP39 .txt — DRAFT, not for submission** — appears only for the CP39 report once readiness is clean (see below).

Every recorded generation lands in the **Recent generations** table at the bottom, showing the report type, period, status (`draft`), row count and the **Tables ver.** used — your reproducibility trail.

## The CP39 monthly PCB file

CP39 is the monthly MTD/PCB statement to LHDN. The screen gives you two things:

1. **The CP39 table + CSV** (Layer-A) — Employee, Tax no, IC, MTD / PCB, with a total. Use this to review and reconcile.
2. **The CP39 .txt download** (Layer-B) — a fixed-width text file in the LHDN e-Data PCB byte layout (Exhibit 4), suitable for upload to the e-PCB portal.

To get the `.txt`: select the `CP39 — MTD / PCB (LHDN)` report, preview a period, and **make sure there are no readiness errors**. When readiness is clean, an amber button labelled **CP39 .txt — DRAFT, not for submission** appears in the header. Click it to download.

> **Important — this is a DRAFT.** The button label, the tooltip, and the file's own header all say so: *"DRAFT until verified against e-PCB Plus."* Open it, sanity-check the totals against the on-screen figures, and verify it in the live **e-PCB Plus** portal before you treat it as a submission. Each download is logged as its own statutory artefact and domain event, so you have a record of every draft pulled.

## The annual EA form (per employee · C.P.8A)

The EA form is each employee's annual Statement of Remuneration.

1. In **Generate report**, choose `Form E / CP8D — annual (LHDN)`. The period field switches to **Year (YYYY)** — enter e.g. `2026`.
2. Click **Preview** to load the CP8D table (one numbered row per employee).
3. Click an **employee's name** in the table to open their **EA (C.P.8A)** statement.

The EA page shows: **A · Employee particulars** (name, TIN, IC, EPF no., SOCSO no., MTD category, children, employment period), **B · Employment income (cash)** (gross salary incl. overtime, bonus, allowances, total gross remuneration), **D · Total deductions** (MTD/PCB), **E · Contributions** (EPF/KWSP, SOCSO, EIS — employee's share), and **F · Tax-exempt allowances**. Use the **Print** button (top right) to produce a PDF or paper copy to hand the employee.

> **Note — employees can self-serve.** Each employee can open their own EA from **My workspace** (the EA links to `/payroll/reports/ea/…?year=2026`), so you don't have to print one for everyone.

> **What the EA does NOT include.** The blue disclaimer spells it out. The figures cover cash remuneration, EPF, SOCSO/EIS and MTD only. **Benefits-in-kind, value of living accommodation, ESOS, gratuity, tax-exempt allowances, zakat and CP38 are not tracked in payroll** and show as `not tracked`. Add any of these before filing. This is a generated working statement, not a substitute for the official LHDN form.

## Form E / CP8D (annual employer return)

The same `Form E / CP8D — annual (LHDN)` preview that lists employees also gives you the employer return:

- The **summary tiles** at the top are **Form E Part A headcounts**: Active at 31 Dec, Subject to MTD, New hires, Ceased.
- The **CP8D table** is the per-employee schedule: No., Employee, TIN, IC, Cat., Children, Gross remuneration, EPF, MTD/PCB, SOCSO — plus totals.
- **Download CSV** to hand to your tax agent, or **Record generation** for the audit trail.

> **Important — same scope caveat.** The blue note on this report warns it covers payroll-derived figures only. **Benefits-in-kind, living accommodation, ESOS, tax-exempt allowances, zakat and CP38 are not here** — add them in **MyTax / e-CP8D** before filing.

## The CP22 / CP22A worklist (new hires & cessations)

The **Compliance worklist · CP22 / CP22A** card at the top of the page is driven from the hire/termination lifecycle in the event log. It surfaces LHDN notifications that are coming due, so nothing slips:

| Column | Meaning |
| --- | --- |
| **Employee** | Who the notification is for |
| **Form** | `CP22` (new hire) or `CP22A` (cessation) |
| **Reason** | `New hire` or `Cessation` |
| **Event date** | Hire date, or cessation date |
| **Notify by** | The deadline (30 days after a hire; ≥30 days before a cessation) |
| **Status** | `overdue` (red), `due soon` (amber, within 7 days), or `upcoming` (grey) |

Items are sorted overdue first. When nothing is pending you'll see **"Nothing due."**

> **Important — this is advisory only.** As the card states: *"File in MyTax; this surfaces what's outstanding."* The app **never auto-submits** CP22/CP22A. Use the worklist as your reminder, then file in MyTax yourself. There's no "mark as filed" yet, so an item simply ages out of the relevance window after its deadline.

### Downloading the CP22 itself

Each **new hire** row in the worklist carries a **Download CP22** button, and the **CP22 / CP22A notices** row on the LHDN shelf carries **Download blank CP22** beside **Open worklist**.

What downloads is LHDN's official **CP22 (Pin. 1/2020)** page exactly as published — same layout, same wording, same Malay and English — with typing boxes added on top of it. **26 of the 33 boxes arrive filled** from records you already keep: your company name, address, E number and telephone; the joiner's name, job title, start date, expected duration, home and correspondence addresses, telephone, e-mail, income tax number, identity card number, passport number, gender, citizenship, date of birth and marital status; their spouse's name and identity card number where a spouse is on record; their monthly basic pay and fixed monthly allowances; and today's date in the signature block.

**Seven boxes are left empty**, because the information is not held anywhere in the system: the LHDN branch address at the top, the tax-agent tick, any earlier passport registered with LHDNM, the spouse's income tax number, fluctuating payments and when they will be known, the previous employer in Malaysia, and the signature line itself.

> **Every box stays typeable — including the 26 that arrive filled.** The file is not flattened, so you can correct anything before you sign and finish the remaining seven in the downloaded file. Nothing is saved back: this reads records you already maintain and hands you a file.

Anything not on record comes through **blank rather than wrong** — no tax number, identity card number or spouse detail is ever guessed. Your own name and job title in the signature block fill in when you have your own staff record on the system, and stay blank when you do not. **CP22A is not covered yet**, so those rows show a dash instead of a button. For a late filing on a hire older than the 60-day window the list covers, use the blank copy.

## The bank payment summary (manual bank upload)

The **payment summary** is a neutral employee / bank / account / net-pay CSV for uploading to your bank. It is generated from a **processed or closed** payroll batch (download it from the batch on the main **Payroll** screen, not from the Reports form). Admin-only; the export is logged as a domain event on the batch.

> **Note — not a giro file.** This is a plain CSV, **not** a byte-exact bank-specific giro file. If a batch isn't ready yet you'll get a clear "not ready" message telling you what to do; finish processing the batch and try again.

## Quick reference: ready-to-submit vs draft/advisory

| Output | What it is | Status |
| --- | --- | --- |
| Monthly tables + **Download CSV** (contributions, CP39, EPF, SOCSO/EIS) | Human-readable Layer-A summary | **Advisory** — remit from / hand to accountant |
| **CP39 .txt** | LHDN e-Data PCB byte layout (Exhibit 4) | **DRAFT** — verify in e-PCB Plus first |
| **EA (C.P.8A)** per employee | Statement of remuneration, printable | **Advisory** — cash items only; add BIK etc. |
| **Form E / CP8D** table + CSV | Annual employer return | **Advisory** — complete in MyTax / e-CP8D |
| **CP22 / CP22A** worklist | Filing reminders | **Advisory** — file in MyTax; never auto-submitted |
| **Payment summary** CSV | Bank upload list | Ready for **manual** bank upload (not a giro file) |
| **Record generation** | Append-only audit artefact | An audit record — **not** a submission |

## Troubleshooting & common pitfalls

- **"No payroll batch found …"** — run payroll for that company and period first, then preview again.
- **Red "missing identifiers" box / empty red cells** — complete the employee's IC, Tax no, EPF no or SOCSO no under **Personnel** before filing.
- **No CP39 .txt button** — it only appears for the CP39 report with **zero** readiness errors. Clear the red box first.
- **EA / CP8D totals look low** — remember benefits-in-kind, accommodation, ESOS, gratuity, tax-exempt allowances, zakat and CP38 are not tracked; add them in MyTax before filing.
- **Filing the wrong company's figures** — every report is per legal entity. Double-check the **Company** selector before you export.
- **"Record generation" did nothing visible** — it's an audit action, not a submission. Confirm it in **Recent generations** at the bottom of the page.
