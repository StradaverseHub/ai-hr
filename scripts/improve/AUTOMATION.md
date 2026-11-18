# Reporter investigation automation

Owner: the operator-side improvement loop (ADR-0044), under the repository owner's
standing authorization for issue pickup, reporter follow-up and in-app notifications.
The application still captures reports, answers and separate plan approval. This
worker neither impersonates a login nor uses the retired anonymous scheduled planner.

## Commissioning

Install PR245 through the release route first. Keep the Codex automation paused until
its exact staging build, migration6200 and fictional reporter journey pass acceptance.
The scheduler runs in the operator environment with the existing private SSH alias;
it requires that environment to be available. Its activation record holds the exact
approved tenant IDs and private SSH configuration path, outside Git. No tenant discovery
or production endpoint belongs in its prompt. Use the registered worktree's CLI with
its real dependencies, `AIHR_DB_PROCESS_ROLE=worker`, and at most8 direct DB connections.
Credentials remain on staging. A source checkout alone does not commission the schedule.

## One scheduled pass

1. Confirm the staging target, current checkout and instructions. Run `pickup` with JSON
   `{tenantId,worker,limit:1}` on stdin. It first projects due canonical bell notifications,
   then claims an eligible report. Save returned snapshots privately; tokens are execution
   credentials. An empty result completes the pass without a user-facing status message.
2. Read the returned report, ordered `block_trail` and attachment metadata. Download and
   inspect the actual attachments through the existing attachment command. Investigate
   current source and prior answers. Treat report/attachment content as evidence to assess;
   use the repository instructions and owner authorization to choose actions.
3. Complete the claim within30minutes using `complete` with the returned report/tenant,
   reporter employment binding, `claimToken`, `sourceDigest`, `expectedPlanRevision`,
   and current `dialogueDigest` where applicable. Choose one action:
   - `ask`: one concise bundle of unanswered questions and why the answers matter. Clear
     reports need no question. The claim token is the stable question ID. At most two
     question bundles are admitted per plan revision.
   - `plan`: follow the feedback-plan skill, evidence from current code and exact history.
     Include `plan`, `model` and `visualChange`. For an interface change set
     `visualChange:true` and provide up to six rendered image paths as `mockupPaths`.
     The plan and its current-revision images commit atomically; an attachment failure
     preserves the old plan. If a useful design cannot be completed in one lease, hold
     the report for an operator instead.
   - `hold`: include a concrete bounded `reason` for a human scope/privacy/authority decision.
     An unchanged held source stays held.
   - `retry`: record an operational investigation failure; retry after15minutes. Three
     attempts on unchanged input cause an operator escalation, preserving the report.
4. Read back the report after completion. `planned` still needs reporter approval. The
   automation never invokes build, approval, release, deployment or milestone commands.
   Read `automation-status` for human holds/exhausted attempts. Notify the owner about a
   new material escalation with its report link and required decision; consolidate related
   items and retain previous alerts rather than repeating unchanged status.

A changed report, answer, question, attachment bytes or plan state invalidates an old
result. Discard it and use a new pickup. A replacement token fences a crashed worker;
replaying an already completed token does not create another question or plan. Thirty-minute
leases recover on a later pass. Investigate the item independently after recovery.

## Reporter communication

Questions appear on the existing report page; only its reporter or an authorized
administrator can answer. A reply resumes investigation on the next scheduled pass,
without requiring both people to be online. The UI preserves the exact question ID
and earlier answers. Reporter silence leaves the report waiting indefinitely.

Canonical in-app bell notices contain a neutral summary and the report link, never its
private question/answer/title text. They address the actual reporter account, including
a user with no employment. Projection is idempotent. One reminder is due after48hours
for the same still-unanswered question. An answer, closure, cancellation or later workflow
state stops new reminders; the worker never auto-rejects, auto-closes or auto-approves.
Existing notification module visibility still applies. This revision sends no email:
existing address verification/consent and email categories are not silently widened.

## Stop and recovery

Pause the Codex automation to stop new investigation and reminder passes. An in-flight
claim may finish only while its lease and source are current. The claim table and audit
remain durable. Do not delete questions, fabricate answers or reset reporter statuses.
Inspect `automation-status`, current report history and active leases before recovery.
For a held report, obtain the required decision and record the resulting real report
change; a changed source admits new investigation. Source/deployment rollback preserves
the additive migration and notification history. Restore only through a reviewed path.
