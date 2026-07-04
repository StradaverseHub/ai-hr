This guide is for **people managers** who want to understand the shape of their team and the wider organisation. By the end, you'll know how to read the **Org chart**, expand and collapse reporting branches, zoom and search for a colleague, tell apart the different reporting-line types (direct, functional, project and dotted-line), and open any person's detail page to see what's within your scope — their leave balance, assignment history, compensation, statutory profile and reporting lines.

Everything you see is governed by your access scope and your active **company context** (the multi-company switcher). You'll only ever see people and detail you're permitted to see; the views below never widen that — they just help you navigate it.

## Open the org chart

In the left sidebar, click **Org chart** (`/org`).

The page header reads **Org chart**, and to the right you'll see a live count — for example `12 people` — showing how many people are in your current view. Below that sits one large card containing the interactive chart, and beneath the card a short legend note explaining the connector colours.

**Note:** If your view is empty you'll see *No employees yet.* — usually a sign your company context is filtered to a company with no staff. Use the company switcher to widen the context.

### What a person card shows

Every person is drawn as a card with:

- An **avatar** and the person's **name** (bold).
- Their **role / position** underneath (a `—` if none is recorded).
- A small coloured dot plus their **department** name on the second line. The dot colour is derived from the department, so people in the same department share a colour at a glance.

Click any card to jump straight to that person's detail page (covered further down).

## Expand and collapse reporting branches

The tree is built from **direct (administrative)** reporting lines — one manager, the people who report to them, and so on down. People with no direct manager appear as the **roots** at the top.

- Where someone has direct reports, a small **pill button** sits just below their card.
- When a branch is **expanded**, the pill shows an up-chevron. Click it to **collapse** that branch and tuck the reports away.
- When a branch is **collapsed**, the pill shows a count and a down-chevron — for example `+4` — telling you how many reports are hidden. Click it to **expand** them again.

**Tip:** Collapsing branches you don't need is the fastest way to declutter a large chart and focus on your own slice of the organisation.

## Zoom in and out

Top-right of the chart card you'll find the zoom controls:

| Control | What it does |
|---|---|
| **−** (Zoom out) | Steps the zoom down by 10%, to a minimum of `50%`. |
| **100%** button | Shows the current zoom level. Click it to **reset zoom** to 100%. |
| **+** (Zoom in) | Steps the zoom up by 10%, to a maximum of `150%`. |

The buttons grey out when you reach the minimum or maximum. For very wide teams, zoom out to fit more on screen, then scroll the chart horizontally to pan across.

## Search for a colleague

To the left of the zoom controls is a **search box** with the placeholder *Search people…*.

1. Start typing a **name**, **role** or **department**.
2. Matching cards are highlighted with a ring; everyone else dims so the matches stand out.
3. The chart automatically **reveals everything and scrolls the first match into view** — so a match buried inside a collapsed branch is never hidden from you.
4. Clear the box to return to your normal expanded/collapsed layout.

**Note:** If nothing matches, you'll see *No one matches "…"* above the chart. Check spelling, or remember that search only covers people inside your current scope and company context.

## Understanding reporting-line types

A core idea in this chart is that **one person has exactly one direct manager** (that's the tree you navigate), but may also have **several cross-cutting lines** to other people. The connector **colour and style** tell you which kind of relationship each line represents. The legend across the top of the chart spells them out:

| Line type | Appearance | What it means |
|---|---|---|
| **Direct** (administrative) | Solid indigo | The primary, line-management relationship. This is the relationship that builds the tree itself. |
| **Functional** | Solid teal | A functional reporting relationship — e.g. reporting into a discipline or function lead alongside your direct manager. |
| **Project** | Solid purple | A project-based reporting line, typically for the duration of a piece of work. |
| **Dotted-line** | Dashed amber | A softer, secondary or advisory relationship that isn't full line management. |

As the legend note on the page puts it: *the connector colour encodes the reporting relationship — direct (administrative), functional, project, and dotted-line.* Only the **direct** lines form the vertical tree; functional, project and dotted-line connections are drawn as additional curves between cards, which is why one person can have multiple lines coming and going.

**Tip:** If you manage someone on a **project** or **dotted-line** basis but they sit under a different direct manager, you'll see them on the chart connected to you by the matching coloured line, not nested beneath your card.

## Open a person's detail page

Click any card on the org chart, or open someone from the **Personnel** list, to reach their detail page (`/personnel/…`).

At the top you'll see the person's **name**, a status badge (for example `active` or `terminated`), and a summary line showing their employee code, email, company and hire date. A **Personnel** back-link returns you to the list.

What you can view here within your scope:

### Leave balance

A row of cards under **Leave balance**, one per leave type, showing the **available** balance, how much has **accrued**, and how much has been **taken** (with any pending days noted). A useful at-a-glance check before approving time off. If nothing is set up you'll see *No leave records*.

### Compensation

The **Compensation** card shows the current basic salary and currency (MYR), any monthly allowance, and the date the figure is valid from. If no package is recorded you'll see *No compensation*.

### Statutory (Malaysia)

The **Statutory (Malaysia)** card holds the person's Malaysian payroll identifiers — **IC number**, **EPF/KWSP**, **SOCSO/PERKESO** and **tax (PCB/LHDN)** numbers, PCB category and child-relief count, bank details, EIS/SIP eligibility and tax-residency status, plus any **TP3** prior-employment figures used for mid-year PCB.

### Assignment history

The **Assignment history** table lists each posting as a row: the **period** (valid-from → valid-to, or `present` for the current one), **department**, **position** and **status**. The current assignment is highlighted. This is your timeline of moves, promotions and transfers.

### Reporting lines

The **Reporting lines** card has two columns:

- **Reports to** — every manager above this person, each tagged with its line type (`administrative`, `functional`, `project` or `dotted-line`).
- **Direct reports** — everyone reporting to this person, similarly tagged.

Both lists are clickable, so you can walk up and down the hierarchy person by person.

### Leave requests

At the bottom, **Leave requests** lists this person's requests with leave type, dates, day count and a colour-coded status: `pending` (amber), `approved` (green), `rejected` (red) or `cancelled` (grey).

**Note:** Editing tools — saving personal details, **Update pay**, **Add reporting line**, **Transfer**, **Terminate**, and the **Change history** audit log — appear only for **HR admins** (`hr_admin` / `super_admin`). As a people manager you have a clear, read-through view of your team, but those administrative changes are made by HR.

## Common pitfalls

- **"Someone's missing from the chart."** They're outside your current scope or company context, or they have no **direct (administrative)** manager set and sit as a separate root — scroll across the top of the chart, or check the company switcher.
- **"I can't find the Update pay / Transfer buttons."** Those are HR-admin only and won't appear for the people-manager role. View is available to you; the change is made by HR.
- **"Search found no one."** Search is limited to people in your current scope; widen your company context if you expected a match.
- **"The chart is huge and hard to read."** Collapse branches you don't need and zoom out (down to `50%`), then pan horizontally.
