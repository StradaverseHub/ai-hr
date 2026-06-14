This guide is for **people managers** acting as reviewers in AI HR. When an HR admin opens a review cycle, the system creates one review for each of your direct reports and points it at you as the reviewer. Your job is to finish each review: read the employee's self-assessment, write your manager review, give an **overall rating**, and — if it's warranted — recommend a merit increase or a one-off bonus. This guide walks through finding your work, completing it, and what happens next.

**The one thing to remember:** as a manager you **recommend** pay changes; you don't make them. An HR admin (or super admin) is the only person who can **enact** a merit raise or bonus through payroll. More on that below.

## Where your reviews appear

In the left sidebar, click **Performance**. At the top of the page you'll see a highlighted card titled **Awaiting you** with an amber count badge showing how many reviews need your attention. Each row lists the **employee's name** and the **cycle** it belongs to, with a **Review** link on the right.

**Note:** Only reviews where you are the named reviewer and the cycle is still **open** show up here. Once a cycle moves to calibration or is closed, reviews freeze and drop off this list. If the "Awaiting you" card isn't showing, you have nothing pending.

Click **Review** on any row to open that person's review page.

## Understanding the review screen

The review page is titled with the employee's name and the cycle (for example, `Aisha Rahman — FY2025 Annual`), with the review period dates and a status badge in the top-right corner. A review moves through these statuses:

| Status | Meaning |
| --- | --- |
| `self_review` | Waiting on the employee's self-assessment |
| `manager_review` | The employee has submitted; it's your turn |
| `submitted` | You've finalized it (rating + overall locked in) |
| `acknowledged` | The employee has read and acknowledged the released review |

The page has two main cards: **Self-review** (the employee's input) and **Manager review** (yours).

### Reading the self-review

The **Self-review** card shows what the employee submitted: their **Rating**, optional **Comments**, and any **Goals referenced**. Read this first — it's their case for the period.

**Tip:** You can finalize a review even if the employee never submitted a self-review. If the self-review card says *"Not submitted yet,"* you can still complete your manager review so the cycle doesn't stall. The self-rating column will simply stay blank.

## Writing your manager review

In the **Manager review** card, you'll see a form (this appears only while the cycle is open and it's your turn). Complete it as follows:

1. **Manager rating** — pick your assessment of the employee on the cycle's rating scale (for example `3 · Strong`). The scale is set per cycle; the default runs `1 · Below` through `5 · Outstanding`.
2. **Overall rating** — set the final, finalized rating for the period. This is the figure that feeds the cycle's **rating distribution** (the calibration view HR uses) and the one the employee eventually sees. It can match your manager rating or differ from it after you weigh the self-review and any calibration discussion.
3. **Comments (optional)** — write your narrative. This is what the employee reads once ratings are released, so be specific and fair.

Both **Manager rating** and **Overall rating** are required. You must choose values that exist on the cycle's scale, or the form will reject the submission.

## Recommending merit or a bonus

Inside the Manager review form is a shaded box for **pay recommendations**. This is optional — leave it blank if no pay change is warranted. Two fields:

- **Merit increase (%)** — a percentage raise to the employee's basic salary (for example `3.5`). When enacted, this becomes an effective-dated salary change.
- **One-off bonus (RM)** — a flat amount (for example `2000.00`) paid through a payroll batch and taxed as additional remuneration (PCB/MTD applies).

**Note:** You are **recommending**, not granting. Entering a number here flags the review with a `recommended` pay action. Nothing reaches payroll, EPF/KWSP, SOCSO, or the employee's payslip until an HR admin reviews and enacts it. Only positive values count; zero or blank means "no recommendation."

When the form is complete, click **Finalize review**. The review status changes to `submitted`, your ratings lock in, and — if you entered merit or bonus — a recommendation is queued for HR.

**Tip on the merit budget:** HR may have set a merit pool for the cycle. Your recommendations can exceed it; the pool is a soft cap that HR uses during calibration to trim. Recommend what you believe is right and let calibration reconcile the total.

## What you can and can't see after finalizing

If you're also an admin or the named reviewer, the review page will show a **Pay recommendation** card summarizing the merit %/bonus and its status (`recommended`, `enacted`, or `declined`), with a note that enactment happens from the cycle page. The employee **never** sees the pay recommendation — it's management-only.

The employee also can't see your manager rating, overall rating, or comments **until HR releases the cycle**. Until then their review page tells them the manager review is pending release.

## After you finalize: HR enacts the pay

This is the hand-off. Once a cycle is released and recommendations are finalized, an HR admin opens the cycle's detail page and works a **Pay recommendations to enact** list. For each recommendation they:

- Set an **effective from** date for a merit raise (it must be after the current pay started), which creates the new compensation record, **or**
- Choose a **draft payroll batch** for a bonus (the batch must belong to the employee's company), which adds the bonus as a payroll input, **or**
- **Decline** the recommendation.

Only then does the status flip to `enacted`. **Bonuses need a draft payroll batch to exist** — if none does, HR creates one in Payroll first. As a manager you don't perform any of these steps; your part ends at **Finalize review**.

## The acknowledgement flow

Acknowledgement is the employee's step, not yours. After HR **releases** the cycle's ratings, the employee opens their own review (from **My workspace** / `/me`) and sees your manager rating, overall rating, and comments. An **Acknowledge** button appears; clicking it moves the review to `acknowledged` and timestamps that they've read it.

**Note:** You can't acknowledge on an employee's behalf, and acknowledgement is only possible after release while the review is in `submitted`. The `acknowledged` count is what HR tracks to confirm the cycle has fully landed with the team.

## Common pitfalls

- **No "Awaiting you" card.** Either you have nothing pending, or the cycle left the `open` state (moved to calibration/closed). Frozen cycles don't accept further manager input.
- **Can't find the Finalize button.** The manager form only renders while the cycle is `open` and the review is in `self_review` or `manager_review`. If it's already `submitted`, you've finished it.
- **Rating rejected.** You picked a value outside the cycle's configured scale. Use the dropdown options exactly as listed.
- **"I recommended a raise but pay didn't change."** Expected. Recommendations sit at `recommended` until an HR admin enacts them from the cycle page. Follow up with HR if it's stuck.
- **Employee didn't self-review.** Not a blocker — you can still finalize. Their self-rating column just stays empty.
