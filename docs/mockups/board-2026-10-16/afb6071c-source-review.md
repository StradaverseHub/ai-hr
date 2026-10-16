# AI Responsive theme: planning evidence

Item `afb6071c-03d5-4f86-b43f-35c01f054937`, all brief/expected behavior/function text read from
`/tmp/aihr-board16-new-open.json`. No attachment was supplied. Source inspection at
`codex/board16-report-artifact@436a8e5d43189325cbc2b375fba911d4a8a7cfa1`.
This is a planning artifact, not product implementation or acceptance evidence.

The root independently reported production SHA256 equality to main for `app/assistant/page.tsx`,
`lib/ui-theme.ts` and `components/user-menu.tsx`. That establishes source provenance for those 3 files,
not authenticated rendering, production provider readiness, entitlement/grant state or successful AI use.
Other source below was read locally; its deployment state is UNKNOWN.

## Existing owners and concrete gaps

| Fact | Existing owner | Source observation and planning consequence |
| --- | --- | --- |
| Theme choices | lib/ui-theme.ts | Monolith, Classic, Current; browser cookie, validated closed union. New choice belongs here. |
| Persistence/first paint | app/ui-theme-actions.ts; lib/ui-theme-server.ts; app/layout.tsx | Server cookie + html attribute; no AI/session authority in a theme preference. Selection must not create grants. |
| Theme-aware shell | components/ui-theme-context.tsx | Server snapshot + html attribute subscription. A conversational shell can share the same axis; light/dark stays independent. |
| Account entry | components/user-menu.tsx; ui-theme-switcher.tsx | Theme picker is inside SIGNED IN AS/account menu. Keep that placement and current choices. |
| Current Assistant UI | app/assistant/page.tsx; actions.ts | Form submits one question, redirects and reads audited result. Last 10 own-user exchanges, newest first. Plain pre-wrapped text and raw tool names, not a session-aware chat. No live render claim. |
| Conversation execution | core/assistant.ts | Caller SessionContext, grant before provider lookup, closed tools, maximum 8 turns / 90-second exchange / 30-second provider turn. Starts fresh turns with each current question, so no cross-question context today. |
| Current lookups | core/assistant-tools.ts | 10 tools, all reads. Leave balances/requests/explanations; holidays; away/team leave; narrowed work profile; reporting line; released own payslip summary/pay change. No Attendance reader, general admin transactions, handbook or action adapter in this registry. |
| Tool scope/evidence | assistant-tools.ts; canonical reads | Module owners and actual caller context; explicit refusal/empty/truncation semantics. Work-profile tool excludes DOB/home/contact details. Payslip tools enforce released/self access. Do not widen them incidentally. |
| Navigation/search | components/sidebar.tsx; packs registry; lib/permissions.ts | Navigation metadata/labels differ from enforcement. SCREENS documents route guards; it is not permission authority. Nav visibility can fail open while domain reads fail closed. Guidance must prove actual reach through owners. |
| Global intent input | components/intent-bar.tsx; command-bar.tsx | Searches one command registry entry, Approval Delegation. It is not conversational AI or an arbitrary action executor. |
| Product guidance | core/knowledge-base.ts; lib/guide-catalog.ts; content/guides | Audience clearance is enforced in KB reads in addition to tenant RLS. Bounded searchKnowledgeArticles already exists; a guide tool can wrap it. Assistant-tools commentary about nonexistent search is stale; executable owners take precedence. |
| Provider/key | core/ai-config.ts; lib/ai | Resolves tenant active provider or environment fallback through the same governance. No new provider client/key in the theme. |
| Basic access | core/assistant-grant.ts | Existing assistant module + exact user's live grant; one does not replace another. Theme selection is only presentation. No new access/truth implied by this plan. |
| Existing cost/control | core/assistant.ts; core/ai-governance.ts; core/ai-management.ts; lib/ai/features.ts | Legacy assistant daily/monthly budgets and shared company/user/feature admission both exist. Root's shared basic policy must reconcile them explicitly for Home/theme; hiding a credit counter alone cannot satisfy the request if a second credit requirement remains. Do not bypass operational admission by a theme flag. |
| Consequential action | core/agent-actions.ts; app/control-tower/actions | One type: close_fixed_upstream, propose-only, cap 50. Exact reviewed verdict IDs, actual readiness predicate and existing resolution writer rechecked; returns closed/stale. Server route requiresAdmin. No general add-employee/allowance/import/process action registry exists here. |
| Proposal evidence | core/agent-proposal.ts | Measurement, facts hashes and outcome telemetry; best effort, its own transaction. Not durable user confirmation or business transaction authority. |
| Employee creation | app/admin/personnel/page.tsx; create-employee-dialog.tsx; new/create-form.tsx | Current labels Admin → Personnel Management → Create new employee; exact full route /admin/personnel/new. Uses shared fields and creates a Draft for separate completion/review. /personnel is the colleague directory, not the creation page. |
| Excel assistance | app/admin/personnel/import; lib/personnel-field-registry.ts; import owners | Actual template/Reference values/field definitions and existing parse/preview/apply workflow. No invented upload tool or caller form-prefill query contract. |
| Other specialised AI | core/report-ai.ts; pay-rule/Performance owners | Existing AI drafts use closed fields and canonical validators, remain human-reviewed. A theme must not turn draft-only functionality into a write. |

## One graph for the proposed experience

Actor/session/tenant → existing assistant access → shared basic policy/provider → current capability
catalogue → actual guide/read owner → bounded typed reply + source reference → shared conversation view.
No derived AI figure becomes a domain record. User and Person and Employment remain distinct; ambiguous
employees or companies are resolved through authorised choices before a lookup or proposed action.

A change request goes through missing input → exact typed proposal → deterministic validation → review
→ separate explicit confirmation → fresh scope/version/precondition checks → existing writer/workflow
→ actual result/domain event. Model output cannot create a permission, bypass an approval, declare a
transaction complete, silently choose a subject or submit an improvement request on the user's behalf.

The Home and theme surfaces share conversation identity, capability registry, basic admission and
evidence/result rendering. Theme is not an admission selector or a second assistant. Standard AIHR pages
remain canonical for forms/imports/payroll/statutory processing; a minimal navigation menu and Return to
conversation preserve reach. Existing unsaved-form navigation guards must cover a theme-triggered route
change. Context switch/logout must not restore or send another session's or revoked-scope old answers
to a provider as current evidence.

## Acceptance mapping

1. Theme/account selection and return: picker sketch; actual cookie/route/first-paint/unsaved-form check
   after implementation. All 3 existing themes and light/dark retain their routes and functionality.
2. Chat UI: desktop sketch; responsive layout, Enter/Shift+Enter/IME, pending and retry, session continuity,
   safe structured reply and local link tests required. No unnecessary dashboard cards or credit counter.
3. Guidance: current employee route shown; payroll period/EPF/EA route and prerequisites must be tied to
   current menu/form/guide owners and each actor's authority. No generic HR text asserted as product facts.
4. Information: existing 10 tools plus bounded owner adapters for requested domains. Every unsupported
   or absent safe reader is disclosed; test actual allowed/denied/self/team/financial/cross-company cases.
5. Actions: supported exception closure sketch; confirmation/invalidation/retry/partial outcome and audit
   checks needed. Employee/allowance/import/payroll requests use honest draft or normal workflow handoff.
6. Import/form preparation: use canonical shared descriptors/templates/validators; no silently executed
   file, missing required field or unsupported auto-fill. Review stays in the existing workflow.
7. Missing capability: mobile sketch; state unsupported, show available alternative and let user review
   an improvement draft before its existing submit/confirmation action. Nothing marked implemented.
8. Basic no-credit requirement: one shared root-owned policy, no new balance/counter/purchase/allocation.
   Existing access and necessary operational safeguards still apply and have useful unavailable states.
9. Existing app/theme parity: compare conventional routes, authorised links, forms and switches in actual
   app after implementation. No source-only inspection can establish this result.

## Static sketch inventory and review limits

- afb6071c-theme-picker.html: existing account placement plus fourth choice. Expanded alternatives are
  explicitly an illustration of dropdown contents, not a new duplicate theme selector.
- afb6071c-chat-desktop.html: normal conversation/guidance with actual verified local route names.
- afb6071c-review-confirmation.html: the single existing action's fictional before-confirmation review.
- afb6071c-chat-mobile.html: unsupported request with normal workflow and improvement-draft handoff.

All CSS is inline, system fonts only, no external assets, no script, no application write action.
Cool neutral/indigo tokens are reused from the committed Classic palette. App context: HR administrator
in a bright office completing a task; restrained light chat view, one text family, ordinary controls,
readable evidence and minimal navigation. Both themes/contrast/keyboard states remain implementation
acceptance targets; dark screenshot and actual contrast/viewport behavior are not verified here.

No browser/server/render was used. HTML was manually source-reviewed, not visually inspected. Parent
should render separate images at 1280 for desktop/picker/review and 390 for mobile, inspect wrapping/contrast,
then attach only reviewed images with the plain plan. No before screenshot was manufactured.

No application implementation, migration, tests, type check, database work, provider call, board push or
publication happened for this item. Product scope remains subject to the reporter's plan approval.
