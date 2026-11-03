Open [Loops](/control-tower/loops) in AI Centre, under Operations. A loop watches one part of HR work, prepares what a person needs to do, and checks on its next run whether it was done. There are six: Probation ending, Pre-salary loop, Missing employee data, Missed clock-outs, Passports expiring and Salary payroll loop. Each row says what "done" means for that loop, its level, whether it is switched on, when it last ran and how many cards it prepared in the last 30 days. Payroll cycle, at the top of the page, follows the Pre-salary, Salary payroll and Audit loops through each pay month.

## Four levels

Each loop has its own level in each company. A company with no level set is at Prepare.

- Watch: the loop records what it finds for the company, shows nobody a card and changes no record.
- Prepare: each night the loop reads only what the administrator who switched it on may see, prepares a card for the right person (an HR administrator, payroll or the employee) and changes no record itself. The person sees the card on Today and finishes the work on the usual page, with that page's own checks and approvals. On its next run the loop looks again: when the work is done it closes the card, and if the same thing comes up again it reopens it.
- Act within limits: the loop takes its step itself, inside the company's limits: the most actions a night (never more than 200) and an undo window of 3 or 7 days. It tells the person, and every action can be undone during the window. Missed clock-outs sets the clock-out to the roster end through attendance and never creates overtime; Missing employee data sends the employee the request itself and changes no record.
- Act and audit: as Act within limits, and HR reviews a weekly sample of the actions (at least 10% and at least 5) instead of every one.

A loop prepares at most 200 new cards a night for each company and never calls an AI model.

## Changing a level

Open a loop from the Loops list to see its level in each company you administer. Only a group administrator changes a level, and every change is recorded with who made it. A loop moves up one level at a time, and above Prepare only when its evidence from the last 30 days is met: at least 200 cards or actions, no broken rule, 30 days at its current level (90 days at Act within limits before Act and audit) and, for Missed clock-outs, fewer than 1% changed by people. It can be moved down at any time. If people correct or undo more than 1% of its automatic actions over 7 days, it drops back to Prepare in that company by itself.

## Pay, status, access, discipline and filing stay at Prepare

Pay, employment status, system access, discipline and statutory filing always need a person's decision. A loop that touches any of them stays at Prepare in every company: this is fixed in the product, not a setting, and no level change can lift it. Probation ending (employment status), the Pre-salary loop and the Salary payroll loop (pay) stay at Prepare, and so does the Audit loop (pay and statutory filing). Passports expiring also stays at Prepare. Only Missed clock-outs and Missing employee data can go above Prepare.

## Switching a loop on or off

Every loop is off until a group administrator switches it on. Switching a loop on or off applies to every company in the group, and the group administrator who switches it on becomes its sponsor. If the sponsor loses administrator access, the loop stops. The company stop switch stops every loop at once.

## Pausing a loop for one company

Open a loop from the Loops list. Under Pause for a company, an administrator of that company can choose Pause or Resume. A paused loop neither runs nor shows its cards in that company; the other companies are not affected. To stop a loop everywhere, a group administrator switches it off instead.

## Asking AI Centre about loops

An administrator can ask AI Centre in chat which loops are on or paused, each loop's level in the companies you administer, when each last ran and how many of its cards are open. The answer gives counts and states for the companies you administer, never who a card is for, and never changes a loop: switching, pausing and levels are changed on the Loops pages.
