Open [Payroll cycle](/control-tower/loops/payroll-cycle) in AI Centre, under Operations › Loops. Three loops carry each company's payroll from inputs to audit, one month at a time: the Pre-salary loop, the Salary payroll loop and the Audit loop. The page shows each loop's state for every company you administer, the last three cycles compared and the people loops.

## The three loops

The Pre-salary loop checks every input from the start of the pay period to the company's cut-off: timesheets, overtime, leave and unpaid days, claims, joiners and leavers, bank, EPF, SOCSO and tax numbers, pay changes, payroll set-up, and the checks the Audit loop found something in two months running. Each check links to the page where its items are fixed.

The Salary payroll loop starts at the cut-off and checks each run: the change in each person's net pay against the company's net-swing threshold, explained by cause; the anomaly checks; whether EPF, SOCSO, EIS and PCB used the current rules; and whether the bank file total equals net pay. Open [Salary payroll loop](/control-tower/loops/payroll-cycle/salary) to see each run's checks and to record whether a net-swing flag was expected or a real problem. Recording it changes no pay.

The Audit loop works after pay day. Open [Audit loop](/control-tower/loops/loop_payroll_audit) for payslips released and opened, each statutory file prepared and filed, bank files, corrections after the run, control findings, and the audit pack for your auditors.

## A person always decides

All three loops stay at Prepare in every company. Pay is calculated only by the payroll service. A person runs, approves and closes payroll, files with EPF, PERKESO and LHDN, and records each receipt.

## Settings

[Payroll cycle settings](/control-tower/loops/payroll-cycle/settings) holds, for each company, how often the Pre-salary loop checks (hourly, twice a day or daily) and the net-swing threshold (15% until it is changed), with the pay items excluded from it. When the recorded flags show the threshold catches too much, the page proposes a change with its evidence. Nothing changes until an administrator approves it, and every change is kept as a new version.

## Asking AI Centre

An administrator can ask AI Centre in chat whether this month's payroll is on track, whether the bank files matched, what the net-swing threshold is, or whether the statutory files are filed. The answer gives states and counts for the companies you administer, never who was flagged, by how much, or any pay figure, and AI Centre never runs, approves or files anything.

## Learning from payroll history

When a payroll administrator switches learning on for a company, AI Centre learns each person's usual pay from the company's closed payroll runs, imported history included: their usual net pay for a regular month, for a whole month and for a bonus run. It learns only from closed runs and only from months before the one being checked, and it leaves out months with a net-swing flag found to be a real problem, an exception fixed at the source, a correction after the run, a statutory figure set by hand, and the months before a salary change. The payroll service works out every range; AI Centre never does the arithmetic.

From 3 clean closed runs, each net-swing flag on the [Salary payroll loop](/control-tower/loops/payroll-cycle/salary) page and each flagged person in a run's exceptions shows a line such as "Usual for this person: above range from 7 runs", with the usual range. The line explains the flag and changes nothing: no figure, check or flag. "Learned this cycle" on the [Payroll cycle](/control-tower/loops/payroll-cycle) page counts how many people's usual pay is settled (6 or more runs), provisional (3 to 5), not yet learned, relearning after a salary change, or has moved. In chat, an administrator can ask for the same counts; a count under 5 is never given, and never a person or an amount.

Learning is off until it is switched on, every change of it is kept as a new version, and a leaver's learned range is deleted 3 months after their final pay closes. Their payslips are kept.
