# Employee imports run as background jobs with staged rows and one activation

Status: source implementation on `claude/import-staged-job-20261110`; hosted verification and integration pending.
Base: `7b585515d67885045d79ebb3dce4ef6c5e7b1bd8` (on main `f07f32dcd`). Production and staging untouched.

The single import transaction held tenant-wide locks for its whole length (DESIGN.md: 11 s for 200 rows). This decision
replaces it with a job: validate once, apply in chunk transactions of about 250 ms, activate in one short transaction.

- **Staged state.** `employment` and `person` gain `import_pending_attempt_id`. A BEFORE INSERT trigger stamps every row
  written while `app.import_attempt` is set; a guard refuses any other writer of the column; a RESTRICTIVE policy hides
  pending rows from every RLS-subject role unless the session's `app.import_attempt` matches. Direct child rows written by
  the hire are hidden by restrictive policies over `app.import_pending_employment_ids()`/`..._person_ids()` (one empty index
  probe per statement on the partial index). `app.access_workforce_employment` admits only the matching import session.
- **Definer audit.** Definers bypass RLS. The audit (phase 1) classified all 622 definers mentioning employment/person; the
  40 enumerators that would act on or leak pending rows were filtered, keeping the 0676 `voided_at` shape where it existed.
  Reservation readers (`employee_code_claim`, `card_identifier_*`, `create_login_person`, `people_nric_*`) intentionally
  still see pending rows so codes, cards, emails and NRICs stay reserved.
- **Activation.** `app.import_activate` clears the marker with one UPDATE per table under a freshly re-checked initiating
  user, after `app.import_activation_conflicts` reports duplicate emails against persons that became visible meanwhile.
- **Discard.** Decided rule: a discarded staged hire leaves `employment.hired` followed by a void event (ADR-0157). The
  worker's owner connection runs `app.import_discard`, so a revoked initiator can never leave staged rows behind.
- **Job.** `employee_import_job`/`employee_import_step` follow the Bank & Statutory queue shape. One active job per tenant
  keeps duplicate checks exact. Each step's write and its `applied` marker commit together; a crash re-runs only what did
  not commit. A separate worker process (`aihr-employee-import.service`) uses its own small pool.

Known limits are reported with the branch: AI-evaluation-bound and chat-import commits still use the synchronous path.
