This guide is for **employees** who need to record their working hours in AI HR. By the end, you'll know how to check in and out for the day, read what `present`, `late`, `half_day` and `absent` mean on your record, review your recent history, and ask your manager to fix a clock-in that went wrong. Everything below happens from **My workspace** (the `/me` page) — the home base for your own day.

## Where to do this

In the left sidebar, click **My workspace**. The page opens with your name, employee code and position at the top. The first card on the top-left is your attendance card — its heading shows **Today** with today's date underneath. This is where you check in, check out, see recent days, and raise a correction.

**Note:** The full **Attendance** page in the sidebar is a company-wide roster used mostly by managers and HR. For your own day-to-day clocking, stay on **My workspace**.

## Checking in

1. Go to **My workspace**. Look at the **Today** card on the top-left.
2. If you haven't clocked in yet, you'll see a single full-width **Check in** button. Click it.
3. The card updates to show **Checked in at** with your clock-in time in bold, plus a coloured status pill (for example `Present` or `Late`).

That's it — one click stamps the current time as your check-in. The system also quietly decides whether today is a normal workday, a rest day, or a public holiday, which affects how overtime is later counted.

**Tip:** You can only check in once per day. If you click **Check in** a second time, the app will tell you that you're already checked in for today.

## Checking out

1. Once you're checked in, the **Today** card shows a **Check out** button beneath your check-in time.
2. At the end of your working day, click **Check out**.
3. The card then displays your full day as `check-in time → check-out time` with the final status pill.

When you check out, AI HR works out your worked hours (deducting your scheduled break once the day is long enough) and any overtime, then locks in the status for the day.

**Note:** Your check-out must be **after** your check-in. If it isn't, the action is rejected.

## What the statuses mean

Each day on your record carries one status pill. Here's what they mean and what triggers them:

| Status | What it means |
| --- | --- |
| `Present` | A normal day — you checked in on time (or worked a rest day / holiday, which is always counted as present). |
| `Late` | On a workday, you checked in after the company's cut-off (the default is after 09:15). |
| `Half day` | On a workday, you checked out before the half-day cut-off (default before 13:00) — i.e. you left around lunchtime. |
| `Absent` | No attendance was recorded for a working day that wasn't covered by approved leave, a public holiday, or a rest day. |

A few things worth knowing:

- **Absent is implicit.** There's no "absent" button — a day simply shows as absent when no record exists for a working day and nothing else explains it.
- **Approved leave, public holidays and rest days are not absences.** If you're on approved leave, or it's a public holiday or your non-working day, the system labels the day accordingly rather than marking you absent.
- **Late and half-day only apply on workdays.** Working a rest day or public holiday is always `present`, and any hours you put in count fully as overtime.

## Viewing your record

On the **Today** card, scroll to the **Recent** section just below the check-in area. It lists your latest days, each showing:

- the **date**,
- your **worked hours** for that day (e.g. `8h 00m`), with an overtime badge when you logged extra time,
- and the **status pill** for the day.

This gives you a quick, at-a-glance history of how your recent days were classified without leaving My workspace.

## Fixing a wrong clock-in (correction request)

Forgot to clock in? Clicked **Check out** at the wrong time? You can't edit attendance directly — instead you submit a **correction request** with the correct times, and your **manager (or HR) approves it**. Only once they approve does your record change.

1. On the **Today** card, find the **Fix a missed punch** section near the bottom and click it to expand the form.
2. Fill in the fields:
   - **Date** — the day you're correcting (defaults to yesterday). Pick the right day.
   - **Check in** — the correct check-in time (defaults to 09:00).
   - **Check out** — the correct check-out time (defaults to 18:00). You can leave this if you're only fixing the check-in.
   - **Reason (optional)** — a short note explaining what happened, e.g. "Forgot to clock in, was on-site from 9am." This isn't required, but it helps your approver decide quickly.
3. Click **Request correction**.
4. Your request appears in the list just under the form with a status pill: `Pending` while it awaits a decision, then `Approved` or `Rejected` once your manager acts.

When a correction is **approved**, AI HR rebuilds that day from your proposed times — recalculating the status, worked hours and overtime so everything (including any overtime that flows to payroll) stays correct. The day is also marked as `Corrected` behind the scenes.

**Tip:** Your **check-out must be after your check-in** in the correction form too, or it'll be rejected before it's even submitted.

**Note:** You can't approve your own correction — that's by design. It always goes to a manager or HR. If your request still shows `Pending`, it simply hasn't been actioned yet.

## Common pitfalls and troubleshooting

- **"Already checked in today."** You've already clocked in. Use **Check out** when you're done, or raise a correction if the recorded time is wrong.
- **No Check in button appears.** You may already have a record for today. Check the **Today** card — if it shows your times, you've already clocked in (and possibly out).
- **A day shows `Absent` but I was working.** No attendance was captured for that working day. Use **Fix a missed punch** to submit the correct times for approval.
- **A day I expected to be off shows oddly.** Approved leave, public holidays and rest days are recognised automatically — if something looks wrong, check that your leave was actually approved, then raise it with HR.
- **My correction is still `Pending`.** It's waiting on your manager or HR to approve or reject it. Your record won't change until they decide.
- **Overtime looks off after a correction.** Overtime is only finalised once a check-out time exists and the day is recalculated. After an approved correction, the recomputed hours and overtime are what count.

**Tip:** Build the habit of clicking **Check in** when you start and **Check out** when you finish each day. Clean, same-day records mean fewer corrections, and they keep your hours and any overtime accurate for payroll.
