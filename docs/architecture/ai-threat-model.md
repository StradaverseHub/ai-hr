# AI threat model

Reviewed 29 October 2026 against integration base `b5758c54c431765461d84235ad19c72ad71cf578`.
This is a source-backed model of the current boundaries and residual risks, not a penetration-test,
provider-privacy certification or staging acceptance. [ADR-0084](../adr/0084-propose-adjudicate-learn.md),
[ADR-0116](../adr/0116-central-ai-inventory-and-allowances.md) and
[ADR-0151](../adr/0151-orchestrator-action-layer-and-system-learning.md) own the decisions.

## Assets, actors and trust boundaries

Assets are tenant/company HR data, identities and grants, provider credentials, AI budgets,
prepared-action custody, human confirmations, canonical HR facts, receipts and evaluation integrity.
Actors include the signed-in employee, assigned approver, company HR, group HR, the platform operator,
an attacker controlling record text, an external provider and a future named scheduled principal.
USER, PERSON and EMPLOYMENT are distinct; an employee identity is never inferred from a submitted UUID.

```text
browser human command → authenticated current login → tenant transaction + RLS → owning HR service
Assistant model proposal → closed parser → deterministic preparation → human digest-bound confirmation
authorized minimized prompt → governed gateway → external provider → deterministic output adjudication
operator maintenance → separate privileged runtime → expired AI custody only
```

The model is untrusted. Its output, employee text, tool results, uploaded content and retrieved KB text
cannot grant authority, add registry entries, name an actor or count as confirmation. The app-role
connection must remain NOSUPERUSER/NOBYPASSRLS; owner connections belong to maintenance, never model tools.

## Threats and controls

| Threat / abuse case | Current control and source owner | Residual risk / required evidence |
| --- | --- | --- |
| Cross-tenant or cross-company extraction using invented subject IDs | `db/client.ts` transaction-local context and RLS; existing scoped reads in `core/assistant-tools.ts`; fresh principal/source checks in `core/assistant-actions/*` | Test actual app-role denial with another tenant/company and revoked grants. An offered tool is not authorization. Avoid secondary stores with copied ACLs. |
| Record or tool-result injection asks for salary, new actions or confirmation | Closed tool/action vocabularies, argument schemas, caller-owned reads; untrusted-data framing in the Assistant system prompt; human commands outside the model loop | Framing is incomplete in embedded performance/triage prompts (R11/WP5, held). Model prose can still be misleading within scope; do not claim injection is eliminated. Test malicious free text, ambiguity and salary leakage for each entry. |
| Unauthorized employment, pay, approval or access effect; replay after timeout | Owning service authorizes; prepared review binds actor, subject, intent and reviewed digests; sealed body, expiry and canonical receipt; completed retries reconcile rather than repeat | Confirmed submission is not approval. Exercise stale input, concurrent/replayed confirmation and uncertain commits. Generic per-entry parity coverage is still WP8. Never-Automatic categories remain fixed code policy. |
| Gateway bypass or spend abuse | `lib/ai/index.ts`, `core/ai-governance.ts`, admission reservations, switches, pause, cumulative company/login allowances, bounded calls and optional monetary policy | At this base, missing governance still bypasses admission (R9; separate WP4 candidate). Workload requests must fail closed; explicit connection probes must be metadata-audited and unable to run workloads. Older Assistant budget reservation/time-boundary weaknesses remain R11. |
| Provider credential disclosure, retargeting or SSRF | Tenant-bound encryption in `lib/ai/crypto.ts`; no normal ciphertext read grant; provider snapshot rechecks; bounded public HTTPS gateway address and explicit OpenRouter routing | Recheck exact provider/model/routes on admission. Key/model connectivity does not establish privacy terms, tool correctness or production data-transfer acceptance. No secrets in events, URLs or diagnostic logs. |
| Excess PII sent to a provider or retained in chat | Feature-specific prompt construction, `redactPII`, metadata-only `ai_model_run`; transcript and custody retirement owners | `redactPII` does not mask names. Conversation deliberately sends the caller-authorized transcript/tool payload without global redaction. Provider data minimization is per feature; a complete data register remains R21/WP12. No training or fine-tuning on tenant data is permitted; code cannot prove a provider's contractual handling. |
| Retention silently fails | Bounded `scripts/ai-retention-runner.ts` maintenance, expired-only DB functions, privileged immutable maintenance bundle; `deploy/systemd/AI-RETENTION.md` | Read-only staging check on 29 October found `aihr-ai-retention.timer` **not installed** (`LoadState=not-found`, inactive). A 30-day retirement rule in source is not a live retention guarantee. Release owner must install and verify service passes/backlog through the documented operator path. No installation was done in this review. |
| Anonymous job or scheduled principal gains interactive powers | Current no-login model admission fails in `core/ai-principal.ts`; templates or refusal apply | Named tenant principal is separate in-flight PR #41, not merged at this base. It must not sign in or impersonate a login; only Automatic entries, tenant-bound enabling administrator and attributed effects. Model spend remains an owner decision; this package grants none. |
| Poisoned evaluation, self-promotion or cross-user learned memory | Versioned candidates, independent held-out evaluations, author/promoter separation, job/time bounds, source/provider fingerprint and fallback | Current promotions are per author; promoter may also be an evaluator; routing comparison cannot produce a win; some modules are test-only. R5/WP11 remains held. Do not claim measured-regression rollback or broad replay coverage. No cross-tenant aggregation, learned permissions or reused private memory. |
| Operator improve loop bypasses product governance | Separate operator authorization and private tooling; output is reviewed source/plan work, not a model tool in the HR session | Out-of-band loop is not covered by tenant gateway quotas/inventory. Operator credentials and production text must remain private; do not treat that loop as an autonomous in-product actor. |

## Verification and operational ownership

Focused security/confirmation suites, then the impact-selected gate, establish candidate behavior;
rendered six-locale desktop/mobile checks establish the changed experience. Neither establishes installation.
Preserve exact-commit receipts, original failures, provider/network limits and fixture scope in each PR.
No training data, real credentials or raw employee records belong in holdouts or public artifacts.

The release owner controls retention installation, migrations and staging acceptance. Missing timer,
failed/missing service passes or an aging cleanup backlog require operator action under
[AI-RETENTION.md](../../deploy/systemd/AI-RETENTION.md). Provider/model changes and new automatic authority
require their own reviewed acceptance. This threat model authorizes no deployment, switch change,
principal enablement, data transfer to a new provider or relaxation of HR approval rules.

## Release integration update — 29 October 2026

Canonical `46049dead` includes the named tenant principal, HR-prepared actions and outcome measurement.
The named principal remains a non-login actor without model-spend admission; only attributed configured
specialists run under it. The candidate now enforces gateway admission and runtime tier ceilings,
including the merged own/assigned action families. Earlier source-base residuals above are historical
observations; scheduled status, generic parity and the remaining learning/inventory packages remain
separate work. Retention installation and actual service behavior still require independent verification.
