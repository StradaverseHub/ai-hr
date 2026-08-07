This guide is for HR administrators (`hr_admin` and `super_admin`). It answers one question that the product does not answer anywhere on screen: **when the system works out someone's hours for a day, where do the hours it measures against come from?** By the end you will know the three places a day's schedule can come from and the order they are tried in, what a **backup shift** is and why every employee has one, when you need to touch the roster at all, and where to look when a figure surprises you.

## The one rule: roster, then backup shift, then company schedule

For every employee, on every date, the system asks three questions in this order and stops at the first answer:

1. **Is this employee rostered on this date?** If there is a roster entry for that exact person and date, that is the schedule. A roster entry can be a shift or an explicit rest day; either way it wins.
2. **If not — do they have a backup shift on their profile?** Then that shift is the schedule. Its own weekly pattern decides whether that weekday is a working day or a rest day for them.
3. **If neither** — the company work schedule applies (Admin → Attendance policy).

That is the whole engine. Everything below is a consequence of it.

## What a backup shift is

The **Backup shift** is set on the employee's profile: **Personnel → the employee → Employment tab → Shift arrangement**. It is the shift used on **any day the employee is not rostered**.

Every employee has one. The field cannot be left empty and there is no "none" option — an employee without a backup shift is an employee whose days quietly fall through to the flat company schedule, which is almost never what anyone intends.

Next to it is **Shift type**, which says how the person is *normally* scheduled. It does not change what the engine does; it describes the intent:

- **Fixed shift** — they work their backup shift every working day. Roster only the days that differ.
- **Roster shift** — they are normally scheduled from the Roster screen, and the backup shift covers any day that has no roster entry.

### So do I still need to roster a fixed-shift employee?

**No.** That is the point of the backup shift. If everybody works their normal shift next week, you do not need to roster anybody.

The roster is for the days that **differ** from normal — a swap, a night rotation, someone covering a shift that is not their usual one, or a one-off rest day. Rostering stays optional, and it is not a second place you have to re-record everybody's normal week.

## Worked examples

Take an employee whose backup shift is `AM03` — 09:00 to 18:00 with a 60-minute break, working Monday to Friday. Net scheduled time is 9 hours minus 1 hour = **8 hours (480 minutes)**.

**Monday, no roster entry, clocks 09:00 → 19:00.**
Step 1 finds no roster entry. Step 2 finds `AM03`, and Monday is in its weekly pattern, so it is a working day. Worked = 10 hours minus the 1-hour break = **9 hours**. Scheduled = 8 hours. Overtime = **1 hour**, at the workday rate.

**Wednesday, rostered onto a 06:00–16:00 shift (60-minute break), clocks 06:00 → 17:00.**
Step 1 finds the roster entry, so it stops there — the backup shift is not consulted at all. Scheduled = 10 hours minus 1 = 9 hours. Worked = 11 hours minus 1 = 10 hours. Overtime = **1 hour**. Note the same 11 hours on the clock would have produced 2 hours of overtime against `AM03`: the schedule the day is measured against is what decides the figure, not the hours worked.

**Saturday, no roster entry.**
`AM03`'s weekly pattern is Monday to Friday, so Saturday is a **rest day** for this employee — regardless of what the company work schedule says about Saturdays. Work on a rest day is classified as rest-day overtime, which carries a different statutory rate.

**A public holiday.**
The holiday calendar overlays the day *type* (so overtime is classified at the holiday rate), but the hours it is measured against still come from whichever shift step 1 or step 2 resolved. A holiday does not erase the schedule; it re-prices it.

## Where the exact working is shown

Do not reconstruct arithmetic by hand. Go to **Attendance → Records**, find the row, and hover any lateness, early-out or overtime figure. The panel shows, for that specific row: the shift times used, the break actually deducted, the raw clock-in and clock-out, the rule that applied, the step-by-step working, the rounding, and the final result.

If a figure looks wrong, that panel tells you which of the three steps above supplied the schedule — which is nearly always the answer.

## What changing a backup shift does, and does not, do

Changing an employee's backup shift changes how days are calculated **from that moment forward**.

**It does not alter attendance that is already recorded.** Each attendance row's figures are worked out and stored when the day is recorded; nothing goes back and re-derives history. If you correct a past day you do so through a correction request, deliberately — not by editing a shift and hoping.

## The company work schedule still matters

Once every employee has a backup shift, no employee's *day* is calculated from the company work schedule any more. It is still read for two things, for everybody:

- **Absence derivation** — which weekdays count as working days when deciding that a day with no attendance record and no approved leave is an absence.
- **Roster generation** — the same working-days list seeds generated roster rows.

The **overtime rates** on that screen (the entitlement wage ceiling and the rest-day / public-holiday multipliers) are statutory and apply to everyone regardless of shift.

Admin → Attendance policy shows a **Backup shift coverage** panel naming anyone who still has no backup shift, so you can see at a glance whether anybody is still being calculated from the company schedule.

## A note on shift codes

Shift **codes are not guaranteed to be unique** in older data — it is possible to have two shifts sharing a code, which makes a roster ambiguous to read. If you see duplicates in Admin → Shift settings, decide which to keep and archive the rest. Archiving is safe: existing roster entries and profiles keep working, and the shift simply stops being offered for new assignments.
