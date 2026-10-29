Use this guide to run payroll with the appropriate company access and enabled payroll modules. The selected company, period, cycle and employee population define the run.

## Prepare the run

1. Open [Payroll setup](/payroll/setup). Check company configuration, payment dates, cycles, components and statutory settings.
2. Review employment dates, period-effective salary, pay mode, bank details and statutory selections for the employees included.
3. Open [Payroll transactions](/payroll/transactions) for fixed and individual items, adjustments, TP1, TP3 and zakat. Use the current import templates where offered. Use [Payroll history import](/payroll/history-import) for historical payroll; it is not the TP3 prior-employer form.
4. Review attendance, leave, approved claims, loans and any other sources being consolidated. A source approval does not by itself prove it has reached the selected payroll batch.

## Import individual transactions

Open [Individual Transaction](/payroll/transactions/individual), then **Import Excel**.
This imports current transactions; it does not replace historical payslips.

1. Choose **One Total for the Month** or **Day by Day**, and download the matching template. Fill in its first worksheet; the other worksheets contain instructions and the current employee, pay item, pay cycle and input type references.
2. The monthly template contains Employee ID, Employee Name (Optional), Month with Year, Pay Cycle, Pay Item, Effective Date, Input Type, Quantity, Amount and Remark, in that order. The daily template contains Employee ID, Employee Name (Optional), Month with Year, Pay Cycle, Pay Item, Effective Date, Quantity and Remarks.
3. Keep Month with Year separate from Effective Date: one selects the payroll period and the other records when the transaction took effect. Use the employee ID and a configured pay cycle from the references. A name that does not match the employee ID produces a warning.
4. For daily input, enter each date on its own row. Equal quantities on different dates remain separate transactions. Daily input requires a pay item that calculates its amount from quantity; use monthly input for items requiring a manually entered amount.
5. Upload the completed `.xlsx` file and select **Validate file**. Review the amounts, warnings and Excel row errors before confirming. Invalid rows do not create transactions. Each file supports up to 2,000 transaction rows; split larger imports into separate batches.
6. Confirm the valid rows, then review the imported and unsuccessful counts. Use the downloadable errors to correct refused rows. Payroll controls and calculation rules are the same as for manual entry.

Open **Import log** to find a batch by its reference, file, user and time. **View Details** retains the original row outcomes and later actions. New batches are tracked from this feature onward; earlier imports are not assigned to batches by guessing.

To undo an eligible batch, select **Revert Import** and check the batch named in the confirmation. The action reverses only transactions created by that batch. If an affected transaction has changed or payroll controls prohibit reversal, the whole reversal is refused. Where processed payroll may be changed, acknowledge the recalculation warning and reprocess the affected payroll before relying on its results. Manual transactions and other batches are unaffected, and the import log remains available after reversal.

## Create, process and review

1. Open [Payroll](/payroll), start the process, and choose the company, period, cycle and payment date.
2. Review employee selection, including joiners and leavers active during the period. Confirm the population before continuing.
3. Review the draft and its warnings. Use the offered consolidation actions for attendance, claims, loans and other configured sources. Inspect existing inputs before repeating an action or overriding an amount.
4. Process payroll. Review individual results, gross-to-net totals and warnings. Use [PCB detail](/payroll/pcb-detail), [Statutory detail](/payroll/statutory-detail), [Transaction view](/payroll/transaction-view) and the run's employee detail to investigate differences.
5. Correct issues using the supported draft, reset or reprocess action for the run's current state. Review its scope and consequences before confirming. A closed run must not be silently edited.
6. Close the reviewed run when your payroll process permits it. Then complete the payment and statutory submission workflow.

In Transaction View's **Transaction Detail**, **Total Overtime** appears in **Summary**. It is already included in gross pay. Individual overtime rate lines remain in the detail area; do not add the summary total to those lines as another payment. The displayed-grid export follows the same placement and retains the same amounts.

Personnel Management's **Bank & Statutory → EPF Contribution** preserves the percentage shown after save and reopen, including decimal rates such as 14.5. The selected EPF category continues to determine which fields are editable and which validation and contribution rules apply.

## Corrections and special cases

[Back pay](/payroll/back-pay), [Statutory adjustment](/payroll/statutory-adjustment) and the multi-cycle worksheet serve different correction jobs. Review the period, existing runs and signed adjustments before committing. Final pay, leave encashment, taxable benefits and special incentives need their own configured treatment; do not put every exceptional payment into Bonus.

Statutory calculations depend on the effective country configuration, employee circumstances and component treatment. Read the calculation breakdown rather than applying a single rate to gross pay or copying figures from an old guide.

## Finish payment and reporting

Use [Payment submission](/payroll/payment-submission) and [Statutory forms](/payroll/statutory-forms). A downloaded file is not evidence that a bank or agency accepted a submission. Keep the external acknowledgement and use available receipt/status fields.

### Generate an OCBC payment file

With the required payroll access, open Payment submission and choose the OCBC Salary, KWSP, SOCSO, LHDN or Zakat card. These bank-upload files are separate from government-portal forms.

1. Choose the company, year, contribution/payroll month, bank account, payment date and reference. Salary also requires one ready payroll run; statutory files use the ready saved runs for the selected month. If no eligible account or run appears, resolve its setup or payroll readiness before continuing.
2. Where File mode is offered, check whether you need a test or live file.
3. Select **Preview** and review the company, period, payment date, record count and total. Correct missing or invalid information and preview again. Changing a selection invalidates the previous preview.
4. Select **Download** to generate the file. Generation records the artifact; it does not send it to OCBC or mark payroll paid or statutory contributions filed. If payroll changes after preview, obtain a fresh preview before generating.

The initial LHDN and Zakat layouts leave the reserved Hash Total field blank. Bank acceptance of these layouts remains unverified; arrange a bank test before operational use. The LHDN Wife Code is taken from a Tax Number ending in 0 or 1 without changing the stored Tax Number. Resolve validation errors in the underlying employee details rather than editing generated bytes.
