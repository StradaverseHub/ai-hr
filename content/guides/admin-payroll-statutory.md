This guide is for HR administrators and payroll officers running monthly Malaysian payroll in AI HR. By the end you'll know how to set up an employee's statutory profile, create and process a payroll batch, read how EPF/KWSP, SOCSO/PERKESO, EIS/SIP and PCB/MTD are computed, handle bonuses, overtime, unpaid leave and proration, close a batch so it becomes immutable, and act on the final-pay advisory for leavers. You'll need the **hr_admin** or **super_admin** role to reach the Payroll module.

## Before you run payroll: the statutory profile

Every figure on a payslip is driven by the employee's statutory profile. Set it up first, because anyone missing required data will still appear in the batch but with incomplete deductions.

1. In the left sidebar, click **Personnel**, then click the employee's name to open their detail page.
2. Find the **Statutory (Malaysia)** card (right column, beside **Compensation**).
3. Fill in the fields, then click **Save statutory**.

### Fields on the Statutory (Malaysia) card

| Field | Notes |
| --- | --- |
| **IC number** | Required. 12 digits (e.g. `900101011234`). Validated and unique per tenant — spaces and dashes are stripped automatically. |
| **EPF number** | KWSP membership number. |
| **SOCSO number** | PERKESO number. |
| **Tax number** | LHDN income-tax (PCB) number. |
| **PCB category** | `1 — Single`, `2 — Married, spouse not working`, or `3 — Married, spouse working`. Drives MTD relief. Defaults to `1`. |
| **Children (PCB relief)** | Number of qualifying children for PCB relief. |
| **Bank** / **Bank account** | Used by the payment-summary export. |
| **EIS eligible** | Checkbox. Untick for employees outside SIP coverage (e.g. first contribution after age 57 with no prior history). |
| **Tax resident** | Checkbox. Untick for non-residents — they pay a flat **30% MTD** with no reliefs. |

### TP3 / opening balances (mid-year adopters only)

The **Previous employment this year (TP3 / opening balances)** section seeds the PCB accumulators so MTD is correct when you adopt AI HR mid-year or hire someone who already worked elsewhere this calendar year. Take the numbers from the employee's **Form TP3** (or your pre-migration payroll):

- **Applies to year** — the calendar year these balances belong to (e.g. `2026`). Balances are only used when this matches the batch's pay year.
- **Accumulated net remuneration (Y−K)**
- **EPF claimed toward relief (K)**
- **PCB already deducted (X)**

**Note:** TP3 figures are never printed on payslips or the EA form. They only feed the cumulative PCB calculation.

**Tip:** Salary itself lives on the **Compensation** card next door. Use **Update pay** there to set **Basic salary (MYR)** and **Allowance** before running payroll — proration and all statutory bases read the current compensation record.

## Creating a payroll batch — the 3-step Payroll Process wizard

1. In the left sidebar, click **Payroll**. You land on the **Payroll Process** tab, which lists every payroll process with its **Period**, **Company**, **Employees**, **Net pay**, **Payment date** and **Status**.
2. Click **New payroll run** to open the guided wizard:
   - **Step 1 — Payroll Period:** pick the **Company**, the **Payroll month**, the **Cycle** (Monthly always; Bonus, Off-cycle, Advance Salary and Mid-Month presets when multi-run payroll is enabled), and the **Payment date** (pre-filled from the company's configured pay day). If a run already exists for the chosen company and month, it's shown with a **Resume draft** link so you can continue an unfinished process instead of hitting an error.
   - **Step 2 — Employee Selection:** narrow the workforce with Business Unit, Department, Position, Job Grade, Employment Type, Cost Centre and Employee Status filters (they combine), plus a searchable individual picker with **Select all** / **Clear** and a live headcount. Leaving every filter untouched and nobody deselected runs the whole company, exactly as before. A status filter that would exclude someone who left partway through the month shows a warning so their final pay is never silently skipped.
   - Click **Continue to review** to create the run and land on **Step 3**.
3. **Step 3 — Review & process** is the run's normal detail page: a summary strip (period, cycle, payment date, headcount), the **Consolidate data** actions (attendance overtime, shift differential, claims, loans, zakat — the same admin-controlled buttons as before, now grouped and explained), any leaver or holiday-completeness warnings, and the **Process payroll** button.

The new batch opens in `Draft` status. **Note:** only one Monthly batch can exist per company per pay period — the wizard shows the existing draft and disables Monthly rather than letting you hit an error.

## The draft batch: inputs, overtime, bonuses

Open the batch from the list. While it's a `Draft` you'll see an amber compliance disclaimer, the **leavers advisory** (if any), and the **inputs editor** listing every employee active during the period.

### Overtime, bonus, TP1 and zakat (per employee)

Each row in the inputs table has four numeric fields plus **Save**:

- **OT** — manual overtime amount (RM).
- **Bonus** — additional remuneration (RM) such as a contractual bonus or, for a leaver, encashed annual leave.
- **TP1** — the employee's TP1 deduction (approved tax reliefs that reduce PCB).
- **Zakat** — zakat paid, which offsets PCB.

Enter values and click **Save** on that row. The rightmost **unpaid days** column is read-only.

**Tip — prefill overtime from attendance:** instead of typing OT, click **Prefill OT** above the table. AI HR reads classified attendance for the period and monetises it at the Employment Act ordinary rate of pay (ORP = monthly wages ÷ 26): 1.5× on workdays, the rest-day half-/full-day rule plus 2×, and holiday rules plus 3×. Employees earning above **RM4,000** are statutorily ineligible for OT and are skipped — pay any ex-gratia OT for them by typing it into the **OT** field manually. Existing **Bonus** values are preserved by the prefill; you can still override any figure afterwards.

### Unpaid leave and proration (automatic)

You don't key these in:

- **Unpaid leave** is auto-derived from `approved` requests on an unpaid leave type that **start** within the period. It deducts at the ordinary rate (monthly basic ÷ days in month). This is the single source of truth shared with the Leave module — no double entry.
- **Proration** for mid-month joiners and leavers is automatic: basic and allowance are scaled by calendar days employed in the month (EA 1955 s.18A incomplete-month basis). The payslip surfaces **days worked** vs the month's total.

## Generating payslips

1. With the batch in `Draft`, click **Generate payslips** (top-right of the batch page).
2. The batch moves to `Processed`, the per-employee payslip table fills in, and four totals appear: **Total gross**, **Total deductions**, **Total net**, **Total employer cost**.

The payslip table shows **Gross**, **Bonus**, **EPF**, **SOCSO**, **EIS**, **PCB** and **Net** per employee. Prorated employees are flagged inline with their days-worked figure.

### How each statutory line is computed

| Contribution | Basis | Notes |
| --- | --- | --- |
| **EPF / KWSP** | Basic + allowance + **bonus**, **excluding** overtime | Employee and employer shares both shown. |
| **SOCSO / PERKESO** | Includes overtime, **excludes** bonus | Employees aged **60+** move to the Second Category (employer-only). |
| **EIS / SIP** | Includes overtime, **excludes** bonus | Coverage applies ages 18–60; ends at 60 or when **EIS eligible** is unticked. |
| **PCB / MTD** | Includes overtime and **bonus** (additional-remuneration difference method) | Uses the cumulative LHDN method: PCB category, children, TP1, zakat and the year-to-date accumulators (seeded by TP3). Non-residents: flat 30%. |

**Note:** PCB year-to-date accumulators are rebuilt by replaying this tax year's earlier payslips in order, so always process months **in sequence** within a calendar year for correct MTD.

## Closing the batch (immutability)

1. With the batch `Processed`, review the totals and payslips.
2. Click **Close batch**.
3. The status becomes `Closed`.

**A closed batch is immutable** — payslips and totals are frozen for audit. You can no longer edit inputs, prefill OT, or regenerate. If you find an error after closing, correct it in the next period.

**Tip:** export the bank file from `Processed` or `Closed` batches — the **Payment summary** download (top-right, once past `Draft`) produces a neutral CSV of employee, IC, bank, account and net pay for manual upload to your bank's portal. Rows missing bank details are flagged in the export.

## Final-pay advisory for leavers

When you terminate someone (on their **Personnel** detail page, **Terminate** card) and their last day falls inside a batch's period, the draft batch shows a **leavers** advisory listing **unused annual leave**, the **ORP per day** (basic ÷ 26), and a **suggested** pay-in-lieu amount (EA 1955 s.60E).

**This is advisory only — there is no auto-pay.** If you choose to pay it, type the amount into that employee's **Bonus** field in the inputs editor before generating payslips. AI HR deliberately leaves the decision to you because the EPF/PCB treatment of leave encashment depends on your policy.

## Common pitfalls

- **Missing IC number** — `Save statutory` is rejected if the IC isn't 12 digits. Fix before running payroll.
- **No compensation set** — an employee with no current basic salary cannot be monetised; set it via **Update pay** first.
- **Running months out of order** — breaks cumulative PCB. Process January → December in sequence.
- **High earners and OT** — anyone above RM4,000 is skipped by **Prefill OT**; enter any discretionary OT manually.
- **Editing after close** — not possible. Verify totals before clicking **Close batch**.
- **Duplicate batch** — one batch per company per `YYYY-MM`; check the list before creating.
