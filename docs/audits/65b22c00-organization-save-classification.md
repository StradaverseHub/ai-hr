# 65b22c00 · Organization → one company — which saves can fold into one Save, and which cannot

**Measured 2026-09-22 against `components/company-panel.tsx` + `components/company-logo.tsx` @ r329,
which is `main` after r327 (efe424b0) landed the divided statutory list.** This is the deliverable the
approved plan promised the reporter *before* any form moves; nothing here changes code.

Why it exists, in the words of the audit it is modelled on
(`docs/audits/420ebab5-personnel-save-classification.md`):

> a tab-wide **Save Changes** implies a tab-wide **Discard Changes**, and Discard is the dangerous
> half. A Discard that appeared to cover a recorded salary revision, a terminated CP38 deduction or an
> archived dependant would be a control lying about what it does.

On Organization the equivalents are **deleting a company**, **archiving one**, **removing a bank
account** and **clearing a statutory body's payment configuration**. A Discard beside a Save that
appeared to undo any of those would be the same fault. So every form is placed in a bucket before any
of them is moved.

This screen has a **second** question the personnel screen never had, because personnel saves already
returned to the employee. Every Organization save today returns to the company **LIST**. So each row
below carries two verdicts: which bucket it is in, and **where its save should leave the reader**.

---

## What is actually on the screen

Counted by parsing the source with comments stripped (`scripts`-free; the parser strips `//`, `/* */`
and JSX `{/* */}` while preserving string literals):

| | count |
|---|---|
| `<form>` tags in `components/company-panel.tsx` | **11** |
| `<form>` tags in `components/company-logo.tsx` (the logo island the panel hands two actions to) | **2** |
| total `<form>` tags | **13** |
| distinct server actions they bind | **12** (`archiveCompany` is bound twice — archive and unarchive) |
| action references on the `CompanyPanel` `actions` prop | 12 |
| `data-save-section` attributes anywhere in either file | **0** — neither file has ever been converted |

### The double-count trap, and where it actually is

The approved plan warns that `company-panel.tsx` "carries `<form action={…}>` strings inside
explanatory comments which must not be double-counted". **Measured: it does not.** Stripping comments
from `company-panel.tsx` changes its count not at all — 11 either way. The trap is real but it is in
the *other* file: `components/company-logo.tsx` line 17 says, in prose, "The same
`<form action={setAction}>` posts the same `companyId` + `logo` file field…", so a naive `grep -c
'<form'` reports **3** forms there against an actual **2**. Counting the two files together, an
unstripped grep gives 14 bindings and the plan's own figure of 13 is the stripped one. The plan's
warning pointed at the wrong file; its number was right.

### Thirteen bindings is not thirteen buttons

Two of the thirteen are rendered more than once, so the reader of a configured Malaysian company sees
far more than thirteen submit controls:

- `BankAccountForm` is rendered **once per saved bank account plus one blank "add" form** — three
  Save-bank-profile buttons on a company with two accounts, each with its own Remove beside it.
- `StatutoryAuthorityCard` is rendered **once per entry in `STATUTORY_AUTHORITIES`**, which is **8**
  today (EPF, SOCSO, EIS, LHDN, HRD Corp, Zakat, PTPTN, Tabung Haji) — 8 Save-authority buttons and up
  to 8 Clear links, all mounted, collapsed with CSS rather than unmounted.

So a company with two bank accounts and every body configured carries roughly **28 submit controls**,
not 13. That is worth stating because it sharpens the reporter's complaint rather than softening it —
and because it is also the reason bucket (b) below is so much bigger than bucket (a).

---

## The rule used to split (a) from (b)

Carried over unchanged from the personnel audit, restated for a company instead of a person. A form is
**(b) RECORD LIFECYCLE** if any one of these is true:

1. **It creates, archives, deletes or removes a row in a register the screen lists** — a bank account,
   a statutory body's payment configuration, the company logo, the company itself.
2. **It is an ACT with its own confirmation rather than a value the reader typed.** Delete asks first
   (`ConfirmSubmit`); Archive changes a lifecycle state and is offered as Archive *or* Unarchive
   depending on that state.
3. **It writes a timestamp or a file rather than a field** — `archived_at`, an uploaded image.

Everything else — a column on the `company` row (or on the company's flat statutory-identity row) that
is simply overwritten, and that a Discard could put straight back — is **(a) FIELD EDIT** and can fold
under one Save.

**Audit is not the test, and this is where the personnel audit's own wording has to be honoured rather
than reached for.** Almost every write on this screen appends an event (`company.updated`,
`company.parent.changed`, `company-bank-profile.removed`, …). The personnel audit filed
`setComplianceFieldsAction` and `setEmploymentHolidayCalendarAction` in bucket (a) with the note
"audited, but no version and no history row" — so an append-only audit event does not make a write
bucket (b). What does is a **row in a register**, a **dated version**, or an **act**.

**There is no bucket (c) on this screen.** The personnel audit needed one for a `method="get"`
navigation form. Every form here binds a server action.

---

## The classification — all 13 bindings

`line` is the `<form>` tag in the file named. **Where it should land** is the second verdict, and is
the half this item was actually raised for.

| # | line | server action | tab · card | bucket | where the save should land | why |
|---|---|---|---|---|---|---|
| 1 | panel 928 | `updateCompany` | General · Company Information + Contact Information | **a** | **stay on this company** | ~20 plain columns on the `company` row, overwritten in place (`updateCompany` → one `.set()` + a `company.updated` event). This is the form the reporter was on when they raised the ticket |
| 2 | panel 1043 | `updateCompanyDefaultCycle` | General · Default Payroll Cycle | **a** | **stay on this company** | one column, `company.default_payroll_cycle`, validated against the company's active cycle catalogue. Already the only save on the screen with a toast — and it still returns to the list |
| 3 | panel 1086 | `setParent` | General · Group Parent | **a** | **stay on this company** | **the plan asked for this to be argued either way; it is (a).** It overwrites ONE column (`company.parent_company_id`) from a plain `<select>` and appends `company.parent.changed`. Nothing bitemporal, no register row, no dated period — a Discard puts the previous parent straight back. The personnel screen's superficially similar Direct Superior is (b), and the difference is exactly the thing being tested: that one writes a bitemporal reporting line *tagged as a movement* and produces a row in Employment History. This writes a column. **The counter-argument, recorded because it is not frivolous:** re-parenting moves a company inside the group tree, which is read all over the product, so it feels heavier than a field. It is still a field. Weight of consequence is not the test — if it were, Payment Method (which moves how people are paid) would be (b) on personnel, and it is not |
| 4 | panel 1230 | `setStatutory` | **Statutory** · Company Registrations (SSM + MyInvois) | **a** | **stay on this company** | two columns of `company_statutory_my`, written through a partial patch (`localization/my/company-statutory.ts` — `if (p[f] !== undefined)`), so it cannot blank a column its form does not carry. A field edit by every test |
| 5 | panel 1108 | `archiveCompany` (unarchive) | General · lifecycle row | **b** | **stay — but only when pressed HERE** (see finding 3) | clears `archived_at`. A lifecycle act, offered only when the company is archived |
| 6 | panel 1116 | `archiveCompany` (archive) | General · lifecycle row | **b** | **stay — but only when pressed HERE** (see finding 3) | sets `archived_at = now()`. Withdraws the company from every picker in the product |
| 7 | panel 1124 | `deleteCompany` | General · lifecycle row | **b** | **the LIST, and it must be** (see finding 2) | `tx.delete(company)`, refused with `InUseError` if any department, employment or subsidiary references it. Already behind `ConfirmSubmit`. The record the detail screen renders will not exist after it |
| 8 | panel 312 (×N+1) | `setBankProfile` | Bank Account · each saved account, plus the blank add form | **b** | **stay on this company** | insert-or-update of a `company_bank_profile` **row**; ticking Primary demotes whichever other row held it — a side effect on a second record, the same reason the personnel Emergency Contact dialog is (b) |
| 9 | panel 1180 (×N) | `removeBankProfile` | Bank Account · under each saved account | **b** | **stay on this company** | `tx.delete(companyBankProfile)` |
| 10 | panel 607 (×8) | `setStatutoryAuthority` | Statutory · each body's editor | **b** | **stay on this company** | `insert … onConflictDoUpdate` — it CREATES the body's `company_statutory_authority` row on first save, which is what "Not configured" → "Configured" on the card face means. It also validates that the chosen bank account belongs to this company and that a newly-named signatory is an active employee of it. Its filing-number half is a partial patch into `company_statutory_my`, i.e. one (a)-shaped field riding inside a (b) act — see finding 4 |
| 11 | panel 761 (×≤8) | `removeStatutoryAuthority` | Statutory · "Clear" under each configured body | **b** | **stay on this company** | `tx.delete(companyStatutoryAuthority)` |
| 12 | logo 133 | `setCompanyLogo` | General · logo card (inside `CompanyLogoEdit`, a client island in its own file) | **b** | **stay on this company** | a file upload: sniffed, size-capped, inserted as a `company_logo` row. It is also the one control on the screen that already has an unsaved-preview state of its own, which a tab-wide Discard would have to reason about and cannot |
| 13 | logo 148 | `removeCompanyLogo` | General · logo card | **b** | **stay on this company** | `tx.delete(companyLogo)` |

**Totals: 4 in bucket (a), 9 in bucket (b), 0 in bucket (c).**

The plan proposed exactly these four for (a) — `updateCompany`, `setStatutory`,
`updateCompanyDefaultCycle`, "probably" `setParent` — and exactly those nine for (b). **The
classification confirms the plan's buckets.** What it does not confirm is that those four can sit under
*one* Save, which is finding 1.

---

## What this means for the build

### Finding 1 — the four (a) forms are NOT on one tab, so "one Save for the whole screen" cannot be built as written

> **SETTLED BY 15e5bd93 (r352), and the record below is kept as the reasoning that led there.** This
> finding's two refusals both still hold: `TabSaveScope` still cannot span two tab panes, and the
> Company Registrations card still must not move off the Statutory tab. What it could not foresee is the
> third answer — the reporter's approved statutory redesign put the eight bodies in one permanent rail
> with one workspace and took the Save button off every body editor, so a scope on the Statutory tab now
> owns every card under its bar instead of claiming eight it did not. The Statutory tab therefore has a
> consolidated Save of its own (`lib/company-statutory-tab-sections.ts`), the registrations card is in
> it, and it did not move. The "one-card scope would be worse than none" paragraph below was correct
> about a one-card scope; it is simply no longer the choice on offer.

The panel is three tabs: **General | Bank Account | Statutory**. The (a) forms sit like this:

| tab | (a) forms | (b) forms |
|---|---|---|
| General | **3** — `updateCompany`, `updateCompanyDefaultCycle`, `setParent` | 4 — archive ×2 / delete, logo set/remove |
| Bank Account | **0** | 3 — `setBankProfile` (×N+1), `removeBankProfile` (×N) |
| Statutory | **1** — `setStatutory` | 2 — `setStatutoryAuthority` (×8), `removeStatutoryAuthority` (×≤8) |

`TabSaveScope` encloses a **contiguous run of cards**, reads/marks/packs/resets only
`[data-save-section]` subtrees inside itself, and renders ONE sticky bar. It cannot span two tab panes:
the panes are siblings, only one is visible at a time, and a bar inside the hidden Statutory pane is a
bar nobody can press. So the plan's sentence to the reporter — "company details, contact details,
**statutory reference numbers** and the default payroll cycle" under one button — is **not achievable
without moving the Company Registrations card off the Statutory tab**, and moving it is refused below.

**Recommendation, and what the reporter is owed in words:** the General tab gets the one Save
(`updateCompany` + `updateCompanyDefaultCycle` + `setParent` — 3 of 4, and the three the reporter was
actually looking at when they raised it). The Company Registrations card keeps its own button, with the
reason stated rather than skipped, exactly as the personnel audit's Finding 2 owed the reporter Family
and Qualification.

**Why Company Registrations is not simply moved to General.** It holds the SSM registration number and
the MyInvois TIN, and r226 deliberately left them on the Statutory tab when it moved EPF's, SOCSO's and
LHDN's filing numbers onto their bodies' cards — because neither is a body an employer pays, and the
SSM number is read by two statutory files we produce (`localization/my/borang-8a.ts:145`,
`localization/my/socso-eis-file.ts:140`). `test/company-panel-bank-statutory-layout.test.ts` pins that
placement ("keeps SSM and MyInvois on the Statutory tab, where the two files that read SSM expect
them"). Moving it to win a tidier Save button would reverse a pinned decision as a side effect of a
save-button change — which is precisely the fault r255 recorded when it moved Holiday Calendar off the
top of the Attendance tab.

**And a scope of ONE card would be worse than no scope.** A `TabSaveScope` around Company Registrations
alone would put a sticky Save/Discard bar above **eight statutory-body editors it does not own**, every
one of them mounted. `covers` would name one card against eight visible ones. That is the
bar-that-claims-more-than-it-owns fault r256 found by rendering the screen, and it would be shipped
knowingly rather than missed.

### Finding 2 — `deleteCompany` is the one save that must NOT stay, and nothing on the screen says so

Everything else on this screen can return to `/admin/organization/<companyId>`. Delete cannot: the row
the page reads is gone, `listCompanies` will not contain it, and the page's own scope guard calls
`notFound()` on a `companyId` that is not in the administrable set. A delete that "stayed" would hand
the reader a 404 for a company they just deleted. It returns to the list, and that is not a gap in the
item — it is the correct destination.

### Finding 3 — `archiveCompanyAction` is shared with the company LIST, and a naive repoint breaks that screen

`app/admin/organization/page.tsx` renders `components/company-rows.tsx` with
`archiveAction={archiveCompanyAction}` — the listing's own Archive / Unarchive button posts to the
**same action** as the panel's. Repointing that action at `/admin/organization/<companyId>` would mean
archiving a row from the LIST now throws the reader into that company's detail page, which nobody asked
for and which is a regression on a screen this item does not touch.

The destination therefore has to come from the FORM, not from the action. A **closed-list** marker
(a hidden field whose only recognised value selects the detail path; anything else, including absent,
means the list) is the shape — never an echoed path, which would be an open redirect. This is the same
posture `app/admin/actions.ts` already records for `SCHEDULE_TAB`.

### Finding 4 — one (a)-shaped field rides inside a (b) act, and it stays there

`setCompanyStatutoryAuthority` writes two tables with one button: the body's payment setup
(`company_statutory_authority`, bucket (b)) **and** its filing number (`company_statutory_my`, which is
the same table and the same partial-patch writer as binding #4, i.e. (a)-shaped). r226 put them on one
card deliberately — "it is one body, so it saves with the one button".

That does not promote the card to (a): the row creation and the "Clear" delete are still what the
control does, and the filing box is one field inside a fourteen-field editor that is collapsed on
arrival. **It stays whole, in (b), and the consolidated Save must not reach into it.** Recording it
matters because "the EPF number is just a field, fold it in" is the obvious next edit and it would drag
a row-creating upsert under a Discard.

### Finding 5 — staying on the screen is not enough on its own: the TAB has to survive too

The panel's tab is client `useState`, not a URL parameter. A server action that `redirect()`s back to
`/admin/organization/<companyId>` re-initialises the panel to **General** — so an administrator who
saves a statutory body would stop being thrown to the list and start being thrown to the wrong tab.
That is a smaller fault than the reported one but it is the same fault.

The personnel screen already hit this and recorded it as feedback **bd2f0bb2**: `ClientTabs`
(`components/personnel-tabs.tsx`) reflects the active tab into the URL with `replaceState` on every
switch, and a capture-phase `submit` listener injects the current tab as a hidden field into whichever
form is submitting, so each action can append `&tab=<key>` to its redirect. The same two moves are what
"keep the Organization edit screen open after save" actually requires. `ToastFromQuery` strips only
`toast` and `error` from the query and `router.replace`s the rest, so a `?tab=` rides through the toast
cleanly.

### Finding 6 — four tests render `CompanyPanel` for real, and a client island inside it reaches them

`CompanyPanel` is itself `'use client'`, and four suites call `renderToStaticMarkup` on it:
`test/company-panel-no-disclosure-render.test.ts` (r327's six-locale render guard),
`test/organization-list-detail.test.ts`, `test/r298-payroll-sections-gate.test.ts`,
`test/hrdf-contribution-rate.test.ts`. `TabSaveScope` calls `useRouter()` from `next/navigation`, which
**throws** outside an App Router context. Any of those suites that renders a subtree containing the
scope needs `next/navigation` mocked — a change to the harness, not to an assertion. **No assertion may
be weakened to accommodate it**, and r327's two guards in particular are updated with the reason or not
at all.

### Finding 7 — `children` identity means something different inside a client component, and the difference is narrow but real

`TabSaveScope` treats a new `children` **identity** as proof that `router.refresh()`'s payload has
landed, because on the personnel page (a server component) only a replaced RSC tree can change it.
Inside `CompanyPanel` — a client component — `children` is a fresh element on every `CompanyPanel`
render, and `CompanyPanel` re-renders whenever its `tab` state moves. So a tab switch is
indistinguishable from a refreshed payload, and it clears `staleUntilRefreshRef` early.

**What that costs, precisely:** the r257 window (save committed, refresh not yet back, Discard pressed)
stops being detected if the reader switches tabs inside it. To reach it they must save on General,
switch to another tab, switch back and press Discard, all before one RSC round trip returns — the
scope's own bound for that wait is 5 seconds and two tab clicks are inside it. It is narrow, it is not
zero, and it is recorded here rather than discovered later. It is a property of hosting the scope
inside a client tab shell, not a defect introduced by this item's code; closing it properly means
giving the scope an explicit "payload landed" signal instead of inferring one from `children`, which is
a change to a component four other tabs depend on and is not this item's to make.

---

## The shape this document authorises

1. **Every save on the company detail screen returns to that company**, with a localised toast and the
   tab it was made on — except `deleteCompany`, which returns to the list because the record is gone,
   and `archiveCompany` pressed from the LISTING, which stays on the listing.
2. **The General tab's three (a) forms fold under one `TabSaveScope`**, with the bar naming the three
   cards it owns. The logo card above it and the archive/delete row below it keep their own controls
   and are outside the scope.
3. **`setStatutory` keeps its own button**, and the reporter is told so in words, with the reason from
   finding 1.
4. **Nothing in bucket (b) is moved**, and the guard for this classification asserts that — every one
   of the nine still stands on its own with its own submit control, and no `data-save-section` marker
   ever appears on one of them.

---

## r329 — what was actually built, and the two things measuring it corrected

**Both halves shipped, and the shape is exactly the one authorised above.** Nothing in bucket (b) moved.

| promise | where it lives | guarded by |
|---|---|---|
| a save keeps you on the company | `app/admin/_redirects.ts` `okCompany` / `failCompany`, called by eleven of the twelve company actions | `test/organization-stay-on-save.test.ts` §1 — every action RUN, its redirect parsed |
| …and on the tab you saved from | `components/company-panel.tsx` (`replaceState` + a capture-phase submit listener) + `lib/company-panel-tabs.ts` | §2 |
| delete still goes to the list | `deleteCompanyAction` | §4 |
| archiving a LIST row still stays on the list | the closed-list `returnTo` marker | §3 |
| one Save for the General tab's three field edits | `TabSaveScope` + `saveCompanyGeneralTabAction` + `lib/company-tab-sections.ts` | `test/organization-general-tab-save.test.ts` §1–§2 |
| every bucket (b) control still stands on its own | the marker set, read off the RENDERED panel | §3 |

### The correction owed to the reporter, in the words it should be said in

**The statutory reference numbers did NOT come under the one Save, and the board plan said they would.**
The SSM registration number and the MyInvois TIN are on the Statutory tab; the other three field-edit
cards are on General; and one Save button can only cover cards that sit together on one tab. Moving that
card to General would have taken those two numbers off the screen r226 deliberately put them on — the
same screen two statutory files we produce read the SSM number from — to win a tidier button. So the
Company Registrations card keeps its own Save, and the General tab's Save honestly names the four
headings it does cover. This is the same answer, for the same reason, that the Employment Information
screen's Family and Qualification tabs got in r255: not "not yet", but "this is what that card is".

### The defect the marker guard found while it was being written, which is the reason it is written this way

**The first version of the "exactly three sections are marked" case passed while a bucket (b) form
carried a marker.** It rendered a company with no bank accounts and no configured statutory bodies, so
the bank-remove and authority-clear forms were not in the markup it measured at all. Adding
`data-save-section="bank"` to the bank-remove form — the precise regression the case exists to catch —
did not fail it. The fixture now renders a company with one of each, and the same mutation fails with
`expected [ Array(4) ] to deeply equal [ 'company', 'cycle', 'parent' ]`.

It is worth recording because the personnel audit's closing constraint asks for exactly this guard, and
a guard that cannot see half the screen satisfies the letter of it while protecting nothing.

### Finding 7 stands, unfixed, and this is what it costs in the shipped code

`TabSaveScope` infers "the refreshed payload has landed" from a change in `children` identity. Inside
`CompanyPanel` — a client component — `children` is a fresh element whenever `CompanyPanel` re-renders,
which is on a tab switch and on an RSC refresh. Typing does NOT re-render it (the inputs are
uncontrolled and the scope's own state lives in the scope), so the practical exposure is narrower than
the general statement: a reader must save on General, switch tabs and switch back, and press Discard,
all inside one RSC round trip.

Two things reduce it rather than leaving it bare. The tab bar now consults `firstDirtyGuard()` before
switching, so leaving a dirty General tab asks first — the same prompt the personnel tab strip shows.
And the Discard button is disabled and reads "Discarding…" for the whole of that window, so the reader
is not invited to do anything during it. Closing it properly means giving the scope an explicit
"payload landed" signal instead of inferring one from `children`, which is a change to a component five
personnel tabs depend on and was not this item's to make.

### What the tests do NOT pin, said plainly

The consolidated save's CLIENT half on this screen — dirty tracking, the change summary, Discard, the
leave-the-tab prompt — is pinned by `test/personnel-tab-save.dom.test.tsx` against the shared component,
not against the company panel. What is pinned HERE is the contract the company screen adds: the marker
set, the section vocabulary, the writers behind it, and the identity fence. A DOM test driving the
company panel's own Save bar would be the next thing to add if this screen grows a second scope.
