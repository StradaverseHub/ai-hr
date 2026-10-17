# System Testing acceptance journey

This is an unexecuted operator journey for approved9689f5d3. The fixture prepares fictional records; it does not record passes, feedback, screenshots, catalogue confirmation or release arrival. System Testing assignments never grant access to Personnel, Payroll, Attendance, Leave or another business module.

## Prerequisites and exact target

The coordinator must first integrate the real prerequisites and register0561_versioned_system_testing at idx561/when1791900000041. The migration source alone is insufficient. Provision this worktree's own real dependencies and private local environment through the normal coordinated process. No symlinked dependencies, production URLs, production runtime or real identity provider is accepted.

After union integration, review the instruction/source relationship for each affected bundled guide and freeze its reviewed source fingerprint. Do not regenerate fingerprints merely to make the check green. The current guide fingerprints intentionally become review-required when their source dependencies change. Root owns the five documented static Next compile keys and official release helper invocation. Missing compile evidence, mismatched source/catalogue and unreviewed guide changes remain unavailable for confirmation.

The closed disposable target is localhost5433 / ai_hr_board16_system_testing_browser, namespace b16systemtesting, app port3214. The operator provides ai_hr_app and a separate migration principal. The runner retargets only those local credentials to this exact database. Other tenants or an inconsistent prior receipt cause refusal. It never drops a database, kills an occupied port or repairs browser state.

From the canonical shell cwd, after an explicit resource handoff:

```sh
cd /Users/zenlam/Projects/ai-hr/.claude/worktrees/mainwt
node --env-file=../board16-system-testing/.env.local --import tsx ../board16-system-testing/scripts/dev-browser-system-testing.mjs
```

This entry owns both test slots and the dev DB lock. Do not wrap it in another both-slot lock command. The internal --held-lock-worker entry is for that coordinator only and proves the actual lock-holder ancestry. Preparation has separate migrate/seed/fixture watchdogs; the whole worker lifetime is at most45minutes, including preparation. All owned child process groups must disappear before shared locks release. Stop by creating ../board16-system-testing/scratchpad/board16-system-testing/browser.stop, or signal the coordinator once. Never kill the wrappers independently.

The fixture must exit cleanly twice and declare identical facts. The second run compares a bounded read-only Repeatable Read digest of the fictional tenants' stored business state, including instructions, assignments, executions, feedback and audit. It refuses changes rather than repairing them. An existing browser-manifest.json stops this initial runner: there is deliberately no resume/reset path yet. Preserve receipt/logs/database on failure and coordinate any separate continuation. --review-required is an alternative initial launch which deliberately omits compile keys; it cannot be combined with an already prepared target. Failed attempt source-identity receipts and log directories have unique IDs and remain preserved. The browser receipt binds its exact attemptDirectory.

The private browser-manifest.json binds the clean candidate, root, target, fixture receipt SHA256 and dev identity receipt SHA256. activeServiceVerified remains false and applicationAcceptance remains UNVERIFIED. A dev identity receipt is not a production Next artifact, health result or independent arrival proof.

## Prepared fictional graph

Read actual UUIDs from the receipt, never hardcode them in browser scripts. The primary and foreign tenants have canonical system_testing entitlement; the third tenant is canonically provisioned without it. Canonical provisioning owns the companies, profile catalogues and administrator Person/login. Only fixture login/grant rows are directly owner-written. Canonical Personnel owners create the employee testers and their reporting edge.

| Manifest actor | Actual identity and intended view |
| --- | --- |
| HR | Primary group HR, Person but no Employment; library/team/catalogue and optional own explicitly assigned testing |
| ScopedHR | Primary company HR with real Employment; no invented group-wide Feedback authority |
| TesterA | Actual employee login with shared, history and inactive assignments |
| TesterB | Actual manager login; independent shared assignment; manager of TesterA |
| UserOnly | Login with neither Person nor Employment; shared assignment and canonical user-only Feedback reporting |
| Empty | Login with neither Person nor Employment and no assignments; honest empty personal view |
| ForeignHR | Separate tenant group HR; cannot see primary guides, attempts, screenshots or Feedback |
| DisabledHR | Separate unentitled tenant group HR; module refusal before testing access |

The primary tenant also has a second company for scope controls. Shared is a published two-step local guide assigned independently to A, B and UserOnly. History has two canonically published instruction versions and an A assignment to version two, with no observations falsely attached to version one. Unassigned is a published master-only guide. Inactive is assigned to A but the current instructions explicitly disallow execution. Incomplete is a saved unfinished Draft, not a published instruction. The fixture creates no legacy versionless observation or historical baseline; genuine pre0561 upgrade behavior has its own isolated migration regression.

Use the actual dev identity chooser at /login (or its existing switcher) to select the exact manifest app-user ID; DEV_USER_ID defaults to HR only. Routes have no invented locale prefix. Use the existing language selector/NEXT_LOCALE for en, ms, zh, ta, th and vi.

## Browser actions and persisted effects to verify

1. HR opens /admin/system-testing. Initial reviewed catalogue preload must happen through this real authorized page, not a fixture writer. Verify the precise guide count/provenance and repeated refresh does not add versions or observations. If source review/compile prerequisites are not satisfied, verify explicit review-required and no accepted catalogue write. /admin/system-testing?tab=updates must show source/build context and honest coverage gaps, never claim those functions were executed.
2. Open Incomplete at /admin/system-testing/{caseId}. Save unfinished paired steps, reorder/add/remove with keyboard, reopen exact content, then attempt publication with missing objective/expected/permissions. Verify safe refusal and retained Draft. Complete valid controls and publish. Reopen and inspect immutable version, author and time; prior instructions must remain readable. Do not assert a failed publish rolled back an already successful Draft save: the UI expressly reports retained Draft state.
3. A opens /system-testing and Shared. Start an execution through the actual control, save In progress with concrete fictional observations, comments, defect and improvement notes. Refresh/reopen and verify the exact tester/version/attempt/revision. B then starts Shared and saves a different honest status/observation. Verify independent state and personal summaries; A must not read or edit B's execution through a copied URL.
4. Keep A's older form open in a second tab. Save in the first, then submit the stale second form: expect stale refusal with no appended observation. Start a new attempt and try the old attempt again. HR publishes a changed Shared instruction version; old passes/results stay historical, targets become retest-required, and stale instruction submission cannot become a current result. New execution must bind the new exact version. HR team review at /admin/system-testing?tab=team stays read-only and filters by actual tester, module, function, category, priority and status; no impersonated saves.
5. UserOnly records a genuine failed/partial observation and explicitly raises a defect via the existing confirmation action. Verify a single canonical Feedback request with actual reporterUserId and NULL reporterEmploymentId, exact execution link/event and unchanged retry. Raise improvement separately and inspect its own link. Do not borrow A's employment. HR/group-wide review may read it; ScopedHR cannot read another user's no-employment Feedback or corresponding audit merely because the subject is NULL. Use the existing Feedback lifecycle to reach a real fixed/deployed state only when justified; then explicitly Request retest. A fixed Feedback item does not automatically mean a passing test. Re-observe before choosing Passed.
6. Save an observation, capture an actual browser screenshot during this window, upload through the execution UI and reopen/download it. Verify filename/type/byte bounds, ten-file limit, unavailable wrong-type/oversize control, origin protection and foreign/unassigned download denial. An uploaded test image alone is not visual evidence that the screen worked. Preserve actual screenshots with their exact source/version/attempt identifiers and inspect console/server logs.
7. Open History's prior instruction version from its version list; it must not change the current editor CAS or imply old execution history existed. Verify Unassigned is unavailable to A and the inactive guide offers no executable promise. Empty sees an honest empty personal queue. DisabledHR gets module refusal; ForeignHR copied primary URLs remain unavailable. Test direct public actions/attachments under restricted roles in the dedicated DB regressions too; visible controls alone do not prove authorization.
8. Catalogue preview/confirm must bind the exact current preview hash. Exercise repeat confirmation, locally edited guide conflict and explicit keep/replace decisions through canonical authoring. A source/catalogue update, missing-entry behavior and inherited legacy mapping need a separately reviewed frozen candidate or the genuine upgrade fixture; this initial browser fixture does not forge source revisions or legacy history. Confirming unavailable/unreviewed entries must refuse. No source file changes are allowed during a frozen browser run.
9. Repeat representative editor, personal save/refusal, team review and feedback flows in all six locales. At390px mobile and desktop, light/dark, use keyboard-only focus/tab/reorder/add/remove, wrap long notes/IDs, read errors without horizontal clipping and inspect accessible labels. Keep user-authored fictional text distinct from application translation coverage. Inspect actual empty/refusal/loading states; source translation-key presence is not locale acceptance.
10. Stop the owned server and prove both slots+DB released only after cleanup. Capture final clean candidate/manifest/log identities and independent restricted readback of actual cases/versions/assignments/runs/attachments/Feedback/audit. Do not derive a newest result from arbitrary row order; use exact IDs and recorded ordinal/revision. Official types, actual app-role SQL/security/upgrade/concurrency regressions, production build, release publication and independent arrival remain separately required.

## Prepared limits

No command above has been executed for this checkpoint. Fixture/source parsing is not a test, type check, DB migration, browser proof or Linux proof. The initial runner has no safe resume course, screenshot files are not fabricated, and genuine old instruction history is not backfilled. The24 reviewed guides have explicit source-owned coverage gaps; this does not assert exhaustive human execution of every installed function. Parent must complete final union fingerprint review and release wiring before claiming initial preload acceptance. Approval, deployment and board completion remain root-owned.
