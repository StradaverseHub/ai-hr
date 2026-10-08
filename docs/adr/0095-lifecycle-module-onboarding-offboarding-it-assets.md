# ADR-0095 — The Lifecycle module: employee onboarding and offboarding, IT requisitions, the asset register and asset requests

- **Date:** 2026-10-08
- **Status:** Built on branch `claude/chgb-onboarding-assets-module-c5e840`, not merged, not deployed. Migration 0516.
- **Source:** the CHGB handover package (`CHGB_Onboarding_IT_Assets_Handover`, 7 October 2026): a brief, field dictionary, API reference, email templates, reference data, an 84-step UAT guide and the proof-of-concept source. Everything below marked FACT was checked in that package or in this repository; everything marked ASSUMPTION or DECISION REQUIRED was not settled by it.
- **Related:** ADR-0018 (the first-login product tour, which is a different thing), ADR-0042 (resignation workflow), ADR-0077 (entitlements), ADR-0080 (module packs), ADR-0030 (no PII in events).

## Context

CHGB asked for five modules to be replicated on this platform: **Onboarding, Offboarding, IT Requisitions, Asset Requests and the Asset Tracker.** Joiners start without a laptop or accounts and leavers keep devices and access because the steps live in different teams' heads. The modules make every step visible, owned and dated.

"Onboarding" already exists here and is unrelated. `core/onboarding.ts` is the first-login product tour for a system user (ADR-0018). This module onboards an **employee** to the company. Nothing here touches `app_user.onboarded_at`. All names (`lc_*`, `it_*`, the `lifecycle` pack, `/lifecycle`) avoid the collision.

## Graph (what the module is)

| Concept | Owner | Notes |
|---|---|---|
| Business group (BG) | `company` | The handover's BG codes (CHGB, CHGP, SIGN…) are companies. No parallel BG list. Per-BG behaviour keys off `company.company_label`. |
| Case (onboarding / offboarding) | `lc_case` | Holds the new hire's own details; `person_id` and `employment_id` are optional links, never a copy the other way. A new hire has no employment until HR creates one. |
| Step definitions | `lc_step_def` | Configuration. Built-in CHGB lists are the defaults until an admin edits. |
| Requisition (Requisition / Return / Standalone) | `it_requisition` + `it_requisition_item` | L1/L2 approval trail by company (0, 1 or 2 levels). |
| Asset and its holder | `it_asset` | The current-user fields are the single owner of "who holds this". Issuing and returning are the only writers of them. |
| Asset request | `it_asset_request` + `it_asset_catalogue` | Forward-only fulfilment, only after approval. |
| Module staff | `lc_staff` | The handover's Agent and Manager roles. Admins are staff at level 3 implicitly. |
| Timeline | `lc_history` | Readable history, written in the same transaction as each change. The `domain_event` ledger carries the audit. |

Hand-offs, all in the caller's transaction (both records exist or neither does): onboarding case creates its requisition; outcome Accepted creates one IT Return; Accepted to Rejected cancels the open Return; Rejected to Accepted creates a new one; marking *Issue Laptop* done with an asset code issues that asset; marking a Return's *Device Received* returns the holder's asset.

## Decisions

**D1. Authorization is the module's own staff table, not line management.** The handover's Agent and Manager are IT and People staff, not line managers. Letting any `manager` role-holder approve IT spend or fulfil requests would be an authorization hole. `lc_staff` names them per company; `app.lc_level(company)` returns 0 requester, 1 agent, 2 manager, 3 admin and is used by both the RLS policies and the service, so the two cannot disagree. FACT: verified by tests that assert refusal from both layers (an admin session passes RLS, so a refusal there is the service's rule).

**D2. Separation of duties the handover does not state.** Nobody approves a requisition or request they raised; level 2 must be a different person from level 1. ASSUMPTION: the handover only says "approval chains cannot be skipped". Both rules are in `core/lifecycle-rules.ts` and tested.

**D3. Approval gates completion and device issue, not the other checklist items.** ASSUMPTION: the handover does not say whether items can be worked before approval. Work may start; a requisition completes only when every item is resolved and it is approved, and *Issue Laptop* with an asset code needs approval first. Reversible by changing one function.

**D4. Resignation outcome decides which checklist applies; it does not end employment.** Termination stays owned by the resignation workflow (ADR-0042). Two competing owners of "this person is leaving" is the failure to avoid. Linking an accepted resignation to an offboarding case automatically is not built (DECISION REQUIRED below).

**D5. New-hire self-service is login-gated, and the Device Acceptance form is not a public link.** The handover uses a public tokenised link. That would add an unauthenticated route to an application whose perimeter is deliberately closed (middleware: only login, callback, invite and reset-password are reachable signed out). The new hire sees their own checklist and submits the acknowledgement from a signed-in screen. Two `SECURITY DEFINER` functions are the only door: the match is the signed-in user's own person email against the case's new-hire email, the read returns a fixed allowlist of fields, and the single write is refused unless a laptop is required, was marked handed over, the case is in progress and nothing was submitted before. Verified: the new-hire payload contains no identity number, bank detail, cost centre, notes, custom fields or staff names. DECISION REQUIRED: if CHGB needs a link that works before the new hire has an account, that is a perimeter change for the owner.

**D6. There is no email transport in this repository, so the reminder emails are replaced by a live worklist.** FACT: `core/notifications.ts` documents in-app delivery only and a guard test pins that. A "last working day reminder email" cannot be built truthfully. `lifecycleWorklist` computes the four prompts (last working day, onboarding start, approvals waiting, warranty and lease dates) on read, with the handover's windows. It is always current, stops the moment the work is done, and cannot claim a message was sent. The email log and templates in the handover are not built. DECISION REQUIRED: a mail transport is a vendor and cost decision; if added, the worklist queries are the digest content.

**D7. Configuration is data with built-in defaults.** Reads fall back to the CHGB lists in `core/lifecycle-defaults.ts` while a tenant has no rows; the first admin save materialises the rows; "Load reference data" writes them explicitly (idempotent). A step key is permanent; a removed step is deactivated, never deleted, so steps already ticked stay in the case history. Per-BG extra fields are admin-defined custom fields scoped to chosen companies, seeded from the handover's per-BG lists.

**D8. Display numbers are per-tenant counters.** `ONB-0001`, `OFB-0001`, `ITR-0001`, `AR-0001` and asset codes `COMPANY-TYPE-0001`. A `SECURITY DEFINER` function takes the next number so a plain employee raising a request needs no write grant on the counter table.

**D9. Staff-only fields stay staff-only.** RISK: the identity number on a case is a pre-hire intake copy, not the owner. The employee's statutory record (`employee_statutory_my`) becomes the owner once HR creates the employee, after which the case copy is a stale duplicate of personal data. It is plain text, like the existing employee identity column (no regression), and it is never shown to the new hire. Clearing it when a case completes is recommended and left to the retention decision (open decision 7). Identity number and cost centre are in `lc_case` for staff; the CSV export masks identity numbers to their last four characters and omits cost centre and notes; event payloads carry references and field names, never values (ADR-0030, pinned by the existing PII guard).

## What the handover asked for that is NOT built, and why

| Item | Status |
|---|---|
| Email log, resend, SMTP, receipt email | Not built. No transport exists (D6). |
| Public Device Acceptance link, e-signature, stored PDF | Not built (D5). The handover itself lists e-signature as open. |
| Print Tag (asset label) | Not built. A print format needs a layout decision; the asset page carries the data. |
| `@FirstName` comment notifications and the notification bell for cases | Not built. The comment is stored; notifying needs the notification engine's recipient resolver. |
| Global search across cases | Not built. |
| Mobile app (React PWA in the package) | Not built. The responsive web screens cover staff and new-hire use; the platform's own native app (ADR-0088) is the mobile surface. |
| Offboarding "retention" e-letter generation | Not built. The handover treats these as ticked steps; so do we. |
| HRMS sync for steps marked HRMS | Not built. They are ticked by hand, as in the proof of concept. This platform IS the HRMS, so linking those steps to real records is the natural next step (DECISION REQUIRED). |
| Deactivation blockers for the module (open cases stranded when it is switched off) | Not built. `core/module-deactivation.ts` lists blockers per module; none is declared for this one. |
| Daily scheduled job | Not built; replaced by the worklist (D6). |

## Open decisions for the owner (DECISION REQUIRED)

1. Step lists, owners and approval levels in the checklists: HR, IT and the People BPs (handover section 13). The defaults ship; they are editable.
2. Whether an accepted resignation should create the offboarding case automatically, and whether the HRMS-marked steps should become real actions (D4).
3. Whether a public acknowledgement link is wanted (D5), and whether it needs a real e-signature and a stored PDF.
4. Whether a mail transport is to be added (D6).
5. Who maintains the request catalogue (any module manager can today; the handover asks for a screen, which exists under Module Config and for managers' first load) and whether agents, not only managers, may fulfil requests. Today fulfilment is manager and above.
6. Whether cancelling an onboarding case should cancel its open requisition. Today it does not: cancelling silently could discard work on an already-issued device, so the case screen says the requisition stays open.
7. Retention for case history and audit (Legal and Compliance), including whether the intake copy of the identity number is cleared when a case completes (D9).

## Verification

- Tests: 42 integration tests against real Postgres as the RLS-governed role (`test/lifecycle.test.ts`), 23 pure rule tests, 6 import tests, 9 worklist and export tests, the pack-boundary guard, and a guard that every history action and status has a translated label in all six locales. The cross-company policy tests were confirmed non-vacuous by reverting the policy in a copy and watching them fail.
- The migration was applied to a copy of the production schema (`pnpm gate:shadow`, 424/424), after its last edit.
- Full gate (`CHUNKS=20`, 1227 of 1227 files counted): 19 chunks green; chunk 7 failed once on a repository guard that every table pointing at a company is declared in `core/company-refs.ts` (a real omission, fixed), then re-ran green. `tsc` clean. `next build` passes on the Darwin build machine; that says nothing about the production box (Linux, node 20).
- Render check on a dev server as an administrator, a module manager, an agent, a new hire and a requester: every screen read for its heading, no unresolved message keys, no server errors, redirects correct, nothing sensitive in the new-hire view; layout measured at 390 px (no horizontal overflow); a step tick, the step editor and the New Hire form were driven end to end and the database read back.
- NOT done: a deploy, a native-speaker review of the Malay, Chinese, Tamil, Thai and Vietnamese text (the handover's own UAT says Malay and Chinese still need one), and a check of the module on the production box. Merged is not deployed (CLAUDE.md §3).
- BEFORE MERGE: re-check that migration number 0516 and ADR number 0095 are still free on main, and that a `scripts/seed-catalogs.ts` run creates the `lifecycle` catalog row on the box. The module is off for every tenant until a `tenant_module` row exists.
