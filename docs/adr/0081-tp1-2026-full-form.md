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

**4. Accumulation is per item and per sub-line, across APPROVED declarations of the same assessment
year.** Remaining = limit − accumulated; a claim that would pass the limit is refused with the
shortfall named. The screen's "remaining" strip and the server's refusal come from the SAME function,
so they cannot agree today and disagree tomorrow. Legacy eight-key rows contribute nothing to the
accumulation: there is no honest mapping from `medicalInsurance` onto C4 / C11 / C13, and an invented
one would refuse a claim citing a number nobody entered.

**5. The record's grain moved from the assessment YEAR to the DEDUCTION MONTH.** The form has a
DEDUCTION MONTH box, so a year holds up to twelve declarations. `tp1_relief` gains `deduction_month`,
and the list is one row per month. The append-only latest-wins rule is unchanged — it now collapses per
month instead of per year, so a correction still never produces two competing lines. A declaration
written before this round has no month and is not given one.

**6. Employer consent gates the payroll feed.** `tp1_status` becomes
Draft → Submitted → Approved / Rejected → Cancelled, and `prefillTp1FromSelfRelief` reads only
`approved` rows whose `approved_month` is at or before the batch's month. Approval is an UPDATE, not an
append — a decision is a fact about a row, not a new declaration — and every decision appends a
DomainEvent carrying who, when, and the changed field NAMES. PDPA Layer-0 holds: never an amount.

**7. The backfill is part of the migration, not a script.** Every declaration that existed before this
round is `submitted`; under the new gate they would all stop feeding, silently, because "no approved
declaration" and "nobody declared anything" are the same empty set. Migration `0445` stamps them
`approved` with `approved_at = submitted_at`, `approved_by = NULL` and `approved_month = 1` — the
behaviour those rows have today, preserved exactly. It is in the migration because `deploy.sh` runs
migrations and does not run scripts.

**8. The generated form is our own layout, drawn to follow the agency's, and says so.** `lib/tp1-pdf.ts`
draws A4 from scratch in the house pattern of `lib/borang-a-pdf.ts`. It is faithful to the agency's
wording, numbering, legal references and column order (ANNUAL LIMIT · CURRENT · ACCUMULATED) and is
never described as the official form. An unfilled box prints EMPTY rather than `0.00`: a zero asserts
"nothing was claimed under this head", which is a statement about a legal declaration.

## Consequences

- **The single largest risk is the feed gate.** If `0445`'s backfill does not run, every existing
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

`0444` REPLACES the `tp1_status` type rather than adding values to it, and the reason is worth knowing
before writing another enum migration: **drizzle replays every pending migration inside ONE
transaction** (`pg-core/dialect.js`), so a value ADDED to a pre-existing enum cannot be USED by any
migration in the same run — `0445`'s backfill hit exactly that (`55P04`). Splitting into two files does
not help when both ship together. A type CREATED in the transaction has no such restriction, so `0444`
renames the old type, creates the five-label one, moves the column across through text, and drops the
old. Older notes in this repo (0392's header, and the standing order in `AGENTS.md`) describe the
mechanism as one-transaction-per-file; they are mistaken, and `0444`'s header records that.
