# Development map

Use this index to find a change's owner and verification boundary. [CLAUDE.md](../CLAUDE.md)
and [repository policy](REPOSITORY-AND-ENVIRONMENTS.md) own working rules; this page does not
add mutation or release authority. ADRs describe decisions at their recorded date; read later amendments.
Tests below are starting points, not claims of a completed run or full coverage.

## Find the owner

| Domain | Entrypoints and public boundary | Canonical implementation | Example discriminating tests |
| --- | --- | --- | --- |
| Personnel and employment | [Personnel](../app/admin/personnel), [organization](../core/org.ts) | [compensation history](../core/comp.ts), [MY statutory profile](../localization/my/statutory.ts); current Workforce and Payroll admission remain distinct | [salary history](../test/basic-salary-history.test.ts), [historical correction](../test/information-correction.test.ts) |
| Payroll | [pack service](../packs/payroll/service.ts), [process actions](../app/payroll/process/actions.ts) | [kernel](../core/payroll.ts), [multi-company run owner](../core/payroll-run-group.ts), [period lock](../core/payroll-period-lock.ts) | [pay structure](../test/employee-pay-structure.test.ts), [resume selection](../test/payroll-resume-selection.test.ts), [EPF funding](../test/employer-bears-epf.test.ts) |
| Leave | [pack service](../packs/leave/service.ts), [web routes](../app/leave) | [leave owner](../core/leave.ts); dated eligibility, ledger and approval are separate facts | [mobile native journeys](../test/mobile-native-journeys.test.ts), [mobile history](../test/mobile-leave-history.dom.test.tsx) |
| Attendance and roster | [pack service](../packs/attendance/service.ts), [web routes](../app/attendance) | [attendance](../core/attendance.ts), [roster](../core/roster.ts) | [recomputation](../test/attendance-recompute.test.ts), [native transaction](../test/attendance-day-native-transaction.test.ts) |
| Claims | [pack service](../packs/claims/service.ts) | [claims owner](../core/claims.ts); preserve approval, reservation and payroll ownership together | [payout](../test/claims-payout.test.ts), [selected payroll scope](../test/payroll-claims-scope.test.ts) |
| Performance, rewards and lifecycle | [performance](../packs/performance/service.ts), [rewards](../packs/rewards/service.ts), [lifecycle](../packs/lifecycle/service.ts) | Start at each pack's service; follow its native writer rather than copying rules into adapters | [lifecycle native DB](../test/lifecycle-v9-db.test.ts); use the domain's current decision and fixture population |
| Native employee app | [screens](../mobile/app), [transport](../mobile/lib/api.ts), [server contracts](../lib/mobile-api) | [own-employment admission](../lib/mobile-api/request.ts), [command receipt](../core/mobile-command-receipt.ts), then the same domain service as web | [session admission](../test/mobile-api-session.test.ts), [mounted screens](../test/mobile-native-journey-screens.dom.test.tsx), [native workflows](../test/mobile-native-journeys.test.ts) |
| Assistant and AI learning | [Assistant owner](../core/assistant.ts), [model contracts](../lib/ai) | [native action owners](../core/assistant-actions), [governance](../core/ai-governance.ts), [release evidence](../core/module-agent-releases.ts) | [prompt release](../test/module-agent-prompt-release.test.ts), [conversation lifecycle](../test/assistant-conversation-lifecycle.test.ts), [retry accounting](../test/ai-evaluation-no-retry-bias.test.ts) |
| Identity and access | [session](../lib/session.ts), [authorization](../lib/authz.ts), [embedded login](../deploy/internal-auth/README.md) | [database context](../db/client.ts), effective SQL policies and installation provider selection | [embedded auth](../test/internal-auth.test.ts), [mobile session](../test/mobile-api-session.test.ts) |
| Time, presentation and distribution | [HR dates](../lib/hr-date.ts), [components](../components), [messages](../messages) | Reuse domain dates, authorized view models, existing renderers and package owners | Native/browser/rendered document checks establish different claims; measure the affected artifact |

Leave cycle dates and override vocabulary live in the pure [cycle policy](../core/leave-cycle.ts).
Leave, TOIL and historical imports share that implementation; outside callers keep using the pack
service. Ledger writes, working-day database reads and accrual orchestration remain with their existing
owners. [Cycle contract tests](../test/leave-year-cycle-override.test.ts) protect the public behavior.

Consumers import pack services where that is the repository's public domain boundary. Client components
receive thin typed projections; they do not import financial writers, server-only export dependencies
or an authority-bearing registry. Keep one writer for each business fact and one financial kernel.

## Trace authority and persistence

1. Identify USER, PERSON and EMPLOYMENT separately; record actor, tenant, company, scope and effective date.
2. Follow the actual route/action to its native owner and transaction. Identify lock order, idempotency,
   audit events and unknown-outcome recovery before changing a write.
3. Read [schema](../db/schema.ts) and the ordered [migration journal](../db/migrations/meta/_journal.json).
   Follow the full chain of policy/function replacements, not the first matching SQL text. Attest actual
   installed grants and app role when making a runtime claim.
4. Preserve historical identities, amounts, paid artifacts and applied SQL bytes. Allocate append-only
   migrations through [migration coordination](MIGRATION-ALLOCATION.md). A source reservation is not installation evidence.
5. Find every supported caller and output: web, native, Assistant, import, scheduled job, API and export.
   One adapter's passing test cannot stand in for another carrier.

## Before a fix or enhancement

Write one user-visible acceptance example and its independent expected result. Specify valid, denied,
missing, empty, zero, unknown, boundary-date and stale/concurrent behavior as applicable. Establish a
unique valid target and authorized positive control before a negative assertion. For money and scope,
prove the test rejects an actual wrong outcome; avoid renderer-to-renderer or helper-to-itself oracles.

Keep patches cohesive. A behavior repair, module extraction and package redesign should be separately
reviewable. Extract commands, queries, pure rules and presentation only when the boundary hides a
coherent responsibility. Preserve public interfaces and transaction ownership; file length alone is
not the acceptance criterion. Use small typed descriptors and exhaustive registries where they clarify
ownership; do not replace explicit domain admission with a generic mutation engine.

Models propose; deterministic authorized services adjudicate. Model/protocol/scorer/native-effect and
real-model quality tests establish separate claims. Preserve completed wrong trials and complete
attempt denominators. Missing, skipped, interrupted or unavailable evidence is never a successful case.

## Verification and documentation

For paid model evaluation, use the [commissioning guide](AI-EVALUATION-COMMISSIONING.md)
for spending ownership, private prerequisites, frozen case plans and independent evidence.
Ordinary no-model carrier checks do not measure model quality.

Use [hosted focused checks](ALPHA-STAGING-ACTIONS.md) for development and current
[CI policy](CI-STAGING-VERIFICATION-POLICY.md) for release evidence. Preserve original failures;
classify product, contract, fixture, oracle and environment causes before changing expectations.
An outdated-test claim needs the approved current contract and independent evidence.

Freeze the candidate and controller identities, fixture clock, actual runtime and artifacts. Let planned
checks finish, then rerun failed or invalidated areas according to current recovery policy. Tests,
production builds, native bundles, rendered views, model quality and installation acceptance remain
separate verdicts. Do not infer deployment permission from any of them.

Keep current instructions concise and link their canonical owner. Follow
[documentation maintenance](KNOWLEDGE-BASE-MAINTENANCE.md) for bundled guides. Give historical plans
and evidence clear source/date/status/successor context; do not silently rewrite original failures,
refresh guide digests without review or promote old chat memory to current product authority.
