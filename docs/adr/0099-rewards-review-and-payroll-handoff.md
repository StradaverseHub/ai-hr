# ADR-0099 — Rewards reviews and payroll handoff

Status: accepted and deployed, 2026-10-11. Tenant activation awaits the owner's company-group scope.

## Evidence and scope

The user supplied `RD-HANDOVER-2026-10-09.zip` and authorized integrating Reward Desk into ai-hr.
The v3 HTML baseline is 428,265 bytes, SHA-256
`bb785800799ecdb3b8904242c1bd5be87aa309b993d737aeca68c58f70f21372`.
The archive's operational instructions for editing its standalone HTML are provenance, not authority
for this repository. Its scenarios and formulas inform this implementation.

FACT: employment, assignment, grade and compensation are existing authoritative records. Rewards
owns review snapshots, policy, recommendations, participants, decisions and the posting reference.
Performance supplies a reference to a closed review in the reward year. It does not supply an inferred
mapping between a numeric rating and SSTAR/STAR/SCORE or UA/BE/ME/AE/OU. Group Rewards verifies that mapping.

DECISION: expose an optional tenant module through the existing catalogue, navigation and module gate.
Tenant activation is separate from releasing its code. Do not enable every customer's module implicitly.

## Calculation and policy

Money is integer cents, rates integer basis points, with BigInt multiplication/division intermediates.
Increases round to whole RM and bonus awards floor to whole RM, following the supplied baseline.
Standard and JG H have independent merit, promotion and special pools (default 5%, 1%, 1%).
Both use the common merit matrix. EC cases are discretionary and do not consume BU pools.
Eligibility, confirmation and off-cycle exclusion windows are policy dates tied to the review year.
Senior leadership, ER/PIP decisions, notice, proration and explicit branch/segment configuration feed checks.
Unknown salary ranges, unverified inputs and missing branch inputs block submission.

CHALLENGE RESOLVED: positive spending against a zero pool blocks; the baseline's zero-denominator
utilisation fallback could silently accept it. A unit bonus multiplier must fit each separately funded
plan; it cannot combine the two plans' salary costs against one plan's budget.

Lump sums use the minimum affordable per-person amount across plans with eligible employees, then the
configured cap. The default is 100% of remaining funds, RM 50 rounding, no per-person cap. These are
configurable defaults from unresolved policy choices in the handover, not newly asserted HR policy.
RM 0 explicitly withholds a token. Unit and individual deviations remain visible checks.
A budget exemption changes only the budget cap, never employee eligibility or data validation.

## Access, decisions and audit

Unit participants are app users, not employment IDs. Roles are BU, BG, Group Rewards, CTRO, EC, PBP and
payroll. Active membership is re-read for each operation; setup requires fresh company administration.
PBP is read-only. Own-person records are filtered even for Group Rewards. EC records are visible only to
GR/CTRO/EC; BU and PBP cannot see BG direct reports. Unverified rows start visible only to Group Rewards.

The service is the confidentiality projection boundary. Database RLS isolates tenants and unit members;
it allows the server to calculate the complete unit internally. Do not expose raw reward tables through
an API, AI tool, export or generic data browser. CSV exports use the same projection and neutralize
spreadsheet formula prefixes. Audit payloads contain identifiers and revisions, never pay or case notes.

RISK retained from the supplied design: standard/H shared aggregates include restricted BG records and
the viewer's own record. Small-cohort subtraction may allow inference; line-item concealment is not a
claim of statistical privacy. EC aggregates are calculated from visible rows only. A separate BG budget
would require a business policy decision rather than a silent allocation invented here.

Annual route: BU → BG → GR → CTRO → EC. Submitted inputs are frozen with a SHA-256 digest. Changes require
return to draft and a new revision. Stale forms fail. Consecutive stages require different users.
Returns require a reason; exceptions/warnings require an acceptance note. An unposted final approval
can be returned to refresh stale employee data. Posted reviews are immutable through the service.
Company deletion refuses while a reward review exists, including drafts; company setup never cascades financial review history.
Assigned queues appear in the approvals inbox; the notification dispatcher sends generic in-app links.

## Off-cycle funding and promotions

Ad-hoc and mid-year reviews are children of a posted annual review. This deliberately grounds their
budget in awards that were actually handed to payroll, rather than a mutable or unposted proposal.
The annual posting freezes each plan's positive remaining increment pools. Off-cycle requests consume
monthly salary deltas. The standard and H balances remain separate; EC requires an ad-hoc exception.

Submission reserves funds, approval retains them and posting consumes them. Draft, returned, rejected
and withdrawn requests reserve nothing. A lock on the annual parent serializes concurrent submissions.
A security-definer helper returns only aggregate unreserved funds and a duplicate-open-request boolean;
it validates tenant, live membership and the annual parent. It never returns sibling employee records.

Ad-hoc: BU → BG → GR → CTRO, with EC for grade 22+ or budget exceptions. A BG-originated direct-report
request starts with BG then GR. Mid-year sets: BU → BG → GR; the set is returned or decided together.
A request needs a positive increase, increment rationale (10 characters) or promotion business case
(30 characters). Promotions move one to three grades and require distinct current/proposed job-description
summaries, which each approver acknowledges. PDF, Word and text descriptions are read locally in the browser (5 MB, 10 PDF pages, 30,000 characters).
A deterministic statement comparison proposes excerpts for human editing. Raw files and pasted source
text are not submitted or persisted. No AI promotion verdict is represented as having run.

## Payroll and failure behaviour

The assigned payroll reviewer also needs company administrator permission to use the existing salary
and grade writers. Posting locks the unit, selected draft payroll batch and employees in deterministic
order. It verifies unchanged employment/company/grade and current compensation identity, currency,
pay mode and salary before writing. Salary changes and payroll input additions share one transaction.
Existing bonus input is added to; overtime, TP1 and zakat are preserved. Repeating posting is idempotent.
Any failure rolls back the whole review's writes.

FACT: job grade is currently an undated employment attribute. Therefore a promotion can be posted only
on its effective day; the module does not silently advance a future grade today. A broader dated-grade
model is outside this change. Ordinary salary changes use existing effective-dated compensation.

## Verification and remaining limits

Targeted tests cover formulas, zero pools, independent plans, exemptions, lump sums, proration, branch
inputs, confidentiality, real RLS, revision checks, routing, double posting, stale salaries and concurrent
off-cycle reservations. The exact shipping commit `03f55e21e6ea690a11e8a129f01a8e78f298a109`
passed all 1,279 test files (20,169 tests), type checking, local and production builds,
14 browser suites (228 passes and one existing expected failure), and shadow migration 432/432.
Production applied migration 0524, reports matching source/build refs and healthy service, and has
RLS enabled on all five reward tables. No reward cycles, units or entries were created and no tenant
Rewards entitlement was activated. The release history records the detailed evidence and corrections.

All six message catalogues carry the new keys. Primary navigation labels are translated; several Rewards
policy explanations currently use English in the non-English catalogues. An optional generative-AI summary is not implemented; the deterministic comparison and human-authored
summary remain the decision record. These limits must be stated in release communication.

Reader API references: [JSZip streaming](https://stuk.github.io/jszip/documentation/api_zipobject/internal_stream.html)
and [Mozilla PDF.js](https://mozilla.github.io/pdf.js/examples/).
