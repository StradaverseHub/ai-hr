# Job pack presentation snapshots

Date: 7 November 2026
Status: Source decision; qualification and release evidence are separate

## Context and verified scope

At base `d8192a8429ff472869716f3d1d7021c725bb9b71`, Job Descriptions' `jobTenant` takes the exclusive Access configuration advisory barrier for both display reads and commands. Architecture's `tenant` does likewise; its navigation courtesy query takes the shared barrier. Ordinary display queries consequently wait for a concurrent Access writer despite requiring no effect authority.

Job Descriptions has live source routes in `app/admin/job-descriptions`: list, new, detail, configuration, print, text export and attachment download. This is source evidence, not a claim about a deployed installation. Architecture has no application/core consumers of its service at this base. Migration `2300_retire_job_architecture_workflows.sql` retired its application workflow writes and employee publication function. Its retained SELECT privileges, seat/RLS predicates and separate Rewards reader do not authorize recommissioning those entry points. Architecture coverage here qualifies retained source display contracts only.

## Decision

Only the following standalone presentation roots own `withTenant(..., {readOnlySnapshot:true})`, establishing PostgreSQL REPEATABLE READ / READ ONLY at BEGIN. They do not acquire the Access advisory barrier. Each owner captures a structured clone of the calling SessionContext before the first asynchronous boundary. The document page reader also copies its mutable filters before opening its transaction.

| Pack | Admitted display roots | Borrowed queries and authorization retained |
| --- | --- | --- |
| Job Descriptions | `getJobMasters`, `getJobForm`, `readJobDocument`, `getJobDocumentPage`, `listJobDocuments`, `downloadJobAttachment` | `actor`, `scope(...,'view')`, `definitionTx`, `getTx(...,lock=false)`, filters, actor-label and reviewer predicates, tenant/company native RLS |
| Job Architecture | `architectureWorkspace`, `architecturePeople`, `architectureSeatList`, `canViewJobArchitecture` | `workspaceTx`, `catalogueTx`, `authority(...,'view')`, current-seat/company predicates, Workforce employment predicates, group-admin seat-list check and native RLS |

The existing `isAiPresentationPrincipalCurrentTx` proves a fresh login within that same snapshot: real tenant/user/person binding, current roles/grants, unarchived/unblocked login and native RR/RO carrier. Its name is historical; it grants no AI/provider, module, subject, company, seat, disclosure or effect authority. This change imports it without moving or changing its implementation. A false proof uses the pack's existing denial error; database failures propagate and roll back. Synthetic effect/exemption contexts cannot become presentation authority.

This is point-in-time display authorization. A reader can finish against its established snapshot while a concurrent access revocation remains uncommitted. A later read must observe the committed revocation and refuse or narrow its projection. Presentation data is never an admission or permission receipt for an effect.

## Ownership that stays serialized

`jobTenant` and Architecture `tenant` retain their existing Read Committed exclusive Access barrier. Document save, form configuration, review/transition, attachment upload/removal, Architecture configuration, proposals, checking, scan, outlier updates, import preview/commit and AI provider/admission/settlement paths keep their locks and freshness rules. No write, RLS policy, SQL function, schema, migration or provider contract changes.

`workspaceTx` is a query-only borrowed helper, not a transaction owner. It performs ordered SELECTs, pure projection/hash calculations and no row locks, events, writes or provider calls. Its command callers still receive the command's existing transaction. `gradeBindings` and mutation helpers using FOR SHARE/FOR UPDATE never enter the new presentation owners. Document reads use `getTx` with its existing false locking argument; command callers retain true.

`approvedPositionArchitecture` and `architectureAdviceForDraft` retain their source/admission barriers. Their contracts prepare movement proposals or accepted advice for a draft, and their freshness must not be silently relaxed by reusing the display owner. `ownArchitectureJob` is untouched: migration 2300 revoked the application's native employee-publication function permission. Its existence in source is no ordinary live display root.

## Verification contract and limits

`test/job-pack-presentation-reads.test.ts` exercises all ten admitted roots against independently known nonempty document, form, attachment, company, position, people and seat records while an actual exclusive Access writer deletes the caller's role inside an uncommitted transaction. It checks native RR/RO modes, unchanged event rows, command advisory-lock waiting, refusal after the revocation commits, and the unchanged document title. All pending reads, command and writer settle in cleanup before fixture reuse.

Additional cases inject a real privileged table UPDATE into every completed display transaction and require PostgreSQL SQLSTATE `25006`; reject forged role/login/person/tenant and effect contexts; enforce native company and current-seat boundaries; mutate captured session/filter objects; and require both preserved source contracts to time out on the actual held Access advisory lock. Existing document owner tests retain review/approver/history and attachment behavior coverage. Their linked-person fixtures now supply the real person binding, and the impossible cross-tenant login case expects explicit refusal.

The focused test manifest identifies the requested hosted checks. The integration owner dispatches them on standard GitHub-hosted runners against the frozen candidate. Source inspection and authored assertions are not passing runtime evidence.

This removes one presentation lock dependency only. Workspace companies, positions, employees, outliers, publications and master choices remain unbounded as before; proposals and suggestions retain their existing 200-row bounds, document summaries their 50-row page/count semantics, and document detail its existing history/attachment behavior. No pagination cursor, parallel query orchestration, query result meaning or ordering changes. There is no measured latency or universal module speed claim. No staging/production deployment or retired workflow activation is authorized by this decision.
