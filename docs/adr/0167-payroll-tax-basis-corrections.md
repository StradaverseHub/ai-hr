# Historical income-tax basis corrections

Status: approved feedback929ea296 plan revision1; implementation candidate awaiting verification and human review. No release or statutory certification is implied.

The correction owner appends tax-basis revisions over exact saved payroll sources. Original transaction amounts, closed batch totals, issued payslips, PCB paid, payments, import provenance and prior statutory artifacts remain immutable. Latest reviewed item IDs, flags and classification values are retained alongside year-rule source/version and exemption-table evidence; a hash alone is not provenance.

An authorized payroll administrator selects original employers, an assessment year, an inclusive January-through-month prefix and eligible employment IDs. A multi-company operation queues the existing per-employer previews and binds confirmation to those saved preview IDs and hashes. Progress and retry are checkpointed through the bulk worker and the existing per-employer audit batches. Dedicated configurable view/recalculate permissions and current principal/company checks govern every service and administrative SQL boundary. Narrow grant carriers never borrow broader roles. Historical company authority derives from original payroll batches, including transferred or departed employments. Tax-input readers retain the original payslip readership boundary so denying the administrative correction log cannot hide an effective basis from a permitted payroll calculation or own annual report.

The country pack reconciles exact original line amounts and deterministically replays month/cycle/run ownership. Missing source/mapping, unsupported noncash or LP provenance, unknown assessment-year rules, and unresolved later cap allocation refuse the whole employee. Exact capped replay prefers original year-bound TP3 opening evidence, including a saved zero. Reviewed imported history may use the documented missing-TP3 rule below. An unknown opening skips the employee-year prefix and preserves its saved values and dependent later allocations. Explicitly requested employments without history for the selected period are skipped. Exact results for other employments continue. Today's profile or a cleared TP3 is not that evidence. Uncapped changes do not import current TP3 values. Original salary and tax-category owners remain separate.

Previews expire before initial confirmation and reject changed sources, rules or settings. Each employee's full prefix, revisions and audit outcome commit atomically under history-before-access locks. Confirmations are idempotent. Bounded continuation rechecks authority, terminal state, any prior outcome and exact inputs under the same lock. Interrupted batches preserve successes and require an explicitly authorized review before fresh-preview retry; recovery never bypasses revoked access. Limits and detailed recovery behavior are documented in architecture/HISTORICAL-TAX-BASIS-CORRECTIONS.md.

Consumers are future payroll YTD/exemption accumulation, tax-only same-month normal/additional inputs, the separate corrected-basis worksheet audit view, and supported newly generated EA/CP8D/EA-derived reports. Original historical working remains original. EA routing still requires its complete original evidence; imported display lines do not create that evidence. Existing artifact bytes and filing statuses are unchanged. EPF/SOCSO/EIS wages do not receive tax-only overrides. Every new calculation/report records its exact correction references. The actual PCB-detail and multi-cycle worksheet pages disclose original working plus correction references; EA review and the statutory report panel disclose applied references. The metadata-only notice owner never overlays or validates original arithmetic, and grants a batch link only with current scoped log-view permission; otherwise it displays the full UUID-derived unique reference as plain text.

A changed source invalidates the overlay. Replacement supersedes only the exact payslip or its validated immutable import-record lineage, never another cycle in the same month. Repetition with identical consumer-relevant values is a no-op; previous-treatment display evidence does not create a new correction. The canonical withTenant boundary declares reader capability1 transaction-locally in its existing session statement. A restrictive payslip policy calls a recursion-safe definer over revision/batch context and refuses an absent/older reader on any corrected employer/employment/month. This also protects a replaced source whose older revision is hidden by history RLS; input revision visibility follows the current source context rather than only the obsolete payslip ID. Rollback must preserve this guard, readable correction provenance and a compatible effective-basis reader; reverting to uncorrected tax inputs silently is prohibited. Migration reservation, hosted verification, human staging review and separately authorized production deployment remain distinct.

## Approved imported-history evidence boundary (18 November 2026)

The import snapshot now retains `importedTaxBasis`: ordered source row/code bindings, exact canonical Pay Item identity, complete applied PCB flags/classification, settings and assessment-year rule evidence, and either the canonical wage-input projection or named missing evidence. This is part of the existing immutable import snapshot/revision owner, not a second wage ledger. A replacement/revert selects one accepted snapshot through the original import-record lineage; a source hash is never relabelled onto another snapshot. File statutory amounts remain original. Supported BIK/VOLA lines have explicit noncash ownership, outside cash gross; unclassified benefits are held, never guessed into earnings.

Uncapped wage reconstruction does not need prior-employer exemption usage and does not assert that it was zero. A capped prefix requires saved same-year evidence or the reviewed imported-history default documented below (from 23 November 2026, the accepted TP3 or RM0 opening documented below). Reusing a later native opening requires recorded employer/employment/year and exact source-prefix hashes covering every otherwise missing historical source. Conflicting, wrong-year or unbound openings remain unavailable. Current TP3 values never replace saved historical amounts. A held preview retains source item amounts, current classifications and named affected figures; it cannot be confirmed and leaves the affected capped totals unavailable.

(Superseded on 23 November 2026, see the accepted TP3 opening section.) On 20 November 2026 the owner approved a zero opening for reviewed imported history when the assessment year has no saved TP3 or applied TP3 opening visible to an authorized reader of both sources. An employee's affirmative previous-employer answer, saved historical usage, conflicting evidence, or insufficient access keeps the hold. The preview and saved revision identify the default. The country pack applies the latest Pay Item classification and the assessment year's verified exemption limits to the original amounts. This default is scoped to explicit historical review and does not create a TP3 form or alter original paid PCB.

## Accepted TP3 opening for historical recalculation (23 November 2026)

Supersedes the 18 November rule that a capped prefix needs saved same-year evidence or the reviewed imported-history default, and the 20 November rule that an existing TP3 or projection, or an affirmative previous-employer answer, keeps the hold. On 23 November 2026 the owner decided, after the reporter of board item 0af23331 answered "Use TP3" and asked that only accepted TP3 submissions be included:

1. The employee's accepted TP3 for the assessment year is valid prior-employer exemption opening evidence for historical recalculation. The canonical `employee_tp3` record supplies the per-code usage through the same `core/tp3.ts` mapping that derives the payroll projection (`deriveAccumulatorSeed`, the capped Section C2 sub-lines). Without that record, the `employee_statutory_my` projection whose `tp3_year` is the assessment year supplies it, filtered as live payroll filters it. `employee_tp3_draft` is private staging and is never read.
2. No accepted TP3 means a RM0 opening, even when `payroll_tp3_previous_employer_answer` says yes. The preview, the saved revision and the screen name the source ("RM0 - no accepted TP3 on file") and show a previous-employer-declared warning. The owner chose this knowingly over keeping the hold; an employee whose previous employer used part of a limit can be under-taxed until the TP3 is accepted and the recalculation runs again.

Order of resolution: year-bound saved payslip opening evidence that resolves as known still wins; conflicting saved evidence, or a nonzero saved year opening without matching lineage, still holds; a caller who cannot see the person, the employment and the employer's payroll still holds, because hidden rows are not absence. The rule applies to any missing opening in the explicit recalculation (imported history and older native history alike), not only to imported history. The owner also confirmed on 23 November 2026 that the same resolution applies to live selective reprocessing of an open run whose earlier months changed (`replayChangedPayrollHistoryTx`): where it previously refused because the opening was unknown, it now proceeds with the accepted TP3 or RM0 opening, which is consistent with the TP3 seed normal monthly PCB already applies. Conflicting saved evidence and insufficient access still refuse there. One set-based statement reads the openings for a selection (`core/payroll-tax-opening.ts`). The TP3 identity and revision, the projection, and the latest answer are in the confirmation digest, and the opening provenance is in each employee's reviewed result, so a TP3 that changes or is accepted after a preview forces a fresh preview.

Each reviewed result and saved revision also carries an additive `exemptionLedger` (per capped exemption code and Pay Item: limit, use before, eligible, exempt, taxable excess and remaining, in replay order) and `openingExemption` provenance. Both are excluded from the comparison that decides whether a revision is new, as is the 20 November `no_tp3_default_zero` label, which compares equal to `no_accepted_tp3`; unchanged employees create no new revision. A still-held employee gets review-only ranges from the country pack (`boundTaxBasis`: exact uncapped items, "exempt up to" and "taxable at least" for capped items, and the excess that is taxable whatever the previous employer used). Ranges are never saved and never confirmable, and held totals stay unavailable. No LHDN table, rate, relief, exemption category, Pay Item setting, PCB method, paid amount, payslip or closed period changes, and no migration is involved.

A newly imported held or changed-settings input cannot fall back to gross in an eligible future calculation. The canonical effective-basis reader requires a reviewed exact-source correction or the unchanged accepted import projection. A separate transaction-local import-reader capability and restrictive payslip policy preserve this boundary across application rollback. Existing historical source/artifact bytes, statutory rules and calculation methods are not migrated or recalculated. Any existing-data correction remains report-first and separately authorized.

The source projection is opt-in for eligible calculations and historical review. Original artifact/report readers continue to read original imported statutory and cash amounts; a current-settings hold cannot erase or reinterpret their saved working. Set-paged historical subject metadata and a read-only original-batch-employer policy preserve authority after transfer without granting current-employment writes or another employer's history. The import revision metadata helper returns only the current source revision to an authorized original employer or self reader, so their canonical source hashes agree without import-file access.

Noncash review and eligible reads compose the same canonical owned-source prefix: current-cycle ownership, earlier cycles in the month and prior-month annual accumulation remain separate. Imported benefits retain deterministic source-row ownership receipts; native benefits keep their saved source identity. Missing/orphaned or duplicated monthly owners block reconstruction. Display-name edits do not invalidate tax input evidence, while changed classification/rule receipts require a fresh review even after an earlier correction; original artifact reads remain independent of these eligible-calculation holds. Legacy imported sources without supported receipts are also held for eligible calculations rather than falling back to gross.

Annual-capped cash remuneration (normal or additional) or optional-deduction usage cannot establish the original recurring/one-off split from the six-column history file: a later calculation in the same month is held with that named missing evidence. Later-month YTD can use the reviewed annual usage. No recurring source or optional deduction is invented, and no statutory formula or rate is changed.

An imported noncash row receipt identifies the saved transaction, not its historical recurring/one-off cadence. A later same-month native run therefore also requires original cadence and regular-run baseline evidence; without it, calculation is held. The owned saved amount remains usable for later-month YTD and review without manufacturing that cadence.

## Approved payroll-history maintenance boundary (18 November 2026)

Versioned maintenance uses the existing immutable import record, snapshot, revision and audit owners. A full replacement replaces the effective breakdown; an update sets the exact total of each listed canonical Pay Item, combining repeated aliases once and retaining unlisted owners and statutory amounts. Item edits/removals bind the exact previous revision and a reason. Removing an upload prunes that upload at every contribution depth, preserving later edits, explicit zeroes and removal tombstones; it cannot resurrect an upload previously removed. Legacy whole-record history must reconcile to its accepted source and every retained active revision before the first partial-ownership revision is admitted. Unavailable or ambiguous original item provenance remains a named hold.

Payroll status and previously produced outputs are impact information for this maintenance confirmation, not status-based refusals. Current principal, granular import/removal permission, original employer, exact employment/month/cycle identity, code ownership, calendar evidence, amounts and stale-source checks remain mandatory. Previewing records no payroll changes; saving a preview retains its immutable review receipt. Applying it uses the existing checkpointed bulk-job and staged atomic release owner. No issued artifact, original statutory result, bank payment, approval or closed native run is rewritten, and no calculation is automatically approved, reopened, processed or paid.

An open native payslip stays a mutable artifact of its original run. Maintenance captures a detached immutable copy under the existing history snapshot owner, with exact native source batch/payslip/version, SQL-owned source fingerprint and canonical value commitment. The mutable original is never adopted or referenced by the snapshot foreign key. Effective history suppresses only the proven original run/employment while a published historical source is effective; later independent runs remain visible. Narrow physical artifact portals retain the native run's original permissions, constraints and reset/regeneration/delete behavior. Withdrawal restores the retained copy, never a later regenerated live row. The copy keeps its original native cash, noncash and source-cadence evidence; its storage in a history batch does not classify it as an imported six-column source.

Merged imported sources retain exact canonical effective item ownership in the same snapshot and reviewed plan. Historical tax review binds that item set and the full statutory source to the accepted revision, then uses the same imported-tax adapter and current flags. Noncash still requires its exact original source receipt, and imported recurring/one-off or regular-run cadence is never inferred. Missing cadence remains a named same-month calculation hold. Eligible open later calculations are marked for review through the existing payroll owner; closed sources, their artifacts and the statutory engine/rates remain unchanged.

## Selective reprocessing after a changed source

The open native run may recompute with the standard country-pack calculator when
the currently locked payslip or its inputs changed after a correction. Exact
corrections and validated lineage still apply where the original inputs match.
A fresh replacement records the actual before and after hashes, the prior
correction ID and the immutable payroll result history checkpoint. It preserves
the original correction, including its source hash.

For stale historical inputs the selected employee calculation may reconstruct
tax inputs from the exact, visible employer and assessment-year payroll prefix.
It uses the same reconstruction as Income Tax Correction and records the
replayed source identities in the new open result. Historical source rows and
correction records are read-only. Genuine missing evidence, invalid lineage and
unprovable annual allocation produce a named employee outcome, rolling back that
employee's calculation and retaining their previous result while the job
continues. Other consumers keep the strict original source policy.

## Amendment, 23 November 2026: hold the employee, not the company (board 016276b7)

The reporter approved a plan that isolates historical tax holds to the affected
employee during payroll processing. Each processing chunk asks the canonical
historical tax-basis reader which of its employees it cannot read, using the same
options and source rows as the chunk's own calculation. Those employees are held
for income tax review: no payslip, nothing of theirs calculated, and their loan
reservations and reserved claims stay on the run. Everyone else is processed. The
run's `payroll-batch.processed` event records each held employee, the month and
the reader's reason. The live list is that record intersected with the employees
who still have no payslip on the run and were not removed from it.

The hold criteria, the reader, the statutory engine and every other refusal are
unchanged. Any other error still fails and discards the whole run. Held employees
keep a regular run's Close shut, as any payslip-less eligible employee already
did, and now also keep an additional run's Close shut. They join the same run
through the existing selective reprocess add path once their history is
corrected. Without the multi-cycle module, that path admits exactly the run's
outstanding held employees and nothing else.

## Amendment, 26 November 2026: automatic group TP3 (board 4ce2c481)

The owner decided on 26 November 2026 ("Automatic group TP3") that live PCB/MTD at a company takes the same person's
earlier months of the assessment year at the tenant's OTHER companies (imported or processed) as an automatic
previous-employer opening, the role Form TP3 plays. The canonical effective tax basis of each contributing payslip is
used (latest correction revision, otherwise an accepted ready import projection, otherwise the native stamp); a month
with none holds the employee with the month named, through the same processing hold, draft readiness and reprocess
readiness paths as an unreadable own history. A TP3 listing a contributing group company is replaced by that history;
a TP3 listing such a company together with an outside employer holds, because its single total cannot be split. TP3s
for employers outside the group, and the 23 November accepted-TP3-or-RM0 rule for them, are unchanged.

Historical correction authority is unchanged: Recalculate Income Tax Value still corrects only the selected original
employer's own months and its opening resolution is as above. Its preview gains a read-only "Year to date from other
group companies" section (per contributing company: months, source, taxable pay, PCB, EPF, exemption use and remaining
limit, missing months), attached outside the preview hash. Totals cross companies only through the definer
`app.payroll_group_tax_opening` (migration 7520), gated by payroll administration of the selected or run company; no
payslip line leaves it. Payrolls already processed are not changed by themselves; reprocessing the affected month
applies the opening. EA/CP8A, CP39 and Form E stay per company.
