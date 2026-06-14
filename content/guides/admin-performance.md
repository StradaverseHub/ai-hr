This guide is for HR administrators (`hr_admin` and `super_admin`) who run appraisals in AI HR. By the end you'll know how to create a review cycle, walk it through its full lifecycle (`draft` → `open` → `calibration` → `closed`), understand how self-reviews and manager reviews flow into a single overall rating, control exactly when employees can see their ratings, and turn a manager's merit/bonus recommendation into a real pay change — without the Performance module ever touching payroll directly.

## Where to find it

In the left sidebar, click **Performance**. The page header reads **Performance** with the subtitle *Review cycles, appraisals, and merit recommendations*.

- **Admins** see the full **Review cycles** table plus the **+ New review cycle** panel.
- **Managers** see a **Reviews awaiting you** card listing the appraisals they still need to finalize.

If you also manage people, both views appear together on this one page.

## Creating a review cycle

A *cycle* is the container for one appraisal round across a set of employees.

1. On the **Performance** page, click **+ New review cycle** to expand the form.
2. Fill in the fields:

| Field | What it does |
|---|---|
| **Name** | Free text, e.g. `2026 Annual`. |
| **Scope** | `Group-wide (all companies)` or a single company. Determines who gets snapshotted in. |
| **Period start** / **Period end** | The appraisal window. Defaults to the current calendar year (1 Jan → 31 Dec). End must not be before start. |
| **Merit pool (optional)** | Leave as `No pool`, or set a soft budget — `% of payroll` or `RM (monthly)` — with a value (e.g. `3.5`). |
| **Only include staff hired before (optional)** | Excludes late hires from the round. |
| **Exclude employees on probation** | Ticked by default. |

3. Click **Create cycle (draft)**.

The cycle is created in `draft` status. Nobody is reviewed yet — opening it (next step) is what generates the actual reviews.

**Note — the rating scale.** Every cycle uses a single overall rating on a labelled 1–5 scale: `1 · Below`, `2 · Meets`, `3 · Strong`, `4 · Exceeds`, `5 · Outstanding`. There is one overall score per employee, not a basket of competencies.

**Note — the merit pool is a soft cap.** It's a guideline for calibration, not a hard limit. Recommendations are allowed to exceed it; the budget bar simply turns red so you can see when you're over.

## The lifecycle: draft → open → calibration → closed

Open a cycle by clicking its name in the **Review cycles** table. The status sits in the page header as a badge, and the lifecycle buttons appear next to it depending on the current state.

### 1. Draft

A draft shows a hint card explaining what opening will do. Click **Open cycle** to begin.

**What "Open cycle" does:** it snapshots every in-scope, active employee (minus probation and late hires, per your settings) into one review each, sets each person's **administrative-line manager** as the reviewer, and starts the self-review stage. The cycle moves to `open`. Employees terminated before this point aren't included.

**Tip:** Get your reporting lines right in **Org chart** *before* opening — that's what determines who reviews whom. If a manager changes mid-cycle, you can re-point an individual review (see *Reassigning a reviewer*).

### 2. Open

This is the active appraisal stage. Self-reviews and manager reviews can be edited only while the cycle is `open`. From here the header offers:

- **Move to calibration** — freezes editing for the calibration review.
- **Release ratings** — opens the visibility gate (see below).
- **Close** — ends the cycle.

### 3. Calibration

Use this stage to review the spread before anything is released. On the cycle page you'll see two cards:

- **Rating distribution** — a bar per scale point showing how many *finalized* overall ratings landed there. A healthy distribution usually isn't all `4`s and `5`s.
- **Merit budget** — used vs. pool (monthly), plus **Recommended bonuses (one-off)** alongside. The bar is green when within pool, red when **over by** an amount.

You can still **Release ratings** or **Close** from calibration.

### 4. Closed

A terminal state. Click **Close** from either `open` or `calibration`.

## How self-reviews and manager reviews flow

Each employee's review walks through these statuses (visible in the **Status** column of the cycle's **Reviews** table):

`self_review` → `manager_review` → `submitted` → `acknowledged`

1. **Self-review** — the employee opens their review (from **My workspace** / `/me`) and submits a self-rating and comments. This moves it to `manager_review`.
2. **Manager review** — the reviewer fills in a manager rating, the **single overall rating**, comments, and (optionally) a merit % and/or bonus recommendation. Submitting moves it to `submitted`.
3. **Acknowledged** — after you release ratings, the employee confirms they've seen it, moving it to `acknowledged`.

**Note — no stalls.** A manager can finalize even if the employee never self-assessed. Reviews still sitting at `self_review` appear in the manager's **Reviews awaiting you** list so nothing gets stuck.

On the cycle page, the **Review cycles** progress column reads `ack / done / total` (acknowledged / manager-finalized / total).

### Reassigning a reviewer

If the wrong person is set as reviewer (e.g. an org change), open the individual review and reassign it. You can't reassign on a closed cycle or on a review that's already `submitted`/`acknowledged`, and an employee can never be set as their own reviewer.

## The release gate

This is the most important control to understand: **employees cannot see their manager rating or overall score until you release the cycle.** Until then, the subject sees only their own self-review. The comp recommendation is *never* visible to the employee.

To release:

1. On the cycle page (status `open` or `calibration`), click **Release ratings**.
2. A confirmation appears: *"Release ratings to employees? Every employee will be able to see their manager rating and overall score. This cannot be undone."*
3. Confirm with **Release ratings**.

After release, the header shows `ratings released` and only then can employees **acknowledge** their reviews.

**Tip:** Calibrate first, release second. Once released it can't be undone, so check the distribution and budget cards before pulling the trigger.

## Comp actions — managers recommend, you enact

The Performance module **never writes pay directly**. Managers *recommend* merit and bonus on a review; an admin *enacts* the recommendation through the existing, tested payroll engines. This separation is deliberate.

On the cycle page, when there are pending recommendations, a **Pay recommendations to enact** card appears. Its explainer reads: *"Enacting applies the change through payroll: a merit % becomes an effective-dated salary increase; a bonus is staged into a draft batch and taxed as additional remuneration. Performance never writes pay directly."*

For each line you'll see the employee, the recommended `merit X% (on RM …)` and/or `bonus RM …`, and the inputs to enact:

- **Merit** — pick an **effective** date (defaults to the day after the cycle period ends). On enact, the system creates an effective-dated salary increase via compensation; the new basic = current basic × (1 + merit%).
- **Bonus** — choose a **bonus batch** (a draft payroll batch for the employee's company). The bonus is staged into that batch and taxed as **additional remuneration (MTD)**.

Then:

1. Click **Enact**.
2. Confirm: *"Enact pay for {employee}? This applies a real pay change through payroll — an effective-dated raise and/or a taxed bonus. It cannot be undone here."*

To reject a recommendation instead, click **Decline**.

**Common pitfalls**

- **"Bonus needs a draft batch."** If there's no open draft payroll batch for the employee's company, the line shows this with a **create one in Payroll** link. Go to **Payroll**, create a draft batch, then return and enact.
- **Wrong company batch.** The bonus batch must belong to the same company as the employee, or enacting is blocked.
- **Effective date too early.** A merit's effective date must fall *after* the employee's current pay record started, otherwise it's rejected.
- **No current pay.** You can't apply a merit increase to someone with no current compensation on file.
- **Terminated staff.** Pay can't be enacted for an employee who has left.

**Note — the merit pool stays informative.** Enacting doesn't enforce the pool. The budget card recovers the pre-raise salary basis for already-enacted rows so the *used vs. pool* figure stays stable as raises land.

## Troubleshooting

- **Can't open a cycle twice.** Opening only works from `draft`; a cycle already `open`/`calibration`/`closed` won't re-snapshot.
- **A review won't let me edit.** Self- and manager-reviews are editable only while the cycle is `open`. Move it back out of calibration is not possible — finalize before calibrating.
- **An employee says they can't see their rating.** Confirm the cycle is **released** (header shows `ratings released`). Before release, that's by design.
- **Every action is logged.** Cycle and review transitions, releases, and enactments all write to the audit trail — see **Admin → Audit trail** (`/admin/audit`) if you need to confirm who did what and when.
