# 420ebab5 · Personnel detail — which saves can fold into one Save per tab, and which cannot

**Measured 2026-09-07 against `app/admin/personnel/[employmentId]/page.tsx` @ r253/personnel-row.**
This is the deliverable that makes part two safe. Part one (the clickable employee row) shipped on its
own; nothing here changes code.

Why it exists: a tab-wide **Save Changes** implies a tab-wide **Discard Changes**, and Discard is the
dangerous half. A Discard that appeared to cover a recorded salary revision, a terminated CP38
deduction or an archived dependant would be a control lying about what it does — the same fault the
row itself was reported for. So every form on the screen is placed in a bucket **before** any of them
is moved.

---

## What is actually on the screen

Counted by parsing the file with comments stripped (several `<form action={…}>` strings appear inside
explanatory comments and must not be counted twice):

| | count |
|---|---|
| `<form>` tags in `page.tsx` | **35** |
| …of those, bound to a server action | 34 |
| …of those, a `method="get"` navigation form that saves nothing | 1 (line 3809) |
| distinct server actions those 34 forms bind | 35 (five forms are `add`-vs-`edit` ternaries) |
| saves that reach this screen from a component the page hands an action to | **4** (not in the 35) |
| `actions.ts` exports | 39 |

The four island-hosted saves are easy to miss and are listed with the rest below: `setIcAction` and
`setPassportAction` (`components/personnel-identity.tsx`), `setTaxAction`
(`components/identity-tax-card.tsx`), `setBankAction` (`components/bank-info-card.tsx`). The page
builds the action and passes it in; the `<form>` lives in the island. **Part two's per-tab form has to
reach into these four, or four cards on two tabs keep their own Save while their neighbours lose
theirs.**

Three panels bring their own forms entirely and are out of scope for a tab-wide save:
`DocumentsSection` → `documents-manager.tsx`, `ReviewSection` → `review-section.tsx`,
`MovementNewEvent` → `movement-new-event.tsx`.

---

## The rule used to split (a) from (b)

A form is **(b) CHILD-RECORD LIFECYCLE** if any one of these is true:

1. **It writes a dated version, not a value.** The save closes one period and opens another
   (ADR-0001/0003 effective dating), so the previous value still exists and is still shown. "Discard"
   cannot mean "put it back" — there is nothing to put back, only a second correction to record.
2. **It creates, archives or removes a row in a register** the screen lists — dependants,
   qualifications, emergency contacts, delegations, CP38 orders, pay items.
3. **It writes a row into the Employment History ledger.** These surface on the Movement tab as
   events, with a reason and an effective date attached.

Everything else — a value on the person or employment record that is simply overwritten — is
**(a) FIELD EDIT** and can fold under one Save per tab.

Money was *not* used as the test on its own, because it does not separate anything cleanly: Basic
Salary is (b) because it is versioned, while Payment Method and Payroll Policy are (a) even though
both move pay. Pay-affecting (a) fields are marked **¤** below: part two's change-summary must show
old → new for those, and they must never be saved silently.

**(c) NOT A SAVE** is a third bucket the plan did not ask for, and it is needed for exactly one form:
line 3809 is a `method="get"` that submits nothing to a server action. Sweeping it into either save
bucket would give a tab-wide Save a control it cannot honour.

---

## The classification — all 35 forms in `page.tsx`

| line | server action | tab · card | bucket | why |
|---|---|---|---|---|
| 771 | `addEmergencyContactAction` / `editEmergencyContactAction` | Profile · Emergency Contact dialog | **b** | a row in a register; choosing Primary demotes the previous holder, so the write has a side effect on another record |
| 848 | `deleteEmergencyContactAction` | Profile · Emergency Contact table | **b** | removes a record |
| 881 | `setPersonAction` | Profile · Personal Details | **a** | plain fields on the person; overwrite in place |
| 963 | `setComplianceFieldsAction` | Profile · gender / marital status / DOB | **a** | plain fields (audited, but no version and no history row) |
| 1017 | `setContactAddressAction` | Profile · Contact & Address | **a** | plain fields; carries identity through as hidden inputs so one section cannot wipe another |
| 1169 | `setEmploymentComponentAction` | Payroll · Pay Items dialog | **b** | a fixed-transaction row with its own effective dates, prorate override and remarks |
| 1313 | `addCp38Action` / `editCp38Action` | Payroll · CP38 dialog | **b** | a court-ordered deduction record |
| 1449 | `terminateCp38Action` | Payroll · CP38 table | **b** | ends a live deduction — a deliberate act with its own confirmation |
| 1508 | `unfreezeEncashmentAction` | Payroll · Leave Encashment | **b** | releases a frozen encashment; money out |
| 1524 | `adjustEncashmentAction` | Payroll · Leave Encashment | **b** | adjusts a computed encashment; money out |
| 1825 | `addDependentAction` / `editDependentAction` | Family · dialog | **b** | a dependant record; drives child relief and therefore PCB |
| 1936 | `archiveDependentAction` | Family · members table | **b** | archives a record |
| 2044 | `addQualificationAction` / `editQualificationAction` | Qualification · dialog | **b** | a row in the qualification register |
| 2115 | `archiveQualificationAction` | Qualification · table | **b** | archives a record |
| 2146 | `assignPolicyAction` ¤ | Payroll · Payroll Policy | **a** | one `policyId` select, overwritten in place — but it decides Pay Mode and Payment Term, so it must be shown in the change summary |
| 2177 | `setDefaultShiftAction` | Attendance · Shift Arrangement | **b** | appends a **dated period** to the shift-arrangement ladder and refuses back-insertion; the previous shift is still the truth for last month |
| 2248 | `setEmployeeClockingLocationsAction` | Attendance · Clocking Locations | **a** | set-based replace of one multi-select |
| 2290 | `setGeofencingAction` | Attendance · Geofencing | **a** | an on/off plus a radius |
| 2630 | `setCompensationAction` ¤ | Payroll · Basic Salary, Add revision dialog | **b** | **the plan's own example.** Records an effective-dated salary revision; a tab-wide Discard appearing to cover it is the exact failure this document exists to prevent |
| 2762 | `setPaymentMethodAction` ¤ | Payroll · Basic Salary card | **a** | one enum field on the employment |
| 2797 | `setStatutoryAction` ¤ | Bank & Statutory · Statutory (Malaysia) | **a** | full-row overwrite of the statutory columns |
| 3009 | `setOthersStatutoryAction` ¤ | Bank & Statutory · Others Statutory | **a** | one tri-state select (HRDF) |
| 3060 | `setTp3Action` ¤ | Payroll · TP3 opening balances | **a** | four numeric columns, partial update |
| 3292 | `reverseMovementEventAction` | Movement · history row | **b** | rolls back a recorded event; it *is* the undo, and cannot itself be undone by a Discard |
| 3749 | `changeEmploymentCompanyAction` | Job · Employment Information (company change, phase 2) | **b** | an audited company transfer with a pre-transaction gate; refused once a payroll transaction lands |
| 3809 | *(none — `method="get"`)* | Job · company change, phase 1 | **c** | a navigation form: it re-renders the page with `?companyChange=…`. Saves nothing, so it belongs to no Save button |
| 3934 | `setEmploymentInfoAction` | Job · Employment Dates | **a** | probation / notice periods and lifecycle dates, overwritten in place. **Absent field ≠ blank field** here — an absent field means "leave as-is", so a consolidated form must not start posting the org columns it deliberately no longer carries |
| 4162 | `setDirectSuperiorAction` | Job · Direct Superior | **b** | writes a bitemporal reporting line **tagged as a movement**, so it produces a Reporting Line Change row in Employment History |
| 4230 | `endDelegationAction` | Job · Delegations | **b** | ends a windowed record |
| 4244 | `addDelegationAction` | Job · Delegations | **b** | creates a windowed record |
| 4279 | `setEmploymentHolidayCalendarAction` | Attendance · Holiday Calendar | **a** | one selection on the employment (audited, not versioned) |
| 4321 | `setLocationAction` (branch suggestion) | Attendance · Work Location | **b** | **has no editable field at all** — a Confirm button on a pre-computed suggestion — and it calls `createMovementEvent(kind: 'transfer')` |
| 4359 | `setLocationAction` (manual pick) | Attendance · Work Location | **b** | same writer: a dated transfer event plus a provenance stamp. It moves payroll and OT history, which is why nothing here auto-commits today |
| 4591 | `setPersonPhotoAction` | **page header — outside every tab** | **b** | a file upload behind its own Edit menu, with a replace confirmation |
| 4617 | `removePersonPhotoAction` | **page header — outside every tab** | **b** | destructive, already confirmed |

### The four saves hosted in components (not among the 35)

| where | server action | tab · card | bucket | why |
|---|---|---|---|---|
| `components/personnel-identity.tsx:156` | `setIcAction` | Profile · Identity (NRIC) | **a** | plain identity fields |
| `components/personnel-identity.tsx:187` | `setPassportAction` | Profile · Passport | **a** | plain passport fields |
| `components/identity-tax-card.tsx:146` | `setTaxAction` ¤ | Bank & Statutory · Income Tax (PCB), nested in the statutory card | **a** | partial save of the tax columns |
| `components/bank-info-card.tsx:66` | `setBankAction` ¤ | Bank & Statutory · Bank Information | **a** | partial save of the bank + custom-holder columns |

### Panels that bring their own forms

`documents-manager.tsx` (upload / edit metadata / replace / delete a document) and
`review-section.tsx` (set review end date, start review, upload letter, save letter) are all **(b)**:
each is a document or a probation-review record with its own act. `movement-new-event.tsx`
(`createMovementEventAction` / `editMovementEventAction`) is **(b)** by definition — it is the module
that records dated events.

---

## What this means for part two

**Totals: 16 in bucket (a) — 12 in `page.tsx` plus the 4 island-hosted ones — 22 in bucket (b), 1 in
bucket (c).**

### Which tabs actually get a consolidated Save

| tab | (a) forms — fold under one Save | (b) forms — keep their own buttons |
|---|---|---|
| Profile | **5** — `setPerson`, `setComplianceFields`, `setContactAddress`, `setIc`, `setPassport` | 2 (emergency contacts) |
| Bank & Statutory | **4** — `setBank`, `setStatutory`, `setTax`, `setOthersStatutory` | 0 |
| Attendance | **3** — `setEmploymentHolidayCalendar`, `setEmployeeClockingLocations`, `setGeofencing` | 3 (work location ×2, shift arrangement) |
| Payroll | **3** — `setPaymentMethod`, `assignPolicy`, `setTp3` | 6 (salary revision, pay items, CP38 ×2, encashment ×2) |
| Job (Employment) | **1** — `setEmploymentInfo` | 4 (company change, direct superior, delegations ×2) |
| Family | **0** | 2 |
| Qualification | **0** | 2 |
| Movement · Documents · Others | **0** | all |
| Leave | **0** | 0 — the tab has no writable form at all |

Four findings follow from that table, and they should be settled before any code is written:

1. **Profile and Bank & Statutory are the whole prize.** Nine of the sixteen (a) forms are on those
   two tabs, and Bank & Statutory has no (b) forms at all — so its consolidated Save covers the whole
   tab with nothing left over. **Profile is the right pattern tab** (the plan already says so) and
   Bank & Statutory should be second.

2. **Family and Qualification cannot be consolidated at all.** The original request names Family as
   one of the tabs to consolidate; every form on it is a dependant record. Adding a tab-wide "Save
   Changes" there would be a button with nothing to save. This needs saying back to the reporter
   rather than silently skipping.

3. **Payroll is where a tab-wide Save is most likely to lie.** Three (a) fields sit among seven (b)
   cards including the salary revision. A single "Save Changes" / "Discard Changes" pair at the top or
   bottom of that tab reads as covering the whole tab. Either the pair must be scoped and labelled to
   the cards it owns, or Payroll should keep its per-card saves. Recommend the latter until Profile
   has proved the pattern.

4. **The photo controls are outside every tab.** They sit in the page header, above the tab strip, so
   a per-tab Save/Discard can never reach them — and must not appear to. Leave them exactly as they
   are.

### Constraints the consolidated save must respect

- **It is not one blanket write.** Effective dating means a save closes and inserts a version rather
  than updating in place, so the consolidated Save must still call each section's own service, in
  order — `setPerson`, then `setContactAddress`, then `setIc` … — and surface a per-section failure
  rather than a single all-or-nothing error.
- **Absent ≠ blank.** `setEmploymentInfoAction` reads an absent field as "leave as-is" and a
  present-but-empty field as "clear to NULL". A client-side form that posts every field it knows about
  would silently clear the eight org columns that deliberately left that form. The same trap sits in
  `setPersonAction` / `setContactAddressAction`, which carry identity through as hidden inputs so one
  card's save cannot wipe another's.
- **A disabled control posts nothing.** If "Save Changes" is disabled until something is dirty, the
  dirty-tracking and the submitted payload must be pinned together across both files — a unit test of
  either half passes throughout.
- **The bucket must be pinned by a test, not by this document.** A later change that moves a
  money-affecting action from (b) into (a) is exactly the regression that makes Discard lie, and it
  would be invisible in review. Part two should carry a guard that asserts each of the 22 (b) forms
  still stands on its own, with its own submit button.

---

## What was actually built, and where it stopped (r254 · r255)

**r254** shipped the Profile tab: five (a) cards under one Save, the change summary, Discard, and the
prompt on every way off the screen. **r255** shipped the other three tabs the table above says can be
consolidated honestly — Bank & Statutory (4), Attendance (3) and Employment (1) — and left Payroll,
Family and Qualification alone, deliberately. Twelve of the sixteen (a) forms are now under a tab Save.

**Finding 1 held, and measuring it turned up a live money defect that r255 fixed.** Bank & Statutory was
NOT the mechanical repeat of Profile it looks like. The Statutory (Malaysia) form carries **no residency
control at all**, and its writer nonetheless read one — `formData.get('isResident') === 'on'` — so it
sent `isResident: false` on **every** save, a lone one included. The Income Tax (PCB) card's setter
re-derives that same column from the `taxResidency` the admin picks, which is why per-card buttons
usually papered over it: whoever saved the tax card next put the column back.

**An earlier draft of this section called that residual inert. It was wrong, and this is the correction.**
`taxResidency` is preferred only for computing `flatTaxRate`; `is_resident` is passed to the payroll
kernel *separately* (`core/payroll.ts` → `resident`), and it decides the outcome precisely when
`taxResidency` is `'resident'` and `flatTaxRate` is therefore null — `localization/my/payroll.ts` reads
`flatTaxRate != null ? flatTaxRate : resident === false ? 0.3 : null`, and
`localization/my/multicycle-worksheet.ts` (the sign-off worksheet) carries the identical pair. Measured
against the kernel: RM8,000/month with `{resident: true, flatTaxRate: null}` gives PCB **514.20**; the
same input with `{resident: false}` gives **2,400.00**, byte-identical to the explicit non-resident flat
path. So an admin who edited only the EPF number, on an employee whose tax residency still said
`resident`, moved them onto flat 30% PCB with no reliefs.

**The fix is in the writer, not in the ordering.** `applyStatutorySection` now derives the flag from the
STORED `tax_residency` (the same rule `setTaxProfileMY` syncs it with) instead of reading a control that
does not exist, so a lone statutory save leaves the residency alone and a row an earlier save had already
knocked out of step self-heals on the next one. `BANK_STATUTORY_TAB_SECTION_ORDER` stays declared and
stays pinned by `test/personnel-tab-save-tabs.test.ts` §1 — the statutory writer is still a full-row
overwrite whose pass-throughs read the row at the moment it runs, so a fixed order is what keeps the
outcome independent of DOM order — but the order is no longer the only thing standing between an
EPF-number edit and the wrong tax basis. §1 now also pins the lone-save case directly.

**Finding 4 generalised: the fence is the MARKER, not the subtree.** The Employment tab has a bucket (b)
form — the audited company transfer — rendered INSIDE the same card as the (a) Employment Dates form,
so "bucket (b) is rendered outside the scope" stopped being the whole safety argument. Nothing reads,
marks, packs or resets anything but a `[data-save-section]` subtree, which is what actually holds; the
r254 guard that asked "is this form inside the scope?" was corrected to ask "does it carry the marker?",
because under the old test a company transfer threw the reader's unsaved dates away with no prompt.

**Attendance cost a reordering, and it is the one visible change this round makes to a tab.** Its three
(a) cards were not contiguous — Work Location and Shift Arrangement (both (b)) sat between Holiday
Calendar and Clocking & Geofencing. A tab-wide Save must enclose a contiguous run, so the two (b) cards
moved OUT of it. They moved **below** the scope, and the tab now reads Holiday Calendar → Clocking &
Geofencing → Work Location → Shift Arrangement.

The first attempt moved them *above* instead, which put the Save/Discard pair at the foot of the tab but
pushed Holiday Calendar down to third and so reversed item 52a30630's "Holiday Calendar pinned first" —
a reporter-specified decision, reversed as a side effect of a save-button change, with no guard to catch
it. The pinned reading order wins.
`test/personnel-holiday-grade-relocation.test.ts` (5) now asserts that this tab still opens with the
Holiday Calendar card, so the next round cannot repeat the swap silently.

**Which forces the general rule: the Save bar names the cards it owns.** Only Bank & Statutory has a
scope covering its whole tab. On Profile, Attendance and Employment the contiguous (a) run has to lead
the tab, so the sticky bar renders above cards it does **not** cover — the emergency-contact register,
Work Location and Shift Arrangement, the Direct Superior line and the delegations. A bar reading only
"Save Changes" there is a control that appears to do something it does not: edit the Direct Superior,
press the Save above it, and it answers "No unsaved changes". `TabSaveScope` therefore takes a required
`covers` prop and prints those card names on the bar ("This Save covers: …"), which is also what makes it
safe for a scope not to be last on its tab. Requiring the prop means a new consolidated tab cannot be
wired up without answering the question.

**Finding 3 stands: Payroll still keeps its per-card saves,** and the reason is now sharper than
"until Profile has proved the pattern". Its three (a) forms are not contiguous either — Payment Method
is rendered INSIDE the Basic Salary card, Payroll Policy is second, and TP3 is sixth, with Pay Items,
CP38 and Leave Encashment between them. Consolidating the tab therefore means BOTH a reordering that
drags TP3 up past three money-affecting registers AND a Save/Discard pair sitting under the card whose
own headline control records an effective-dated salary revision. The marker fence would keep Discard
away from that revision, but the CONTROL WOULD STILL READ as covering it, which is the fault this
document exists to prevent. That trade is the reporter's to make, not a builder's.

**Payroll is therefore still saved card by card, and the reporter should be told that in those words** —
the board plan said every plain field card would lose its button, and on Payroll three have not: Payment
Method (inside the Basic Salary card), Payroll Policy and TP3. The `covers` label added at the end of
r255 removes half the objection (a bar can now name the three cards it owns instead of implying it owns
the tab), but not the other half: the cards are still not contiguous, so consolidating still requires
moving TP3 up past Pay Items, CP38 and Leave Encashment. If the reporter wants it, the shape is:
compensation → policy → TP3 → pay items → CP38 → encashment → zakat, with the scope on the first three
and the bar naming them.

**Findings 2 is unchanged and is owed to the reporter in words: Family and Qualification cannot be
consolidated at all.** Every form on both is a child record — a dependant, a qualification — so a
tab-wide "Save Changes" there would have nothing to save and a tab-wide "Discard Changes" would cover
nothing. The original request names Family explicitly; the honest answer is that those two tabs already
work the way the rest of the screen is being moved towards, one deliberate act at a time.

---

## r256 — Payroll consolidated, and the two things measuring it turned up

**Every tab that CAN be consolidated now is.** r256 took the last one: Payroll's three field edits —
`setPaymentMethod`, `assignPolicy`, `setTp3` — are under one Save, so all sixteen bucket (a) forms are
now under a tab Save and no bucket (a) form on the screen still carries its own button. The remaining
buttons on the screen are all bucket (b) or bucket (c).

**Finding 3 was answered, not waived.** It refused Payroll on two grounds, and each was handled on its
own terms rather than argued away:

1. *"A Save/Discard pair would read as covering a recorded salary revision."* Two separate mechanisms
   answer this, and both were already in the code before r256 wanted them. The MECHANICAL half is r255's
   correction that the fence is the MARKER and not the subtree: `setCompensationAction`'s dialog carries
   no `data-save-section`, so nothing reads, marks, packs or resets it even though it shares a card with
   Payment Method. That is the Employment tab's shape exactly — the audited company transfer sits inside
   the Employment Dates card — so the nesting stopped being disqualifying the moment that landed. The
   HONESTY half is `covers`: the bar prints "How This Employee Is Paid", the heading the reader sees
   above the control, and never "Basic Salary". Naming the card would have been the fault this document
   exists to prevent; naming the sub-section is not.
2. *"Consolidating still requires moving TP3 up past Pay Items, CP38 and Leave Encashment."* ACCEPTED,
   and it is the one visible change r256 makes to a tab. The order is now compensation → policy → TP3 →
   pay items → CP38 → encashment → zakat, which is the shape this document itself named. **It reverses
   nothing anyone decided**: feedback 326f0b5e pinned compensation FIRST (still first) and R46 79eb7151
   pinned the policy card SECOND (still second); TP3's sixth slot came from item a6a47698 simply
   appending it when it relocated the card here, and no guard held it. That is not an assumption — the
   pre-existing guard was re-run against the reverted order and its 326f0b5e cases passed while only the
   new r256 cases failed. `test/personnel-payroll-tab-order.test.ts` now pins the new run, with the
   original case kept and its docblock updated rather than replaced.

### The defect the round found, which no test would have

**A bar can lie by claiming MORE than it owns, and two of them did.** `covers` was added so a bar could
not silently own LESS than the tab it sits on. The mirror fault went unnoticed: `clockingCard` and
`payrollPolicyCard` are both gated `admin && !emp.terminatedOn`, so on a **terminated employment** they
render as nothing at all — while the bar went on printing "Clocking locations & geofencing" and
"Payroll policy". Measured on a terminated employee, the Attendance bar named two cards with one on the
screen; Payroll would have shipped naming three with two.

**Attendance shipped that way in r255.** It is fixed here too, because it is the same one-line mechanism
and leaving it would mean knowingly shipping a control that names a card the reader cannot find.

**It was found by rendering the screen, not by a test**, which is the point worth recording: the source
guards all passed, tsc passed, the suite passed, and the page returned 200. What exposed it was reading
the rendered `data-tab-save-covers` text against the `data-save-section` markers actually present, for a
terminated employment and an active one. `whenLive()` drops a name the reader cannot see;
`test/personnel-tab-save-tabs.test.ts` §6 pins it AND enumerates the conditionally-rendered cards inside
a scope, so a third one cannot be added without answering the question.

Payment Method keeps its name on a terminated employment: that card IS rendered, with its select
disabled, so naming it describes something the reader can actually see.

### Where the item now stands

| tab | consolidated? |
|---|---|
| Profile · Bank & Statutory · Attendance · Employment · **Payroll** | yes — every bucket (a) form on the screen |
| Family · Qualification | **no, and not "not yet"** — see below |
| Movement · Documents · Others · Leave | nothing to consolidate (no bucket (a) form) |

**The item cannot be closed as literally written, and this is the sentence the reporter is owed.** The
original request lists Family among the tabs that should get one Save button. Family and Qualification
cannot have one. Every form on both tabs is a child record — adding a family member, archiving a
qualification — so a tab-wide "Save Changes" there would be a button with nothing to save, and a
tab-wide "Discard Changes" would be a button that covers nothing. This is not a limit of the current
build that a later round could lift; it is what those two tabs are. Everything else the request asked
for is built.
