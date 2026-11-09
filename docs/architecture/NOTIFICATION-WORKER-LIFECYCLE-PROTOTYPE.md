# Native notification lifecycle prototype: stage1

Status: executable isolated-CI source, no hosted result or installation. This is a
coherent first implementation chunk following the frozen native API proposal at
12b544c6. It does not implement or commission the notification projection worker.
The root authorized only isolated source/CI use of ai_hr_notification_worker,
notification_worker and notification_worker_private. No numbered SQL, journal,
credential, production role/schema creation, installer or schedule changes occur.

## Functional boundary

The unnumbered test fixture implements eight real fixed SECURITY DEFINER functions:
open_run, scope_page, open_batch, events, finish_batch, settle_scope, finish_run and
fail_run. There is no SQL broker or signature stub. The typed direct-postgres port
uses these exact capabilities, owns no app pool and supplies no fake Drizzle Tx.
The positive fixture observes a single actual worker backend; a separate real LOGIN
connection exists only for explicit cross-backend/reconnect refusal controls.

Native admission checks session_user's actual role OID/profile, zero memberships,
shared schema CREATE, sensitive schema USAGE, every user-relation/column/sequence
privilege and accessible user-defined definers. Only the eight exact API OIDs are
allowlisted. A newly exposed PUBLIC definer or source privilege refuses admission;
the prototype does not silently revoke unrelated existing PUBLIC grants. Such an
actual baseline exposure is a failed qualification requiring a reviewed installation
profile correction. None of these checks authenticates accepted source or environment.

Private persistent run/batch/event state binds the real login, backend PID and start,
run/tenant/consumer and xid8. All API calls require READ COMMITTED and a writable
transaction. Native tenant standing and notifications purchases determine only an
upper bound; System tenant is excluded. Existing canonical environment kill levers,
settings, module resolver and notifications registry remain unchanged and are NOT
replaced by this upper bound. Scope completion comes from the native ledger, not
caller pagination. Batch selection joins actual pending receipts to source event,
tenant and sequence and takes SHARE locks while holding the legacy tenant cursor
transaction lock. It never filters by the old high-water cursor.

finish_batch genuinely commits an EMPTY admission and its native batch counter. It
refuses nonempty work with55000. There is no project, facts, prepare_assessment,
project_reward_account or finish_event capability in this stage. Thus no notification,
email outbox, reminder preparation, disposition or cursor can be written by this
prototype. Nonempty adapter admissions roll back; they are never called processed.
Native success requires all scopes settled with no pending work, no active batch,
unchanged native scope and an exact still-running fixed-key job_run CAS. Failure
accepts safe codes only and cannot overwrite terminal or another job's history.
All processed/created counters are truthfully zero while projection is absent.

A protected singleton lease supplements the session lock. Explicitly releasing an
advisory lock cannot admit a second run while its native predecessor remains active.
An unfinished admission cannot survive COMMIT: a deferred private constraint trigger
requires the batch to have been removed by settlement. Rollback releases admission
and source references. An abandoned run stays visibly incomplete and blocks new runs;
only fixture DBA cleanup is currently provided. Safe operational abandonment recovery
and retention remain required work, not an implicit worker authority to replay data.
No successful terminal update can overwrite a failed/finished run.

## Owner and qualification limits

The fixture requires a clean disposable ai_hr_test_w... database and its existing
job_run/domain_event relation owner. In the current hosted harness this is postgres;
only the new API/private state is owned by that existing fixture owner. It does not
create ai_hr_owner, reassign application ownership, add app-role SET edges or grant
new broad helper authority. Choosing/qualifying the final non-web native API owner
and its exact installed ownership/ACL graph belongs to root's guarded migration.
This is not proof that the proposed ai_hr_owner installation already exists.

Hosted tests exercise actual nonsuperuser LOGIN connections, forged valid GUCs,
temp/search-path shadowing, cross-backend/transaction/tenant selection, reconnect,
unknown/terminal runs, caps and real module change. They inspect native access,
reject direct HR/pay/role/settings/event/notification/job/DDL/helper writes inside
and outside admission, compare all-column source hashes, verify rollback and admit
a pending lower sequence after a higher legacy cursor. An injected PUBLIC mutating
definer, login-OID substitution and real role-profile drift must fail closed.
No local app/SQL/runtime/compiler/build checks have been run.

Required later chunks remain substantial: canonical pure registry/render/recipient
adapter extraction; fixed event-bound fact families; reminder hidden preparation
writes with both epoch checks; account Rewards projection; consent/outbox/effect and
receipt/cursor atomic settlement; nonzero native run counters; complete hostile
matrix/fault/parity tests; abandoned-run recovery; resource/retention commissioning;
guarded migration/profile and protected invocation/package/scheduler acceptance.
Existing combined sweeps, page catch-up and always-refusing scheduling prerequisites
remain untouched. No SMTP/provider call, staging or production deployment is authorized.
