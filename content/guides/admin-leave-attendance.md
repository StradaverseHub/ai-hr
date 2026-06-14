This guide is for HR administrators (`hr_admin` and `super_admin`) who set up and maintain leave rules and attendance for their companies in AI HR. By the end you'll know how to define leave types, layer company entitlement policies over the Malaysian statutory floor, correct or remove a policy, open a new leave year with carry-forward, and understand how attendance day-types and correction requests work. All of these screens require an admin role — employees and managers won't see Leave configuration at all.

## Leave configuration

In the left sidebar, under **Admin**, click **Leave config**. You'll land on the **Leave configuration** page, organised into two cards: **Leave types & entitlements** at the top and **Leave year** at the bottom.

### How the statutory floor works

AI HR ships with the Malaysian country pack (Employment Act 1955) built in. The statutory minimums are **not configurable** — they come from the pack and are banded by completed years of service (`<2` / `2–5` / `5+` years). Your company policies layer *on top* of this floor.

The key rule, repeated throughout the UI: **grants apply the greater of the statutory floor and your company policy.** A policy below the minimum is recorded and shown with a `below minimum` badge, but it is never actually applied — the employee still receives the statutory amount.

The pack bands are:

| Leave type | `<2 yrs` | `2–5 yrs` | `5+ yrs` | Counting |
| --- | --- | --- | --- | --- |
| `ANNUAL` | 8 | 12 | 16 | Working days |
| `SICK` (outpatient) | 14 | 18 | 22 | Calendar days |
| `HOSPITALIZATION` | 60 | 60 | 60 | Calendar days |
| `MATERNITY` | 98 | 98 | 98 | Calendar days |
| `PATERNITY` | 7 | 7 | 7 | Calendar days |

**Note:** Annual leave **pro-rates** in the hire year; sick and hospitalization grant **in full** (they are per-calendar-year entitlements, not prorated for mid-year joiners).

### Adding a leave type

1. Scroll to the form at the bottom of the **Leave types & entitlements** card.
2. Enter a **Code** — letters, digits or underscores, stored uppercase (e.g. `SICK`). The code is the semantic key the floor, standing grants and carry-forward match on, so it matters: type `annual` and it's normalised to `ANNUAL` so it can never silently miss the EA floor.
3. Enter a **Name** (e.g. `Sick Leave`).
4. Leave **Paid** ticked unless this is an unpaid type.
5. Click **Add type**.

The new type appears in the list above as a collapsed row showing its name, code, and effective days/year.

### Reading a leave-type row

Each leave type is an **expandable row**. Click it to expand. On the right of the collapsed row you'll see the **effective entitlement** (`days/yr`) and one of two badges:

- `policy` (emerald) — your company policy is **above** the floor and is what applies.
- `below minimum` (amber) — your active policy is *below* the floor, so the floor applies instead.

Expanding the row reveals: type-level controls (**Rename**, plus **Archive**/**Unarchive**/**Delete**), the read-only **Statutory minimum (MY)** line, and the **Company entitlements** timeline.

**Tip:** A type that is in use can only be **Archived** (it stays referenced by past requests and ledger entries); a type referenced nowhere shows **Delete** instead. Archived types appear dimmed with an `archived` badge.

### The inline entitlement editor

Entitlement policies are **effective-dated** and edited inline on the type's row — there's no separate, disconnected policy form. The mental model:

- **Add** a new dated entitlement to change things **going forward**.
- **Edit** an existing entitlement to **correct** a mistyped value (same effective date).
- **Remove** an entitlement to stop it driving future grants.

To add an entitlement:

1. Expand the leave type.
2. Click **+ Add entitlement**.
3. Fill in **Days / year**.
4. For annual leave only, set the **Carry cap** — the maximum unused days that roll into the next leave year (default `0`). Non-annual types don't show this field; their carry is always zero.
5. Set **Effective from** (a date). The newest active policy is the one that applies today.
6. Click **Add**.

To correct one, click **Edit** on the policy line, change **Days / year** (or **Carry cap** / **Effective from**), and click **Save**. To stop one from driving future grants, click **Remove** and confirm.

**Note:** Removing an entitlement is safe — past grants stay because the leave ledger references the leave *type*, not the policy. Removal only stops the row from feeding future grants.

The active policy line carries an `active` badge; a superseded policy shows its `from … to …` range. The `none` / "No company policy — the statutory floor applies" message means only the statutory amount is in effect for that type.

## Public holidays

Public holidays come from the Malaysian country pack and drive two things automatically — there's no separate holiday editor to maintain:

- **Working-day leave** (annual leave) **excludes** weekends and public holidays from the day count, so applying for leave across a public holiday doesn't burn an annual-leave day.
- On the **Attendance** page, a day with no punch on a public holiday shows the `Holiday` context pill instead of counting as absent, and any work logged that day is treated as holiday overtime.

## Opening a new leave year

At the start of each calendar year you must **open the leave year** to post everyone's new entitlements. In the **Leave year** card on the Leave config page:

1. The **Year** field defaults to next year. Adjust if needed.
2. Click **Open leave year**.

What happens:

- Every **active** employee hired before 1 Jan of that year receives their new standing entitlements (`ANNUAL`, `SICK`, `HOSPITALIZATION`) at their **current service band** — so the 2-year and 5-year band upgrades happen here automatically, resolved as `max(statutory floor, policy)`.
- **Carry-forward:** unused annual leave carries up to the policy's **Carry cap**; anything above is forfeited (s.60E expects leave to be taken within the year). Sick and hospitalization **reset** — they don't carry.
- The operation is **idempotent** and safe to re-run: employees already opened for the year are skipped, and anyone hired *during* the year is covered by their pro-rated hire grant, so they're skipped here too.

**Tip:** Run this once near year-start. If you add a backdated entitlement afterwards, you can safely re-open the year — already-granted employees won't be double-counted.

## Attendance

In the sidebar, click **Attendance**. The page has three sections: the day grid (defaults to **Today**, navigate with the date picker), **Correction requests** (only when some are pending), and the **Month summary**.

### The attendance policy and day-type classification

Each company has an attendance policy defining the work schedule: **work start** / **work end**, **break minutes**, the late threshold (`Late after`), the half-day cutoff, and **working days** (default Mon–Fri). Where a company hasn't customised it, sensible defaults apply (09:00–18:00, 60-min break, late after 09:15, half-day before 13:00).

When someone checks in, the day is **classified and frozen** on the record as one of three day-types:

- `workday` — a scheduled working day. Only here can a check-in be **late** (after the threshold) or a short day count as **half day**.
- `rest_day` — a non-working weekday/weekend per the schedule. Any work is overtime *in full*.
- `holiday` — a public-holiday date. Any work is overtime *in full*.

In the day grid, employees with no record on a non-working context show a context pill — `On leave`, `Holiday`, or `Rest day` — so a legitimately empty day isn't read as absent. Overtime on rest days and holidays is tagged `RD` / `PH`.

The **Month summary** rolls this up per employee: **Present / Late / Half day / Leave / Absent** counts, total **Hours** and **Overtime** (split by day-type in the tooltip), plus compliance **Flags**: `OT > 104h` (the statutory monthly overtime cap) and `45h+ week` (indicative). Absent counts elapsed working days only — it never marks future days or pre-hire days absent.

### Attendance correction requests

If a punch is wrong or missing, an employee (or their manager) raises a **correction request** proposing the right check-in and optional check-out. As an admin you action these in the **Correction requests** card, which appears when requests are pending.

1. Each row shows the **Employee**, **Date**, **Proposed** times, and **Reason**.
2. Click **Approve** to amend the day, or **Reject** to decline.

**Approving re-derives the whole day through the time engine** — status, worked minutes and overtime are recomputed from the proposed punches and the company schedule, so corrected overtime flows through to payroll. The record is stamped `Corrected`.

**Note:** You **cannot approve your own** correction request — your own rows show `your request` instead of action buttons. Ask another admin or the employee's manager to action it. The system enforces this server-side too.

## Common pitfalls

- **Policy below the floor does nothing.** Setting annual leave to 5 days when the EA floor is 8 records a `below minimum` policy that's never applied. Use the floor figures above as your baseline.
- **Forgetting the carry cap.** A new annual-leave entitlement defaults its carry cap to `0` — unused days will be forfeited at the next year-open unless you set a cap.
- **"Edit" vs "Add" entitlement.** Edit only *corrects* a value at the same effective date. To change entitlement *going forward* (e.g. a raise to 18 days from next January), **Add** a new dated entitlement instead.
- **Opening the year too early.** Band upgrades resolve at the employee's service as of 1 Jan, so open the year *for* that year — re-running later is safe.
- **Empty attendance day flagged as absent.** Check the context pill: `On leave` requires an **approved** leave request covering the date; pending leave won't suppress the absence.
