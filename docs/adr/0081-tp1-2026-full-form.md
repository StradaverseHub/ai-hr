# ADR-0081 — The LHDN TP1 (1/2026) as a complete e-form: pack catalogue, approval gate, printable output

- **Status:** Accepted — landed with board item `7ad37961` (r201).
- **Extends:** ADR-0050 (§1.1.3 self-service TP1, §0.1 the delta feed), ADR-0073 (the eight-key
  breakdown), ADR-0080 D6 (statutory vocabulary belongs to the country pack), ADR-0008 (no unsourced
  statutory number), ADR-0030 (PDPA Layer-0 event payloads).
- **Corrects:** ADR-0073's note that there is "no PDF tooling in the repo" — `pdf-lib` has been a
  dependency since the CP22 work, and there are now six generators beside it.

## Context

The TP1 screen captured eight broad categories and one total. The agency's own form asks for seventeen
numbered items with named sub-lines, an annual limit against each, the amount already claimed this
year, a deduction month, an employer block, an employee block, a rebate section, an employee
declaration and an employer consent. Two of the eight categories were checked against a legal limit;
the other six accepted any figure. There was no way to print the result.

## Decision

**1. The item catalogue lives in the country pack, not in the form and not in the message catalogues.**
`localization/my/statutory-tables.ts` gains `MY_TP1_2026` — C1–C17 with their lettered sub-lines, the
ANNUAL LIMIT the agency's form prints against each, the printed "(Limited RM…)" sub-limits, and the
Section D rebate lines. It is surfaced as `payroll.taxReliefCatalogue` on the `CountryPack` contract,
alongside (not replacing) the older `taxReliefCategoryCaps`, which still serves legacy rows.
`core/tax-relief.ts` types it structurally off the contract so no `core/` file names a pack
implementation — the R55 mistake rung 5a undid.

The screen RENDERS `def.limit`; it never states a figure. The legacy help strings embedded "RM 9,000"
in six message catalogues, which is six copies of a statutory number that do not move when the law
does. `test/tp1-2026-form.test.ts` fails the build if a ringgit limit reappears in any catalogue.

**2. ADR-0008 holds, in both directions.** An item the form prints no limit against carries
`limit: null` — captured, summed, printed, never blocked. A frequency rule the form states in words
("once every 2 years of assessment") is captured and printed but NOT enforced: enforcing it needs the
employee's claim history at LHDN, which this system does not hold, and a wrong refusal on a valid claim
is worse than no check.

**3. `tp1_amount` remains the authoritative, server-computed roll-up, and it sums the DEDUCTION items
only.** Section D rebates are stored and printed and are deliberately excluded: a rebate reduces the
tax, not the chargeable income the PCB kernel projects from. Rolling them in would move every affected
employee's monthly MTD silently. The client never sends a total at any level — an item's amount is the
server's sum of its sub-lines, exactly as the grand total is the server's sum of the items. This is the
line that keeps the PCB arithmetic byte-identical, and the byte-stability case (ADR-0073 point 2) was
re-pointed at the C1–C17 shape rather than deleted.

**4. A DECLARATION IS AN INCREMENT, AND A YEAR IS THE SUM OF ITS MONTHS.** This is the decision the
rest of points 4–6 hang off, and it has to be stated once for both halves of the round to be true at
the same time. Accumulation is per item and per sub-line across the APPROVED declarations of the year;
remaining = limit − accumulated; a claim that would pass the limit is refused with the shortfall named
("RM X has already been approved … so at most RM Y can be claimed now"). That message teaches HR to key
what is NEW this month — so the relief the payroll feed must apply is the SUM of the approved months,
not the newest row. A feed that took one annual figure per person would make a second declaration
*reduce* the relief (January 3,000 then June 2,000 would feed 2,000), silently and with no error
anywhere; `test/tp1-2026-form.test.ts`'s "feeds the SUM of the approved months" case is the guard.

**4a. One month, one record — `collapseTp1ApprovedByMonth` is the only rule.** Approval is an UPDATE
and a correction is a NEW row, so a superseded declaration keeps `status = 'approved'`. Every consumer
therefore collapses the approved rows per `deduction_month` (newest `created_at`, tie-broken on id)
before doing anything else, and the accumulated figure for a month EXCLUDES that month's own bucket.
Without the collapse, a correction to an approved month is refused by its own prior figure and payroll
double-counts it; without the exclusion, no correction to an approved declaration is possible at all.
The month list, the screen's "remaining" strip, the server's refusal, the printed ACCUMULATED column
and `prefillTp1FromSelfRelief` all call that one exported function with the month they are asking about
— an id-based exclusion was tried and is wrong, because a month can hold several superseded approved
rows. `deduction_month IS NULL` is its own bucket (pre-round rows, and /me self-service, which declares
for the year), never folded into January.

Legacy eight-key rows contribute nothing to the accumulation: there is no honest mapping from
`medicalInsurance` onto C4 / C11 / C13, and an invented one would refuse a claim citing a number nobody
entered. Their `tp1_amount` still feeds payroll.

**5. The record's grain moved from the assessment YEAR to the DEDUCTION MONTH.** The form has a
DEDUCTION MONTH box, so a year holds up to twelve declarations. `tp1_relief` gains `deduction_month`,
and the list is one row per month. The append-only latest-wins rule is unchanged — it now collapses per
month instead of per year, so a correction still never produces two competing lines. A declaration
written before this round has no month and is not given one.

**6. Employer consent gates the payroll feed.** `tp1_status` becomes
Draft → Submitted → Approved / Rejected → Cancelled, and `prefillTp1FromSelfRelief` reads only
`approved` rows whose `approved_month` is at or before the batch's month — then collapses them per
month (point 4a) and SUMS, which is the annual figure the ADR-0050 §0.1 delta is taken against. Approval is an UPDATE, not an
append — a decision is a fact about a row, not a new declaration — and every decision appends a
DomainEvent carrying who, when, and the changed field NAMES. PDPA Layer-0 holds: never an amount.

**7. The backfill is part of the migration, not a script.** Every declaration that existed before this
round is `submitted`; under the new gate they would all stop feeding, silently, because "no approved
declaration" and "nobody declared anything" are the same empty set. Migration `0449` stamps them
`approved` with `approved_at = submitted_at`, `approved_by = NULL` and `approved_month = 1` — the
behaviour those rows have today, preserved exactly. It is in the migration because `deploy.sh` runs
migrations and does not run scripts.

**8. The generated form is our own layout, drawn to follow the agency's, and says so.** `lib/tp1-pdf.ts`
draws A4 from scratch in the house pattern of `lib/borang-a-pdf.ts`. It is faithful to the agency's
wording, numbering, legal references and column order (ANNUAL LIMIT · CURRENT · ACCUMULATED) and is
never described as the official form. An unfilled box prints EMPTY rather than `0.00`: a zero asserts
"nothing was claimed under this head", which is a statement about a legal declaration.

**8a. The form is printed in the DOCUMENT's language, not the viewer's — allowlisted to `en` / `ms`.**
`lib/tp1-pdf.ts` embeds Helvetica, which is WinAnsi, and folds anything outside Latin-1 to `?`. Every
word of the body comes from the `taxRelief` namespace and every locale in `messages/` translates it, so
resolving that namespace against the viewer's UI locale prints a statutory form whose whole of Section C
reads as rows of `?` for `ta` / `zh` / `th` / `vi`. Same allowlist, for the same reason, as
`app/me/ea/[employmentId]/pdf/route.ts` (587ee719); a `lang` parameter chooses between the two and any
other locale gets the English form rather than a broken one.

**9. Section F's Name is resolved through `approved_by`, never copied onto the row.** The column stores
the deciding `app_user`; the screen and the PDF both read the name through a LEFT join to that user's
person, so a renamed user is never two names on two documents. Absent — no decision yet, a login with
no person behind it, or RLS hiding that person from this reader — prints the form's own blank rule
rather than a guess.

## Consequences

- **The single largest risk is the feed gate.** If `0449`'s backfill does not run, every existing
  employee's relief stops with no error anywhere. Verify the row count after deploy, not just that
  `deploy.sh` returned. `test/tp1-self-relief.test.ts`'s legacy-row case is the regression guard: its
  fixture is now shaped exactly as the backfill leaves a row.
- **`Tp1Categories` is a discriminated union.** Readers narrow on `isTp1Categories2026`. Legacy rows
  stay readable, editable, printable and payroll-feeding — the branch in `resolveInput` is what makes
  that true, and `TP1_CATEGORY_KEYS` stays exported for it.
- **The catalogue is transcribed, not verified.** The figures came from an attachment on a board item
  whose producer metadata is `Microsoft Word 2019`, not from a file we retrieved from hasil.gov.my.
  `docs/architecture/STATUTORY-SOURCES.md` §7 records every figure and carries the sign-off gate.
- **A correction to a limit is one edit.** `MY_TP1_2026` is the only place a ringgit figure appears.

## Notes for the next reader

`0448` REPLACES the `tp1_status` type rather than adding values to it, and the reason is worth knowing
before writing another enum migration: **drizzle replays every pending migration inside ONE
transaction** (`pg-core/dialect.js`), so a value ADDED to a pre-existing enum cannot be USED by any
migration in the same run — `0449`'s backfill hit exactly that (`55P04`). Splitting into two files does
not help when both ship together. A type CREATED in the transaction has no such restriction, so `0448`
renames the old type, creates the five-label one, moves the column across through text, and drops the
old. Older notes in this repo (0392's header, and the standing order in `AGENTS.md`) describe the
mechanism as one-transaction-per-file; they are mistaken, and `0448`'s header records that.
