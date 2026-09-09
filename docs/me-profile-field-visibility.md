# My Profile — exactly what an employee sees of their own record, and what they do not

Board item **9583deac**, stage one. r259.

The approved plan promises you this list in writing:

> Some tabs will show less than the administrator's view even when the layout matches — an employee has no
> business seeing another person's cost centre or an internal note. **The list of exactly which fields are
> hidden is written down and shown to you before stage one is built, not decided as we go.**

This is that list. It is the difference between a self-service screen and a data leak, so it is a
deliverable of the round rather than a note about one.

**One correction to that promise, and it is ours to make.** The plan says the list would be shown to you
*before* stage one was built. It was not: it was written **during** the build, as each card was matched to
the Personnel record's, and you are reading it now, with the screen finished and before it is released to
anybody. That is later than we promised. Nothing on the list was decided after the fact — the screen is
built from this list rather than described by it — but the sequence was not the one you were told, so we
would rather say so here than let the title imply otherwise.

It is not prose that can rot. `app/me/visible-fields.ts` holds the same list as code, the screen renders
from it, and `test/me-profile-visibility.test.ts` fails the build if this document and that file stop
agreeing. The same file also now checks the harder direction: every field the administrator's Personnel
record shows must be either on the employee's screen or on the withheld list below. A field added to a
Personnel card in some later round cannot quietly go missing from the employee's copy of their own
record — the build stops until somebody decides, in writing, which of the two it is.

---

## The shape

My Profile now carries the **same six tabs, in the same order, with the same names** as the Personnel
record an administrator sees:

| Tab | The card(s) on it |
| --- | --- |
| **Profile** | Personal details · Contact & address · Emergency contact · Personal details, identity & documents (request a change — added in stage two) |
| **Employment** | Employment Information · Direct Superior · (other current positions, with the pay of each, if any) |
| **Bank & Statutory** | Bank Information · Statutory (Malaysia) · Others Statutory · Bank, tax & personal (request a change) |
| **Payroll** | Basic Salary · My payslips · Personal tax relief (TP1) · My loans |
| **Family** | Family & Dependents Information |
| **Documents** | Tax statement (EA) · Review outcome · Resignation |

The first card on each of the first five tabs carries the **same name HR sees**, letter for letter, because
it is the same catalogue entry. The rest are the employee's own lists — payslips, tax relief, loans, EA
statements, the resignation form — which have no Personnel counterpart at all, so there is no second name
for them to drift from.

The tab names are not copies of the Personnel screen's words — they are the **same catalogue entries**,
read from the same place. Rename a tab on the Personnel side and it renames here. That is what stops the
two screens drifting apart again, which was the original complaint.

Two things sit **outside** the tabs, on purpose:

- **Clock in / out** stays at the top of the page. It is one of only two places a geofenced punch can be
  made, and the Personnel record has no clocking card, so putting it in a tab would have meant deleting it.
- **My Performance** (goals, feedback requests, one-to-one check-ins) moved to its own screen at
  `/me/performance`, linked from the top of My Profile. The Personnel record has no Performance tab; the
  contents moved rather than disappearing.

---

## What an employee **cannot** see on their own record

Three kinds of thing are withheld, and the difference between them matters.

### 1. Other people's data, reachable from a field on this person's record

| Tab | Field | Why |
| --- | --- | --- |
| Bank & Statutory | Duplicate income-tax-number warning | It names the **other** employees filed under the same tax reference. A warning meant for HR would tell an employee who else shares their number. |
| Employment | Cost centre and cost-recharge allocation | Which companies this salary is charged to is the group's internal accounting, not a fact about the person, and the percentages disclose an inter-company arrangement. |
| Employment | Delegations (who covers this person’s approvals) | An operational authority setting about other employees' approval rights; changing it is an HR act, and reading it tells an employee who can approve in their name. |
| Family | Dependant remarks and employer details of a working spouse | Free-text HR notes about a family member, and a third party's employer address, neither of which the employee record needs to show back. |
| Family | Dependant identity, address, marriage and study details | The Family card shows who is on the record and whether each child counts toward tax relief. A dependant's own IC/passport, home address, marriage date and schooling are another person's details, held for a payroll purpose and not printed back onto a self-service screen. |
| Profile | Emergency contact remark | The register's free-text note is HR's ("call the sister first, the mother is overseas"). Who the contacts are, how to reach them, their address and their priority are all shown. |

### 2. The employer's own commercial position, recorded against the employee

| Tab | Field | Why |
| --- | --- | --- |
| Bank & Statutory | Employer-borne EPF / SOCSO / EIS / SKBBK / tax flags | These record which contributions the **company** absorbs on the employee's behalf — an employment-cost arrangement, not the employee's statutory position. |
| Bank & Statutory | Child-relief rate table (full / half categories) | Tenant-level tax configuration shared by every employee; the employee's own relief **count** is shown, the grid behind it is not. |
| Payroll | Payroll policy assignment (which pay template applies) | Internal payroll configuration. What it produces — pay mode, payment term, the payslip — is shown; the template name is not. |
| Payroll | Pay component catalogue and recurring component setup | HR master data for building pay. Every amount it produces already appears on the employee's own payslip. |
| Payroll | CP38 instalment orders | An LHDN order telling the **employer** to deduct a fixed instalment of an employee's tax arrears. The deduction itself is a line on the employee's own payslip, which My Profile shows; the order record — its reference, its months, HR's note on it — is the employer's compliance file, and the employee receives the order from LHDN directly. |
| Payroll | Zakat contribution setup | The state, method and rate by which zakat is computed for this employee is payroll configuration on the employer's side. The amount it produces is a line on the employee's own payslip and on their EA statement, both of which My Profile shows. |
| Employment | Attendance, holiday-calendar and shift configuration | Which holiday calendar, shift pattern and geofence apply to this employment are operational settings HR assigns. What they produce — the public holidays on the leave calendar, the clock-in the employee actually makes — is on My Absence and at the top of this screen; the assignment itself is not a fact about the person. |
| Employment | Contract remark | A free-text HR note on the contract ("renew at revised rate", "do not extend"). The contract **dates** are shown; the note is an internal judgement. |

### 3. An internal judgement about this person

The most dangerous class: it *is* their data, and it is still not a thing to hand them without an HR
decision.

| Tab | Field | Why |
| --- | --- | --- |
| Employment | Blacklist flag and blacklist reason | An internal HR decision about re-employment. Disclosing it on a self-service screen would be the employee learning it from a web page. |
| Payroll | Salary revision remarks and the full revision history | The **current** salary, currency and effective date are shown. The remark on each past revision is HR's reasoning, and the increment history is a performance conversation, not a field. |
| Documents | HR personnel-file documents (the Documents repository) | The file can hold a warning letter or an investigation note, and there is no per-document "visible to employee" switch yet. Payslips, EA statements and review letters — the documents meant **for** the employee — are shown. |
| Every tab | Change History / audit trail | It names which member of staff changed what and when. It is HR's record of its own handling of the person. |
| Every tab | Data privacy tools (PDPA export / erasure controls) | Administrative controls that act on the record; a request route, not a self-service button. |
| Every tab | Movement history (transfer / termination / blacklist events) | The event ledger carries the reasons behind each movement, including exit reasons recorded by HR before anything is communicated. |

---

## One address on the Contact & address card, and why there is only one

The plan promises you this, and we hold ourselves to it: *"My Profile will not hold a second copy of
anybody's information. It reads the Personnel record and writes requests against it, so there is only ever
one master."*

Keeping that promise cost this round a card. **HR’s Permanent and Correspondence address block** is not on
My Profile, and the reason is worth a paragraph because it is a fact about your data rather than a
decision about privacy.

An employee record currently holds the home address in **two different places**. There is the address the
employee maintains themselves — the one behind the "My details" panel on this screen, which saves the
moment they press the button. And there is the Permanent / Correspondence pair that HR fills in on the
Personnel record, which is what feeds statutory forms and reports. They were one address until the
Personnel card was split into two blocks; since then, nothing keeps them in step.

We built My Profile showing HR’s pair first. The result was a card an employee could not trust: two
addresses on screen, and a Save button that changed neither of them — while the mobile number and personal
email in the same panel *did* update, because those are single columns shared by both screens. An employee
would have corrected their address, seen it apparently ignored, and corrected it again.

So My Profile shows **the address the employee can actually change**, and nothing else. What is on the
card is what the button writes.

**What that means for you, in practice.** Until the two are merged, an address an employee corrects on My
Profile does not appear on the Personnel record, and an address HR types on the Personnel record does not
appear on My Profile. That is true today, before this round, and this round does not make it worse — but it
is now visible, so we are telling you rather than leaving you to find it. Merging them is a change to the
stored record itself and needs a short, separate piece of work: decide which of the two is the master, copy
the other into it, and retire the loser. We recommend doing it before stage two, because stage two is
where an employee starts *requesting* changes to fields HR owns, and an address with two homes would make
a request ambiguous the first time it was used.

---

## Two more decisions worth stating plainly

**The bank account number is masked.** The employee sees the bank and the last four digits, which is
enough to confirm which account is on file without the full number rendering onto a shared screen or into
a screenshot. That is how My Profile has always shown it; nothing changed.

**Nothing new became editable in stage one.** Stage one showed the record. The two ways to change
something were already there and were unchanged:

- low-risk contact details (mobile, personal email, home address, emergency contact) save immediately;
- bank details, PCB category, number of children, date of birth, gender and marital status raise a
  **request** that waits for an administrator.

**Stage two (r260) widened the second of those** from three areas to twenty-four named fields, added the
rejection reason, and put a waiting request's value beside the master one rather than over it. The whole
list, and what is deliberately left off it, is `docs/me-profile-change-requests.md` — written for you the
same way this document is. Nothing on the withheld list below became requestable: an employee cannot ask
to change a field they are not shown, and the build fails if the two lists ever disagree.

One label moved as part of that, and it belongs in this document because it is a field name you read.
**"PCB category" on the Bank & Statutory tab is now "Tax Category"** — Personnel Management's own name for
it, the one on the Identification & Tax card. It had been the one field on this screen still carrying a
second wording of its own, which is exactly the drift this whole item was raised about. Same field, same
value, HR's name for it.

Stage three adds the setting that controls, field by field, what an employee may ask to change, and who
approves it.

---

## The one item we would like a decision on

**The HR personnel file (the Documents repository) is withheld for now.** Technically an employee is
already permitted to read the documents filed against their own employment — the database allows it. We
have not surfaced them, because there is no way today to mark a single document "the employee may see
this", and the same folder is where a warning letter would be filed. Surfacing the folder wholesale would
publish those.

The right fix is a per-document visibility switch on the HR side, which is a small piece of work but is
not in stage one's scope. Until then the Documents tab shows only what is produced **for** the employee:
their EA statements, their review outcome, and their own resignation.
