# Asking for a change — exactly which fields, and what happens to a request

Board item **9583deac**, stage two. r260.

Stage one gave employees their own record in the shape HR sees it. This is the stage that lets them
**ask you to correct something on it**, and it is the extension we told you about in the correction at the
top of the plan: you already had a request-and-approve path, so this widens what it covers rather than
building a second one.

Three things changed. Nothing else about approval changed — the same people approve, the same way.

---

## 1. The list of fields an employee may ask to change

Before this round the answer was three areas: bank details, the PCB category, and the number of children.
It is now **twenty-one fields**, and here is the whole list. Everything on it is something the employee
already sees on their own record, and something **you** hold the master copy of.

### On the Profile tab

| What they can ask to change | Why it needs your approval rather than saving straight away |
| --- | --- |
| Salutation | Part of how the person is addressed on letters you send. |
| Full name (as per IC) | This is what prints on the payslip, the EA statement and the bank file. A name change is the request HR receives most often — marriage, deed poll, a mis-keyed IC name — and until now there was no route for it at all. |
| First name · Last name · Known/preferred name | The name parts behind the full name. |
| Nationality | Decides which identity document is mandatory, and sits beside the EPF citizenship the payroll calculation reads. |
| Religion · Race | Recorded for your own reporting; sensitive personal data under the PDPA, so not a field anybody edits casually. |
| Date of birth | Drives the EPF senior rate and the SOCSO age bands. Wrong date, wrong contribution. |
| Gender | Decides maternity and paternity eligibility. |
| Marital status | Drives the PCB (monthly tax) category. |
| Identity No (NRIC) · Old IC No | The number every statutory return is filed under. |
| Passport number · issuing country · issue date · expiry date | The identity document for a non-Malaysian employee, and the one you would chase for a work permit renewal. |

### On the Bank & Statutory tab

| What they can ask to change | Why it needs your approval |
| --- | --- |
| Bank · Bank account | Where their salary is paid. Both must be sent together — approving an account number against the wrong bank name is exactly the half-change approval exists to prevent, and the system refuses it. |
| Tax Category (PCB) | The monthly tax bracket. |
| Children (PCB relief) | The relief count the monthly tax calculation uses. |
| EPF number · SOCSO number · Tax number | The registration numbers you file returns against. A wrong one is a wrong filing, not a typo. |

### What is deliberately **not** on the list, and why

- **Assessments you make about the employee** — the SOCSO and EIS category overrides, tax residency,
  whether HRDF applies, the disability relief flags. Those are judgements an employer records, not facts
  an employee corrects. An employee who believes one is wrong should raise it with you, and you change it
  on the Personnel record.
- **Anything on the withheld list** in `me-profile-field-visibility.md`. An employee cannot ask to change
  something they are not shown — being able to ask about a field is itself a way of learning it exists.
- **The contact details that already save instantly** — mobile, personal email, home address, emergency
  contact. Those have never needed approval and must not acquire a second, slower route to the same place.

**Which of these an employer allows is stage three.** The plan says so: "A setting that controls, field by
field, which information an employee may ask to change." Until that setting exists the list above is the
default, and it is written down here rather than decided quietly in code.

---

## 2. A field with a request waiting shows **both** values

This is the plan's own promise: *"A field with a request waiting shows both values — what it is now and
what was asked for — so nobody is confused about which one is real."*

On My Profile, the field keeps showing **what the record actually says**, in the same place it always was.
Underneath it, in amber, appears a second line: **"Requested, waiting for approval: …"**. The master value
is never replaced by the requested one, and never dimmed or crossed out. An employee reading their own
record sees the number that is really on file — the number their payslip will use tonight — and separately
sees what they have asked you to change it to.

One detail worth stating because it looks like an oversight and is not: a **requested bank account number
is shown masked**, as `•••• 7890`, exactly as the account already on file is shown. Printing the requested
number in full beside a masked one would defeat the masking on the same line.

---

## 3. Rejecting asks for a reason, and the employee is shown it

This is the one part of stage two that genuinely did not exist. The record had somewhere to store the
decision and nowhere to store the sentence, so an employee whose bank change was refused learned only that
it had been refused.

Now:

- the **Reject** button on both approval screens opens a box, and the decision cannot be submitted until a
  reason is typed. There is no way to reject without one — not from the screen, not from the service
  underneath it, and not in the database;
- the reason is stored against the request and **shown to the employee** on their own screen, under
  "My change requests";
- **approving** may carry a note too ("checked against the passport"), and the employee is shown that as
  well. It is optional there.

**One honest note about your existing data.** Requests that were rejected *before* this round have no
reason recorded, and we have not invented one for them — a made-up sentence attributed to whoever approved
it would be worse than a blank. Those show no reason; everything from here on does.

---

## 4. An employee can see the status of their own requests

Under **My change requests**, on the tab the request belongs to: each request lists the fields it covers
and the values asked for, a **Waiting / Approved / Rejected** marker, the date it was asked, the date it
was answered, and the reason if one was given.

They see **only their own**. There is no way for an employee to see, or decide, anybody else's request —
that is enforced by the database, not by a filter on the screen, and it is tested by asking for a
colleague's request by its identifier under a colleague's login and getting nothing back.

---

## What has not changed, and is worth saying out loud

- **Nothing reaches the master record without a decision.** A request that is waiting changes nothing at
  all; a request that is rejected changes nothing at all. That is the safety property of the whole change,
  and it is tested by reading every one of those twenty-one columns before a request, again while it
  waits, and again after it is refused, and requiring them to be identical.
- **Who approves has not changed.** An administrator, never the person who asked, exactly as before. The
  plan says single-level approval is what stage two builds and invites you to reject if you want
  multi-level from the start; you approved it as written.
- **There is still only one master copy.** My Profile reads the Personnel record and writes requests
  against it. It does not keep a second copy of anybody's information.

---

## Still to come in stage three

- The setting that controls, **field by field**, which of the twenty-one above an employee may ask about.
- The setting that controls **who approves**, and an approval screen showing the current value beside the
  requested one for the approver as well as for the employee.

Neither is built. The approver's queue today names each proposed field by the same words the employee and
HR both read it under, which is the groundwork for both — a permission, a request and a record cannot end
up calling one field three different things.
