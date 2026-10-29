# WP1: scheduled AI status verification

Scope: R1 and R22 of the [October review](ai-architecture-review-2026-10.md).
This is a source reconciliation and acceptance contract; merge, CI verification, installation and
staging acceptance are separate evidence on the package PR.

## Rechecked source

The review's `82f7c6570` observations were rechecked against canonical `57b3c9fd232618c4ac62eed60fd92388c6606119`.
A subsequent canonical update, `fa487eddc`, changes own-leave handoff/refusal copy and employee home tasks;
those changes are preserved in the candidate. They do not implement the scheduled-status changes below.

| Finding | Already fixed before WP1 | Remaining gap addressed here |
| --- | --- | --- |
| R1: nightly identity | Migration 0672 and `core/agent-principal.ts` provide a named tenant principal, no grants/login and attributed switch enablements. `core/readiness-nudge.ts` uses templates under that principal. | `core/input-triage.ts` still returns the same `notConfigured` flag for principal refusal and missing provider. Add closed `modelBlockReason`, retaining the old boolean for compatibility. |
| R1: misleading output | `scripts/review-sweep.ts` already says `[no model admission]`, rather than `[no AI provider]`. Six-locale `aiManagement.orchestratorHelp` already says scheduled drafting is not enabled. | Print the actual reason, avoid claiming an unread claim was clear, and persist aggregate triage counters and refusal counts in `job_run.result`. |
| R1: status | Principal admission still requires a current login (`core/ai-principal.ts`). | `core/control-domains.ts`, `core/control-tower.ts` and `core/ai-management.ts` still treat enabled switches/provider as scheduled model readiness. Distinguish fixed-template reminders from unavailable scheduled model drafting, in all six locales. |
| R1: company queue | Case reads already join the caller's RLS-visible employment/company. | `core/hr-orchestrator.ts` only matches the caller's exact `scopeDigest`. Add explicitly marked scheduled receipt metadata to the read model; keep manual receipts exact-scope and all people/counts scoped. |
| R22: other scheduled model callers | The AI gateway refuses the anonymous callers; no principal model allowance exists. | `scripts/anomaly-sweep.ts` still attempts hypotheses and reports missing provider, and `scripts/feedback-plan.ts` still enumerates/attempts every item. Explicitly retire these model steps. Keep deterministic payroll checks/recurrence and a clearly logged feedback-command no-op. Persist zero hypothesis calls and the retired-step batch count. |

No migration, provider change, new model allowance or tier increase is introduced. No tenant data is
used for training. Existing human decisions and owning services retain their authority.

## Acceptance checks

- `test/agent-principal.test.ts`: a real named scheduled pass; nonempty company and other-company cases;
  company-scoped rows/counts; same metadata receipt visible to company/group HR; foreign tenant refusal;
  no principal identity leaked through the summary; fixed-template versus unavailable model status;
  principal triage refusal before reading claims. The real scoped service views from that pass are rendered
  in six locales for both roles, with hosted-runner desktop/mobile captures.
- `test/input-triage-engine.test.ts` and `test/payroll-hypothesis-engine.test.ts`: real signed-in fixtures
  establish `no_provider`, distinct from `principal_not_admitted`, with zero calls/proposals.
- `test/scheduled-ai-status.test.ts`: deterministic anomaly evaluation and recurrence still run; the retired
  model step is never called; dry-run does no writes; the feedback command succeeds without touching an
  invalid database connection.
- `test/ai-management.test.ts`: a usable fictional provider and enabled switches cannot make scheduled AI
  ready; reminders show templates and the other two scheduled features show unavailable.
- Existing orchestration, canonical provider-source admission, management drift, agreement and six-locale
  screen tests remain in focused verification. The complete frozen candidate still requires the official
  GitHub Actions gate, compiler, production build, migrations and three browser engines.

Screenshots are rendered service/component fixtures, not an authenticated installation journey.
External provider connectivity, real tenant scheduled delivery, manual model-call history and production
are not verified by these checks. Staging installation/acceptance must bind the final source/build after
the shared staging owner hands back its window. WP3 follows this package; no other package is authorized
by this record.
