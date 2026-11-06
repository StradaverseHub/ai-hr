# Staging feedback: source and acceptance review

This is a technical evidence packet for the eight staging feedback items. It is not
provider approval, reporter acceptance, or permission to install the candidate.

The verified installed baseline is commit `167746604919fd5b85918256f1396bb796afbab9`.
The read-only staging check matched all 697 migration entries, in order and by
checksum, through timestamp `1793330001700`. The candidate appends three migrations:
private payroll remarks, a narrow Rewards activity projection, and reconciliation
source version receipts. See the [migration register](../MIGRATION-ALLOCATION.md)
for the exact filenames, timestamps, and hashes.

## Provider boundary

The baseline provider transform digest is
`e6d8787efa5cd0051baad6afe5b59cc3c6f27d7b2ff2e3dc03b757e1decec907`.
This candidate computes
`ddfdd95e41caa57e468007a7c97564ead57bfcf1d4a0c1b1f2aa3628edd81603`
over 1,456 files. The module-agent digest is
`9ad6948e9436012f9fa14f8c91903bacdc5f0e63bd3a920c33e7203bf33f597c`
over 467 files before recording the owner decision. The prior candidate failed
closed because the active disclosure records still pointed to the installed
baseline.

The covered changes affect Attendance calculation and configuration, Payroll
result reads and report navigation, Lifecycle document generation and preview,
route and capability catalogs, the schema, and the locale dictionaries. This
candidate does not grant an agent a new mutation or a new provider contract.

- The provider-facing BASIC Payroll adapter accepts only its original coarse
  selectors. Individual search, employment IDs, cycle selection, grouping, and
  saved template defaults remain in the native report. The adapter does not read
  the remarks table or the all-pay-item export path.
- Reconciliation remarks are separate from the general domain-event stream.
  Individual search text is excluded from report audit payloads. Automatic
  source receipts contain run IDs and a fingerprint of result identities and
  revisions; they do not contain amounts, employee names, or remarks.
- Lifecycle preview values are returned through an authorized case read. Template
  overrides remain document data, and missing required fields stop delivery.
- Rewards search uses the page's already authorized review and person lists.
  The keyboard palette keeps these searches local. The Group Rewards activity
  function returns only the named audit fields for an authorized review. It does
  not widen generic event access.
- The new Attendance import is listed as a native workbook workflow. It has no
  provider serializer or tool registration.

Before renewing any approval, inspect the covered-source diff against the
approved baseline, verify the old contract and its refusal cases on the exact
candidate, and record the actual source-binding decision. Do not move agent
evaluation or promotion records to a new hash.

### Fictional-data staging binding

On 6 November 2026 at approximately 08:42 UTC, the repository owner answered
“Yes” in the Codex feedback-board chat to the request to bind the existing
AI disclosure contracts to digest `ddfdd95e41caa57e468007a7c97564ead57bfcf1d4a0c1b1f2aa3628edd81603` for fictional-data staging
verification. The request expressly excluded real HR data and production use.

The registry refresh changes only the source digest of the 28 previously
approved records. Historical reviewer, evidence and review timestamps are
preserved. Pending records, disclosure contracts and the admission logic stay
as before. This is the exact-source decision record for the staging refresh.

## Reward Desk evidence

Reference: `Reward-Desk-offline-v3_3.html`, submitted on the Rewards parity report,
SHA-256 `bb785800799ecdb3b8904242c1bd5be87aa309b993d737aeca68c58f70f21372`.
The repository does not copy its demo people, payroll data, or role simulator.
The shared arithmetic case in `test/rewards-engine.test.ts` uses independent
expected figures for the salary pools, merit, promotion, catch-up, bonus months,
multiplier, lump sum, and over-pool flags. Later AIHR policy owns configured
matrices and salary structures, the independent plan budgets, named Senior
selection, uploaded awards, and the no-salary-reduction rule.

| Reference screen | AIHR evidence surface |
| --- | --- |
| Home and budget | Review cards and authorized all-unit budget list |
| Team Review | Salary/bonus sections, individual recommendation edits, person drawer |
| Flags | Unit counts and links from the landing page; blockers first in the unit, with links to a person, section or applied rule |
| Approvals and matrix | Approvals board and cycle coverage matrix |
| Promotions | Unit nominations and the Group Rewards cross-unit list |
| Data Check and Data Centre | No-pay pre-launch projection, native refresh and imports |
| Activity, Access and Configuration | Restricted audit, role permissions, and existing native configuration pages |
| Analytics and Rules | Existing authorized analytics and rules pages |
| Off-Cycle | Separate phase per the board plan |

The table records the matching surfaces, not screenshot or role acceptance.
A complete side-by-side pass still needs the same fictional cycle exercised
as BU CEO, BG CEO, Proxy BG CEO, Group Rewards, CTRO, EC, and PBP. Capture
screen evidence and compare the figures and approval outcomes for each role.
