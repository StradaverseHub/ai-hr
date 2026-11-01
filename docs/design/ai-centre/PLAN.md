# One AI centre: review and plan (phase 1, for owner approval)

Status: **proposal only. Nothing is built.** Mockup: [mockup.html](mockup.html), renders in [renders/](renders/). Fictional data only.
Base: `origin/main` at 7fe8f8627 (1 November 2026). ADR-0170 was read from `origin/claude/assistant-onyx-phase1-20261031` for content only.

## 1. What people find confusing today

The evidence is the source code; "inference" marks what is not proven. We could not get rendered screenshots of today's screens: the evidence-only capture on GitHub Actions (run 41310845881, branch `claude/ai-centre-capture-20261101`, never to be merged) built the app, then stopped at the database migration step with no error printed. Its cause has not been diagnosed.

| Surface | Who can see it (guard) | What it does | ADR-0170 layer / family | What is confusing |
|---|---|---|---|---|
| Chat `/assistant` | Any signed-in user. The layout checks the session; `mayUseAssistant` requires the module to be on and a per-user grant (`core/assistant-grant.ts:69`) | Fixed grammar of 19 request types (`lib/ai/provider-assistant-policy.ts:16`), plus greetings and 7 proposal phrases | Interfaces → harness (closed loop) | Anything outside the 19 types gets "Which area would you like help with?" plus chips, which reads as a dead end. A collapsed "tools" drawer holds five more AI tools |
| Floating chat (launcher) | The shell decides; administrators can hide it per area | A small window or side panel; knows the page area only | Interfaces | The conversation resets on every page. It is hidden on all 52 `/assistant/*` pages. It ends with "Open in Assistant", a second place to look |
| 7 inline cards | The proposal phrases in chat | Pre-filled cancel/edit leave, cancel claim, overtime, decide claim/attendance/time-off-in-lieu (TOIL) | Interfaces (proposal) | A different card look from the 56 chat "human review" link cards; only these 7 carry the right `?flow=` |
| 51 review pages `/assistant/*` | Layout session check. The real checks run again on POST (`/api/assistant/module-actions`) | Each confirms one of 59 registry actions | Interfaces (review pages) | **4 page shells, 4 confirm transports, no shared review component.** The denial block is copied 21 times. 6 pages have no back link. `/assistant/hr` is unreachable except by typing its URL. Names do not match (`pay-codes`/`payComponent`, `employee-code` vs `org-employee-id`, `performance/checkins` meaning cancel). Every page duplicates a native screen |
| Control Tower Overview, Readiness, Exceptions, Proposed actions, Opportunities | `requireAdmin` (hr_admin or super_admin) | Work queue, record readiness, payroll exceptions, approve-N agent proposals, automation opportunities | Capabilities (watchers) and Trust | The nav says "Approvals" but the page says "Proposed actions"; `/approvals` is also "Approvals". The nav says "Employee data" but the page says "Record readiness". The work queue appears twice |
| AI management `/control-tower/agents/*` (9 pages) | `requireAdmin`; provider needs a group administrator | Overview, provider, assistant, features, allowances, spending, orchestrator, runs, inventory | Trust and governance | 16 nav rows in one group. Inventory, Features and Runs overlap. "What is on" is read from two different sources. Spending bounces to Overview when there is no spend policy |
| How it works `/control-tower/how-it-works` | `requireAdmin` | Static SVG of the checking loop, plus switch list and promises | Explainer for administrators | Explains only the payroll checking loop, not the whole AI |
| Analytics "Explore patterns privately" | `requireAdmin` | Banded analysis over 8 areas | Capabilities (governed metrics) | Hidden in a `<details>` element, and duplicated inside the chat tools |
| Payroll AI | `requireAdmin` | Anomaly narrator; hypotheses (off by default); pay-rule drafting; import mapping; performance drafting (off) | Explainers, preparers | Each has its own switch and entry point |
| `/delegations` | Any signed-in user | **Approval delegation** (who covers whose approvals). Not AI | — | The name collides with ADR-0170 "mandates" if the AI copy says "delegation" |

## 2. Proposal: one AI centre

The name is a single config constant (`PRODUCT.centre`), because the final name is undecided. Entry points: one sidebar row ("AI centre", with the Inbox count) and the floating chat.

| Tab | Who | Contents |
|---|---|---|
| **Ask** | Everyone with an Assistant grant (unchanged) | The conversation, the saved chats, and the tools that today sit in the drawer. Answers render proposals with the shared card |
| **Inbox** | Everyone with an Assistant grant | Everything waiting on the person, in three groups: *Needs your decision*, *Prepared for you*, *For your information*. Every item uses **one proposal card** (ADR-0170 §11.3: what, for whom, authority, checks with rule versions, expiry, "How this was prepared"). The card never completes anything: its only action opens the review page |
| **Delegated jobs** | Everyone; job types filtered by the company's allowance (ADR-0170 §3.10, two keys) | The person's mandates, "Delegate a job", and the never-delegable list. It is **not called "Delegations"**, to avoid colliding with approval delegation |
| **Workers** | Administrators (`requireAdmin`, as today) | All workers from §3.13, grouped by family, each with switch, trigger, effect, authority, last run, and acceptance or reversal figures. Includes the stop-all switch. Replaces Inventory, Features, Orchestrator and Runs |
| **Setup** | Administrators; the provider row needs a group administrator (unchanged) | AI switch, provider, launcher areas, sensitive-topic contact, delegable job types, AI readiness |
| **Spend and providers** | Administrators; the group-administrator rule unchanged | Spend, allowances, model and provider, recent runs. Replaces Spending, Allowances and Provider |
| **How it works** | Everyone sees the request walkthrough; administrators also see the worker and switch detail | The animated walkthrough (section 4) |

**One review-page pattern.** Back to Inbox, "What will change", "Checks the system ran" (with rule versions), "How this was prepared" (the outcome record), and a sticky "Your decision" panel with the Maker's Mark. The 51 pages keep their routes, server actions and checks. Only their shell is shared, and each page's own denial, unavailable and expired states move into the shell's standard slots.

**The floating chat** becomes the pocket version of Ask: the same conversation across pages, the Inbox count on the button, the same proposal card, and "Continue in the AI centre". It stays hidden where administrators hide it.

**What stays outside the centre:** Control Tower operations (exceptions, readiness, the work queue, opportunities) stay where they are as operational HR pages, under the existing `requireAdmin`. Their AI-raised items also appear in the Inbox as cards. `/delegations` (approval delegation) is untouched.

### Route map (redirects are permanent; permission checks stay identical)

| Today | New home | Note |
|---|---|---|
| `/assistant` | `/assistant` → Ask (same route, new shell) | Keeps the guard |
| `/assistant/*` (51 pages) | Same routes, shared review shell | No route changes, so no redirects; the registry stays valid |
| `/assistant/hr` | Same route | Made reachable from Inbox cards (fixes a dead end) |
| new `/assistant/inbox`, `/assistant/jobs`, `/assistant/how-it-works` | new | Inbox and Delegated jobs read existing owners only |
| `/control-tower/agents` | `/assistant/workers` | requireAdmin |
| `/control-tower/agents/inventory`, `/features`, `/orchestrator`, `/runs` | `/assistant/workers` (with filter / tab anchors) | Runs → `/assistant/spend#runs` |
| `/control-tower/agents/assistant` | `/assistant/setup#assistant` | Launcher settings form unchanged |
| `/control-tower/agents/provider` | `/assistant/spend#provider` | Group administrator check unchanged |
| `/control-tower/agents/allowances`, `/spending` | `/assistant/spend#allowances`, `#spend` | Spending only renders when a policy exists (no bounce) |
| `/control-tower/how-it-works` | `/assistant/how-it-works` | Control Tower links to it |
| `/control-tower`, `/readiness`, `/exceptions`, `/opportunities` | unchanged | Nav labels aligned with page titles |
| `/control-tower/actions` ("Approvals" in nav) | unchanged route, nav label "Proposed actions" | Its proposals also appear in the Inbox |

**Removed or merged:** 9 AI-management nav rows become 4 tabs; the duplicate work queue on `/control-tower/agents/orchestrator` goes; the second "what is on" reader (`agentStatuses` on How it works) is replaced by the Workers registry; the chat "tools" drawer is folded into Ask and Setup; the Analytics AI panel copy inside chat is removed (the Analytics one stays).

## 3. What users see

- **Employee:** one "AI centre" row (Ask, Inbox, Delegated jobs, How it works). Their own prepared requests wait in the Inbox until they confirm.
- **Manager / approver:** approvals the AI prepared arrive as Inbox cards and open the existing review page. They can delegate allowed work jobs (today only the Monday absence summary exists, on PR 182).
- **HR administrator:** also sees Workers, Setup, and Spend and providers in the same place. Control Tower keeps the operational queues.

## 4. How it works (Control Tower and AI centre)

- **One authored moment:** a request travels through the layer map: interfaces → guard (foundation) → harness (the model as a dashed, violet "suggests only" box inside it) → context → capabilities → system of record → outcome record → back to the person, who confirms (the Maker's Mark fills). There are 9 steps.
- **Other chapters:** Delegated jobs (two keys, "for, never as"), the five worker families, and "What it never does".
- **Visual language:** Atelier tokens, existing semantic colours (violet = model, tan = person, neutral = rules), the existing Maker's Mark. No new fonts or assets; diagrams are HTML and CSS, so every label wraps and translates.
- **Accessibility:**
  - Step dots are a tab list (arrow keys, Home, End), with Previous, Play/Pause and Next buttons, and a polite live region.
  - With reduced motion there is no autoplay and no travel animation; the marker jumps and colour changes remain.
  - Contrast follows the Atelier light and dark tokens.
- **Languages:** all six are in the mockup. The Malay, Chinese, Vietnamese, Tamil and Thai text is a **draft for layout only** and needs native review (Tamil and Thai at least).

## 5. Risks

1. **Permission drift.** Moving pages must not widen access. Mitigation: no page route changes for review pages; every new tab reuses the existing guard function; redirect tests assert the guard per role (employee, company HR administrator, group administrator).
2. **Digest closure.** Changing `lib/ai/provider-*`, `core/assistant.ts` or `db/schema.ts` could change the approved digests. Mitigation: shell and UI only; run both `--check` scripts before every push.
3. **Inbox data.** The Inbox must read existing owners (approvals queue, review custody rows, watcher findings) as the caller under row-level security (RLS). It invents no new store. Unknown: whether every existing review custody row carries enough to render a card. Some items may show only a title and a link at first.
4. **Mandates and workers registry are on unmerged PRs (182, and step 5).** On main, Delegated jobs will show "nothing delegated" plus the never-delegable list, and Workers will be built from the existing features, settings and chasers. When PR 182 lands, it adds the rows.
5. **Name collision.** "Delegation" already means approval cover. The proposal says "Delegated jobs"; ADR-0170 uses "mandate" publicly. The owner should choose.
6. **51-page shell migration is large.** Do it per pattern (P1 16, P2 23, P3 9, P4 3) in separate commits, each with its own tests.

## 6. Phases (after approval)

1. Shared `ProposalCard` and `ReviewShell` components, the AI centre tabs, Inbox (read-only from existing owners), Workers (from existing features, settings and chasers), the Setup and Spend merge, and redirects.
2. Move the 51 review pages onto the shell, by pattern.
3. How it works (animated, six languages through `messages/*.json`), plus Control Tower links.
4. Floating chat continuity and the Inbox badge.
5. Tests: permissions per role and tab, redirects, animation accessibility (reduced motion, focus order, keyboard), translation keys present in all six languages. Rendered evidence through GitHub Actions. Then a draft PR. No merge, no deployment.

## 7. Open questions for the owner

1. "Delegated jobs" or "Mandates" as the public word?
2. Should the centre live at `/assistant/*` (fewer redirects, chosen here) or at a neutral `/ai/*`?
3. Should employees see How it works, or administrators only (today it is administrators only)?
4. Should Control Tower operations move into the centre later, or stay a separate operational area (proposed: stay)?
