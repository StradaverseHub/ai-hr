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

**Pending submission**:
An employee's specific clock or leave request whose accepted or refused outcome has not yet been confirmed.
_Avoid_: Recorded attendance, approved leave

**Reported location uncertainty**: The device provider's estimate of the distance by which a reported
position may differ from the physical position. It describes location quality and does not prove
where the person or device is.

**Geofence containment**: A reported position qualifies for an assigned workplace only when its
distance from the workplace plus its reported uncertainty fits within that workplace's radius.

**Submission abandonment**:
An employee's decision to prevent an unaccepted pending submission from being recorded. An already
accepted request keeps its outcome and follows the normal attendance correction or leave cancellation process.
_Avoid_: Delete attendance, cancel approved leave, erase history
