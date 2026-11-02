# Review strand: interface and experience — AI centre and "How Noveri works"

Reviewer: independent UI/UX and accessibility review. Checkout `claude/teras-review` at 7d57fc6a4 (diff base 7fe8f8627). Static reading only: no build, no tests run locally, no state-changing git commands.

Rendered evidence: CI artifacts from runs 41338446035 and 41328586576. Both were downloaded to `scratchpad/review/artifacts/`. Every PNG row in the 41338446035 JSON names candidate d8aa371bd, the second parent of HEAD's merge. I viewed en and employee Inbox, approver Inbox, and ta, vi and th How-it-works at desktop and mobile.

Evidence gaps: the screenshots are light mode only, atelier theme only, and 1440px and 390px wide only, never 375px. Inbox is captured in en and zh only, and Delegated jobs, Workers and review shell in en only. There are no screenshots for the manager or payroll-partner roles, and none in dark mode. The request marker's position in static screenshots is measured by jsdom (all rects are 0), so the orange dot at the left edge of the mobile How screenshots is a capture artefact, not a defect.

Drafted tests live in `scratchpad/review/tests/ui/`, written as `test/review/<name>.dom.test.tsx`. They fall under `vitest.config.ts`'s `dom` project (`test/**/*.dom.test.tsx`).

## Summary by severity

| # | Severity | Title | Confidence | Test |
|---|---|---|---|---|
| M1 | medium | Inbox shows two different "waiting for your decision" counts on one screen | High | ai-centre-inbox-digest (cases 1, 2) |
| M2 | medium | Employee's "Your day" tile links to /approvals, which redirects them to the dashboard | High | ai-centre-inbox-digest (case 3) |
| M3 | medium | Admin digest "Statutory deadlines" tile shown and linked into payroll when payroll is off | High (render), Medium (that admins in payroll-less tenants exist) | ai-centre-inbox-payroll-off |
| M4 | medium | Worker registry "Change in delegated jobs" leads to a page with no control | High | worker-registry-job-type-dead-end |
| M5 | medium | Clockwork figure labels clipped in long locales (Tamil) | High (screenshot) | — (visual; screenshot evidence) |
| L1 | low | Clockwork figure text below 4.5:1 (caption 4.13, dimmed name 3.90, dimmed part 1.89) | High | clockwork-figure-contrast |
| L2 | low | Classic theme in dark mode: text-primary links 4.04–4.34:1, white on primary 4.47:1 | High (computed); pre-existing tokens | — |
| L3 | low | Chapter tabs' aria-controls point at panels that are not rendered | High | how-it-works-tabs-aria (case 1) |
| L4 | low | Step dots are role="tab" with no tabpanel | High | how-it-works-tabs-aria (case 2) |
| L5 | low | Under reduced motion, "Play" acts as "Next" but keeps the Play label and aria-pressed=false | High | — (current behaviour is pinned by the existing test) |
| L6 | low | Reduced motion is detected only after mount: server HTML shows the watch closed, then it snaps open | Medium | — |
| L7 | low | Phone: active centre tab can sit off-screen in the scrolling tab bar | High (screenshot) | — |
| L8 | low | Every decision card's link is named "Review"; the figure/list and dot targets are small | Medium | — |
| L9 | low | Copy and flow: "Manage delegated jobs" leads to a page with nothing to manage; three zeros on an empty Inbox; h1→h3 skip | Medium | — |
| L10 | low | i18n polish: Vietnamese in the mono font falls back (Geist Mono latin only); a few unused keys | Medium | — |
| X1 | note (other strand) | `?recommend=` is a GET read that records a run each time the page reloads | Medium | — |

No blockers in this strand: no screen in scope shows or lets a role do something its own page would refuse. The data guards themselves were not in scope.

---

## Findings

### M1 — Inbox shows two different "waiting for your decision" counts (medium, High)

Evidence (verified by reading):
- Inbox list and the summary: `app/assistant/centre/inbox.tsx:42-50` calls `listPendingTasks(session, scopeIds, {attendance, claims, performance, rewards})`. This includes notice acknowledgements (default) and is scoped to the company switcher's `scopeIds`.
- "Your day" tile: `inbox.tsx:52` → `digestPreview` → `core/digest/daily-digest.ts:56`:
  ```ts
  const tasks=await listPendingTasks(ctx,undefined,modules,{noticeAcknowledgements:false});
  ```
  This passes no scope and excludes notices (`core/approvals-inbox.ts:122`).
- Rendered side by side: `inbox.tsx:96-97` (digest number), `:116` (Needs your decision count), `:152` (Decisions).
- The existing evidence test hides this. `test/ai-centre-step5-evidence.dom.test.tsx` mocks `digestPreview` to return `total: state.tasks.length`.

Reproduction:
1. Take any person with one leave approval and one notice to acknowledge.
2. They open /assistant?view=inbox.
3. Observed: "Your day · Waiting for your decision 1" sits above "Needs your decision 2", and the summary shows "Decisions 2".
4. Expected: one number.

The same split appears for an HR admin with a company selected in the switcher. The digest counts all companies, and the list counts the selected company only.

Fix: either have `digestPreview` take the Inbox's scope and options, or label the tile as a different measure (for example "Approvals (all companies)"). The simplest fix is for the Inbox to show `decisions.length` in the tile and keep the digest numbers for the job's own record.

### M2 — Employee's "Your day" tile links to /approvals, which sends them home (medium, High)

Evidence:
- The tile is always a link to `DIGEST_PAGES.approvals = '/approvals'` (`core/digest/daily-digest.ts:33`, `inbox.tsx:96`).
- `app/approvals/page.tsx:193`:
  ```ts
  if(!focus&&!admin&&!manager&&!rewardReviews.length&&!assignedAttendance&&!assignedTasks.length)redirect('/');
  ```
  Also, `/approvals` reads performance and rewards tasks differently (`:190` passes `performance:false, rewards:false`), while the digest counts them (`daily-digest.ts:55`).
- Screenshot `en-ai-centre-step5-employee-inbox-mobile.png` shows the employee with "Waiting for your decision 0" as a bordered, clickable tile.

Reproduction:
1. Log in as an employee with no approver role.
2. Open the Inbox and click "Waiting for your decision 0".
3. Observed: the page silently redirects to /.
4. Expected: no link, or a link to `#inbox-decide`.

An employee whose only task is a performance review sees "1" on the tile, and the tile also bounces them home.

Fix: link the tile to each decision's own `linkPath`, or to the in-page list (`#inbox-decide`). Do not link when the total is 0.

### M3 — Admin "Statutory deadlines" tile links into a disabled payroll module (medium)

Evidence:
- `core/digest/daily-digest.ts:61` (`if(isAdmin(ctx)){...}`) and `:76` set `deadlines` for every administrator, with no payroll-module check. If `complianceWorklist` throws, `unknown` is counted but the tile is still emitted with 0/0.
- `DIGEST_PAGES.deadlines='/payroll/statutory-forms'` sits under `app/payroll/layout.tsx` = `moduleLayout('payroll')`, which is a courtesy redirect to `/?moduleUnavailable=payroll`.
- By contrast, the Inbox already gates its own payroll findings: `inbox.tsx:45,54-55`.

Reproduction:
1. Log in as an HR admin in a tenant with payroll off.
2. Open the Inbox.
3. Observed: a "Statutory deadlines 0 · 0 overdue · 0 due soon" tile that bounces the admin to the module-unavailable notice.
4. Expected: no tile.

Fix: gate `deadlines` on `isModuleEnabledOrFalse(ctx,'payroll')` in the digest, or in the Inbox render.

### M4 — Worker registry "Change in delegated jobs" leads to a page with no control (medium, High)

Evidence:
- `app/control-tower/agents/worker-registry.tsx:29-31`: switch owner `job_type` → `/assistant?view=jobs`, with the label "Change in delegated jobs".
- Two registered workers have this owner: `core/agent-registry/workers.ts:138` (team_absence_weekly_summary) and `:142` (daily_digest).
- `components/ai-centre/delegated-jobs.tsx:6-10` says it reads nothing and offers no job type. It renders no form, button or input.
- `setJobTypeEnablement`, `grantMandate` and `revokeMandate` (`core/mandates/mandates.ts:38,107,168`) have no caller anywhere outside `test/`.

Reproduction:
1. Log in as a group admin and open AI centre › Workers.
2. In the "Daily digest" row, click "Change in delegated jobs".
3. Observed: the page says delegated jobs are not available, with no control.
4. Expected: either a control, or the row says the job type cannot be switched on yet.

Latent consequence: if a mandate is ever created by a script or a future UI, Delegated jobs would still say "You have no delegated jobs". Meanwhile the Inbox would say "Your daily digest job last prepared this at…" (`inbox.tsx:105`) and its own sidebar would say "Nothing is delegated." The page should read `listMandates` before it makes that claim.

### M5 — Clockwork labels clipped in long locales (medium, High from screenshot)

Evidence:
- `components/ai-centre/clockwork-figure.tsx:176-181` uses plain SVG `<text>` at a fixed `x=708` within a 1000-unit viewBox, with no wrapping and no truncation. The container has `overflow-hidden` (`:150`).
- Screenshot `ta-ai-centre-how-desktop.png` (1440px) cuts the right-hand part lines at the figure edge: the context row ends "…உங்கள் பணிப்" and the foundation row ends "…தணிக்".
- The repository already learned this lesson on the Control Tower loop diagram. `app/control-tower/how-it-works/page.tsx:84-90` (r286) switched to `foreignObject` because "SVG text neither wraps nor ellipsises".

Fix: render the label rows as HTML (absolutely positioned, or `foreignObject`) with `max-width` and wrapping. Alternatively, shorten the part strings in ta/vi to fit about 45 monospace characters. Add a ta screenshot assertion that no text box's right edge passes the panel's.

### L1 — Clockwork figure text contrast (low, High)

The panel is hard-coded `bg-[#0c0d0f]` in every theme (`clockwork-figure.tsx:150`). The computed ratios are below:

| Text | Location | Ratio |
|---|---|---|
| Caption and mark `#6f747c`, 10.5px | `:151-152` | 4.13:1 |
| Dimmed layer name `#e8e8ea` at `opacity-45` | `:180` | 3.90:1 |
| Dimmed part `#7b8089` at `opacity-45` | `:181` | 1.89:1 |

The figure has `role="img"`, but these are visible labels. Fix: dim by colour, for example `#a3a8b0` for names and `#8a9099` for parts, with no opacity, and raise the caption to at least `#878c94`. The draft test computes the ratios from the component's own classes.

### L2 — Classic theme, dark mode: primary text and badges (low, High; pre-existing tokens)

Computed from `app/globals.css:52-75`, where `--primary:#6366f1`:

| Use | Ratio |
|---|---|
| `text-primary` on background | 4.34:1 |
| `text-primary` on card | 4.04:1 |
| White on primary (inbox count badge at 11px, Next, Review) | 4.47:1 |

New AI-centre links use these tokens: "Open Ask", "Manage delegated jobs", "Show the recommendation", "Open approval delegation" and the badge (`centre-tabs.tsx:34`).

The default theme is atelier (`lib/ui-theme.ts:19`), and atelier dark passes (7.15–7.94). So this affects tenants or users on the classic theme in dark mode only. Every pair I checked in light classic, both atelier modes and both monolith modes passes. The script is `scratchpad/review/scripts/contrast.py`. Fix: either lift classic dark `--primary` to about `#7c7ff5`, or use a separate `--primary-text` token.

### L3 / L4 — Tab semantics in How it works (low, High)

- `components/ai-centre/how-it-works.tsx:51` gives every chapter tab `aria-controls="how-panel-<key>"`, but `:59` renders only the selected panel. Three of the four references point at ids that do not exist.
- `:210-217` defines nine `role="tab"` step buttons with no `aria-controls` and no tabpanel. The step text they change sits in an `aria-live` div (`:195`).

Keyboard behaviour is correct, and the existing test pins it: arrows, Home and End, roving tabindex, and focus that follows the selection. Fix: give aria-controls only to the selected tab, or render the inactive panels `hidden`. For the steps, either make `:195` a `role="tabpanel"` labelled by the selected step tab, or turn the dots into a button group with `aria-current="step"`.

### L5 — Reduced motion: "Play" becomes "Next" without saying so (low, High)

`how-it-works.tsx:120-124`: under reduced motion `togglePlay` calls `go(step + 1)`, but the button still reads "Play" with `aria-pressed=false`. A screen-reader user hears "Play, toggle button, not pressed". Pressing it advances one step and the button stays "not pressed". The existing test pins this behaviour intentionally, so I did not draft a failing test.

Suggestion: under reduced motion, hide Play and keep Next, or label it "Next step" with no aria-pressed.

Autoplay (non-reduced): the two polite live regions (`:195`, `:201`) re-announce every 3.6 s. This is acceptable because autoplay starts only on request.

### L6 — Reduced motion detected after mount (low, Medium)

`usePrefersReducedMotion` starts `false` (`how-it-works.tsx:23-33`), and `ClockworkFigure` sets its initial `open` from that (`clockwork-figure.tsx:104`). The server HTML therefore renders the watch closed, with labels hidden because they need `e>0.6`. After hydration the parent effect flips `reduced` to true, and the figure's effect cleans up and sets `open=1`.

Because the opening starts with a 350 ms delay (`:113`), no animated frame plays. A reduced-motion user sees a closed→open jump rather than motion, so this is marginal. Fix: read the preference synchronously on the client with `useSyncExternalStore` and `getServerSnapshot: () => true`. That renders the server HTML open and still, and the animation can start only when motion is allowed.

Verified sound:
- `motion-safe:animate-[ai-centre-tick…]` (`:131`), and `globals.css:524-526` defines the keyframes only.
- `motion-reduce:transition-none` on the layer list, dots and chevrons.
- The request marker's transform transition is dropped under reduced motion (`:157-158`, `clockwork-figure.tsx:185`).
- Autoplay never runs under reduced motion (`:83-89`).

### L7 — Phone: active tab off-screen (low, High)

`components/ai-centre/centre-tabs.tsx:20-21` uses `overflow-x-auto` with `min-w-max`. At 390px the bar shows "Ask, Inbox, Delegated jobs, Ho…" (screenshots `en-ai-centre-step5-employee-inbox-mobile.png` and `ta-ai-centre-how-mobile.png`). On /assistant?view=how the current tab is off-screen, and nothing hints that the bar scrolls. In Tamil the bar overflows even at 1440px (`ta-ai-centre-how-desktop.png`). Fix: scroll the `aria-current` link into view on mount, and add an edge fade or wrap to two rows below `sm`.

### L8 — Link names and target sizes (low, Medium)

- Every decision card's only link is "Review" (`inbox.tsx:122`, `proposal-card.tsx:41-42`), so a screen reader's links list shows N identical "Review" entries. Add `aria-describedby` pointing at the card title, or put the title in a visually hidden part of the link text.
- Step dots are `size-7` (28px, `how-it-works.tsx:214`). That meets WCAG 2.2 AA (24px) but sits below the 44px used elsewhere in this UI (`min-h-11`).

### L9 — Copy and flow (low, Medium)

- Inbox sidebar "Manage delegated jobs" (`inbox.tsx:159`) leads to a page where nothing can be managed. "See delegated jobs" would match what the page does.
- An empty employee Inbox shows "Your day 0", then "Nothing is waiting for you", then "Waiting on you · Decisions 0". That is three statements of the same zero (screenshot `en-ai-centre-step5-employee-inbox-mobile.png`). Hide the digest tile and the summary when the empty state shows.
- The Jobs, Families and Never chapters use `h3` directly under the page `h1` (`how-it-works.tsx:231,248,266`). The Request chapter uses `h2`.
- AI management pages lost their "Back to Control Tower" header link (`screen.tsx` diff: `PageHeader back=…` removed). It is reachable only from the sidebar now. This is minor.

### L10 — i18n polish (low, Medium)

- The figure's mono caption and part lines use `--font-geist-mono`, which is loaded with `subsets:['latin']` (`app/layout.tsx:75`). Vietnamese diacritics fall back to another face mid-word, as visible in `vi-ai-centre-how-desktop.png`. This is pre-existing app-wide, but the figure is mono-heavy. Use the sans face for non-Latin-only locales, or add the `vietnamese` subset.
- Keys that appear unused, each costing translation and review in five languages: `aiCentre.inbox.daysOld`, `aiCentre.inbox.items.open`, `aiCentre.workers.stopAllTitle/stopAllHelp`, `aiCentre.launcher.earlier/continue` (the launcher uses `assistant.launcher.contextNote`), and `aiCentre.inbox.filters.*`/`filterLabel`. I grep-checked these, so confidence is medium.
- Rates in the worker registry are formatted as `${Math.round(v*100)}%` (`worker-registry.tsx:15`) rather than `f.number(v,{style:'percent'})`. This is harmless for the six locales today.

### X1 — Recommendation is recorded on every reload (note for the core/recommender strand; Medium)

`LeaveRecommendationLink` puts `?recommend=<id>` in the URL (`leave-recommendation.tsx:13`). `inbox.tsx:65-66` calls `readLeaveRecommendation` during render, and `app/assistant/centre/recommendation.ts:13-17` says the service "records the run". Each reload, or back/forward navigation to that URL, while the request is still pending therefore writes another outcome run. That can inflate the worker's "decided/accepted" metrics. Whether the service de-duplicates is outside this strand, so verify in core/recommenders.

---

## Per-role walk-through (what each sees; dead ends)

| Role | /assistant?view=inbox | view=jobs | view=how | Control-tower AI pages |
|---|---|---|---|---|
| Employee | Tabs Ask/Inbox/Jobs/How. Digest tile → /approvals → redirect / (**M2**). "Open Ask" → /assistant (without a grant: the denied home that names who to ask, which is fine) | Static explanation; "Open approval delegation" → /delegations (all roles, `app/delegations/page.tsx:30-34`) ✔ | Walkthrough, no admin link ✔ | Tabs hidden; layout `requireAdmin` redirects anyway ✔ |
| Manager | Leave cards → `linkPath` (/approvals focus) ✔; "Show the recommendation" → same page with panel `#recommendation-<id>` ✔ (panel only for a leave id in the viewer's own queue, `inbox.tsx:65`) | as employee | as employee | — |
| HR admin (company) | Findings → /control-tower/exceptions, /actions, /readiness (pages exist; same `isAdmin` predicate as `requireAdmin`, `lib/authz.ts:46-49`) ✔; digest setup → /control-tower/readiness ✔; deadlines → payroll (**M3** when payroll off) | as employee | Admin link → /control-tower/how-it-works (requireAdmin) ✔ | Workers/Setup/Spend tabs; provider subnav hidden (non-group) ✔; registry not shown (service refuses; page only for group admin, `features/page.tsx`) ✔ |
| Group admin | as HR admin | as employee | as HR admin | Registry with switches; `job_type` rows dead-end (**M4**); "Open scheduled actions" → /admin/scheduled-actions (isGroupAdmin page guard, shown only to group admin) ✔ |
| Payroll partner | Not admin: no findings and no digest setup/deadlines. Consistent with /control-tower requiring admin ✔ | as employee | no admin link ✔ | Tabs hidden ✔ |

Redirects checked: /control-tower/agents/orchestrator → `redirect('/control-tower')` (page exists, same guard). Every centre tab and subnav href resolves to an `app/**/page.tsx` (passing test `ai-centre-link-targets`).

## Coverage: checked and found sound

- **Tabs**
  - The centre tab bar is a `nav` of links with `aria-current="page"`, the correct pattern for page navigation (`centre-tabs.tsx:20-38`). Focus rings are visible (`focus-visible:ring-2`).
  - The count badge has visible digits that are `aria-hidden`, plus pluralised `sr-only` text (`:34-35`).
  - Admin tabs are hidden for non-admins, and each page keeps its own guard (`lib/ai-centre/centre-nav.ts:32-34`).
- **Cards**
  - The proposal card has exactly one link and no form or button (`proposal-card.tsx`), and an existing evidence test asserts this.
  - The "How this was prepared" disclosure is a native `details`/`summary` with focus ring and a reduced-motion-safe chevron.
- **Recommendation panel** (`leave-recommendation.tsx:21-41`)
  - It is `role="status"` and never shows a reject verdict.
  - Every `RecommendationCheckName`, verdict and unavailable reason has a key in all six locales.
  - Prefetch is off on the link, so nothing runs on hover.
- **Review shell**
  - Way back to the Inbox: `review-shell.tsx:22`, with a 44px target.
  - The denied state names who can grant access (`:34-42`).
- **Launcher** (`assistant-launcher.tsx`)
  - Turns from earlier pages are disabled through `fieldset disabled` and labelled with the page they came from.
  - The Inbox link appears only when the shell passes a count. The count comes from the same `listPendingTasks` call as the bell (`app/layout.tsx:208`).
- **Worker registry**
  - The table has an `sr-only` caption and `scope="col"` headers.
  - Each switch button's `aria-label` includes the worker name.
  - After an action, the redirect returns to `#worker-<id>` (`actions.ts` `setRegistryWorkerSwitch`).
  - The family row headers use `scope="colgroup"`, and `aria-labelledby` is set on each `tbody`.
- **i18n**
  - All 363 keys are present and non-empty in ms, zh, vi, ta and th, with no extra keys.
  - ICU argument names match in every locale.
  - The only value identical to English is ms `aiCentre.how.layers.model` ("Model", a valid Malay loanword).
  - I found no hard-coded English JSX text in the scoped TSX. The product name is deliberately untranslated (`lib/ai-centre/brand.ts`).
  - `i18n/request.ts` merges the AI-centre catalogue over the main one with English fallback for missing or blank values, and the test helper mirrors this.
  - Passing test: `ai-centre-i18n-completeness`.
- **Contrast**
  - All AI-centre token pairs pass in classic light, atelier light/dark and monolith light/dark.
  - The tinted chips (violet, emerald, amber and sky at -700/-800, and -300 in dark) are 5.85–12.67:1.
- **Phone width**
  - The Inbox, Jobs and How list layouts stack under `lg` and `md`, and the screenshot JSON reports no document overflow at 390px.
  - The worker registry table scrolls inside `overflow-x-auto` (`min-w-[820px]`), which is acceptable for an admin table.
  - The clockwork figure is `hidden xl:block`, and the stacked layer list replaces it below `xl` (`how-it-works.tsx:152-156`).
- **Dark mode**
  - No hard-coded colours outside the clockwork figure. That figure is a deliberately dark panel in both themes.
  - Every tinted text class has a `dark:` counterpart.

## Drafted tests (`scratchpad/review/tests/ui/`)

| File (as `test/review/…`) | Expect on 7d57fc6a4 | Claims |
|---|---|---|
| `ai-centre-i18n-completeness.dom.test.tsx` | PASS | `REVIEW pass:` key parity, no empties, ICU arguments, translated values, runtime-built keys exist, every message formats |
| `ai-centre-link-targets.dom.test.tsx` | PASS | `REVIEW pass:` every tab/subnav/fixed href has a page; non-admin sees four tabs; badge has sr-only text |
| `how-it-works-tabs-aria.dom.test.tsx` | 2 FAIL, 1 PASS | L3, L4; pass: chapter keyboard and panel labelling |
| `ai-centre-inbox-digest.dom.test.tsx` | 3 FAIL | M1 (notice, scope), M2 (employee → /approvals). Uses the real `digestPreview` with only `listPendingTasks` and plumbing mocked |
| `ai-centre-inbox-payroll-off.dom.test.tsx` | FAIL | M3 |
| `worker-registry-job-type-dead-end.dom.test.tsx` | FAIL | M4 |
| `clockwork-figure-contrast.dom.test.tsx` | FAIL | L1 |
| `ai-centre-role-matrix-screenshots.dom.test.tsx` | PASS (assertions), screenshots on CI only | Proposed evidence: 5 roles × 6 locales, dark, phone width, through the existing helper |

On the screenshot proposal: the helper today renders only 1440px and 390px, light, with `data-ui-theme` set on `<html>`. The proposal gets classic dark by wrapping the markup in `.dark`, without changing the helper. Atelier dark (`:root[data-ui-theme='atelier'].dark`) and a true 375px viewport need a small helper option (`dark`, `viewports`), which is described in the test's header.

Caveat: none of these drafts has been run (no local test runs, by brief). The mocks follow the existing `test/ai-centre-*.dom.test.tsx` patterns. The two Inbox digest files mock `db/client`, `core/reporting` and `core/setup-copilot/copilot`, so the real digest module imports without a database.
