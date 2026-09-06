# Handoff — ai-hr

Updated after **every release/deploy**. This file holds ONLY the standing contract, the live state,
and the entry for any round still in flight. Shipped round entries live in
**`docs/HANDOFF-HISTORY.md`** (newest first).

**Rules for updating this file — the old version grew to 5,900 lines of layered contradictions and
sessions drowned in it (three different "deployed head" claims coexisted; a fresh session could act on
any of them):**

- **CURRENT STATE is a snapshot, not a log.** When a fact changes, REPLACE the line — never prepend a
  new block above a stale one. If a number changes (deployed head, next migration, board counts), the
  old number leaves the file.
- **When a round ships:** update CURRENT STATE in place, move the round's entry to the TOP of
  `docs/HANDOFF-HISTORY.md`, delete the in-flight entry here, and **refresh the code graph**
  (`graphify update .` in this worktree — incremental, seconds, no LLM). The high-value part of each
  entry is **Decisions** — calls the tickets did not settle; those cannot be reconstructed from the
  diff.
- **Keep this file under ~700 lines.** If it is longer, something here belongs in history.

## CURRENT STATE — snapshot 2026-09-06 (r226-r249 SHIPPED · BOARD HAS NOTHING BUILDABLE · THE LEARNING LOOP IS CLOSED IN CODE; ONLY A PROVIDER IS MISSING)

**`main@ec9612db` IS WHAT RUNS ON PRODUCTION (r249, 2026-09-06)** — verified by an
`rsync -azi --delete --dry-run` from **mainwt** that returned ZERO lines. Not by `deploy.sh` succeeding,
which is not proof. (`next-env.d.ts` alone is also a zero-change result — Next rewrites it per build mode
and it is gitignored.) Service active, `GET localhost:3000/` → 401 ON THE BOX.
**Migration `0454` VERIFIED APPLIED, not assumed:** 370 migrations, watermark `1781862554000`,
`payroll_anomaly_finding.proposal_id` present (uuid, nullable), and
`setting_definition` carries `payroll.anomaly_hypotheses_enabled` (tenant scope, default false) — the
catalog seed ran. `0452`/`0453` remain applied from r236.
**370 migrations applied. `0454` IS STILL THE LAST ONE — r247 carried none**, and neither did r239,
r240 or r245.


**✅ ALL FOUR APPROVED ITEMS ARE CLOSED (r247, 2026-09-05). THE BOARD HAS NOTHING BUILDABLE.**
- `cd63bd91` Haji Leave — `deployed`, `build_ref = no-code-change`. It already worked; Delete is offered
  on Leave Configuration and cascades the two approval rules. Their leave type was never unset — NULL is
  the company DEFAULT chain, not a non-match.
- `d6e2cccc` EA C.P.8A — `deployed`. One line on the PREVIEW screen naming it a preview, six locales. The
  form itself did not change; the reporter had photographed the preview.
- `4da751c6` Benefit Scheme + Effective From — `deployed`. A DERIVED read-only panel on the employee Leave
  tab (`core/entitlement-scheme-view.ts`), never stored, plus the "does not resolve to a single scheme"
  empty state.
- `a6fe37fc` Rebuild Leave Configuration — **the Phase 1 AUDIT was the deliverable and it is now BACK WITH
  THE REPORTER as plan rev 2** (`docs/audits/a6fe37fc-leave-config-audit.md`, mockup attached). It
  recommends NOT rebuilding. The concrete defect it found is CONFIGURATION and would survive any rewrite:
  45 template lineages, ALL with `valid_to IS NULL`, only 4 eligibility rules in the whole tenant, and
  Annual Leave carrying **16 tables in force against 2 rules**. Approve means "fix the configuration
  first"; reject-with-a-reason means they still want the rebuild.

⚠️ **THE OPERATING MODEL CHANGED THIS SESSION — READ
[ADR-0083](docs/adr/0083-hr-operations-control-plane.md) BEFORE PLANNING CONTROL-TOWER WORK.** It
supersedes ADR-0074's framing (not its invariant): the auto-clear rate is a LAGGING indicator of input
quality, the model counts instances where the work is caused by classes, and payroll-run verification is
a minority of HR operations time — so perfecting it can leave headcount unchanged. The target is no
longer a ratio but a shape: **HR operations ceases to be a staffed function.** 0074 items 2 and 7 are
superseded; item 8 is re-rated UP. **ADR-0083 BUILD ORDER:** 1 domain seam ✅ r233 · 2 record readiness ✅ r234 · 3 the ACTION LAYER
✅ r235 · 4 tier-0 letters and certificates · 5 onboarding adapter · 6 compliance adapter · 7 exit adapter.

⚠️⚠️ **THE DIRECTION CHANGED ON 2026-09-01 — READ
[ADR-0084](docs/adr/0084-propose-adjudicate-learn.md) BEFORE BUILDING ANY AI SURFACE.** The owner looked
at the Control Tower's How it works page and said that if the AI only explains things there is not much
value in it. **That is correct, and the page is not the worst of it.** Three findings, all checkable:

  1. **EVERY AI CALL IN THIS PRODUCT WAITS FOR A CLICK.** The narrator, the assistant, the pay-rule
     drafter and the report designer are all human-triggered. **The only thing that acts unattended is a
     deterministic cron.** The ceiling on that is *a faster human* — which ADR-0083 §2.5 already says does
     not remove headcount.
  2. **NOTHING THE AI PRODUCES IS EVER MEASURED.** There is no edge anywhere from an AI output back to an
     AI input, so nothing improves without a developer and nobody can say whether any of it helps.
  3. ~~**`agentStatuses` UNDER-REPORTS.**~~ **CLOSED IN r238** — twelve rows now, and all six `core/` AI
     call sites are on the page (`payroll-anomaly-narrate`, `assistant`, `pay-rule-ai`, `report-ai`,
     `feedback`, `performance`) beside the two unattended agents.

**THE PATTERN IS ALREADY HERE, INVENTED THREE TIMES AND NEVER NAMED** — `narrationIsFaithful` (discards
prose whose numbers the facts do not support), `pay-rule-ai` and `report-ai` (a model classifies into a
CLOSED union, then the SAME validator the kernel and the UI use adjudicates it). 0084 names it
**propose · adjudicate · learn**, and the widened invariant is: *a model may propose anything; nothing it
produced reaches a human, a record or a document until deterministic code the kernel or the UI already
depends on has re-derived it.* Two corollaries that are not negotiable: **a model may never raise a
`block`** (only `review`), and **adjudication failure is SILENT** — never "the AI said X but we could not
verify it", which just moves the checking onto the reader.

**ADR-0084 BUILD ORDER.** Phase 1 (no production data needed): 1 the proposal ledger + the `adjudicate`
contract ✅ r236 · 2 the readiness nudge agent ✅ r237. Phase 2: 3 hypothesis detection ✅ r238 ·
4 input-side triage ✅ r240 (claims only). **PHASE 2 IS DONE.** Phase 3 (needs real history):
**5 agreement measurement ✅ r248 — the SURFACE ships; the RATES stay null until production has a provider,
a switched-on tenant, and a caller for `recordDecision`** · **6 recurrence mining ✅ r249 — `core/recurrence-mining.ts` is the only writer of
`agent_proposal.reversed_at`, folded into `anomaly-sweep` (cron VERIFIED installed, not assumed)** ·
**7 the first autonomy grant — NEXT, and it is the one that needs a human decision rather than a build:
§2.5's kill switch and daily action budget must arrive WITH it.**
~~Not a build: the missing call sites~~ ✅ r238.

⚠️ **ALL THREE UNATTENDED AGENTS ARE STILL OFF — BUT THEY ARE NOW SWITCHABLE FROM THE PRODUCT (r243).**
`/control-tower/agents` is the switchboard; `core/tenant-settings.ts` is the app's first writer of
`tenant_setting`. **The hand-written INSERT is no longer the only way in**, and the three round entries
that had to document one are superseded. The SQL below still works and is kept for a headless context:

    INSERT INTO tenant_setting (tenant_id, key, value, source) VALUES
      ('<tenant>', 'notifications.readiness_nudge_enabled', 'true'::jsonb, 'platform'),
      ('<tenant>', 'payroll.anomaly_hypotheses_enabled',    'true'::jsonb, 'platform'),
      ('<tenant>', 'claims.input_triage_enabled',           'true'::jsonb, 'platform')
    ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value;

⚠️ **SWITCHING ONE ON IS NOT THE SAME AS IT BEING ABLE TO RUN, AND THE SCREEN NOW SAYS SO.** Each agent
has a SECOND gate — a billable module, a configured AI provider, or both. An agent switched on behind a
shut gate does nothing at all while looking enabled, which is the state this deployment was in
invisibly for three rounds. The switchboard renders THREE states (`Running` / `On, but cannot run` /
`Off`) and names the shut gate.

The nudge one ALSO needs the `notifications` module (a billable entitlement gating `dispatchNotifications`);
the hypothesis and triage ones need a configured AI provider, or they record nothing and say
`notConfigured`. Triage additionally needs the billable `claims` module.

⚠️ **THE LEDGER'S THREE VERDICT COLUMNS MUST NOT BE COLLAPSED INTO ONE.** Machine-adjudicated,
human-approved and later-reversed are three different truths and their combinations are three different
failures — a high agreement rate WITH a high reversal rate means the humans are rubber-stamping, which
looks like success in every other metric. This is also the honest answer to the owner's original question
(does the control tower help?): three measured rates per proposal type, not a staffing ratio.

⚠️ **A MODEL CAN NOW CREATE A PAYROLL FINDING (r238), AND ONLY EVER AT SEVERITY `review`.** That ceiling
is a literal appearing once in `core/payroll-hypothesis.ts`, not a setting, and a test pins the count.
Hypotheses are proposed ONLY about employees the eleven detectors AUTO-CLEARED — which is what makes the
operator's resolution attributable to the model rather than to a rule sharing the row, and what makes the
round the machine's own false-negative check.

⚠️ **AN AGENT CAN NOW WRITE, AND EXACTLY ONE THING — READ THE r235 ENTRY BEFORE ADDING A SECOND.**
Everything before it was read-only, which makes people faster without removing them. `close_fixed_upstream`
is the first and only action type, it is `propose_only`, and **`AutonomyLevel` is a union with ONE member
so granting autonomy is a change to `core/agent-actions.ts` rather than to a setting somebody can flip.**
Adding an action type means: a deterministic, re-checkable precondition (share the predicate, never
re-write it); a `reversible` class, because `irreversible` may not exist here while autonomy is unearned;
a blast-radius cap that REFUSES rather than truncates; and execution through the existing service so the
RBAC check and the domain event are the ones already trusted. **The kill switch and the daily action
budget §2.5 lists are deliberately absent and must arrive WITH the first grant of autonomy** — while
every execution is a human pressing a button they stop nothing the button does not already stop, and
shipping them early advertises a safety property that is really just the button.

**ADR-0074 SCOREBOARD, so nobody re-derives it.** 1 anomaly layer ✅ · 2 auto-clear gate ❌ REFUSED,
see above · 3 nightly sweep ✅ (r230 — it had never been installed) · 4 exceptions queue ✅ + the
cross-run Control Tower (r229) · 5 employee explanation agent ✅ (r232, `my_pay_change`) · 6 circuit
breaker ✅ · 7 learning loop ❌ still not possible, but r235 opened the tap: `close_fixed_upstream` is
the first thing in this system that can produce a RESOLVED verdict, and until someone approves one on
production the count is still zero · 8 MyInvois
e-filing ❌ not started, only the identifier field exists. **Item 5 is the only one that attacks the
ratio from the DEMAND side** — every other item makes exception CLEARING faster, which does nothing
about the queue of people asking why their own payslip changed.

⚠️ **THE ASSISTANT IS REACHABLE BUT NOBODY HOLDS IT YET.** r231 shipped `/assistant` and the grant
toggle on Users, so the path exists end to end — but production still has **0 assistant grants, 0
exchanges, and the `assistant` module is not activated for the tenant**. Nothing is broken; it has simply
not been switched on. Turning it on is two steps by hand: activate the billable module for the tenant,
then grant the people who should have it from Administration → Users. **Do not read the zero counts as a
defect** — that is what an unactivated billable module looks like.

⚠️⚠️ **PRODUCTION HAS NO AI PROVIDER AT ALL, AND NOTHING IN THIS FILE SAID SO UNTIL r238 WENT LOOKING.**
Measured on the box, both halves of `resolveActiveAiConfig`: `ai_provider_config` is **EMPTY (0 rows)**,
and `.env.production` sets **none** of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` /
`GEMINI_API_KEY` (the env fallback in `lib/ai/registry.ts`). **So every LLM surface in the product is
inert on production** — the narrator has never written a sentence, the assistant could not answer if it
were granted, and the four authoring assists return `not_configured`. The DETERMINISTIC layers are
unaffected and are what has been running all along: the eleven detectors, the sweep, record readiness, the
action layer, and the nudge agent's shipped template body.
**Do not read a zero AI count on production as a defect in the feature.** Adding a provider is
Administration → AI, or one env key on the box; until then the honest description of this product's AI is
"built, gated, and switched off at the source".

⚠️ **AND IT IS WHY SWITCHING `payroll.anomaly_hypotheses_enabled` ON TODAY WOULD DO NOTHING** — the layer
would report `notConfigured` and record nothing, which is correct behaviour, not a fault. Two things must
be true first: a provider, and a run big enough to have a peer group. **Only ONE processed batch on
production clears `MIN_COHORT` (8): `2026-08`, with 37 payslips.** The others carry 2, 4, 6, 6, 7 and 2 —
every one of them would report `cohortTooSmall`. Live verdicts today: **30 auto_clear, 63 review, 37
block**, so the candidate pool is those 30 minus whoever is not statistically unusual.

⚠️ **`agent_proposal` IS STILL EMPTY ON PRODUCTION (0 rows).** No proposal of any type has ever been
recorded, so all three rates remain NULL and ADR-0084 §2.8's autonomy test has no input yet. That is the
expected state, not a defect: the narrator needs a provider, the nudge agent and the hypothesis layer are
both switched off, and `close_fixed_upstream` needs an operator to press the button once.

⚠️ **BOTH UNATTENDED AGENTS ARE DEPLOYED AND OFF EVERYWHERE — 0 tenants switched on, 0 proposals of
either kind** (verified on production). The hypothesis layer (r238) additionally needs an AI provider; with
the setting on and no provider it records NOTHING and reports `notConfigured`, which is correct rather than
a fault.

⚠️ **THE NUDGE AGENT** (verified on production). It runs inside `review-sweep` at 03:00 and needs NO crontab change. Turning it on is the one
`tenant_setting` statement in the r237 entry — and note the HR half will record `no_recipient` until an
admin's `app_user` is linked to an employment.

**SCHEDULED JOBS ON THE BOX — SIX, and `anomaly-sweep` at 02:30 is the one r230 added.** The others:
`provision-runner` (every minute), `capture-usage` 01:00, `review-sweep` 03:00, `accrue-earned` monthly,
`expire-carry` annually. **A script existing in `scripts/` and being documented in DEPLOY.md does NOT
mean it runs** — anomaly-sweep was both for six weeks and had never been installed. Check `crontab -l`
against DEPLOY.md's block when a scheduled thing looks like it has not happened.

⚠️⚠️ **CORRECTION — "TUNE THE THRESHOLDS" WAS WRONG, AND IT WAS WRONG TWICE OVER.** r230's entry and an
earlier version of this block recorded threshold tuning as the top priority, on the strength of the
backlog sweep's **26% auto-clear rate (23 runs, 104 verdicts: 27 clear / 43 review / 34 block)**. Both
halves of that reasoning fail:

  1. **THE DEMO TENANT'S FINDINGS ARE NOT EVIDENCE OF ANYTHING.** They are seeded rows; their distribution
     reflects the seed script, not a payroll. No conclusion about this system's accuracy, its thresholds
     or where operator time goes may be drawn from them. **The first real tenant month is the first real
     data point.**
  2. **EVEN TAKEN AT FACE VALUE THEY POINTED THE OTHER WAY.** Only `net-swing` is threshold-driven
     (`netSwingPct`, default 30). `missing-bank-profile`, `missing-tax-profile`, `pay-without-attendance`
     and the component appeared/vanished pair take **no params at all** — they are binary presence checks,
     and thresholds cannot move them. Tuning would have touched a small fraction of the findings and left
     the rest exactly where they were.

**WHAT REPLACES IT: [ADR-0083](docs/adr/0083-hr-operations-control-plane.md).** The auto-clear rate is a
LAGGING indicator of input quality, so optimising it is optimising the wrong end of the pipe; the fix is
to shift detection LEFT onto continuous record readiness and to track CAUSES rather than instances. 0083
supersedes ADR-0074's operating model, its item 2 (global confidence dial → autonomy per ACTION TYPE) and
its item 7 (whose learning target taught the system to stop flagging rather than to fix). **0074's
invariant stands unchanged: the LLM never computes the money.**

**Still true and still the gate on item 2:** `payroll_anomaly_config` is empty, no verdict has ever been
resolved (r235 makes it POSSIBLE, not automatic — somebody has to open Agent actions and approve),
`falsePositiveRate` and `mttrSeconds` are structurally NULL, and the Control Tower's staffing
tile correctly refuses to print a figure. **Do not build the auto-clear gate** — and note 0083 §5 that the
tile measures exceptions ÷ throughput, which is an exception-load estimate rather than a headcount answer.

**BOARD: NOTHING BUILDABLE. Verified on production 2026-09-05 after r247: `open` 0, `contested` 0,
`approved` 0, `blocked` 0.** Everything live is `planned` and with the reporter, and `a6fe37fc` **rev 2**
(the Leave Configuration audit answer at the top of this file) joined them this round.
⚠️ **The CLI cannot list `planned` items** — `pullPlannable` is `open`+`contested`, and there is no
`pull-planned`. So the planned list below is the last thing a round WROTE, not a reading of the board;
treat a count here as unverified until someone queries `feedback_request` directly.

  - `b36a8a91` **planned rev 4** — "C.P.8A (EA form) Mapping", and **rev 3 was WRONG.** It told them there
    was nothing to build and closed the item; they came back with a full workflow spec. ⚠️ **The correction
    is at the TOP of rev 4** (AGENTS 31). What rev 3 got right: the completed EA exists. What it missed:
    they were describing a WORKFLOW, and two of its four steps are absent. **Measured on the screens
    rather than assumed** — `app/payroll/reports/ea/[employmentId]/page.tsx` IS already the review screen
    (statement rows + `EaAmendPanel` + print), `app/me/ea/[employmentId]/pdf/route.ts` already downloads
    the POPULATED pdf in both languages, and `/payroll/ea/blank` is the secondary action they pressed,
    which does exactly what its label says. Rev 4 promises only the two real gaps: rename the primary
    action to "Open Form" and fold the blank + field register into one second action; and a readiness
    panel naming which boxes are empty. ⚠️ **A box is "missing" only when the field register says it maps
    to an employee-record field that is NULL — never when a payroll figure is zero** (AGENTS 28).
  - `1ff969ed` **planned rev 1** — "Leave Inquiry", raised as a new function. **Nearly all of it exists**
    under Leave rather than the Leave Config tab they looked in: `components/leave/leave-inquiry-nav.tsx`
    already renders their exact three tabs, and Employee Balances already carries every column but four.
    The one real gap is the Explanation button — `components/leave/EntitlementBreakdown.tsx` exists and is
    mounted on `/me` and the personnel record, but NOT on the HR balances row. ⚠️ **Credit, Share, Pending
    Share and Years of Service are deliberately NOT promised**: `SharedLeaveBalanceInfo` is about which
    leave TYPES share a pooled ledger, not employee-to-employee sharing, and committing to a column on a
    name match is how a column that reads authoritative and is wrong gets shipped.

**Both plans carry a before/after mockup, and NEITHER DRAWS A SINGLE FIGURE** — dashes and state chips
instead. The first EA draft had a real employee code beside invented ringgit amounts, which is exactly the
half-fix `scripts/mockup/README.md` records from r170; it was redrawn before pushing.

⚠️ **THE REPORTER'S ONLY TEXT CHANNEL BACK IS `contest_reason` ON A PLANNED ITEM** (or the answer field
on a BLOCKED approved one). An item raised at `open` with no plan has NO reply path — `approveFeedbackPlan`
carries only an id and there is nothing to reject. Two questions were raised that way on 2026-08-29 and
were unanswerable by construction; both are now folded into their parent items' plans, where approve
means "your reading is right" and reject-with-a-reason carries the answer. **Ask a question INSIDE a plan
with a recommendation. Never as a bare raised item.**

  - ⚠️ **TWO LESSONS FROM `b36a8a91`'s EARLIER REVISIONS, kept now that rev 3's plan text is superseded
    by rev 4 above.** (a) **Rev 1 promised to print the Encik/Cik/Puan title and that was WRONG** — the
    salutation catalogue holds Datin, Dato', Dr, Mr, Mrs, Ms, Puan Sri, Tan Sri … and *no* Encik, Cik or
    Puan; 6 of 40 people have "Mr", 3 "Ms", 31 nothing. (b) **REV 2 WAS PUSHED WITHOUT READING THE `.docx`
    THEY ATTACHED TO THE REJECTION** — AGENTS 30 exists for exactly that. Read attachments BEFORE replying:
    `feedback_attachment`, base64 out, `unzip` the docx, look at `word/media/`.
  - `afc29d75` / `568b8f0b` **planned rev 1, both with before/after mockups** — the two halves of
    `c6bb5f5a` that r227 did not deliver. The consolidation is **Quick** because r227 already did the
    hard part: every row carries its own section, so a mixed list needs no change to the pop-up, the
    server action or the request kind. The status redesign is *partly there already* — the filters and
    the colour-coded pills exist; what is weak is the seven-column row and a Cancel that is a bare
    underlined link. Each plan carries its open question with a recommendation, so approve settles it.
  - `a8f525cf` / `3cbfe5e2` **planned — close-outs.** They were QUESTIONS raised the wrong way (see the
    channel warning above); each now carries a short plan whose only action is to be closed.

⚠️ **THREE ROUNDS SHIPPED IN ONE SESSION AND TWO OF THEM WERE ALREADY BUILT WHEN IT STARTED.** r226 was
merged and deployed but unrecorded; r227 was built on three branches and never gated. **The board was
the only thing that surfaced it** — two items sat in `building`, which `improve:pull` deliberately hides.
Run the two checks in "How this project is actually run" AND look at `building` before believing the
board is quiet.

⚠️ **THREE THINGS ABOUT `ea54fe6e` (r228) THE REPORTER HAS NOT BEEN TOLD. These are a DELIVERY MESSAGE,
not work** — there is no board item to carry them, because the item is already `deployed`:
  1. `allowance_exempt` is one of their fourteen EA lines and it MAPS BUT MOVES NO FIGURE, deliberately —
     the exempt box is a memo line with one derivation and must not gain a second;
  2. nothing routes before assessment year **2027**, so mapping items today changes no form they can
     generate today (they agreed this in the block trail, but it is worth restating on delivery);
  3. their §10 request for an amendment audit trail is **ALREADY MET** by `ea_override` (amender, reason,
     timestamp, and now the routed figure kept as `original`) — confirm it rather than leave it reading
     as outstanding work.

**The two `c6bb5f5a` halves r227 did not deliver are now ON THE BOARD** (`afc29d75`, `568b8f0b`) with the
questions that block them (`a8f525cf`, `3cbfe5e2`) — see the board list above. They are no longer owed
silently, which is what this block used to record.

### r249 (2026-09-06) — the loop closes: the system can now catch its own failed fix. `main@ec9612db`.

**DEPLOYED.** tsc clean · **full gate GREEN, 765 files / 5 chunks, peak disk 58-79%** · `next build` clean ·
no migration · arrival proved by a ZERO-line `rsync -azi --dry-run` · service active · `GET /` 401 ·
**`anomaly-sweep` cron VERIFIED present on the box** (AGENTS 13 — a script existing is not a script running,
and r230 lost six weeks to exactly that).

**ADR-0084 §2.4 / Phase 3 item 6.** `core/recurrence-mining.ts` implements one sentence: *a verdict closed
as `fixed_upstream` whose finding re-fires next cycle proves the fix did not hold.* It is the ONLY writer of
`agent_proposal.reversed_at`, and runs once per tenant at the END of `anomaly-sweep` — the evidence it needs
is the verdicts that same pass just wrote, so per-batch would ask before the answer exists and before-the-loop
would always be a cycle stale.

⚠️ **A RECURRENCE REVERSES A CLOSURE AND MUST NEVER TOUCH A HYPOTHESIS. This is the decision to re-read
before extending this file.** `close_fixed_upstream` claimed *the cause is gone*, so the finding returning
falsifies it. `anomaly_hypothesis` claimed *there may be a problem here*, so the problem returning CONFIRMS
it. Reversing the second would record a correct model as wrong — and because §2.8 reads these rates to grant
autonomy, the bug would teach the system to **stop raising hypotheses that were true**. A test pins it;
nothing else in the suite would notice.

⚠️ **"NEXT CYCLE" IS THE EMPLOYEE'S NEXT APPEARANCE, NOT ANY LATER ONE.** A fix that held for five clean
cycles and broke in the sixth is a REGRESSION; one gone by the very next payroll never worked. Only the
second falsifies the closure. A clean next cycle means the fix HELD and nothing is written — silence is the
correct record of a fix that worked.

⚠️⚠️ **FLIPPING `REVERSAL_HAS_A_WRITER` WAS NOT SUFFICIENT, AND THE SECOND HALF IS THE ONE THAT NEARLY
SHIPPED.** A closure is not TESTED until the employee is paid again, but `reversed ÷ approved` puts every
approval in the denominator — so ten closures all still pending would have printed **"0% reversed"**, which
is r248's own lie in a new coat, one round later. The rate is now blanked PER TYPE until at least one closure
of that type has been tested, and `closuresPending` is on the screen so a reader can tell *"no fix has
failed"* from *"no fix has been tried yet"*. **Verified by rendering a POPULATED card, not the empty state:
`close_fixed_upstream` shows an em dash beside a 100% agreement rate, exactly as intended.**

**ONE PREDICATE, TWO CONSUMERS.** `classifyClosures` is read-only and shared: the sweep writes reversals from
it, the Control Tower asks it whether the denominator is real. r235's rule — *share the predicate, never
re-write it*. A test pins that the read path writes nothing, because the screen calls it on every render.

**NO TENANT SWITCH, deliberately.** The three unattended agents each carry one because each DOES something to
the tenant. This writes one timestamp to a telemetry table about our own accuracy: nothing employee-facing,
no money, no notification. Gating self-measurement behind a switch is how a product ends up unable to answer
whether it works.

⚠️ **TWO CORRECTIONS TO r248, AND THE SHAPE MATTERS MORE THAN THE FACTS.** r248 recorded that
`recordDecision` had no callers and that wiring one "deserves its own round". **It has TWO** —
`core/payroll-anomaly.ts:742` (r238) and `core/readiness-nudge.ts:248` (r237). The claim came from ADR-0084
§2.3's *"what has no caller yet, deliberately"*, which was TRUE at r236 and was overtaken by the next two
rounds without the sentence ever being edited. **An ADR is a decision record, not a statement of current
fact, and nothing updates it when a later round overtakes it** — so AGENTS 7 applies to this repository's own
prose exactly as it applies to a ticket. A four-second grep settles it. That ADR line now carries a dated
flag pointing here.

### r238 · r239 · r240 · r241 · r242 · r243 · r244 — ALL SHIPPED. Full entries in `docs/HANDOFF-HISTORY.md`.

r238 hypothesis detection (migration `0454`) · r239 the attendance list's second face · r240 input-side
triage · r241 one consolidated Attendance Irregularity list · r242 EA review + leave inquiry · r243 the AI
agent switchboard · r244 an EA arrival says it is the EA. None of r239-r244 carried a migration.

### r230 · r231 · r232 · r233 · r234 · r235 · r236 · r237 — ALL SHIPPED. Full entries in `docs/HANDOFF-HISTORY.md`.

The facts from them that are still LIVE are in CURRENT STATE above, not here: the nudge agent is deployed
and off everywhere, the assistant is reachable and ungranted, `close_fixed_upstream` is the only action
type, and production has no admin whose `app_user` is linked to an employment.

### r221 · r226 · r227 · r228 · r229 — ALL SHIPPED. Full entries in `docs/HANDOFF-HISTORY.md`.

The one fact from them still worth carrying here: r227 shipped three branches that had been BUILT AND
LEFT UNMERGED for a day — a round is not finished until it is deployed AND recorded, and nothing but
this file notices when it is not.

### r177 · r179 · r180 · r184 — ALL SHIPPED. Full entries in `docs/HANDOFF-HISTORY.md`.

⚠️ **THE PANEL ROUND TRIP IS NOW COMPLETE, AND IT IS THE MOST EXPENSIVE LESSON ON THIS BOARD.**
r179 REMOVED the left-hand employee panel from Transaction View and Individual Payslip in favour of a top
search field. The approved plan EXPLICITLY warned that the reporter had previously asked for that panel to
EXIST on the neighbouring payroll screens, said both could not be true, and offered "reject this and say
so". They approved it, saw it live, contested both — and **r185 put the panel back on both screens.**

**The lesson is not that the warning failed — it is that a warning in prose does not substitute for seeing
it.** A mockup showed the new layout; nothing showed them what they were LOSING. Draw BOTH states whenever
a plan trades one thing away for another.

**AND IT MAY BE ABOUT TO HAPPEN A THIRD TIME.** Open item `1372d169` "Payroll Transaction View – Full-Width
Layout Enhancement" is asking for the width back. Full width and the left panel are the SAME trade-off they
have now reversed once in each direction. Whoever plans it must show both states and say plainly that this
is the choice — **do not silently re-remove the panel they just asked to have back.**

### ✅ THE ROSTER DELETE ASYMMETRY — CLOSED IN r191 BY `0436` (kept for the lesson)

A delete path that removed the parent and left children orphaned, closed by a migration. **The lesson
that outlived it: when a delete spans tables, COUNT what each side removes on real data before believing
the code reads symmetrically** — the asymmetry was invisible in review and obvious in a row count. Full
entry: `docs/HANDOFF-HISTORY.md` → r191.
### ⚠️ STATUTORY FORMS — THE PROVENANCE RULE (the three items themselves are closed)

**EVERY "AGENCY REFERENCE" ATTACHMENT THIS REPORTER HAS SENT HAS TURNED OUT TO BE ANOTHER PAYROLL
SYSTEM'S OUTPUT, NOT THE AGENCY'S PAGE.** Five so far — EPF Borang A, SOCSO Borang 8A, CP39 and EA are
all `Developer Express Inc. DXperience` PDFs with the auto-filled values highlighted. **Check
`pdfinfo`'s Producer before you plan any form.** They are usable as a TRACING SOURCE and are often a
faithful rendering, but a form drawn from one can never carry `fidelity: 'official'`, and the code that
draws it must record where its layout came from. `public/forms/` holds exactly ONE genuine artwork:
`cp22-pin-1-2021.pdf` — which carries LHDN's own "UNTUK RUJUKAN SAHAJA" watermark, deliberately, because
CP22 is filed through e-CP22 since 2024-09-01. **Ship what the agency publishes, stamp included.**

⚠️ **DO NOT TREAT A SPECIMEN'S FIGURES AS ARITHMETIC FIXTURES** — the SOCSO specimen's RM202.35 does not
reconcile to the EPF specimen's RM6,200 wage under the current PERKESO table on any reading. Take the
figure from the run and show the run's own total beside the form's.

⚠️ **`payslip.statutory.bases` IS ONLY ON PAYSLIPS FROM r187 ONWARD.** Pre-r187 rows must be FLAGGED,
never silently fall back to gross. This bites every statutory form and the r209 statutory-explanation
screen alike.
### r209 (2026-08-20) — ELEVEN ITEMS, SEVEN WORKSTREAMS, `0448`+`0449`. Full entry in `docs/HANDOFF-HISTORY.md`.

Moved out on 2026-08-21. Its durable half is AGENTS rules 23, 23b and 24-28. The two warnings below
are the only parts of it that are still LIVE BEHAVIOUR rather than round history.

⚠️ **THE EPF WORKSHEET IS A REPORT, NOT A SWITCH.** `computeMonthlyRuns` is STILL not wired into the
payroll kernel and must not be until an accountant signs off the §7 worksheet (ADR-0024 §5). The
worksheet r209 shipped is that document: a read-only replay that prices the difference on real history.
`MULTI_CYCLE_PAYROLL_ENABLED=true` gates CREATING second runs, not the aggregation.

⚠️ **EA EMPLOYMENT INCOME IS STILL FOLDED INTO ALLOWANCES, and un-folding it is its own round.** There is
no persisted per-component breakdown: `payslip` holds only aggregate scalars, there is no payslip-line
table, and `core/payroll.ts` folds every earning component into `payslip.allowance` before the row is
written. Doing it properly needs a new table, a migration, and a backfill that is impossible for slips
already generated — plus the CP8D/Form E reconciliation.

### r190 · r191 · r192 · r193 · r194 — ALL SHIPPED. Full entries in `docs/HANDOFF-HISTORY.md`.

Moved out on 2026-08-19 to keep this file near its ~700-line cap. What survived them lives in the
sections around this one: the entity-transfer warning below, the roster-delete measurement above,
and rules 13-22 in AGENTS.md, which those five rounds are the reason for.

### ⚠️⚠️ ENTITY TRANSFER: STAGE ONE IS INCOMPLETE IN A WAY THAT UNDERPAYS. READ BEFORE RE-RUNNING ANY MONTH.

**Proven on production 2026-08-14, and it produced a real underpayment that had to be reversed.** Employee
100814 (employment `aa899123`) transferred Fiamma → ISEDECOR BINA effective 2026-08-11. Reprocessing their
August through `reprocessSelectedEmployees` gave:

    BEFORE  1 payslip · gross 6,600.00 · net 5,832.35 · 31 days · v2
    AFTER   1 payslip · gross 4,470.97 · net 3,946.82 · 21 days · v3      ← 6600 ÷ 31 × 21, the ISEDECOR part
    MISSING the Fiamma 1–10 Aug counterpart, 6600 ÷ 31 × 10 = 2,129.03

The proration is CORRECT. What does not happen is the second payslip, **and it structurally cannot**:
**every company has its OWN batch for a period** — 2026-08 has EIGHT batches, one per company (Fiamma
`30ba5f09` 1 employee; ISEDECOR `3b62dc57` 23) — and `reprocessSelectedEmployees` recomputes strictly
within the ONE batch it is given. A mid-month transfer therefore spans two batches by construction, and no
single-batch operation can complete it. The batch total fell by exactly 2,129.03, which is how it was
caught.

**RESTORED** to the pre-reprocess figures (payslip v4, batch totals back to gross 98,952.09 / net
86,792.14, verified equal to the sum of its 23 payslips). Both directions are in
`payroll_employee_result_history` with reasons. **The assignment company history was LEFT INTACT** — it is
correct: three periods, Fiamma to 2026-08-10, Fiamma 08-10→08-11, ISEDECOR from 08-11.

**DO NOT RE-RUN AUGUST FOR 100814** until cross-batch segment creation exists. That is the first thing
stage two (`1b0943d5`) must answer — ahead of attendance and leave, which is not how that item is currently
written.

**TWO RESTORE LESSONS, both cost time here:**
  1. `payroll_employee_result_history.before` carries only SIX keys — `grossPay`, `netPay`,
     `totalDeductions`, `employerCost`, `version`, `statutory`. It does NOT carry `basic_salary`,
     `allowance`, `overtime_pay`, `other_deductions`, `bonus` or `days_worked`, so it is NOT sufficient to
     rebuild a payslip on its own. The backup was needed for the rest.
  2. **You cannot restore a scratch database on the server**: `ai_hr_owner` is `rolcreatedb=f`,
     `rolsuper=f`, so `CREATE DATABASE` is refused. Read rows straight out of the dump instead —
     `pg_restore -t <table> -a -f - <dump>` emits the COPY block and its column header, and you can grep the
     row you want. No database required.

**`3c88d593` IS MARKED DEPLOYED FOR STAGE ONE ONLY**, with `build_ref` saying so. Stage two is `1b0943d5`,
now PLANNED with a mockup drawn on 100814's real figures — see START HERE §2 for the two blockers it names
and why the item's original ordering was reversed. The mockup deliberately states WHY two payslips are
impossible today rather than just drawing them: stage one's mockup promised two payslips the build could
not deliver, and repeating that would be the panel round-trip lesson all over again.

### r187 · r188 · r189 — ALL SHIPPED. Full entries in `docs/HANDOFF-HISTORY.md`.

r189 claims grade-first limits (`0435`) + the pay-item formula builder · r188 the "Apply to Early
Overtime" untick defect (no migration) · r187 eight items (`0430`/`0432`/`0433`/`0434`), the round
whose merge order silently skipped two migrations — that lesson lives in AGENTS.md rule 14.

### r180 IS ARCHIVED (history) — but ONE thing it found is still live and unfixed

r180 found recurring pay items paying TWICE on issued payslips, and fixed the writer. r185's `2aed39d4`
then added the `employment_pay_component_no_overlap` EXCLUDE constraint and repaired the 9 bad rows, so
the *overlap* half is closed. **What is NOT closed:**

⚠️ **A MID-MONTH RESTATEMENT STILL PAYS BOTH LINES IN FULL.** End one line on 15/07 and start the next on
16/07: the two windows are adjacent and legal under the constraint, but BOTH overlap the month and the
kernel pays each returned row its FULL amount. The first regression test written returned **1554 = 777 +
777**. It is recorded as `it.fails` in `test/fixed-transaction.test.ts` — the same idiom this repo uses for
the known width no-op — **so the gate turns RED when someone fixes it.** Leave it failing and leave it
labelled.

**Fixing it is a DESIGN DECISION, not a patch:** prorate a partial window, take latest-row-wins per period,
or refuse a mid-period restatement. Each changes what CORRECTLY-dated rows pay today, so it belongs to the
reporter. `2aed39d4`'s approved plan names it in GOOD TO KNOW as a request of its own — it has not been
raised yet.

### r176, r175, r174, r173 and r172 are SHIPPED — full entries in `docs/HANDOFF-HISTORY.md`

One thing outlives those rounds and is deliberately NOT archived with them:

**NOT BUILT ON PURPOSE — Pay Items has no per-row Edit, and adding one naively DOUBLES PAY.**
`setEmploymentPayComponent` closes the open row at the new `effectiveFrom` and inserts a fresh one, while
the kernel selects every row overlapping the period — so re-stating an item inside its own running month
leaves BOTH rows in the window. The table already renders every column, so a View would be furniture.
**Safe editing needs a dating change, not a presentation change.**

### ⚠️ A SCRIPT THAT IS CORRECT AND MUST NOT BE RUN

- **`scripts/seed-overtime-multipliers.ts` IS DEPLOYED, CORRECT, AND MUST NOT BE RUN** (`2da9937a`, seed
  step withdrawn). A pay component was always the wrong mechanism: overtime is ALREADY wage-derived per
  employee (`localization/my/payroll.ts overtimePay`, multipliers and ceiling configurable per ADR-0019),
  and one flat rate for everyone cannot express that.

- ⚠️ **THE `OT1_5` DIAGNOSIS THAT USED TO SIT HERE IS NOW WRONG — THE REPORTER FIXED IT THEMSELVES
  (measured twice on production, r178).** This file used to state that `OT1_5` holds
  `{"kind":"per_hour","rate":1.5}` and is "the tenant's only `per_hour` item". **Production now has ZERO
  `per_hour` components.** On 2026-08-10 09:58:36 the reporter changed `OT1_5` to a **`formula`** rule —
  `(basic + fixed_allowances) / 26 / 8 * 1.5 * hours` — i.e. they took `b00f9e6e`'s "reject and we build
  it" option by building it. At 10:01:53 they keyed 10 hours, deriving **RM 396.63**, on processed payslip
  `ced390ae`. **DO NOT ARCHIVE `OT1_5`** — the approved revision-1 plan said to, and doing so now removes a
  working item and makes its three `payroll_individual_txn` rows uneditable
  (`core/payroll-individual-txn.ts:239` throws unconditionally).
  **`employment_pay_component` WAS THE WRONG TABLE TO CHECK**: revision 1's load-bearing sentence "nobody
  has ever been paid a cent from it" was already false when written — RM 2.00 was keyed 2026-08-04 and paid
  on processed payslip `c32b0088` on 08-07. **Verification trap:** both amounts are stored in the `bonus`
  column with `overtime_pay` 0.00, and read as overtime only through `statutory->'displayEarnings'`
  (`core/pay-display-category.ts:73-84`). Anyone checking `payslip.overtime_pay` will wrongly conclude the
  reporter's overtime never landed. Revision 2 is pushed and awaiting them.

### 6e9a126e RELEASE THREE — the one fact still live (full entry: history → r167)

**THE CUSTOMER STILL HAS ZERO ENTITLEMENT CONFIGURED.** Every figure reads blank until ~400 items are
retyped from the archive into Entitlement Templates + Employee Eligibility. The no-opinion guard is what
keeps balances still while that is true — if a recalc ever starts posting non-zero deltas against an
unconfigured type, that guard has broken and it is the first thing to check.

### The board

**Counts live in CURRENT STATE and are not repeated here. Always RE-COUNT** — the line said
`approved = 0` on 2026-08-08 and eight items were approved the next morning.

**COUNTS LIVE IN CURRENT STATE ONLY — re-count on the box before acting on any of them** (this line has
been wrong four times). As of 2026-08-17: `deployed = 674` · `approved = 19` · `planned = 2` ·
`cancelled = 14`.

**THE CONSTRAINT IS BUILDS.** It has flipped five times in a week. **Check which side is short before
choosing what to do next** — `improve:pull` for unplanned work, `improve:pull-approved` for unbuilt work.
⚠️ **`pull-approved` RETURNS ITEMS THAT ALREADY CARRY A `build_ref`, AND THAT IS NOT A BUG.** A post-deploy
refute (`feedback.deployment.refuted`) → re-plan → approve leaves the OLD `build_ref` on the row beside a
NEW plan revision. Six of the 19 approved on 2026-08-17 are exactly that shape, so **never decide "already
shipped" from `build_ref`** — read the item's `domain_event` stream and compare the approved revision with
the one that was built.

**c8052ae3 IS DONE — the leave reset RAN on 2026-08-12.** It was the longest-open item on the board.
147 `leave_ledger` rows and 22 `leave_entitlement_recalc_audit` rows archived under capture tag
**`c8052ae3-2026-08-12`** and then deleted; `leave_ledger` went 318 → 171, leave requests (41) and
payslips (121) untouched, no entitlement generation run. The record is at
`/admin/leave/entitlements/ledger-archive`, reached from the Entitlements screen and deliberately not in
the sidebar.

⚠️ **THE SENTENCE THAT USED TO SIT HERE — "Medical and Hospitalization now read 0.00 for everyone because
no rows exist, not because something granted zero" — IS HALF FALSE, AND THE HALF THAT IS FALSE MATTERS.**
Measured on the box 2026-08-18 while planning `70ac09ef`:
  · **HOSPITALIZATION has 35 `leave_ledger` rows**, all `accrual`, effective 2026-01-01 → 2026-07-27, and
    they sum to **0.00 days**. Rows EXIST and the engine granted zero.
  · **SICK (Medical Leave) has 0 rows**, and `UPM` has 0. For those two the old sentence was right.
The distinction is the whole diagnosis. `openLeaveYear`'s `no_entitlement` (days ≤ 0) and `earned_method`
branches both `continue` WITHOUT writing a row, so a row sitting at 0.00 cannot be either — it can only
have come through the `isAccrualUnconfigured(t) ? 0 : …` line, which also proves a template band DID
resolve. Hospitalization's table is fine; the leave type has **no earning method set**, and the engine
deliberately grants zero while that is true. Saving the earning method fires
`reprojectEntitlementForLeaveTypeCohort` and credits all 35 in one top-up — pressing Generate Entitlement
does NOT fix it, because those 0.00 rows already mark the year open and the run reports them as granted.
**`70ac09ef` is CONTESTED as of 2026-08-19 — read the reporter's push-back before acting on any of this.**

⚠️ **TWO STEPS OF THAT PLAN WERE WRONG, AND ONLY RUNNING IT FOUND THEM. Fix them before reusing it.**
1. **Step 0's `pg_dump "$U" -Fc -f …` EXITS 1 on this database** and leaves an ~889 KB partial that looks
   like a backup and is not. `ai_provider_config`, `leave_adjustment_batch` and `platform_user` are FORCE
   RLS; `ai_hr_owner` has neither superuser nor BYPASSRLS and there is no passwordless sudo to `postgres`.
   The working form adds `--exclude-table-data=` for those three — and all three hold **0 rows**, so the
   dump is complete anyway. **Verify a dump with `pg_restore -l`, never with its exit code alone.**
2. **Step 4's check `leave_entitlement_recalc_audit 0` IS WRONG** and reports failure on a correct run.
   It must read **0 FOR THE TWO RESET TYPES**. After the real run the table holds 50 rows, every one of
   them ANNUAL — which the script correctly did not touch. A check that fails on success is how a good
   result gets rolled back.

**THE CONSTRAINT FLIPPED TWICE IN ONE DAY** — theirs, then ours (13 items planned in an afternoon), then
theirs again. **Check which side is short before choosing what to do next:** `improve:pull` for unplanned
work, `improve:pull-approved` for unbuilt work.

⚠️ **`2f889bae` IS NO LONGER APPROVED — it was RE-PLANNED at revision 2 on 2026-08-12 and now awaits the
reporter.** Do not build it from an older reading. Of its seven revision-1 steps, **five were already
delivered** (step 1 by r180's `34cc8137`; steps 2–5 by r185's `2aed39d4`), **step 7 asks for the OPPOSITE
of what is live** (it wants Remove refused for any COMPLETED run; r185 shipped Remove allowed while
`processed` and refused only once `closed`, on the reporter's newer instruction), and the only work left is
a View/Edit link on the Personnel Payroll tab, which is read-only today while the real buttons sit one
screen away at `app/payroll/transactions/fixed/[id]`.

**TWO ITEMS RAISED BY US ON 2026-08-12**, both from findings that belonged to no approved plan:
`47609f53` (supervisors are shown dashboard links to screens that refuse them — the `2ec1e3d2` plan
claimed it had checked for siblings and found none, which was wrong) and `154865f4` (the roster DELETE
asymmetry above). Both `open` with `reporter_label = 'CLAUDE AI'`.

⚠️ **A RAISED ITEM NEEDS A PLAN, NOT AN ANSWER — this file said the opposite and it cost a day.** An item
created by `improve:raise` lands `open` with `plan_revision = 0`, and **an item with no plan has no approve
or reject button**, so its recommendation sits in the description where the reporter can do nothing with it.
The old line here said `42afb2d2` "needs an ANSWER from the reporter, not a plan, and `improve:push-plan`
must never be pointed at it". That is backwards and is why it sat. Giving a raised question a PLAN is how
they answer it: approve means leave it, reject-with-reason means do the other thing.

**THE REPORTER COMMUNICATES IN PICTURES — 143 of 151 attachments are images.** Read an item's attachment
BEFORE forming any opinion; this session burned a plan revision writing from the prose alone and the
screenshot showed a different screen entirely.

### Plans must carry a MOCKUP — shipped r165

**The full procedure and its rules live in `scripts/mockup/README.md`** — read it before drawing one; it
is kept in step with `.claude/skills/feedback-plan`. The three that cost a round each, in brief: attach
AFTER pushing (`plan_revision` is stamped server-side, and `pushPlanWithMockups()` enforces the order);
a mockup is a PROMISE and a picture cannot hedge, so draw only what will be built and keep the uncertain
parts in words; and use the reporter's OWN measured data — r170 drew invented employees, and the
half-fix of real names with invented figures was worse, because it looks authoritative and is wrong.

**NOTHING IS `building` OR `approved`-and-unrecorded.** `improve:pull` hides `building`, so a partially
built item MUST be recorded here — nothing else surfaces it.

### THE DELETE GUARD (r160) — the count was the lesson (full entry: history → r160)

**A list of referrers maintained by hand is wrong the moment anyone adds a table.** `deleteLeaveType`
counted five, its `inUse` predicate counted three, and the database carried TWELVE foreign keys — both
the plans and this file said eleven. So there is no list: `core/leave-type-refs.ts` declares each
referrer with a disposition (`history` refuses, `config` cascades), both the button predicate and the
delete guard are GENERATED from it, and `test/leave-type-referrers.test.ts` fails if the declaration and
the live foreign keys disagree either way. Verified still in place 2026-08-09.

**`inUse` MEANS "this type has HISTORY"**, not "anything points at it" — a type carrying only policies
and approval rules is correctly deletable. `core/read.ts` documents the identical hazard for job grades.

### ⚠️ DECISIONS TAKEN THAT THE REPORTER SHOULD SEE

- **Notice Board ships MARKDOWN, not the requested WYSIWYG** — owner-approved 2026-08-05. Storing raw
  HTML would make every notice a stored-XSS vector aimed at every employee.
- **`3c473773` did NOT change the statutory calculation.** Its build note said `earningsOf` should
  switch on the new category — taken literally that moves EPF, SOCSO, EIS and PCB, contradicting the
  same plan's promise. Shipped as a decoupled DISPLAY overlay; stored payslip columns unchanged.
- **`18103ba4` refused Job Title / Employee Group / Employee Class** — no column, catalogue or import
  field exists. The screen NAMES them as unavailable rather than silently omitting them.
- **Claims stage 1 has no `reserved_amount` column**, deliberately: a stored counter is what gets
  decremented twice and silently frees limit that is still consumed.

### ⚠️ ONE OWNER DECISION OPEN ON ATTENDANCE — free to make NOW, expensive later

1. ✅ **THE OT ROUNDING RULE — DECIDED AND BUILT IN r186 (`7c834696`). ROUNDING IS DOWNWARD.**
   `core/attendance-rule.ts applyOtRuleRows` uses `Math.floor`, so a band's Round-To can never return
   more minutes than were worked nor exceed the band's own upper bound. **Built on `build/r186-attend`;
   see that round's entry for merge/deploy state.**

   History, kept because this entry was wrong twice. It first said "Production has exactly ONE rounding
   band — rule `A01` … it decides ZERO days"; that was overtaken on 2026-08-05 when `A02` (the SAME row,
   renamed) got a 60–119 band with round-to 60 and 8 shifts began selecting it. Rounding to the NEAREST
   60 then sent 90 minutes upward to 120 — past the band's own 119-minute ceiling — so a day inside the
   band paid MORE than was worked, and it created a cliff (1h29 paid one hour, 1h30 paid two, 2h00 paid
   two). Two real days, re-measured on production 2026-08-11:

       Eee Lee Yong             2026-08-05  out 19:30   ot_minutes 120   worked  90   → 60
       NURUL ALIAH BINTI ACHIN  2026-08-05  out 19:40   ot_minutes 120   worked 100   → 60

   Every other overtime day on production matches its raw minutes exactly, and every Standard-governed
   OT figure is an exact multiple of 60, so floor moves nothing else.

   **THE STORED FIGURES DO NOT MOVE ON DEPLOY.** Code decides new derivations only; the two rows above
   keep their 120 until someone runs the SCOPED recompute (Attendance → Recompute Attendance,
   `core/attendance-recompute.ts`) for **2026-08-05 and those two employments only**. Do NOT run a wide
   recompute: shift codes and times were reassigned on 2026-08-05 17:45–17:47 and 41 historical days
   already carry a stored OT that disagrees with today's shift times.

   `test/attendance-stage1-calc.test.ts` and `test/attendance-ot-rounding-money.test.ts` pin the new
   rule against `A02`'s REAL two-row geometry and name the exact minutes that move — update them, never
   loosen them.

   **A02's OTHER SETTINGS, verified, because they read as bugs and are not:** grace is 5 minutes on
   arrival and **0 on departure**, and `include_grace_in_lateness` is TRUE — so a 09:06 arrival counts
   6 minutes late, not 1, because once the grace is spent it stops counting in the employee's favour at
   all. `apply_deductions` is FALSE, so no lateness or early-out deduction has ever been taken from
   anyone's pay, on any day. **Lateness and early-out are RIGHT; only overtime was wrong.**
2. **"Overtime beyond the final band shall not be counted"** would cut `ot_minutes` DOWNWARD and
   retroactively. Not built — those minutes keep the final band's rate. Truncation needs its own opt-in.


### ⚠️ THE PAID-ITEM GUARD IS ONLY ~14% EFFECTIVE TODAY, AND THAT IS BY DESIGN

`f1123afd` refuses to remove a recurring pay item paid on a processed payslip, but it can only fire where
the payslip stored WHICH component produced a line — measured 2026-08-05, **7 of 50 payslips** carry
`statutory.componentLines`. Line stamping began 2026-08-01 (`862ed0ad`) and earlier runs cannot be
itemised retrospectively.

**There is no payslip line table.** Per-item detail lives in `payslip.statutory` jsonb keyed by catalog
CODE, not by `employment_pay_component.id`, so the guard also needs the batch's `pay_period` to fall
inside that row's own validity window to attribute a line to it rather than a sibling.

**With no stored evidence the removal is ALLOWED, deliberately** — refusing on absence of evidence would
block removing almost every pre-August recurring item with no way to prove otherwise. Pinned by a test, so
reversing it means changing a test and saying why. **It is protection going forward, not a repair of
history** — say that plainly rather than implying paid items are protected.

### Durable product facts and unbuilt follow-ups (measured 2026-08-04/05; the items themselves SHIPPED)

Per-item measurements are in `docs/HANDOFF-HISTORY.md` under their rounds. What outlives them:

- **`employment_type` lives on `assignment`, NOT `employment`** — a query against
  `employment.employment_type` errors.
- **`EMERGENCY_LEAVE_CODE = 'EMERGENCY'` is still hardcoded** while production's type is `EL` — the
  constant is documented as "the code the PACK SEEDS" and the resolver has changed, so **re-verify
  against the tree before reusing the old diagnosis**; its old line numbers have moved.
- **"Processed By" on the payroll dashboard is viable** — 43 processed events, 43 with a resolvable
  actor name. A two-join + one-`<td>` change; shipped without it only because an agent could not
  verify from its sandbox.

### Waiting on the owner, not on code

1. **Slice 6's deploy-failing flip** (unclassifiable company: warning → failed deploy) needs explicit
   confirmation before shipping — right end state, deliberate foot-gun.

**FIVE cron jobs now, not four (2026-08-09).** `accrue-earned` (monthly, 1st 02:00), `review-sweep`
(daily 03:00), `expire-carry` (yearly, 1 Apr 03:00), `provision-runner` (every minute), and
**`capture-usage` (daily 01:00)** — ahead of the leave sweeps so it meters the day before they mutate
it. **`expire-aged-leave` is NOT among them** (an older note here claimed five including it; its line
is commented out on the box). **Verify with `crontab -l` as `ubuntu`, NOT `systemctl list-timers`** —
no timers exist.

### ⚠️ LEAVE ENTITLEMENT — THE FACTS r208/r209 ESTABLISHED (nothing else records these)

**`maxBalanceDays: 0` IS A REAL CAP OF ZERO, NOT "UNSET".** `bandMaxBalance` (core/leave-compute.ts)
accepts any finite number ≥ 0 and `applyMaxBalance` clamps the running ledger at grant, so a leave type
configured with a 3-day table and a Maximum Balance of 0 grants 3 and immediately clamps to nothing.
Six leave types on production are in exactly that state. **`0` is also what someone types when they mean
"no limit"** — r209 added a warning rather than changing the semantics, because altering a leave-affecting
default as a side effect of a configuration round is how it happens to nobody's decision. If that
semantic is ever changed, it needs its own item.

**AN ENTITLEMENT RESOLVES THROUGH `template ?? scheme ?? policy`, AND THE TEMPLATE ARM NEEDS AN
ELIGIBILITY RULE.** On 2026-08-19 the tenant had exactly ONE `entitlement_eligibility_rule`, pointing at
the PERMANENT Medical table, with `valid_to = 2026-08-13` — expired. Since that date NO employee resolved
to ANY template, which is the single cause behind three separate board items. **An expired or missing
rule is silent by nature**; r209 shipped the health card and the per-employee "why is this 0.00" caption
so it cannot be silent again.

**"PERMANENT" vs "CONTRACT" IS CARRIED BY THE JOB GRADE NAME, NOT `employment_type`.** That column holds
`full_time` (55) / `contract` (3) / `part_time` (1) and cannot separate five of the six Medical tables.
The grade families — `GRADE 12 (PERMANENT)`, `GRADE 12 (C-RETIREE)`, `CONTRACT - GRADE 12 (SPECIAL)`,
`CONTRACT - SPECIAL (40 AL)`, `Executive` — map one-for-one onto them. **Key eligibility rules on
`gradeIds`.** `Executive` maps to no table and the reporter has not said which it should use.

**THE SHARED-POOL MECHANISM IS `leave_type.balance_source_type_id` AND IT ALREADY WORKS** — Emergency
Leave draws from Annual Leave on production. Configure it; do not build a second pooling path. Note
`leaveBalancesAll` (the all-employee pivot) does NOT pool, only `leaveBalances` does.

### Known live defects, deliberately left standing

- **THERE ARE SIX INLINED COPIES OF THE SHIFT SPAN-MINUS-BREAK CALCULATION, and the sixth cannot be
  deduplicated (r174).** The canonical one is `netScheduledMinutes`; `rosterVariance` was the fifth and
  was fixed this round after it disagreed with the engine on a rounded shift. The sixth is
  `components/shift-time-fields.tsx:63-71`, which recomputes span, the unpaid-only break sum and the
  rounding floor by hand. **It is CORRECT today** — already rounding-aware and paid-aware — but nothing
  tests that it tracks the engine, and it is `'use client'` while `core/attendance.ts` imports
  `db/client` and drizzle, so it CANNOT import the shared helper. If the scheduling rule changes again,
  this is the copy that silently drifts. The real fix is extracting `netScheduledMinutes`/`shiftSpan`
  into a dependency-free module both sides can import. Two further copies exist at
  `core/attendance.ts:279` and `app/admin/attendance-policy/page.tsx:251` — those are the
  `attendance_policy` domain, which has no rounding column and no shift, and must NOT take the shift
  rounding parameter.

- **`${inputCls} w-<n>` is a width NO-OP in ~133 files** — `inputCls` contains `w-full`, and the
  stylesheet's emission order wins, not the class attribute. Recorded as `it.fails` in
  `test/tailwind-width-order.browser.test.tsx`, so the gate turns RED when someone fixes it. Not on
  the board yet (awaiting the owner). Fix is `tailwind-merge` (already a dependency) or dropping
  `w-full` from `inputCls`; **both change rendered widths across 133 files — measure before
  planning.**
- **Sepang location carries `country = 'SG'`** on a Malaysian company — a data-entry slip, harmless
  since r110 (state validation narrows by the COMPANY's country). A human should fix the row; **a
  validator silently rewriting customer data would be worse than the error.**

### What I would pick up next (platform work from ADR-0077 — NOT on the board; nothing will surface it except this entry)

- **Finish slice 6**: sweep remaining reports for one-jurisdiction assumptions — grep `packFor(` in
  `core/` and check each against "whose jurisdiction is this row?". r115 fixed the overtime report.
- **Provision slice 7** — create `ai_hr_platform` from `deploy/bootstrap-db.sql`, set
  `PLATFORM_DATABASE_URL`. No code; turns `pnpm platform:usage` from exit-2 into a working report.
- **Slice 9's ONE gap: give `closureDecision` a caller.** Decision function, retention check and schema
  are built and tested; nothing invokes them. Reactivation already has its runner.
- **Slice 10's dashboard**, now that the meter records daily. Wants slice 7 provisioned first.
- **The old line here called 7 and 8 "the big untouched ones" — wrong for both.** This table has now
  gone stale on 7, 8, 9 and 10 in turn: **check the tree before believing any row of it.**

## Settled decisions — do not reopen

- **`fa3f4ccb` statutory minimum removal is SETTLED — do not re-refuse.** The reporter asked twice
  with reasoning; a reaffirmed instruction is the owner's decision. The configured figure wins and the
  EA 1955 floor renders as a non-blocking warning. **Scope: entitlement DAYS only** —
  `core/leave.ts:553`/`:557` (the right to APPLY) and the `updateLeaveType` statutory guard are NOT in
  scope. Keep `floorDays` in the return shape; recomputing the floor in the UI is how figures drift.
- **ANNUAL carry-forward expiry is 6 months** (`0333`, r85) — the reporter's policy change. "My
  carried leave disappeared early" is intended behaviour, not a bug.
- **`c33d9bbb` is PARKED BY THE OWNER** (2026-07-31) and is now `cancelled` on the board — re-counted
  2026-08-05, correcting an older line here that said it "stays `contested`". Either way, writing a
  rev 2 would re-open a settled decision.
- **`reporter_label` is DISPLAY ONLY** — `raiseFeedback` stamps `'CLAUDE AI'`. **Never "simplify" this
  into a synthetic person + employment**: `reporter_employment_id` drives RLS `can_see_employment()`
  and a fake employment row would join `openLeaveYear`, payroll and every employee list.
- **The entitlement page header stays empty** (`962077a8`, guarded by
  `test/entitlement-header-actions-removal.test.ts`).
- **Never edit an applied migration file** — drizzle records a content hash. (`0333`'s header
  mislabels itself as the guard; the guard is `0334`. Left uncorrected on purpose.)
- **Per-band carry-forward columns/JSONB/readers are retained, not dropped** (r85) — do not "tidy"
  them away.
- **`transferEmployee` has zero production callers and is kept deliberately** — it is the only writer
  of `assignment.transferred`, which `reverseLegTx` still replays. Not dead code.

## How this project is actually run

**Deploy is automatic after a green gate** (owner's override of ADR-0045; AGENTS.md carries the rule).

**THE GATE, IN FULL — and the middle line is the one that keeps being got wrong:**
`pnpm exec tsc --noEmit` · **`CHUNKS=6 bash scripts/gate-chunked.sh`** · `pnpm exec next build` ·
`pnpm gate:shadow` whenever a migration is involved.
⚠️ **`CHUNKS=6` IS PART OF THE COMMAND, NOT A TUNING KNOB — this line omitted it until r227 and that
omission cost a whole false-red gate cycle.** The Environment section has said "CHUNKS=6, NOT the
default 3" since 2026-08-10; this headline recipe contradicted it, and the headline is the one people
copy. The default 3 now puts ~248 files in a chunk, which fills the RAM disk and kills the cluster.
**NOT `pnpm vitest run`.** A bare full run exhausts the RAM disk and kills the cluster mid-suite — it
produced two false red gates on 2026-08-06 alone (293 and 9 failed files, zero assertion failures both
times). The shadow rehearsal is the one that catches a journal `when` collision, which is a SILENT SKIP.

**Deploy mechanics.** SSH port **8288**, `ubuntu@203.142.6.241`, app at `/opt/ai-hr`. rsync (excluding
node_modules/.next/.git/.env*/.turbo/coverage/.claude/graphify-out) then `./deploy/deploy.sh` on the box,
which migrates, seeds catalogs, runs backfills and restarts. **The server has NO git checkout** —
`git log` there tells you nothing. **Run deploy.sh under `nohup … &` and poll its LOG**: it outlives a
10-minute ssh, and `pgrep -f deploy/deploy.sh` matches the waiter's own command string (cost 10 minutes
on 2026-08-06). `GET /` returning **401** is CORRECT — the password gate, not a failure.

**Before planning ANYTHING, run BOTH of these checks. Neither one finds what the other does.**

**1. Is `main` itself ahead of production?** (r159: it was, by a whole release.) This is the check
that did not exist before r159 and the only one that would have caught r158 sitting merged and
undeployed. It costs seconds and needs no branch archaeology:

    cd .claude/worktrees/mainwt && rsync -azi --delete --dry-run \
      -e "ssh -p 8288 -o BatchMode=yes" \
      --exclude node_modules --exclude .next --exclude .git --exclude '.env*' \
      --exclude .turbo --exclude coverage --exclude .claude --exclude graphify-out \
      ./ ubuntu@203.142.6.241:/opt/ai-hr/

Zero lines = production matches `main`. Anything else is an undeployed release, no matter what
CURRENT STATE claims. **Do this before trusting any "what runs" line in this file, including the one
above** — that line has been wrong.

**2. Is there an unshipped BRANCH?** — r86 was 13 finished items sitting unmerged while `main` stood
at r85, and a finished round nobody shipped looks exactly like no round:

    for b in $(git for-each-ref --format='%(refname:short)' refs/heads/build); do \
      n=$(git rev-list --count main..$b); \
      [ "$n" != 0 ] && echo "$b: $n unmerged"; done

(Use `for-each-ref`, not `git branch --list | tr -d ' *'` — the old form here mangled the `+` marker
git prints for branches checked out in another worktree and produced a screenful of
`unknown revision +build/rNNN`.)

Then LOOK at what it prints — the count alone lies (`build/r71` reports 4 unmerged commits whose
content reached main by another route). Confirm with `git diff --stat main <branch>`: main deleting
thousands of lines means the branch is old, not pending. A real pending round has recent commits, an
integration commit, and a small diff of genuinely new files.

**Reply on Telegram when the owner writes from Telegram.** Terminal output never reaches their chat.

## The feedback board — how the loop works

**Commands** (all from a checkout, `IMPROVE_SSH_HOST=203.142.6.241 pnpm improve:<cmd>`):
`pull` (open + contested ONLY — it hides `building`) · `pull-approved` · `pull-blocked` · `push-plan` ·
`block` / `unblock` · `build-start` / `build-complete` · `release` · `mark-deployed` · `raise`.
The CLI default host `10.20.30.20` is LAN-only — always set `IMPROVE_SSH_HOST`.

Parsing tip: `pnpm` prints a banner before the JSON. Split on the first `\n[\n`, not the first `[`.

**Plans are PLAIN TEXT.** The board renders them RAW — no Markdown. There is a skill for this:
`.claude/skills/feedback-plan`. Read it before writing any plan. Business language above the dashed
line, all technical detail in the BUILD NOTES trailer below it.

**Approve carries NO payload.** A plan that asks the reporter to choose between options can never be
answered — one item sat unbuilt three rounds that way. State ONE course of action, recommend it, and
tell them to reject with a reason if they want otherwise.

**Statuses:** open → planned → approved → building → done → deployed, plus `contested` (pushed back,
re-plan from the reporter's latest words) and `blocked` (approved but waiting on an answer).
`startFeedbackBuild` accepts ONLY `approved`, which is what makes `blocked` a real guard.

**Plan history is immutable** (`feedback_plan_revision`, append-and-close-once, by policy and by
trigger). Read a plan's `KNOWN OPEN POINTS FROM REVIEW` block before building it — that is where
unresolved objections are recorded, with citations.

**Adversarial plan-critique loops do not converge.** r123 spent 34 agents / ~3.2M tokens over two
rounds on 10 contested plans; verifiers confirmed round-1 fixes landed, then found deeper, different
defects each pass. 0 of 10 survived and there is no stopping rule. Do not simply run another round.

## Running builds with subagents

**THE METHOD IS NOW AGENTS RULES 23, 23b AND 24-26. Read those first; this section is only what they
do not fit.**

The shape that works, proven over r206 and r209: the PARENT creates every worktree from `main` with an
ABSOLUTE path, copies in `.env.local` and symlinks `node_modules`, allocates migration numbers centrally,
and groups workstreams so **no two agents touch the same files** (that grouping is what makes a
conflict-free merge, not luck). Each agent gets its own `TEST_DB_NAMESPACE` and runs ONLY narrowly
targeted tests — the parent runs the single full gate, alone, afterwards.

`isolation: 'worktree'` is FORBIDDEN here: it cuts the agent's tree from root HEAD, and the root is a
stale scratch worktree. `scripts/improve/r209.workflow.js` and `fix-r209.workflow.js` are kept in the
repo as the worked example of both passes.

Agents commit on their own branch and never amend, rebase or `git stash` (stashes are REPO-GLOBAL and
another agent will get yours). Before merging, and again immediately before the final gate, run
`git log --oneline main..<branch>` for EVERY branch — a workflow reporting "N complete" is not the same
as its branches being frozen (rule 19).
## The code graph — query it before spelunking

**`graphify-out/` in THIS worktree holds a knowledge graph of the whole codebase**, built from local
tree-sitter AST (no API key, no LLM). Untracked and rsync-excluded; regenerable in ~a minute.

**Use it FIRST when you need to understand code** — who calls what, with file:line, read from the tree
rather than from this file's prose (line numbers in prose go stale; the graph does not — it already
corrected one of this file's own citations). All commands run from this worktree:

    graphify explain "applyLeaveTypeRules"     # a node + every caller/import, with file:line
    graphify query "how does X reach Y?"       # BFS over the graph, --budget N tokens (default 2000)
    graphify path "requestLeave" "core/payroll.ts"   # shortest path between two nodes
    graphify affected "withTenant" --depth 2   # reverse traversal: what breaks if X changes
    graphify god-nodes --top 20                # the architectural hubs
    graphify-out/GRAPH_REPORT.md               # community map of the codebase (labels = hub node names)

**Every build updates it:** `graphify update .` after any merge to main (seconds, no LLM); add
`--force` after a refactor that deletes a lot of code.

**Known limitations:** the 313 `.sql` migration files are not parsed (`tree_sitter_sql` not
installed — the live schema is the drizzle TS, which IS in the graph); community labels are
hub-node names, not LLM prose (semantic naming needs `ANTHROPIC_API_KEY`); `graph.html` is not
generated (the 5,000-node viz limit) — the CLI queries are the interface. **Symbols exported
through destructuring under-report**: `explain "withTenant"` resolves to a `{ db, client,
withTenant }` node with no caller edges, while a plain exported function (`applyLeaveTypeRules`)
shows all 22. When `explain`/`affected` come back thin on a symbol you know is hot, fall back to
grep — an empty result is a parser gap, not proof of no callers.

## Environment — read before you lose an hour

### Worktrees and which tree you are on

- The repo ROOT (`~/Projects/ai-hr`) is a SCRATCH worktree on `local/root-scratch`, far behind main.
  **`main` lives at `.claude/worktrees/mainwt`.** The root's HANDOFF.md is a stub pointing here.
- **Check `pwd` and the branch in EVERY gate command, and read vitest's `RUN` line + file count.**
  A gate run in the wrong tree reports GREEN for the wrong code — this has bitten three times
  (r79, r83, r86), each via a single `cd` that left the shell at the root.
- ~30 stale `build/r*` worktrees sit under `.claude/worktrees/`, all merged, safe to prune.
  `git worktree remove` deletes the DIRECTORY, not the branch; the only thing removal can lose is
  uncommitted work — check `git -C <path> status --porcelain`, not `git log main..<branch>`.

### Local Postgres — the wedge is FIXED; do not re-diagnose it (full diagnosis: history → r160)

- Data dir **`/opt/homebrew/var/aihr-pg16`** (a SYMLINK to a RAM disk), binaries
  **`/opt/homebrew/opt/postgresql@16/bin`** (keg-only — PG14 shadows `psql` on PATH, use the explicit
  path or `pnpm db:start`). Port **5433**.
- **Misbehaving? Run `./scripts/dev-db-rebuild.sh`** (<1 min). It puts the data dir on an 8GB RAM disk
  (mounted at `<DATA>-ram` with `<DATA>` a symlink, because `initdb` refuses a mount point as PGDATA),
  sets the WAL sizes **conditionally on the volume type** (see the two bullets below), keeps `fsync=off`,
  and creates the `NOBYPASSRLS` role. Opt out with `AIHR_RAMDISK_GB=0`. **A RAM disk does not survive a
  reboot** — and if it dies mid-run it can leave a worker DB in `invalid` state, which reads as
  `cannot connect to invalid database`; drop those (`datconnlimit = -2`) or just rebuild.
- **NEVER blame the cluster first.** Every earlier version of this section did, and r160 lost hours to
  it. The real bug was `resetDb()`'s TRUNCATE having no `lock_timeout` while TWO pools sat on every
  worker DB; it is fixed in `test/harness.ts` (5s timeout + bounded retry inside ONE transaction).
- **THE DIAGNOSTIC RULE, which has now paid out four times: A RED GATE WITH NO ASSERTION FAILURES IS A
  HARNESS OR ENVIRONMENT PROBLEM.** `grep -c AssertionError` the log BEFORE reading a single failure.
  Three of the four were a background process — a live Workflow, a stale dev server — still holding the
  cluster while the gate ran. **Kill the dev server in the same command that finishes a render check.**
- **The suite generates ~10GB of WAL per full run, more than this machine retires in real time**, so
  **always use `CHUNKS=6 bash scripts/gate-chunked.sh`**, never a bare `pnpm vitest run`: it rebuilds
  the cluster between chunks, covers BOTH vitest projects, and asserts vitest COUNTED as many files as
  it was asked to run (a file whose worker fails to spawn is not counted and reads as green). The real
  cure is in the harness — `CREATE DATABASE … TEMPLATE` instead of a ~100-table TRUNCATE per file — and
  is worth doing deliberately, not at the end of a release.
- **`CHUNKS=6`, NOT the default 3 — measured 2026-08-10.** A 209-file chunk reached 5.1GB of WAL against
  the 8GB volume and was still climbing; at 105 files per chunk the volume sits near 12% and checkpoints
  retire cleanly. 627 files went green in 6 chunks.
- **NO WAL SETTING SUBSTITUTES FOR CHUNKING, so do not go tuning instead.** `pg_wal` settles at roughly
  *write rate x checkpoint duration*. `max_wal_size` decides when a checkpoint STARTS — it does NOT
  throttle writers — and `checkpoint_timeout` has a hard 30s floor (`15 s is outside the valid range …
  (30 .. 86400)`). At the ~130MB/s this suite generates, the arithmetic floor is ~4GB and it ran to 7GB.
  Three settings were tried on the RAM disk (min 3GB/max 1GB, min 1GB/max 2GB, min 192MB/max 512MB) and
  **all three filled it**. Bounding the RUN is the only lever.
- **`min_wal_size`/`max_wal_size` now differ BY VOLUME, and the reasons are opposite.** `dev-db-rebuild.sh`
  picks: ON DISK `min 3GB / max 4GB` (unlinks were the ~8s AV-scanned bottleneck, so a big pool makes
  Postgres RECYCLE by rename instead); IN RAM `min 192MB / max 512MB` (unlinks are free, so the pool buys
  nothing and every byte is charged against a volume that cannot grow). The old config had `min 3GB`
  under `max 1GB` — a floor above the ceiling, which Postgres accepts silently because pacing reads
  `max` and retention reads `min`.
- **THE FIRST COMMAND ON ANY RED GATE IS A CAUSE GREP, not reading test names.** On 2026-08-10 the
  failure list was read three times (2,766 failures / 344 files, zero assertion errors) before anyone
  grepped for the actual cause, which was `could not extend file … No space left on device` (SQLSTATE
  53100) — the volume had filled and killed the cluster mid-run. Run:
  `grep -oE "(PostgresError|AssertionError)[^\"]{0,80}" <log> | sort | uniq -c | sort -rn | head`
- **Apex One** real-time scanning of the data directory was excluded by the owner 2026-08-04; keep it.

### Running and reading test gates

- **One vitest at a time.** A second concurrent run wipes the first's worker databases. Parallel
  agents each get their own `TEST_DB_NAMESPACE`; otherwise do NOT invent one (leaked namespaces once
  reached 366 databases, which slows CRASH RECOVERY catastrophically, not checkpoints).
- **Redirect long commands to a FILE, never a pipe** (`> log 2>&1`). An undrained pipe hangs the
  command at 0% CPU forever, and an exit code read through a pipe is the LAST command's (`rsync … |
  tail -3; echo $?` reports tail's — this once turned a half-transferred deploy green).
- **"Is it stuck?" — read the LOG, never the process list.**
  `grep -E "Test Files|Tests |Duration" <log> | tail -4`. A `Duration` line means DONE regardless of
  the process table (vitest often does not exit after reporting; teardown takes minutes and emits
  nothing).
  **CORRECTED r137: "no Duration + GROWING log = still working" is wrong for a redirected run.**
  Vitest's reporter BUFFERS in non-TTY mode, so the log sits at its `[global-setup]` line and does
  not grow at all for the entire run — 15 minutes of silence is the NORMAL healthy state, not a
  symptom. **The liveness signal is the test-DB connection count**, which tracks real work:

      psql -p 5433 -U postgres -d postgres -At \
        -c "select count(*) from pg_stat_activity where datname like 'ai_hr_test%'"

  Healthy mid-run is ~16–22 with several `active`. Genuine hang = no `Duration` AND zero connections.
  A full suite is **745 files / 10,843 tests** (measured r227, 2026-08-29 — it was 558 / 6612). At
  `CHUNKS=6` that is ~124 files a chunk, ~80–128 s each, **~12 min end to end including the six cluster
  rebuilds**; peak disk stayed ≤66%. At the default `CHUNKS=3` the third chunk hit 99% and the cluster
  died. The old "~950 s" figure was for the smaller suite; re-measure it when the file count jumps again.
- **Never `pgrep -f` a string your own waiter contains** — `until [ "$(pgrep -f 'vitest.mjs run' …`
  matches itself and waits forever.
- **Read vitest's EXIT CODE and file count, never just the summary.** A file whose worker fails to
  spawn is not counted AT ALL — r91 printed `513 passed (513)` on a 514-file tree and exited 1. The
  `browser` project's `*.browser.test.tsx` file being outside `pnpm vitest run` is EXPECTED (one-file
  gap); anything else is not.
- **`TaskStop` does not stop server-side statements a test run started** — kill the client, then
  check `pg_stat_activity` and cancel what it left behind (one orphaned `CREATE DATABASE` once turned
  12 unrelated tests into 30 s timeouts).
- **Test layers:** `pnpm vitest run` = node + jsdom `dom` projects together (the gate).
  `pnpm test:browser` = real Chromium + real Tailwind (`getComputedStyle`), opt-in, deliberately
  OUTSIDE the gate until it has a track record. `globalSetup` is inherited by `extends: true`
  projects — declare it on the project that needs it, never at the root, and count the
  `[global-setup]` lines in the output.

### Migrations

- **The JOURNAL is the migration.** A `.sql` file without a `db/migrations/meta/_journal.json` entry
  silently never runs. `test/migration-journal-ordering.test.ts` catches it — but only if you run the
  suite, not just your new test file. The test-template fingerprint hashes the journal (r112), so
  adding the entry forces a real template rebuild.
- **Allocate numbers centrally — never let an agent pick one.** Parallel agents independently pick
  the same next number; hand them out up front (gaps are fine and deliberate).
- **A stale number is a SILENT SKIP.** drizzle reads the last applied `when` as a watermark and
  ignores journal entries below it. Before merging ANY held branch, compare its journal `when`
  against the deployed watermark and renumber above it (SQL file + journal `idx`/`when`/`tag` + any
  comment citing the number). Reused numbers merge as the same silent skip.
- **A migration that CREATEs a table must also GRANT on it.** Production's
  `ALTER DEFAULT PRIVILEGES` masks the omission; a dev cluster restored from a dump has no such
  default and the first render through `ai_hr_app` throws `permission denied`. No test sees it — the
  suite connects as the owner. Copy `0345`/`0354`/`0357`.

### Rendering and verification

- **A 200 is NOT a render check.** `MISSING_MESSAGE` shows ONLY in the dev-server log on a real
  render — tsc, the suite, `next build` and the route's 200 all stay green. Three shipped this way in
  five rounds (r123 server/client boundary, r127 twelve labels, r134 the Cycle field on every payroll
  run page). The recipe costs five minutes:

      pnpm db:seed && PORT=3111 pnpm dev
      curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3111/admin/leave/entitlements
      # …then READ the dev-server log for MISSING_MESSAGE

- **Server components passing closures to client components also pass every gate** (r123 broke
  production this way; the reporter found it). `test/server-client-boundary.test.ts` pins the class.
- **Browser verification runs against a LOCAL dev server with the `dev_user` identity switcher —
  never production** (WorkOS OAuth). `cloudflared` runs ON THE SERVER — a local `pgrep` means
  nothing; curl the tunnel URL WITHOUT `-f` (401 is the healthy password gate). The tunnel hostname
  changes if that process restarts.
- **Fetching page HTML to grep for a label is a false positive** — Next.js embeds the whole i18n
  catalog in the payload. Check the component source or a real render.

### The server

- ssh `-p 8288 ubuntu@203.142.6.241`; you may `sudo systemctl restart aihr` yourself.
- Default `node` is v18 and predates `--env-file` — prefix `PATH=/opt/node20/bin:$PATH` or chase a
  phantom "bad option" bug.
- **CORRECTED r137: the deploy rsync DOES carry `--delete`.** `scripts/improve/release.ts:71` has it,
  and r137's two deleted files were verified gone from the box afterwards. The older warning here
  ("no `--delete`", from r128) is **wrong for the release path** — but `--delete` only protects you if
  you actually pass it, so keep it in any hand-rolled rsync, and note excluded paths
  (`node_modules`, `.next`, `.env*`) are protected from deletion, which is why `.env.production`
  survives. Still worth listing what a release removes:
  `git diff --diff-filter=D --name-only <last-released-ref>..HEAD`.
- **Proof a deploy arrived** is `rsync -azi --delete --dry-run` reporting ZERO changes afterwards —
  `deploy.sh` succeeding is not it (a broken pipe once left 93 stale files behind a green deploy).
  Plain `--dry-run` prints nothing without `-i`. Use `--partial --timeout=120` and
  `ssh -o ServerAliveInterval=15`.
- **`next build` on the box runs BEFORE `db:migrate`** — an OOM aborts with production untouched and
  the old `.next` still serving; verify (`systemctl is-active aihr`, `GET /` 401, migration count)
  rather than assume. `NODE_OPTIONS` heap is 4096 MB against 3.9 GB RAM + 3.9 GB swap; past that it
  is a bigger-box problem. **Never `typescript.ignoreBuildErrors`** — the build's type pass catches
  RSC boundary errors `tsc` alone does not.

## Traps — the durable ones (each cost at least a round; several recurred AFTER being written down)

### ⚠️ THE MOVED-ASIDE CLUSTERS ATE THE DISK — and the gate reported it as a CODE failure (r246)

`dev-db-rebuild.sh` moved each old cluster to `aihr-pg16.wedged-<stamp>` and **nothing ever removed it**:
`--purge` existed but was opt-in and `gate-chunked.sh` has never passed it, while it calls the script
ONCE PER CHUNK. Every six-chunk gate left six clusters behind. Measured 2026-09-03: **68 of them, the
data volume at 188MB free of 926GB**, one sampled cluster holding 2.5M files.

**FIXED in `902d2170`** — keeps the newest, drains one older per run in the background behind a lock.
Do not re-diagnose it; do check `ls -d /opt/homebrew/var/aihr-pg16.wedged-* | wc -l` if the disk is tight.

**THE FOUR SIGNATURES, ALL OF WHICH READ AS A BROKEN BUILD:**
- `cluster rebuild FAILED` then `initdb: No space left on device` — the honest one.
- **A chunk exiting 1 with COMPLETELY EMPTY output** — no failure count, no assertion, no duration.
- **N failed files and EXACTLY N `Hook timed out in 30000ms`** — the hook is `test/harness.ts`'s TRUNCATE
  reset. 15 files, 15 hook timeouts, one file taking 21 MINUTES.
- `Failed query: TRUNCATE …` / `canceling statement due to lock timeout` — the harness's `lock_timeout = '5s'`
  losing to a previous test's still-open transaction.

**THE TELL IS ALWAYS `AssertionError` COUNT ZERO.** Three consecutive reds in r246 (13, then 1, then 15
failures) had zero between them. `grep -c AssertionError <chunk log>` BEFORE believing any red.

**DELETION IS THE BOTTLENECK AND YOU CANNOT PARALLELISE OUT OF IT.** An endpoint-security extension
(`com.trendmicro.icore.es`) intercepts every unlink on this machine: measured **509 files/sec at 8
parallel `rm`, 612 at 16** — 20% for double the processes. The 68-cluster backlog is ~60 hours of AWAKE
time (it freed 2GB in 16 hours overnight — the Mac was asleep, not hung). The only real lever is an
exclusion for `/opt/homebrew/var`, which is the OWNER's call, not an agent's.

**KILLING `rm` MID-DELETE THEN STARTING A GATE IS ITS OWN TRAP.** APFS flushes the pending unlinks
afterwards — free space jumped 26→48GB on the kill — and a gate started into that flush produced the
13-failure red. Let the filesystem settle, and confirm with a cheap benchmark (2000 small files created
in <1s, deleted in 3s) rather than by guessing.

**TO SUPPRESS THE DRAIN FOR ONE GATE**, hold its own lock rather than editing the script:
`mkdir -p /opt/homebrew/var/aihr-pg16.purge.lock && nohup sleep 86400 & echo $! > …/pid`. Remove it after.

### ⚠️ THREE CHUNKS IS NO LONGER A FULL GATE — THE SUITE OUTGREW IT (r247)

`gate-chunked.sh` defaults to **3** chunks. At **763 test files** that is too coarse: chunks 1 and 3 both
reported **`peak-disk=100%`** on the 8 GiB RAM disk, Postgres died mid-chunk, and everything after it
failed with `database system is in recovery mode` / `ECONNREFUSED 5433` — **58 files red for no reason
connected to the code.** Chunk 2 peaked at 85% and was the only chunk whose failure was real.

**`CHUNKS=5 ./scripts/gate-chunked.sh` IS THE FLOOR, AND r248 MEASURED IT RATHER THAN GUESSING.** Five
chunks peaked at **58-79%** and produced **ZERO** environmental failures the day after three chunks produced
58. Read the `peak-disk` figure the script prints per chunk: **100% means that chunk's result is not
evidence**, whatever the failure list says. The machine has 18 GB of RAM, so the RAM disk cannot simply be
made bigger — more chunks is the lever.

**The AssertionError count remains the discriminator.** 59 failed files, 58 with ZERO AssertionErrors, all
59 green on a rebuilt cluster (519 tests, exit 0). Grep `AssertionError` before believing any red gate.

### ⚠️ `node_modules` VANISHED FROM mainwt MID-SESSION, AND `npx` HID IT (r247)

Between the full gate and the re-run, `node_modules/` disappeared from mainwt. Nothing in
`dev-db-rebuild.sh` touches the repo and no deletion was running when it was noticed — **cause unknown, so
expect it again.** What matters is how it PRESENTED:

- **`npx vitest run …` did not say "no dependencies".** npx fetched its own vitest and died inside
  `vitest.config.ts` with `Cannot find module 'vitest/config'` — a config error, not a missing-install one.
- **`pnpm vitest run …`** then failed with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "vitest" not found`.
- **`npx tsc --noEmit` returned exit 0 with node_modules absent.** A green typecheck proved nothing.

**`ls node_modules/.bin/vitest` before trusting any gate result on a tree you have not just installed in.**
`pnpm install --frozen-lockfile` restored it in 3.5s from the store, and tsc + the 59 files were green
afterwards. Related: a fresh worktree never has node_modules.

### ⚠️ 10 VITEST WORKERS IS TOO MANY WHEN THE MACHINE IS UNDER MEMORY PRESSURE (r246)

The default is `availableParallelism() - 2`. With **154MB unused RAM and 3GB of 4GB swap consumed**, that
produces hook timeouts, not test failures. **`VITEST_MAX_WORKERS=4` is the supported override** — and
`test/global-setup.ts` reads the SAME variable to decide how many worker DBs to stamp, so the two stay in
step automatically. A RAM disk is NOT the escape here: it is wired memory and reproduces r241's swap
death. Check `top -l 1 -s 0 | grep PhysMem` before blaming code.


- ⚠️ **NEVER `source .env.local` IN THE SAME SHELL AS `pnpm gate:shadow` — IT REPORTS AS A MIGRATION
  DEFECT (r236).** `scripts/shadow-migrate.sh:92-93` REWRITES `MIGRATION_DATABASE_URL` inside `.env.local`
  to point at the scratch `ai_hr_shadow` DB before running `drizzle-kit migrate`. An **exported** variable
  of the same name (from `set -a; . ./.env.local`) wins over the dotenv file, so drizzle migrates
  `ai_hr_dev` instead — which is usually already up to date, applies nothing, and leaves the shadow DB at
  its restored watermark. The script then correctly observes that nothing was applied and prints
  **`MIGRATION SILENTLY SKIPPED … almost certainly a when value that is not strictly greater than the live
  watermark`** — pointing at a journal that is completely fine. The tell: a shadow run that PASSED earlier
  in the session starts failing after you sourced the env for an unrelated `psql`. Run it as
  `env -u MIGRATION_DATABASE_URL -u DATABASE_URL pnpm gate:shadow`, or in a shell that never sourced it.

- ⚠️ **A TEST THAT HARDCODES "THE FUTURE" IS A TIME BOMB, AND IT DETONATES AS A FALSE FAILURE IN AN
  UNRELATED ROUND (r236, 2026-09-01).** `test/employment-movement.test.ts` asserted that a future-dated
  increment writes nothing yet, with `effectiveDate: '2026-09-01'` written down. On 2026-09-01 the date
  arrived, `createMovementEvent` correctly applied the change immediately, and the assertion failed
  against a code path behaving exactly as designed — inside a gate for a change that touched nothing
  near it. **The tell is a failure in a file the round did not touch, on a date boundary.** Fix: derive
  the date from the clock (`new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)`) and pass
  the SAME value as the sweep's `today`.
  **The class is wider than the one that fired.** It bites only where PRODUCTION CODE compares against the
  wall clock — the movement family (`createMovementEvent` / `sweepDueMovements`, 21 test files) is the
  main exposure. Tests comparing a hardcoded `effectiveFrom` against a hardcoded payroll `PERIOD`
  (e.g. `test/payroll-basic-source.test.ts`) are date-STABLE and are not this. 153 hardcoded
  `effectiveDate:` literals remain across the suite; they were NOT swept, and the gate is the oracle for
  the next one to expire.

- **MERGED IS NOT DEPLOYED, AND THIS FILE HAS ASSERTED OTHERWISE (r159).** r158 was merged to `main`,
  including migration `0403`, and never shipped; CURRENT STATE said "no pending deploy, nothing in
  flight" and the board still showed all three items `approved`. Every signal agreed and every signal
  was wrong. The failure mode is structural, not careless: the unshipped-round check reads `build/*`
  branches, and merged work has none; the board reads status, and nobody had called `build-start`.
  **A dry-run rsync against the box is the only cheap ground truth for "what is actually running".**
  Corollary — after a merge, the deploy is not optional bookkeeping you can leave for the next round:
  the next agent will read `main` as shipped.

- **THE IMPORT RATCHET DOES NOT STRIP COMMENTS, so a comment that quotes an import is read as a real
  edge (r159).** `lib/completed-years.ts` imports NOTHING, and the leave pack-drift guard failed it
  anyway: its header explained which specifier `core/leave.ts` re-exports, spelled as a literal
  `from '…'`, and `test/helpers/import-ratchet.ts` matched it. **Before believing a drift violation,
  open the flagged file and look for a quoted specifier inside a comment.** The fix is to reword the
  comment — never to add an allowlist entry (that list is audited debt and only shrinks) and never to
  "fix" the scan: a regex comment-stripper mangles `//` inside string literals and would start MISSING
  imports. Comment blindness can only ADD edges, which fails loud; the alternative fails silent. That
  trade is now written into the helper's header.

- **A GUARD THAT READS ONE FILE'S SOURCE BREAKS WHEN A FIELD IS EXTRACTED INTO A COMPONENT — and the
  tempting fix deletes the protection (r159).** `35b7af0a` group 4 moved EPF Number/Citizenship into a
  shared component; three static-source guards stopped finding `name="epfNumber"` on the page. Two of
  them are wipe guards on a FULL-ROW overwrite form, where a field missing from the POST silently
  clears the column — exactly what must not be dropped. Following the string alone is also wrong: the
  component contains the name whether or not the page still renders it, and `mode="controlled"` emits
  `value`/`onChange` with **no `name` at all**. So a guard that follows an extraction needs three
  things, not one: the field exists in the component, the page renders that component, and it renders
  it in the mode that actually posts. Note also that a form-mode prop object (`name: 'epfNumber'`)
  mounts an input exactly as a JSX attribute (`name="epfNumber"`) does — accept both spellings or
  every future extraction fails for a cosmetic reason.

- **A NAIVE JSON DEEP-MERGE RESURRECTS DELETED KEYS — and the six message catalogs are where it bites.**
  When two parallel branches both edit `messages/*.json`, git conflicts on the whole file and the
  obvious fix is a recursive merge of the two objects. That is WRONG whenever either branch DELETED a
  key: a branch cut before the deletion still carries it, so "present in theirs, absent in ours" looks
  like an addition and the retired key comes back. Measured this session — r138 retired four wizard
  label groups, r141 predated that, and the merge silently restored all four in all six catalogs.
  **PRESENCE IS A VALUE. Consult the merge BASE for absence too:**
  - in base · gone from one side · unchanged in the other ⇒ **DELETE**
  - not in base · present on one side ⇒ ADD
  - deleted one side · modified the other ⇒ deletion wins, and REPORT it
  Get the base explicitly (`git merge-base HEAD^1 HEAD^2`) — the `:1` stage is gone once you commit.
  Assert afterwards that BOTH sides' additions and each side's deletions survived; the guard that
  caught this (`test/wizard-personnel-shared-fields.test.ts`) only exists because r140 wrote it.

- **AN EXACT-SET NAV GUARD MUST BE UPDATED, NOT LOOSENED, WHEN A ROW IS LEGITIMATELY ADDED.**
  `ADMIN_GROUP_FLAT_HREFS` (sidebar), `EXPECTED_SET` (payroll flyout) and the pack-drift allowlist all
  fail when a new row appears — that is their job: they catch a sibling accidentally CLIPPED by an
  edit. Declare the new row in the list. Only ONE agent per round may own each of these, or two
  branches both edit the same literal.

- **`redirect()` SIGNALS BY THROWING, so a success toast next to one gets swallowed.** A toast inside
  the same `try` is caught by the service-error handler and every SUCCESSFUL action redirects to
  `?error=NEXT_REDIRECT` — live for a whole release in the leave adjustment writer. Put the toast
  AFTER the redirect, never beside it.
- **A `labelKey` IS NOT THE LABEL.** Resolve the key against `messages/en.json` before describing
  what a screen says — a plan written off key names proposed three renames that were all already
  live. A key's NAME is not evidence of who reads it either: grep consumers before deleting keys by
  prefix (r137 deleted three shared `festive*` labels a surviving component used).
- **A date derived from an instant must go through the tenant timezone.** `toISOString().slice(0,10)`
  is YESTERDAY between 00:00 and 08:00 MYT. Use `todayInKualaLumpur()` for "what date is this
  instant"; date-only ARITHMETIC stays UTC. **This applies to FIXTURES too** — r92 fixed 45 app sites
  and skipped `test/`, and six test files then failed only at night (the product was right, the test
  was wrong). `test/today-in-myt-drift.test.ts` scans both. Every daytime green proves nothing about
  a timezone fix — re-verify inside 00:00–08:00 MYT. **Debugging an off-by-one date: check the clock
  before the code.**
- **THIS DOCUMENT'S SHIPPED LISTS ARE NOT EVIDENCE — in either direction.** An item recorded here as
  shipped had never merged (r76); slice 2 had no round entry and looked skipped but was live at 50
  call sites. Verify with `git log -S <symbol> main` before trusting any claim here.
- **i18n guard holes** (`test/i18n-coverage.test.ts` check C): it skips files using more than one
  namespace, and only matches LITERAL keys — `t(helperReturningKey(x))` is invisible.
  **THE SAME BLINDNESS MAKES "UNUSED KEY" A FALSE POSITIVE, and r159 nearly deleted three on it.**
  `fields.rateAmount`, `fields.dateOfBirth` and `fields.bankAccount` survive no literal grep, because
  the wizard's Review step renders `t(`fields.${f}`)` from whatever `missingByStep` returns
  (`app/admin/personnel/new/wizard.tsx:849`). Deleting them is a MISSING_MESSAGE on screens HR really
  reaches: a daily-paid hire with no rate, a malformed date, half a bank instruction. All three are
  pinned non-empty in all six catalogs by `test/wizard-personnel-shared-fields.test.ts`, and both
  component headers say so. **Before deleting any key, grep for the COMPUTED form (`` t(`prefix. ``)
  as well as the literal — absence from a literal grep is not evidence.** Prefer one
  namespace per file; for computed keys, test every value the helper can return.

- **A KEY THAT EXISTS BUT CANNOT FORMAT IS INVISIBLE TO CHECK C — third hole, found r140.** Check C
  asks whether the key resolves, and *existing* and *formatting* are different things. A message
  containing `{row}`/`{expected}` is ICU interpolation, so a plain `t('…')` with no arguments THROWS
  `FORMATTING_ERROR` at render and paints the literal key path on screen. **The route still returned
  200, tsc passed, and check C passed.** Only the dev-server log on a real render showed it. Use
  `t.raw()` when the braces are meant literally (e.g. a template a client island substitutes into),
  and remember that placeholder-looking text is a formatting contract, not decoration.
- **A REFUSAL TEST CAN BE PINNING SOMETHING OTHER THAN YOUR FIX — so REVERT THE FIX AND RE-RUN before
  you believe it (r172).** `3e3d3fb2`'s plan called the TP1 `?employmentId=` handling a security gap;
  three attempted exposures were all refused by RLS, including the manager branch the plan predicted
  would leak. The mutation check is what caught it: **with the guard reverted, the whole test file still
  passed**, because it was pinning RLS rather than the new guard. A green refusal test proves the
  behaviour is refused — NOT that your code is what refuses it.
- **THE PACK IMPORT RATCHET'S ALLOWLIST IS NOT A REGISTRATION POINT — READ ITS FAILURE TEXT (r175).**
  A new `core/` file imported `core/attendance` and `core/payroll` directly and turned BOTH drift
  ratchets red. The tempting fix is `test/pack-drift-allowlist.json`; the guards refuse it in their own
  message — "The allowlist only ever shrinks; do not add entries." That list is audited kernel-contract
  DEBT, not a place to file new work, and adding to it silently widens the ADR-0080 boundary the guard
  exists to hold. **Import from `packs/<pack>/service` instead.** Two things make that safe and both are
  worth checking rather than assuming: the facades re-export with `export *`, so every symbol resolves
  unchanged; and several `core/` files already import a facade (`absence-days`, `admin`, `entitlements`,
  `movement-apply`, `operator`), so it introduces no cycle. Check for the documented comment false
  positive first — the ratchet does not strip comments.

- **A MERGE CONFLICT WHERE NEITHER "OURS" NOR "THEIRS" IS CORRECT (r175).** `core/attendance.ts`
  collided between the shift item (which had just made `scheduleFor` DATE-AWARE via a new `defShiftOn(d)`
  helper) and the absence item (which had moved the same declaration earlier, still using the old
  `defShift` variable — which no longer existed). Taking ours dropped the absence item's roster-wins
  gate; taking theirs silently reverted date-aware shift resolution that was ALREADY DEPLOYED, and would
  not even have compiled. The resolution was semantic: one declaration on the date-aware helper, with the
  other branch's new gate rewired onto it. **When two branches touch one function in the same release,
  read what each was FOR before resolving — a clean-looking pick can revert live behaviour.**

- **A PLAN THAT PROMISED WHAT THE DATABASE REFUSES GETS RAISED, NOT PATCHED, AND NOT PUSHED AS A PLAN
  REVISION (r175).** `23390097` promised supervisors could roster future dates; RLS refuses it. Note the
  mechanism trap: `improve:push-plan` sets `status = 'planned'`, so pushing a revision onto a DEPLOYED
  item un-deploys it on the board and loses the record that the work shipped. Use `improve:raise`
  instead — the CLI documents it for exactly this ("a decision the pipeline surfaced that the reporter
  must own"), it lands as `open`, and `raiseFeedback` stamps `reporter_label = 'CLAUDE AI'`.

- **A GREEN SUITE, A 200, AND ONE OF TWO PDF RENDERERS ALL CALLED A PAGE CORRECT WHILE IT WAS WRONG
  (r175a).** The CP22 renderer silently DROPPED any line past the third in a multi-row block: a
  four-line Malaysian address filed to LHDN without its state, and box (b) short an allowance,
  understating declared remuneration. No warning, no ellipsis — the box looks full. 81 tests were green
  because every fixture used three address lines, while **the form is ruled for four**. Two lessons:
  **(1) test the row count the artefact actually prints, not the one that happens to fit**; and
  **(2) WHEN TWO RENDERERS DISAGREE, THAT DISAGREEMENT IS THE INSTRUMENT.** Poppler regenerates a field's
  appearance when `NeedAppearances` is set and drew the line whole; MuPDF and macOS Preview draw the
  embedded stream and showed the damage. Rasterise in BOTH (`mutool` and `pdftoppm` are available) — a
  fix that satisfies one is not a fix. The clip is the rect inset by 1pt, so a block sized "top of row 1
  to bottom of row R" also slices the Rth row's descenders; extend the rect DOWNWARD, which moves no
  text because `baseline_n = rectTop − 1 − n × pitch`.

- **STOPPING AN AGENT CAN LOSE UNCOMMITTED WORK THAT IS BETTER THAN ITS LAST COMMIT (r175a).** A fix
  agent was stopped to free the cluster for the gate; it had already committed a working fix, and had
  THREE further modified files uncommitted — the 900dpi measurement showing the last row's descenders
  were still being clipped. Merging the branch as-committed would have shipped the weaker fix silently,
  because the committed state passed its own tests. **Before merging a branch whose agent you stopped,
  run `git status` in its worktree and read the diff.** If it is coherent (tsc + its own tests), commit
  it — do not discard it as scratch.

- **`rejects.toThrow()` passes on the WRONG throw** — a fixture failing NOT NULL before reaching the
  constraint under test reads as a pass. Assert the constraint NAME or match the real Postgres error
  via `.cause` (Drizzle wraps as "Failed query: …").
- **Editing code by index arithmetic needs assertions IN the edit script** — r137's span-cutting went
  wrong three times (comment-embedded braces, `//`-commented declarations) and only in-script asserts
  caught it before writing. Removing a `Promise.all` element without its destructuring slot silently
  shifts every later variable.

## Entitlement facts — read before touching leave (corrected r224, 2026-08-26)

**r85 MOVED THE RULES. Anything (including old history entries) saying `leave_policy` owns earning
method or carry-forward is WRONG.**

- **Rules live on `leave_type`** (columns `0325`, engines repointed `0334`). `applyLeaveTypeRules`
  (`core/leave-compute.ts:489`) overlays them onto the resolved policy — a **whole-set** overlay
  gated on `hasAnyLeaveTypeRule`. 10 leave types carry type-level rules.
- ⚠️ **`leave_policy`, `benefit_scheme` AND `scheme_leave_entitlement` ARE GONE.** `db/schema.ts:1673-1675`
  says it plainly — release three removed the benefit-scheme entitlement layer, including
  `employment.benefit_scheme_id` — and production's `information_schema` (2026-08-27) lists only
  `entitlement_template`, `entitlement_eligibility_rule` and `entitlement_reset_archive`. The bullets
  that stood here quoted "67 policy rows, 57 earned_monthly", a `schemeDays ?? policyDays` precedence,
  and a benefit-scheme "coverage gap that bites at reset time". **All three described tables that no
  longer exist**, in the FIRST thing an agent doing entitlement work reads. There is no policy-row
  fallback to zero out and no scheme coverage gap to plan a reset around.
- **DAYS COME FROM ONE PLACE:** the winning `entitlement_template` band, composed by `composeEntitlement`
  (`core/leave-compute.ts`). Nothing resolves ⇒ `noOpinion` ⇒ the caller posts **nothing at all** (delta
  exactly 0), which is what stops an empty configuration clawing back days people already hold.
- ⚠️ **THE STATUTORY FLOOR IS ADVISORY (`fa3f4ccb`), NOT A FALLBACK.** `core/leave-compute.ts:928-947`:
  the composition used to be `max(statutoryFloor, configured)`, **"the reporter asked twice for that
  override to go and approved the change in writing"**, and **"the floor no longer participates in the
  arithmetic anywhere."** `belowStatutoryFloor` survives only as a warning flag. So a leave type whose
  tables reach nobody grants **0.00** — `openLeaveYear` records `no_entitlement` and writes no accrual row.
- ⚠️ **THE TRAP THAT PRODUCED THE WRONG ANSWER TWICE IN ONE DAY, because it generalises past leave:**
  production's ledger shows Annual Leave accruing 307.26 days across 85 rows to 27 employees (~11.4
  each), which looks exactly like a floor fallback and was twice read as one — once into a board plan
  and once into this file. **Those rows were granted under the PRE-`fa3f4ccb` composition.** A ledger
  records what WAS granted, never what today's code would grant. Do not infer live behaviour from
  historical rows without first checking whether the composition moved.
- **The coverage gap, tables in force vs eligibility rules in force (production 2026-08-26):** Annual
  16/0 · Graduation 3/0 · Marriage 3/0 · Caregiver 3/0 · Paternity 3/0 · Study 3/0 · Maternity 3/0 ·
  Compassionate 3/0 · Hospitalization 1/0 · Medical 6/1 · Examination 3/1. ⚠️ **Hospitalization's 1/0 is
  NOT a gap** — one table in force with no rule applies to everybody (r193 fault 3, mirrored in
  `soleTableApplies` / `viaSoleTemplate`, `core/entitlement-template.ts:1571`), so its reported zero
  automatic accrual has a DIFFERENT cause. **EIGHT types resolve to nothing, not nine.** r224 surfaces
  this on the leave-configuration landing screen and at create time; it deliberately creates no rules
  (who receives which table is a policy decision, and guessing a criteria object silently widens or
  narrows who a table reaches). **Board item `41330484` and its approved plan both say NINE and both tell
  the reporter to "look at Hospitalization first" — the one type the product calls healthy. Both
  corrections still owe the reporter a reply.**

## Carried debt — none of it blocking, all of it real

1. **Browser verification of shipped UI remains the top gap.** Nearly everything since r70 is
   source-reasoned only. The r93 runners (jsdom in the gate, Chromium opt-in) cover `'use client'`
   islands — they do NOT retire manual verification, because async SERVER components cannot be
   rendered by testing-library and most pages here are server components. The one time a screen was
   browser-measured (`4dbe04c6`) it overturned the source-reading diagnosis.
2. **A rendered-markup test can still be blind** when a client component receives server-passed
   nodes — the fixture must be the POST-TRANSPORT shape (`test/organization-list-rsc-lazy.test.ts` is
   the worked example; the Companies screen rendered 1 of 8 rows for 24 days behind a green suite).
3. **Pagination pages in memory on ten tables** — `paginateRows()` fetches everything then slices.
   Contract holds; the promised speed does not. Pushing limit/offset into ~10 read functions is the
   follow-up.
4. **ADR-0077 slices** (plan at `~/.claude/plans/resilient-greeting-ripple.md`, 43 KB, written 26 Jul —
   re-verify against the tree before building any of it):
   | slice | state |
   |---|---|
   | 0–4 | **DONE** (invitation privesc fix · schema · `isModuleEnabled` (`a38ed02f`, 50 sites) · gate classification · nav/page gating) |
   | 5 | **DONE r97–r100** except the admin setup notification (no natural key on `notification`) |
   | 6 | **DONE r176 (2026-08-10), except the deploy-failing flip.** The jurisdiction sweep and the mixed-currency refusal both shipped: `core/report-registry.ts` narrows the currency-mix check to rows that actually CONTRIBUTE a money value (a row with no figure can no longer trigger a refusal), and `core/reporting.ts` gained `eaEmployerCountry()` so `employeeEaStatements` resolves each form's pack from its OWN employer's country via a `Map<companyId, country>` rather than the tenant default — in a multi-country group, foreign-entity forms were being built against the wrong pack. Pinned by `test/report-summary-mixed-currency.test.ts` and `test/ea-per-employer-pack.test.ts`. **Still open: the deploy-failing flip** (unclassifiable company: warning → failed deploy) — needs explicit confirmation, see the blocker list |
   | 7 | **WRITTEN, NEVER PROVISIONED.** `core/platform-usage.ts` (148 lines), `test/platform-plane.test.ts` (203), migration `0351` and the `ai_hr_platform` role definition in `deploy/bootstrap-db.sql` all exist. **But `PLATFORM_DATABASE_URL` is ABSENT from production's `.env.production` (re-verified 2026-08-09)**, so `platformPlaneConfigured()` is false and `pnpm platform:usage` exits 2 on the box. Create the role from `bootstrap-db.sql` and set the URL — cheapest remaining slice |
   | 8 | **DONE (r121 `901352c5`) — this row used to say "decide whether that gate should be removable at all", and that decision HAS been taken: not once history exists.** `chainArmingDecision` is wired into `db/client.ts:13` and REFUSES to disarm a tenant with chained history; `test/audit-hash-chain.test.ts:134` used to assert the hole and now asserts the refusal. Preflight `scripts/check-audit-chain-gate.ts`; `app/admin/privacy/page.tsx:53` records why there is no banner. **The hazard it closed, worth keeping:** events appended while the gate is off carry `chain_seq IS NULL`, so they are ABSENT from the chain rather than breaking it — re-arming links onto the last chained event, every `prev_hash` matches, and `verifyTenantChain()` returns valid over a log with an unprotected hole |
   | 9 | **CLOSURE AND REACTIVATION ARE BOTH BUILT — the old "Remaining: CLOSURE · REACTIVATION" here was stale.** `core/tenant-lifecycle.ts` carries `closureDecision` (dual control + its own retention check), `suspendedDaysWithin`, `shiftExpiryForSuspension` and `replayPlan`, all pinned by `test/tenant-lifecycle.test.ts`; schema in `0350`. `scripts/reactivate-tenant.ts` (145 lines) closes the window, records the event and PRINTS the replay plan — report-only until `--apply`, deliberately not firing sweeps at a customer's live payroll. **THAT GAP IS CLOSED — r176 (2026-08-10).** `scripts/close-tenant.ts` is `closureDecision`'s first caller. It carries a `--today` guard: without one, an arbitrary date silently defeats the retention hold the decision exists to enforce, so the script refuses a `--today` that is not the real MYT day unless explicitly overridden. Pinned by `test/tenant-closure-runner.test.ts`. Report-only until `--apply`, matching `reactivate-tenant.ts` |
   | 10 | **SCHEDULED 2026-08-09 — the bleed is STOPPED.** `capture-usage` runs daily at 01:00 (crontab, ahead of the leave sweeps); first scheduled-era run wrote 9 rows / 0 failures across 9 companies in 1 tenant. Env contract is **`MIGRATION_DATABASE_URL`, NOT the platform pool** — slice 7 is not a prerequisite, which is why this could ship ahead of it. **2026-08-03 → 2026-08-08 are permanently unbillable** — before this, `usage_snapshot` held 8 rows all dated 2026-08-02. The read model (`platformUsageSummary`, `pnpm platform:usage`) is done; the DASHBOARD is still unbuilt, deliberately — `/platform` needs its own auth boundary (`platform_user` ≠ `app_user`, ADR-0077 D5) and cannot reuse the tenant session |
   Slice 9's enforcement is inert in production today; `apply-dunning` is report-only and unscheduled.
   **An older line here said "both tenants `active`" — 2026-08-09's `capture-usage` run reported
   `1 tenant(s) in scope, 0 skipped` via the shared `loadSweepScope`, i.e. ONE tenant, not two out of
   two. Count before relying on either number.**
5. **Test-DB teardown is FIXED — kept so nobody "fixes" it again.** `test/global-setup.ts:298`,
   best-effort and never fatal. A run drops its own template and workers on exit.
6. **Dead/misplaced payroll config** (r78): `payment_basis` is written and read by nothing; probation
   months / review reminder days / default currency live on the payroll screen but belong elsewhere.
   No open item carries these any more — raise afresh if they matter.
7. **`tenant_module` has exactly ONE writer** — `scripts/module-change-runner.ts` draining
   `module_change_request` under the OWNER role. Never hand SQL. Reactivation NEVER re-seeds
   (ON CONFLICT DO NOTHING), so a customer's edited settings survive a disable/enable cycle (D4,
   pinned by test).

---

