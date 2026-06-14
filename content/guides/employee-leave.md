This guide is for **employees** who want to check how much leave they have left and apply for time off. By the end you'll know how to read your leave balance, submit a request, understand what happens to it after you click submit, and what each status means. You can do everything here from two places in the app: the **Leave** page and your own **My workspace** page.

## Where to find leave

In the left sidebar you have two entry points:

- **Leave** (`/leave`) — the shared leave page. At the top is a **Planned absences** timeline showing who's away over a 14-day window, then your balances, a **Requests** table, and a request form.
- **My workspace** (`/me`) — your personal page. It has a compact **Leave** card with your balances, a quick request form, and your last few requests, all in one place.

**Tip:** For a fast "how many days do I have left, and let me book one," the **Leave** card on **My workspace** is the quickest path. Use the full **Leave** page when you want to see the planned-absences timeline or your complete request history.

## Checking your balance

Your balances are **private to you**. On the **Leave** page the balances card is titled **My balances** and shows only your own rows — you won't see colleagues' balances there. (HR and admins are the only roles who see everyone.) The subtitle reads **available / entitled**, which tells you how to read each number.

Each leave type shows a figure like `12 / 16`:

- The **first number** is what you can still book right now (**available**).
- The **second number** is your total entitlement for the year (**entitled / accrued**).

On **My workspace**, the **Leave** card shows the same `available / accrued` figure for each type, plus a small usage bar and a one-line summary underneath:

| Term | What it means |
| --- | --- |
| `used` | Days already approved and taken |
| `pending` | Days in requests you've submitted that aren't decided yet |
| `available` | What's left to book = entitled − used − pending |

The usage bar fills in two shades: the solid part is leave you've **used**, and the lighter part is leave **pending approval**. On the Leave page's balance grid, a pending request also shows a small amber **{n} pend** badge next to the number, and hovering a cell shows a tooltip like `2 used · 1 pending approval`.

**Note:** Some leave types don't accrue a yearly balance (for example certain per-occurrence sick leave). Those show a dash (`—`) instead of a number — that's expected; there's simply no running balance to count down, but you can still request them.

**Note on Malaysian leave:** Annual, sick, and hospitalization leave are granted as yearly entitlements based on your length of service, in line with the Employment Act. Bands step up automatically with service years, so your **entitled** number can grow over time.

## Requesting leave

You can submit from either page. Both forms create the same request.

### From My workspace (quickest)

1. In the left sidebar, click **My workspace**.
2. Find the **Leave** card and the small form below your balances.
3. Choose a **Type** from the dropdown (your available leave types).
4. Pick a **From** date and a **To** date. Both are required.
5. Click **Request leave**.

Your new request appears under **Requests** lower in the same card with a status pill.

### From the Leave page

1. In the left sidebar, click **Leave**.
2. Scroll to the bottom and click **+ Request leave** to expand the form.
3. Fill in:
   - **Employee** — yourself (this picker exists because managers and HR can file on others' behalf).
   - **Leave type** — the type of leave you want.
   - **Start date** and **End date** — both default to today; change them to your dates.
   - **Reason (optional)** — a short note, e.g. `Family trip`. You can leave this blank.
4. Click **Submit request**.

### How the days are counted

You don't enter a day count — the system works it out from your dates:

- For **working-day** leave types (such as annual leave), it counts only working days and **skips weekends and public holidays** in your range.
- For other types, it counts every calendar day in the range.

So a Friday-to-Monday annual-leave request over a normal weekend is counted as **2 days**, not 4. If your range works out to zero days (for example an end date before the start date, or a range that's all weekend), the request is rejected with an error — pick valid dates and try again.

## What the statuses mean

Every request carries one status, shown as a coloured pill:

| Status | Colour | What it means |
| --- | --- | --- |
| `Pending` | Amber | Submitted and waiting for a decision. It already counts against your **available** balance as pending. |
| `Approved` | Green | Approved. The days are deducted from your balance. |
| `Rejected` | Rose/red | Turned down. No days are deducted; your pending amount frees back up. |
| `Cancelled` | Grey | The request was withdrawn and is no longer active. No days are deducted. |

On the full **Leave** page, the four cards across the top (**Requested**, **Approved**, **Pending**, **Rejected**) are also filters — click one to show only requests in that state, and click **Requested** to clear the filter.

## Who approves your leave

When you submit, your request goes to **Pending** and is reviewed by someone with approval rights — typically your **manager**, or **HR**. A few things worth knowing:

- **You can't approve your own leave.** Even managers can't approve their own requests; the Approve/Reject buttons never appear on your own rows.
- On approval, the system checks you actually have enough balance. If an approved request would push a balance below zero, approval is blocked with an insufficient-balance message — so a request may sit pending until that's resolved.
- You won't see Approve/Reject controls in your view — those belong to approvers. Managers and HR also have a dedicated **Approvals** inbox.

## Cancelling a request

The `Cancelled` status exists for requests that are withdrawn, but there's no self-service "Cancel" button on the employee leave or My workspace pages today. If you've submitted a request by mistake or your plans change:

1. Reach out to your **manager** or **HR** (the people who handle **Approvals**).
2. Ask them to **reject** the request if it's still `Pending`, or to reverse it if it's already `Approved`.

Either way, the days return to your balance once the request is no longer `Approved`.

**Tip:** Before submitting, double-check your **From**/**To** dates and the **Type** — getting it right the first time avoids a back-and-forth with your approver.

## Troubleshooting & common pitfalls

- **My balance shows a dash (`—`).** That leave type doesn't carry a running yearly balance (e.g. per-occurrence sick leave). You can still request it.
- **"No leave days in range" error.** Your **To** date is before your **From** date, or the whole range falls on weekends/holidays for a working-day leave type. Adjust the dates.
- **I can see fewer days than I expected.** Working-day leave types skip weekends and public holidays, so a calendar span often counts as fewer leave days.
- **My request is stuck on `Pending`.** It's waiting for your approver. If it's urgent, ping your manager or HR — and remember approval can be held up if there isn't enough balance to cover it.
- **I can't see anyone else's balances.** That's by design — balances are private to each employee. Only HR and admins see the full picture.
