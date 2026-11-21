# Personnel to Probation reconciliation

The protected `aihr-bank-import.service` runs a durable Personnel reconciliation companion beside the shared bulk-job kernel. It uses the installed worker's physical owner connection and one additional single-connection owner pool. Keep `AIHR_DB_PROCESS_ROLE=worker` and `AIHR_DB_POOL_MAX` at most 8 in the existing private worker environment. No new public endpoint or new service credential is needed.

Migration `6600_probation_reconciliation` records intents on canonical Personnel employment/assignment and intake changes. A setup publication or activation change requests a new scan. The worker also starts a full candidate scan every 15 minutes using 100-record keyset slices. Each tick checks at most one employment in its own transaction; the queue row lock, canonical Probation lock and existing unique employment identity prevent concurrent duplicates. A restart resumes the saved source cursor and uncommitted employment check. Every rehire remains its own employment identity. Closed cases are shown for review and never silently replaced.

The scan changes no settings and activates no company. Existing runtime activation, published versions, grade policy, intake exclusions and exact historical cutover approval remain mandatory. Catch-up uses the same canonical admission and audit path as new starters. Existing case progress is unchanged. A missing Personnel Business Unit is a warning only. Future starters may have a case, but their parts and work remain unissued before the start date.

The tracker reads only. It reports every currently visible missing case with all recognised setup/eligibility/cutover holds and links to the corresponding owner screens. Counts, ordering and pagination stay in SQL. A check that safely identifies a setup hold is successful; an unexpected canonical refusal is recorded as a failed check and retried without exposing raw database errors. A completed scan is recorded only after all queued checks have committed. If none has completed, or the last completion is over 30 minutes old, the tracker reports that condition.

## Installation and catch-up acceptance

Do not claim this schedule installed merely because source tests pass. The release controller must independently verify the target source, build, ordered migration ledger and existing worker service/environment before restart. Preserve the shared staging lease. Do not activate companies, publish defaults or issue live messages as part of this installation.

After the independently verified worker restart, observe two automatic passes at least 15 minutes apart. Confirm its actual process/service identity, UTC timestamps and Malaysia business-day handling. Capture a read-only status receipt from the installed source:

```sh
node --conditions=react-server --import tsx scripts/operator/probation-reconciliation-status.ts TENANT_UUID
```

The command uses the installation's private owner environment. It only reads schedule checkpoints, missing-case classifications and queue totals. Retain the receipt privately with the verified source/build and service evidence; do not copy Personnel details into public artifacts. Re-run after the first catch-up completes and verify zero unchecked work, no unexpected failed checks, and an explanation for each remaining missing case. An acknowledged setup/cutover hold is not permission to bypass it.

On a fictional authorised fixture, verify activation and later status changes, pre-start admission with no early work, missing-BU admission, setup recovery and repeated/concurrent replay. On staging, inspect the reported existing employment without altering its configuration or creating an artificial case to make the count green. No production installation or actual catch-up receipt is claimed by this source change.
