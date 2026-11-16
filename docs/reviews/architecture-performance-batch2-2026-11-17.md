# Own Leave and Payroll paging review

Scope: AP-062 and the candidate-selection portion of AP-045, against accepted staging base 9bdfb45969c4bff81a9b9830b52403a95e82bdc6. Production is outside this batch. The original audit and failed runs retain their original identities.

## Standards

Independent fresh-context standards review of 3342531271c095a825ad67a5df942e0f74e94e7a found two concrete P1 issues: invalid TSX at the inserted existing-payslip pager, and navigation accidentally conditional on Skipped additions. Both were fixed and independently rechecked at c972532570f3eb1fa5e9569c74103ab7ef208776. No additional hard architecture/security violation was identified by source review. This is not a test or acceptance result.

## Spec

Independent fresh-context specification review found the same two P1 issues, fixed and rechecked as above. Selection/review/FormData equality and persistent idempotency are covered by added DOM fixtures. Native skip/readiness equivalence was added to existing financial fixtures. One behavior remains explicitly pending owner clarification: the previous answer covered displayed-page New/Pending defaults; the implementation currently also limits stale existing-payslip defaults to the visible page. The primary agent explicitly communicated that visible defaults apply to both groups in the prepared candidate as an assumption; optional owner clarification remains open. This does not claim explicit approval of an additional behavior.

## Development evidence

- 2858a55d3 / focused 43931609323: native 121 passed / 2 failed. Missing suspended-tenant refusal after allowing READ ONLY metadata, plus missing fixture primaryEmail, were repaired. Whole typecheck failed on the same fixture email omission. Raw failures retained.
- 3342531271c095a825ad67a5df942e0f74e94e7a / focused 43934876702: all 162 native cases passed across 13 DB files, no skipped cases. 151 no-DB/DOM cases passed across 9 files; Reprocess DOM could not transform because of the pager syntax. Whole typecheck and Linux build failed on that syntax. This run remains failed.
- c972532570f3eb1fa5e9569c74103ab7ef208776 / focused 43935883124: repaired candidate under hosted verification, with additional skip/readiness and pending-money regression fixtures. Selected tests passed: 177 native cases in 15 files and 191 unit/DOM cases in 10 files. Whole typecheck and Linux build also passed.

- `6350cacc0cbf36f5c700ffd2131f7dc43a83458c` / focused 43937314461: final application source passed 34 native and 71 unit/DOM cases, whole typecheck and Linux build. The measured 25-row service results were 6,732 bytes versus 216,907 bytes for the complete Remove list, and 6,727 bytes versus 3,942,774 bytes for discarded Reprocess detail on 1,000 paid employments.
- `38339d5f55433d4b808a403933d75b72017d5383` / focused 43939945809: after migration reallocation and approved binding, 101 native and 13 unit cases passed. No test cases were skipped. Whole compiler/build were not repeated for metadata/literal-only changes; the final release gate will cover the eventual Movement-baseline integration.

## Limits and release boundary

Reprocess disclosure/history and recorded result populations remain separate open paging work. The global overtime availability proof retains its complete native cohort to preserve refusal semantics. No complete-request latency or numerical payroll improvement is claimed. Sixty of 62 observations remain open; no batch2 finding is closed before staging acceptance. Migration 5787 is unapplied, reallocated by the coordinator from provisional 5880 with unchanged SQL bytes. The direct owner approval for AI binding and migration ordering was verified; the same 28 approval literals are carried forward with exact manifests and a dated binding record. Movement releases first; fresh baseline/ledger review and the full gate remain required.
