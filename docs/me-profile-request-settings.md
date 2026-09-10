# Who may ask, and who decides — the two settings

Board item **9583deac**, stage three. r261. The last stage.

The approved plan promised you exactly two things here, in its own words:

> - A setting that controls, field by field, which information an employee may ask to change.
> - A setting that controls who approves, and an approval screen showing the current value beside the
>   requested one, with Approve and Reject. Rejecting asks for a reason.

The approval screen, the current value beside the requested one, and the required rejection reason all
shipped in stage two (r260) and are described in `me-profile-change-requests.md`. What was missing was
the two decisions in front of them. Both are now on one screen:
**Administration → System Settings → Employee Change Requests**.

Nothing changes for you until you open it. A company that never touches this screen behaves exactly as it
did after stage two — all twenty-four fields askable, an HR administrator approving.

---

## 1. Field by field, what an employee may ask to change

The screen lists all twenty-four fields, grouped by the tab an employee reads them on, each with a tick
box. Ticked means "an employee may ask me to correct this". The list is not per tab and not per group of
fields — it is per **field**, which is what you asked for.

Three things are worth knowing about how it behaves.

**An unticked field is not on the employee's screen at all.** It is not greyed out, and it is not a box
with a padlock beside it. There is nothing there. A control an employee can see but not use tells them the
field exists and that somebody decided they may not touch it, which invites a question you would rather
not field; and a greyed box is one small mistake away from working. So the field simply is not offered.
The system also refuses the change on the server, independently of the screen, so it does not matter how
the request is sent.

**Switching a field off refuses anything already waiting on it.** This is the case that matters, and we
would rather write down the decision than let you discover it. Suppose an employee asked to change their
bank account on Monday, and on Tuesday you switch the bank account field off. The request is **refused**,
there and then, with a sentence the employee can read on their own screen:

> *This field is no longer open to change requests. Please contact HR if it still needs correcting.*

Nothing is written to the employee's record, and nothing is deleted — the request stays in their history
with what they asked for and why it was refused. It is the only safe answer of the three available: a
request left waiting could be approved next week under a permission you had already withdrawn, and a
request quietly deleted would leave an employee who asked you something and never heard back. So that you
are not surprised by it, each field on the screen shows how many requests are waiting on it **before** you
switch anything off, and the confirmation afterwards tells you how many were refused.

**And the approval itself checks again.** Refusing the waiting requests when you switch a field off is
the ordinary path — the employee is told, in a sentence, on their own screen. But a request can be raised
in the same second you save the setting, and any request that somehow survives that moment would otherwise
be sitting in the approval queue looking perfectly normal. So the approval itself asks the question one
last time: if the request names a field you no longer allow, it **cannot be approved at all** — the
administrator is told to reject it, and the record does not move. There is no configuration, and no timing,
in which a field you have switched off can be written to somebody's record by an approval.

A request that names a switched-off field **and** a field that is still open is refused whole, not trimmed.
Editing somebody's request down to the parts that survive would mean an administrator later approving a
request nobody actually submitted. The employee can ask again for the part that is still open, and the
reason tells them why they need to.

**A field added in a later round.** If you have never configured this setting, your answer is "the
default", and a field we add later is included in it — exactly as today. If you *have* configured it, your
answer is a list, and a new field is not on that list, so it starts switched off and waits for you. That is
the cautious direction for a company that has made a decision, and no change at all for one that has not.

---

## 2. Who approves

One approver, one decision. The plan said so and invited you to reject it if you wanted manager-then-HR
approval from the start:

> We have planned a SINGLE approver to begin with … If you want multi-level from the start, reject this
> plan and say so.

You approved it as written, so a request is settled by one person either way. The setting chooses which
people those are:

| Setting | Who can approve |
| --- | --- |
| **Any HR administrator** (the default) | Every HR administrator in scope, including one whose access covers a single company. This is how the system behaves today. |
| **Only a group administrator** | A super administrator, or an HR administrator whose access covers the whole group. An administrator for one company can no longer sign these off. |

Choose the second when a bank account or an identity number should be signed off by whoever holds the whole
group rather than by whoever administers one company. Requests they may no longer decide simply stop
appearing in their approvals inbox, rather than appearing and then refusing when pressed.

**Nobody can approve their own request, under either setting.** That is not a configuration — it is checked
before the setting is ever consulted, for an administrator exactly as for anybody else. (The one long-
standing exception, unchanged by this round, is the super administrator of a very small company, who would
otherwise be locked out of their own approvals with nobody else to ask.)

**Neither setting changes who can see whose requests.** An employee sees their own and only their own; an
administrator sees the employees they administer; a manager sees their own team. That is enforced by the
database rather than by a filter on a screen, and this round did not touch it.

---

## The one thing you asked for that this setting cannot do, and why

Your original request described **manager first, then HR**. We reduced that to one approver, told you so,
and you approved it. What we owe you now is the reason the single approver is an *administrator* rather
than *the employee's manager*, because that is a real limit and it shapes what to ask for next.

Approving a change **writes the master employee record** — the name that prints on the payslip, the bank
account the salary is paid into. Since the first version of this system, only an administrator has been
permitted to write that record, and the permission is enforced by the database itself rather than by the
screens. It is not a rule about this queue: it is the rule that stops an employee record being edited from
anywhere it should not be.

So "the manager approves" is not a setting we could turn on. It would mean giving every manager write
access to their team's employee records, by every route, not just this one — a much larger change than the
one you approved, and not one a tick box on a settings screen should be able to make.

**If manager approval is what you want**, it is a separate piece of work and a real one: the manager would
record a recommendation, and the record would still be written by an administrator acting on it. That is
the honest shape of manager-then-HR approval, and it is close to the multi-level flow your original request
described. Tell us and we will plan it properly rather than approximate it.

---

## What did not change

- **Nothing reaches the master record without a decision.** Unchanged, and still the safety property the
  whole item rests on.
- **The twenty-four fields themselves.** This round decides which of them *you* allow; the list, and what
  is deliberately left off it, is still `me-profile-change-requests.md`.
- **The employee's screen.** Same six tabs, same cards, same "requested, waiting for approval" line beside
  the value that is really on file.
- **No new copy of anybody's data.** These are two settings on your company, not a second record of anyone.
