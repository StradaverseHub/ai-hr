This guide is for **people managers** — anyone with the `manager` role who has direct reports. It walks you through the unified **Approvals** inbox, where every request from your reporting line waits for a single decision: leave requests, attendance correction requests, and (for admins) profile changes. By the end you'll know how to approve or reject each type, understand exactly whose requests you can see, why you can't decide your own, and what each click does downstream — like debiting a leave balance or amending an attendance record.

## Opening your Approvals inbox

In the left sidebar, click **Approvals**. The page is only visible to managers and admins; if you don't have a report or an admin role, you won't see the menu item.

At the top you'll see a **PageHeader** titled **Approvals**. Below the title is a live count:

- If there's nothing to do, it reads **"Nothing waiting on you"**.
- Otherwise it reads **"3 items awaiting a decision"** (or **"1 item awaiting a decision"** for a single one) — a running total across all sections.

The inbox is one screen with stacked cards. Each card header shows a section name and a count badge so you can see at a glance where the work is:

| Section | What it holds |
| --- | --- |
| **Leave requests** | Pending time-off requests from your reports |
| **Attendance corrections** | Requests to fix a day's check-in / check-out times |
| **Profile changes (bank / tax)** | Bank and tax-detail edits — **admins only** (you won't see this card as a plain manager) |

**Note:** Only **pending** items appear here. Once you decide a request it drops off the inbox — there's no "decided" tab on this page. To review past decisions, use **Audit trail** (admins) or the per-record **History** view.

## Whose requests you can see (reporting-line scope)

You only ever see requests from **your own reporting line** — the people who report to you administratively. The system enforces this in two layers, so you never have to filter manually:

- **Visibility** is trimmed by row-level security: a manager reads their reports' rows, an employee reads only their own, an admin sees everything in scope. The lists on this page are already filtered before they reach you.
- **Authority to decide** is a second, stricter check (see below).

**Tip:** If a teammate's request isn't showing up, the most common reason is that you're not their **active administrative manager**. The reporting line must be effective *today* — a line that's future-dated, already ended, or superseded won't put their requests in your inbox. Ask your HR admin to confirm the reporting line on the **Org chart** or in **Admin → Organization**.

## The no-self-approval rule

You **cannot decide your own request**. If one of your own requests appears in a list — for example, you filed an attendance correction for yourself — the action column won't show buttons. Instead you'll see the muted label **"your request"** where **Approve** / **Reject** would normally be.

This guard sits in the service layer, not just the UI, so it can't be worked around. Your own leave and corrections must be decided by *your* manager or an HR admin.

**Note:** There is one deliberate exception: a `super_admin` keeps a sole-admin escape hatch and *can* self-approve, so a one-person admin team in a tiny firm isn't permanently blocked. Regular managers and `hr_admin` users never can.

## Approving or rejecting leave requests

The **Leave requests** card shows a table with these columns: **Employee**, **Type**, **Dates**, **Days**, and **Action**.

1. Read the row: the **Dates** column shows the range as `start → end`, and **Days** shows the counted total (working-day leave types already exclude weekends and public holidays).
2. In the **Action** column, click **Approve** or **Reject**.
3. The decision submits immediately and the row disappears from the inbox.

**What Approve does downstream:** approving a leave request does three things atomically in one transaction:

- It checks the employee's **projected balance** for that leave type. If approving would push the balance below zero, the decision is blocked with **"Leave rejected: insufficient balance"** and nothing changes.
- If there's enough balance, it posts a **debit** to the append-only leave ledger for the requested number of days (effective on the leave's start date), so the balance drops by exactly that amount.
- It flips the request status to `approved`, stamps who decided and when, and records the decision in the event log.

Once approved, those days also count as **on leave** on the **Attendance** views for the covered dates — so the employee won't be flagged absent.

**What Reject does:** the status flips to `rejected` and the decision is logged. **No balance is touched** — rejecting never debits or credits days.

**Common pitfall — "insufficient balance":** if Approve fails on balance, it usually means the employee's entitlement hasn't been granted yet, or they've already used it. You can't override the balance from this screen; route it to your HR admin, who can post a leave adjustment.

## Approving or rejecting attendance corrections

When an employee's punch times were wrong (forgot to clock in, clocked out late, etc.), they raise a correction from their workspace. It lands in your **Attendance corrections** card.

The table columns are: **Employee**, **Date**, **Proposed**, **Reason**, and **Action**.

1. Check the **Proposed** column — it shows the requested times as `HH:MM` (and `HH:MM → HH:MM` when a check-out is included).
2. Read the **Reason** the employee gave (it shows `—` if they left it blank).
3. Click **Approve** or **Reject**.

**What Approve does downstream:** approval doesn't just rubber-stamp the times — it **rebuilds the attendance record through the time engine**. The proposed check-in/check-out are re-classified by day type (workday, rest day, or public holiday) and re-derived into a status (`present`, `late`, or `half_day`) plus **worked minutes and overtime minutes**. That corrected record is written to the day (replacing any existing row for that date) and marked **"Corrected"**. Because overtime is recomputed here, an approved correction flows straight through to payroll — so getting the times right matters.

**What Reject does:** the correction is marked `rejected` and logged; the original attendance record is left untouched.

**Tip:** Overtime classification follows Malaysian EA 1955 rules — work on a rest day or public holiday is counted as overtime in full and later monetised at premium rates in payroll. So approving a rest-day correction can legitimately increase someone's pay. Sanity-check the **Proposed** times against the **Reason** before approving.

## Profile changes (admins only)

If you also hold an admin role, a third card — **Profile changes (bank / tax)** — appears. It lists pending self-service edits to sensitive fields, showing the employee's name and each proposed change as `field → new value`. Click **Approve** or **Reject** the same way. Plain managers don't see this card; bank and tax changes are reserved for HR admins because they feed statutory deductions and payment files.

## Quick reference: what each decision does

| Request type | Approve | Reject |
| --- | --- | --- |
| **Leave** | Checks balance → debits the ledger → marks `approved`; days now count as on-leave on Attendance | Marks `rejected`; **no** balance change |
| **Attendance correction** | Re-derives the day through the time engine, writes the corrected record (with OT for payroll), marks `approved` | Marks `rejected`; original record untouched |
| **Profile change** (admin) | Applies the new bank/tax value, marks `approved` | Marks `rejected`; no change applied |

## Troubleshooting

- **"You cannot decide your own ..."** — you tried to act on your own request. This is expected; it must go to your manager or an HR admin. (Only a `super_admin` can self-approve.)
- **"Only an admin or the administrative manager can decide this ..."** — you're not the subject's *active* administrative manager. Confirm the reporting line is effective today and not superseded.
- **"... is already approved / rejected"** — someone (often an admin, or you in another tab) already decided it. Refresh the page; it should have dropped off the inbox.
- **A request never reaches me** — check the reporting line on the **Org chart**. If it's future-dated or ended, ask your HR admin to fix it in **Admin → Organization**.

**Note:** Every decision you make is recorded in the audit/event log with you as the real actor — approvals here are accountable, not anonymous. If you need to revisit who decided what, that's where to look.
