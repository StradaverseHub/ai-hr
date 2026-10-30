# Central provider masking and review gate

Status: implemented candidate; specialist disclosure approval PENDING; not installed.
Date: 30 October 2026.
Decision owners: repository owner and the specialist who approves each disclosure policy.

## Context

The owner requested both mandatory masking and a review gate, then explicitly required useful analysis across AI features. Prior `redactPII` was opt-in pattern replacement and did not remove names, stories or image identities. WP12 inventory records disclosure; it does not enforce it. This package changes the single gateway and actual native transports. It has no migration or deployment action.

## Decision and data flow

```text
native source owner checks module/person/company access
  -> closed task-specific projection, private original fingerprint
  -> source-owned aggregate bands / per-request aliases
  -> fixed system + minimized JSON, no raw question/history/tools/provider state
  -> exact complete outbound request digest
  -> current specialist review of exact transformation sources
  -> canonical provider/principal + ALL prior source checks + same-transaction native replay
  -> existing quota/spend admission and accounting
  -> one-use opaque disclosure + exact native serializer permit
  -> provider explanation (untrusted; no source or decision authority)
```

`preparePrivateAiAnalysis` accepts only a genuine configuration issued by the canonical governance owner and a trusted native source reader. It is an internal source-owner API, not a server action accepting browser facts. The reader must perform its domain permissions every time. Preparation and admission replay both occur under fresh provider/principal checks. Every existing admission check, lifecycle and spend-root binding composes; no prior check is removed. Canonical config derivations share one-use disclosure state. Copies, serialized values, changed sources, stale reviews, changed requests and disposed capabilities refuse. Review is checked before reservation and again before dispatch. Native adapter SDK entries and the final OpenRouter POST cannot be called directly to bypass the gateway.

The current central analysis entry point generates a fixed-input draft from the aggregate schema. It does not retrofit arbitrary existing prompts or create new business permissions. Existing source owners still need to adopt this API with actual native derived facts before their individual feature paths become usable under the gate. The candidate intentionally refuses legacy unbound workloads; shipping it without the adoption and review work would disable those external AI paths. Native non-AI workflows remain the route while a variant is unavailable.

## Useful analysis contracts

The shared aggregate comparison contract covers workforce/personnel, attendance, leave, payroll, claims, performance, rewards and organisation. AI can compare previous/current periods, compare generic cohorts, explain coarse source-derived changes, and distinguish recorded contributors from associated changes. All calculations and evidence relationships come from the authorised native owner. AI never calculates authoritative pay or assigns ratings/decisions. Numeric population/support counts are used locally for suppression, then emitted as coarse bands. Monetary amounts, actual dates, private labels, names, IDs, narratives, documents and images are absent. Source-defined metric/driver/category enums are feature-specific, not caller-invented labels.

The attendance-specific candidate preserves consistent random person aliases over relative periods and categorical bands. This supports within-person comparisons but exposes more relationships than aggregate-only analysis, so it is separately pending review. Selector-only canonical records remain explicitly marked as selector-only; they are not presented as analysis.

Utility fixtures assert independently expected retained comparisons in all eight domains. Payroll/claims fixtures retain relative cost/volume changes and supplied relationships without exact amounts. Workforce/performance/rewards fixtures retain completion, progress and workload categories without individual assessments. These prove transformation utility on synthetic inputs, not model task quality or installed acceptance.

## Feature coverage and honest limits

| Registered features | Closed analysis candidate | Existing variants still blocked |
| --- | --- | --- |
| hr_assistant, report_insight | All eight aggregate domains; fixed-input draft API | Raw questions, histories, arbitrary tool results, narrative report requests |
| readiness_reminders | Workforce/organisation aggregates | Legacy prompt dispatch until adopted; existing local templates do not require a provider |
| claims_triage | Claims aggregates | Individual descriptions, receipts, personal exact amounts |
| payroll_hypotheses, payroll_explanation, pay_rule_draft | Payroll aggregates | Legacy hypothesis prose, exact-amount narration, arbitrary rule drafting |
| performance_360, performance_tc, performance_pm, performance_review, performance_idp | Performance aggregates | Individual feedback, remarks, aspirations, ratings, attachments/images |
| performance_calib, performance_assistant | Performance/rewards aggregates | Named rosters, raw commands and original text-span transformations |
| provider_evaluation, module_agent_evaluation | No business-analysis candidate | Existing synthetic protocol paths need their own exact approved synthetic contract |
| personnel_import_mapping, module_agent_planning, feedback_planning | No safe aggregate fit | Headings, raw import cells, user instructions and pasted feedback/logs need separate transformations |

Every current registered feature appears in the runtime coverage registry, including explicit refusals. A feature's presence is not approval. New or incompatible feature/domain/operation/payload combinations default to refusal; there is no raw fallback. This is a central boundary with useful multi-domain candidates, not a claim that all 19 existing AI feature paths are already migrated or fully operational.

## Review and activation

All three disclosure records are PENDING. Tests deliberately simulate an approved record only to verify transport/source custody and accounting; those tests cannot activate production or fabricate a specialist receipt. The source reviewer must record identity, evidence, approved contract ID and the exact `PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST` in `provider-data-reviews.ts`. The generated digest covers transformation code, coverage/dependency enums, canonical source preparation and gateway/egress ownership. Static manifest checks detect any change. A schema-shape hash alone is insufficient. Per-request callers cannot supply `reviewed:true` or choose their own thresholds.

Before approval, examine necessity/utility, reidentification and differencing risks, cohort memberships/overlap, the native owner's calculation and authorization proof, all supported locales, unknown-field refusal, complete request surfaces, and provider-purpose/retention policy. Population >=20 and every nonzero slice >=5 are provisional suppression controls, not anonymity guarantees. Relative bands can still be sensitive or reveal a person with external knowledge. Review must evaluate whether a particular native use needs stricter suppression or should remain local. Raw text/images are not sanitized by asking a cloud provider to sanitize them.

There is no human specialist, legal, retention, provider-training-policy or rollout approval in this source package. No installation or configuration is changed. Review activation and native-caller adoption must be explicit follow-ups on concrete source; do not mark pending as PASS because tests passed.

## Options and consequences

- Review-only preserves current usefulness but permits unmasked external disclosure; rejected after the owner's change of direction.
- Regex-only is insufficient for arbitrary names, stories, private labels and images; rejected.
- Closed minimization plus exact source review and native transport enforcement is chosen. It supports reviewed structured analysis and fails closed where safe utility has not been established. It requires more native-owner work and can intentionally make unsupported provider features unavailable.

Provider usage already observed by trusted adapters is preserved even if completion validation fails. Unknown/uncertain monetary exposure remains held; privacy refusal must not invent zero cost or refund a charged call. Fixed operational credential/model probes remain data-free and governed by their existing issuer; a probe permit cannot POST a workload. No credentials were inspected or real provider calls made during development.

Guidance: [OWASP sensitive information disclosure](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/) and [NIST SP 800-188](https://csrc.nist.gov/pubs/sp/800/188/final). Minimization and governance both matter; this record makes no anonymity or legal adequacy claim.
