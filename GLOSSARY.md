# AIHR

Personnel distinguishes a person from each employment they hold. These terms distinguish identity,
access, HR classification and employee submission outcomes.

## Language

**Test record**:
An employment that authorized HR has explicitly marked for test use. The designation belongs to that
employment and does not classify the person or their other employments.
_Avoid_: Fake employee, test person, automatically detected test data

**Unmarked employment**:
An employment without the explicit Test record designation. Unmarked does not certify that the record
is real or has been reviewed.
_Avoid_: Verified real employee, production-certified employee

**User without an employee record**:
A named person who can sign in through explicitly granted access without holding an employment.
Their login does not establish employment, payroll eligibility or a reporting relationship.
_Avoid_: Dummy employee, fake employee, unlinked identity

## Employee submissions

**Reported clock attempt**:
An employee's claim that they started preparing a clock action at a phone-reported time. Receipt by
the company establishes that the claim arrived, not that the employee was present or clocked in.
_Avoid_: Verified attendance, proof of presence, accepted offline punch

**Pending submission**:
An employee's specific clock or leave request whose accepted or refused outcome has not yet been confirmed.
_Avoid_: Recorded attendance, approved leave

**Reported location uncertainty**:
The device provider's estimate of the distance by which a reported
position may differ from the physical position. It describes location quality and does not prove
where the person or device is.
_Avoid_: Verified location, proof of presence

**Geofence containment**:
A reported position qualifies for an assigned workplace only when its
distance from the workplace plus its reported uncertainty fits within that workplace's radius.
_Avoid_: Radius expansion, spoof-proof location

**Submission abandonment**:
An employee's decision to prevent an unaccepted pending submission from being recorded. An already
accepted request keeps its outcome and follows the normal attendance correction or leave cancellation process.
_Avoid_: Delete attendance, cancel approved leave, erase history

## AI Centre operations

Each of these facts has one page that owns it (AI Centre restructure, owner decisions 26–29). Every other screen,
the Assistant included, shows a count or a link to that page.

**Exception**:
A payroll anomaly verdict, flagged for review or blocking a run, that a person has not yet resolved. It is resolved on
Operations › Exceptions only; a run's own page lists it and links there.
_Avoid_: Alert, error, incident, finding (a finding is one detector's evidence inside an exception)

**Finding**:
One check's evidence about a record or a run: what it compared and what it found. An exception carries one or more
findings; Today shows an administrator's findings as counts that open the page owning them.
_Avoid_: Exception, issue, recommendation

**Gap**:
A missing field on an active employment's record that stops or weakens payroll, payment or statutory filing, as the
one readiness rule defines it. Gaps are listed on Operations › Record readiness only.
_Avoid_: Error, exception, incomplete employee

**Loop card**:
A card a loop prepared for one person to act on (for example, confirm a missed clock-out or fill in a missing detail).
The person's own Confirm is the decision; the loop never decides for them. A loop's card is the one place its subject is
shown (passport expiries, for example, appear once, as the passports loop's card).
_Avoid_: Notification, task, automatic action

**Readiness**:
Whether something is complete enough for its next step. Record readiness is an employment's gaps; payroll readiness is
a person's own items before this month's payroll cut-off, on their own page; setup readiness is the go-live stages.
_Avoid_: Using one of the three to mean another, health, compliance score
