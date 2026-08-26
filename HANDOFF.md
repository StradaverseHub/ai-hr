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

## CURRENT STATE — snapshot 2026-08-26 (r221-r223 SHIPPED · THE BOARD IS EMPTY · ADR-0082 IS THE ACTIVE WORKSTREAM)

**`main@b85d2528` IS WHAT RUNS ON PRODUCTION (r223, 2026-08-26)** — verified by an
`rsync -azi --delete --dry-run` from **mainwt**, not by `deploy.sh` succeeding, which is not proof.
Service active, `GET localhost:3000/` → 401 ON THE BOX.

### r223 (2026-08-26) — ADR-0082 slice 2: the assistant substrate + the access-scoped tool registry. `0451`.

Four tables, the billable `assistant` module, the per-user grant service, and **nine tools** each
wrapping an existing `core/read.ts` function inside the CALLER'S OWN `SessionContext`, so RLS scopes
them. `search_handbook` is deliberately held for its own slice — it is the one tool that is not a
wrapper (no full-text search exists here) and **Postgres FTS stems per language**, which collides with
the six-locale answer decision. Nine tools, not ten, is the shipped state.

⚠️⚠️ **THE BUILD AGENT DIED MID-RESPONSE AND THE VERIFICATION WAS BETTER FOR IT.** The tool-registry
agent wrote its files and then died before reporting, so the three verifiers ran against a NULL build
report — with no builder claims to anchor on they read the code directly, and the completeness critic
returned "slice 2 is NOT done". It was right. **A build report is a claim, not evidence; its absence
cost nothing.**

⚠️ **THE DEFECT THAT GENERALISES PAST THIS ROUND: A READ BEING RLS-SAFE DOES NOT MAKE IT ANSWER-SAFE.**
ADR-0082 §4 mapped `upcoming_holidays` to `upcomingHolidays` (`core/read.ts:1886`), which filters on the
DATE ALONE — no company, no state, no holiday group — because its only caller is a dashboard card
already inside a company-scoped page. Pointed at "when is my next public holiday" it names days the
asker does not observe. Fixed with `holidayDatesForEmployment` over the ADR-0054 resolver. **Ask both
questions separately for every tool that is ever added.**

⚠️ **AND THE ONE THAT ALMOST SHIPPED UNGUARDED: `leave_entitlement_explain` BOUND TO `emps[0]`.**
`leave_type` is TENANT-scoped, so a leaveTypeId from `my_leave_balances` cannot say which employment it
came from — a shared-services employee asking about Company B was answered with Company A's figures,
silently. Now one block per employment with every figure INSIDE its block: a single top-level
`cycleStart` beside a list reads as "the" answer and gets quoted for the wrong company. **The
non-vacuity check is what caught that the fix was unguarded** — the existing test had ONE employment,
where `emps` and `emps.slice(0,1)` are the same list, so reverting the fix broke nothing. A
concurrent-employment fixture now guards it.

⚠️ **TWO MODEL-INPUT DEFECTS OF ONE FAMILY: EVERY IDENTIFIER AND DATE A TOOL RECEIVES IS
MODEL-SUPPLIED.** `Date.parse('2026-02-30')` does NOT fail — it ROLLS OVER to 2026-03-02 and returns a
finite timestamp — so 30 February reached Postgres and came back as `22008` thrown OUT of the tool
instead of the refusal it declares; and three tools passed a model-supplied id into a uuid comparison
behind only a non-empty check, so a hallucinated `"E12345"` raised `22P02`. Both now refuse. This is the
ordinary case for a tool registry, not the edge one.

⚠️ **THE MISSING SECURITY TEST NOW EXISTS, AND 0451 ALREADY CITED IT.** The migration named
`test/assistant-grant-rls.test.ts` in the PRESENT TENSE as the guard for its REVOKEs; the file did not
exist. It pins the critic's highest-value gap: **`assistant_grant_read` ORs in `app.is_admin()`, so RLS
hands an admin EVERY grant row in the tenant** — only the explicit `app_user_id` comparison in
`mayUseAssistant` stops an admin resolving `allowed: true` off SOMEBODY ELSE'S grant. A companion case
asserts RLS really does return that row, so the first cannot pass vacuously. Verified on production:
DELETE revoked on grant/budget/usage, KEPT on `assistant_exchange` (a user erasing their own history is
the PDPA right), RLS on all four.

**THE SLICE STILL HAS NO LOOP, NO BUDGET ENFORCEMENT AND NO SCREEN** — `converse()` (r221) and the
registry (r223) exist and still have no caller between them. Next: `core/assistant.ts`.

### r222 (2026-08-26) — the shell is branded "Kingdee AI HR". NO MIGRATION. Owner request, not a board item.

`components/kingdee-mark.tsx` (new) draws the Kingdee four-dot symbol as inline SVG; the sidebar's old
`bg-primary` "HR" tile now carries it, and the wordmark reads `common.appName` — **"Kingdee AI HR" in all
six locales**, plus the document title.

⚠️ **THE MARK IS DRAWN, NOT IMPORTED, AND THAT WAS NOT A PREFERENCE.** The supplied asset is a 1200x675
JPEG on a flat `#f7f7f7` ground — no transparency — which in a 40px rounded badge renders as a grey tile
in light mode and a bright grey box in dark. Geometry and colours were MEASURED off the artwork by
connected-component analysis (centres, radii, modal fills `#0085d0` `#00b1c3` `#00b7f0` `#c170aa`),
normalised into a 100x100 viewBox. **The mark is taller than wide — that is the artwork's proportion,
not a bug to stretch out.** The badge is WHITE in both themes: those four colours only read on a light
ground, and a logo that re-tints with the colour scheme is no longer the logo.

⚠️ **`common.appName` HAD NO CONSUMER** — the sidebar carried a literal and the key was dead in all six
locales. Wiring it up needed a SECOND translator: the key is under `common`, the sidebar's `t` is bound
to `nav`, and `t('appName')` would have resolved `nav.appName` and thrown **MISSING_MESSAGE — which
passes tsc, the suite AND `next build`** (rule 6). `app/layout.tsx` keeps a literal because `metadata`
is evaluated outside locale scope.

**NOT CHANGED, DELIBERATELY: `setProducer('AI HR')` in the EIGHT PDF generators.** That string is
metadata on statutory documents (EA, CP39, Borang A/8A, TP1, payslips, review letters, report exports).
Re-stamping filings is not a sidebar change and is the owner's call.

⚠️ **THE GATE WENT RED ONCE ON PURE ENVIRONMENT AND THE TALLY IS WHY WE KNEW.** Chunk 1 failed 11 files
/ 14 tests at **38% disk** — so NOT the WAL ceiling — with **ZERO AssertionError, ZERO MISSING_MESSAGE,
107 `does not exist`, NINE `Hook timed out`**, and it took 421s against a 107s baseline for the same 124
files. No stray process was found afterwards. **Re-running the identical code gave 124/124 in 112s.**
Rule 12's signature exactly; run the cause tally and re-run before believing a red.

### r221 (2026-08-26) — ADR-0082 slice 1: the AI gateway learns to converse. NO MIGRATION.

**THE ROUND DID NOT COME FROM THE BOARD.** The owner asked to start "the real AI part". `lib/ai` was a
governed gateway with four single-shot drafting callers and nothing else; the north star's Phase B
(assistant) had never been started. **ADR-0082** designs it and **slice 1 is now deployed**.

⚠️ **THE ASSISTANT DOES NOT RETRIEVE, AND THAT IS THE WHOLE DESIGN.** ADR-0007 §3 rejects naive RAG
over tenant data, and this repo makes the reason concrete: access control is **per-row and in the
database** — `db/client.ts:186-190` sets `app.tenant_id/user_id/roles/grants` as transaction GUCs and
**128 migrations carry `CREATE POLICY`** against them (`payslip_rls` → `app.can_see_employment`,
`compensation` → admin-or-self). A vector store is a DERIVED store and inherits none of it: you would
re-implement `can_see_employment` as index-time ACL tags and re-index on every reporting-line change,
delegation, transfer and termination — a second authorization system that must agree with the first
forever. So the assistant calls the reads the SCREENS already call, inside the caller's own
`SessionContext`. ~40 functions on `core/read.ts` already take `ctx` first; that signature is the seam.

⚠️ **SLICE 1 HAS ZERO CALLERS AND THE ROUND SAYS SO.** `converse()` + the three adapters are ~1,800
lines no production path reaches. Deployed because main-ahead-of-production is its own hazard (r159),
NOT because it does anything yet. Every defect below was latent, never live.

⚠️⚠️ **THE ADVERSARIAL PASS FOUND 3 MAJORS UNDER 58 GREEN TESTS, ALL THE SAME SHAPE: ANTHROPIC (the
reference) WAS RIGHT AND THE OTHER TWO DIVERGED SILENTLY.** (a) Google's `providerState` replayed
`functionCall` parts even when `normaliseStop` had SUPPRESSED those calls on refusal/`max_tokens`, so
the next request showed the model a refused call as an outstanding request with no result closing it;
(b) `String(raw ?? 'STOP')` read an ABSENT `finishReason` as `end`, though the SDK documents empty as
"has NOT stopped generating" — a truncated answer reported as finished; (c) OpenAI emitted
`{role:'assistant', content:null}` with no `tool_calls`, which the SDK documents as invalid — one
`ConverseArgs`, legal on two providers, a 400 on the third surfaced as "Could not reach OpenAI".
**Hand-fixed, not sent back for a second agent pass (rule 23b), and each fix PROVEN non-vacuous** by
reverting it from a `cp` copy and watching exactly its own named test fail.

⚠️ **ONE OF THOSE FIXES WAS WRONG AND AN EXISTING TEST CAUGHT IT — RULE 18, EXACTLY.** Routing Google's
400 away from "Invalid API key" broke a deliberately-pinned behaviour whose premise was RIGHT: **the
Gemini Developer API answers a bad key with 400, not the 401 Anthropic and OpenAI use.** 400 only became
ambiguous once `converse()` made the request shape variable (a rejected tool schema is also a 400). So
`reason()` now takes the PATH: `generate`/`validate` keep "Invalid API key" (fixed shapes — nothing else
CAN be invalid), `converse` names both causes. The half still true stayed.

**FOUR ADR-0082 §8 DECISIONS ARE SETTLED (2026-08-26), TWO AGAINST THE RECOMMENDATION** — both kept
visible in the ADR rather than overwritten. (1) Audience is **a per-user grant the HR admin assigns and
removes** — neither option offered, and a mechanism this codebase DOES NOT HAVE:
`payroll_permission_grant` is keyed by ROLE, `lib/permissions.ts SCREENS` is static with no backing
table, and no per-user screen access is persisted anywhere. (2) The **full §4 tool catalogue**, which
commits `search_handbook` — the one tool that is not a wrapper over an existing read, since **there is
no full-text search in this codebase at all**. (3) Refuse at the ceiling. (5) **Answers in all six
locales**, which promotes one guardrail to load-bearing: the assistant may never ORIGINATE a statutory
figure or interpretation in any language, because model quality in ms/ta/th/vi for statutory HR
terminology is UNMEASURED here. Still open: transcript retention, and whose API key pays.

**STILL NOT DONE IN SLICE 1, deliberately:** the cache-read assertion ADR §2.2 says the build MUST make
(needs a live key); the `claude-opus-5` default in `lib/ai/registry.ts:16` (still `claude-opus-4-8` —
valid, just behind, and moving it changes behaviour for FOUR shipped drafting callers, so it is the
owner's call); and localising the gateway's raw-English error strings, which decision 5 makes overdue.
**THE DRY RUN IS CLEAN WHEN YOU EXCLUDE `next-env.d.ts`, AND THAT EXCLUSION IS CORRECT:**
`next-env.d.ts` (UNTRACKED and generated — a tree that has run `pnpm dev` says `.next/dev/types/…`,
production says `.next/types/…`, and each side is correct for its own build mode). DELETE the deploy's own
`deploy-rNNN.log` off the box when you are done with it, or `--delete` will report it forever. Anything
ELSE in that dry run is an undeployed release.
**NO MIGRATION SINCE r209** — r210 six items / 52 files; r212 two / 30; r215 two / 16.
**Production is on 365 migrations** — r209 added `0448` `tp1_status_values` and `0449` `tp1_approval`
(the reissue of the dead `0444`/`0445`), both verified present on the live schema
(`tp1_relief.approved_month` / `approved_year` / `approved_by` / `deduction_month`). NOTE: `drizzle.__drizzle_migrations` is NO LONGER READABLE by the app role
(`permission denied for schema drizzle`), so verify a migration by its EFFECT on `information_schema`
instead of by the watermark. **r217 ADDED `0450`** (`employee_statutory_my.old_ic_number` +
`passport_issuing_country_code`), verified on the live schema by its EFFECT on `information_schema`.
**r218-r222 added NONE. r223 ADDED `0451`** (`assistant_substrate` — the four ADR-0082 tables),
verified on production by its EFFECT: all four tables present, RLS on all four, and the DELETE
asymmetry intact (`assistant_exchange` keeps DELETE for PDPA erasure; grant/budget/usage do not).
**Next free is `0452`.**
**Board after r220 (2026-08-25): `deployed = 738` · `cancelled = 14` · EVERYTHING ELSE ZERO — the board
is completely clear for the THIRD time in its life.** r220 shipped two: `00806b4c` (the CP39 e-Data PCB
file fills all four identity boxes, refuses an over-long one, and the two downloads are named apart) and
`61c2e30f` (the blank C.P.8A Pin. 2024 in both languages, plus the EA field register). r219 shipped five
(`0fea5cc9`, `ece6d75d`, `64c09b0e`, `ca7766ab`, `7966ee35`) — details in `docs/HANDOFF-HISTORY.md`.

⚠️⚠️ **r220's DECISIVE FINDING, AND IT IS THE SECOND TIME: THE REPORTER'S "WRONG FORMAT" WAS THE WRONG
BUTTON, NOT A WRONG FORMAT.** `00806b4c` sent a full LHDN fixed-width specification and asked for the CP39
text file to be rebuilt to it. Generating **ISEDECOR's own January 2026 file from production** (19
employees, aggregated per employment exactly as `cp39FileForBatch` does) produced
`009457390901_2026.txt` — **the filename in their own ticket, byte for byte** — with a 57-character header,
nineteen 136-character detail lines, no other line length present, CRLF between and after the last, and no
delimiter anywhere. It already met every clause they sent. What they had almost certainly downloaded was
**"Download as text"**, the READABLE COPY on the review screen, whose own tooltip already said it is not
the upload file. r218 was the same shape (PERKESO). **Generate the tenant's own file before agreeing that
a format is wrong.**

⚠️ **AND THE REAL DEFECT WAS UNDERNEATH IT: THREE OF THE FOUR IDENTITY BOXES WENT OUT EMPTY ON EVERY
LINE.** `buildCp39File` has always placed old K/P at 73–84, passport at 97–108 and Kod Negara at 109–110;
`cp39FileForBatch` simply never fetched them. Now it does. **Filling them made silent truncation reachable
for the first time** — the three columns are unbounded `text` and two are free-text inputs, and `alpha()`
hard-truncates — so `overlongCp39Identities` refuses and names the person and the box instead. A half
passport number is not most of an identity; it is a different identity, on a tax filing.

⚠️ **r220 CHANGES NOTHING VISIBLE FOR THIS TENANT YET, AND THAT IS A DATA FACT, NOT A BUG.** All 33
employees in `employee_statutory_my` have a new IC; **ZERO have an old IC, a passport or a country code**,
so the three newly-filled boxes are still blank in their file and the new "no identity at all" refusal
fires for NOBODY (verified against production before release: `would_refuse = 0`). Building r220's output
and pre-r220's output from the same rows gives **byte-identical files**. The value lands when HR enters a
passport. Two employees still have no TIN and are blocked by the older, unchanged gate.

⚠️ **THE JANUARY DATA IS STILL WRONG IN THE WAY r218 FOUND, AND NOBODY HAS FIXED IT.** ISEDECOR's January
rows still carry `TEST0001`…`TEST0014` in the name box and `ISMAIL` where the filed file says
`MOHD RIDHUAN BIN ISMAIL`. r218 reported it in `68147833`; it is a DATA correction only they can make.

⚠️⚠️ **`7966ee35` IS SHIPPED BUT THE FEATURE IS STILL OFF, AND THAT IS DELIBERATE.** What shipped is the
SCREEN SAYING WHY. Replacement Leave in Lieu stays unavailable until `toil` is granted to this tenant, and
that grant is COMMERCIAL PROVISIONING, not a migration or a seed — the owner has it. Until then `/leave`
reads "Replacement Leave in Lieu is not part of this plan" instead of showing nothing, which is verified
on a dev server, not inferred.

**THE BOARD IS STILL EMPTY, BUT THE NEXT ROUND IS ALREADY CHOSEN** — `improve:pull` and
`improve:pull-approved` both return `[]`, and every status except `deployed` and `cancelled` is ZERO.
**That no longer means "nothing to build":** ADR-0082 is the active workstream and slices 2–7 are
specified and decided (see the r221 entry above). Slice 2 is the tool registry
(`core/assistant-tools.ts`) over the existing `core/read.ts` functions, plus the `assistant_grant`
table and the module entry. **Next free migration is `0451`** — slice 1 added none.

⚠️ **THE ONE THING THAT NEEDS A HUMAN: GRANT `toil` TO THIS TENANT, OR REPLACEMENT LEAVE STAYS OFF.**
`tenant_module` has no `toil` row, so `replacementRequestAvailability` returns `module_off` on its first
line for every employee in every company. r219 shipped the screen that SAYS so — `/leave` now reads
"Replacement Leave in Lieu is not part of this plan" instead of showing nothing, verified on a dev server.
The grant itself is COMMERCIAL PROVISIONING and must NOT be written as a migration, a seed or a fixture.

⚠️⚠️ **r219's LESSON IS ABOUT THE PARENT, NOT THE AGENTS: MARKING ITEMS `building` BEFORE LAUNCHING MAKES
THE APPROVED PLAN UNREADABLE TO EVERY AGENT.** `improve:pull-approved` returns only `approved` rows, and
all five briefs said "read your plan there first". Five agents found nothing; ONE said so in `notBuilt` and
the others built from the brief alone. **The plan is the promise to the reporter; the brief is only the
parent's summary of it** (AGENTS 29). Either mark `building` AFTER the agents have read their plans, or
paste the plan text into the brief. The parent's hand-done plan-vs-build diff then found two real gaps —
the EA's derived `0.00` and the entitlement's half-built "backwards" — both fixed before the merge.

⚠️ **A CLUSTER REBUILD WIPES `ai_hr_dev`, AND THE RENDER CHECK THEN FAILS IN A WAY THAT LOOKS LIKE THE
CHANGE.** After `dev-db-rebuild.sh` every screen answered 500 with "No valid dev principal … run
`pnpm db:seed`". Nothing was wrong with the code. Run `pnpm db:migrate && pnpm db:seed` before any render
check in a session where the cluster was rebuilt, and READ THE DEV LOG rather than the status code — it
named the cause on its first line.

⚠️ **THE SAME MISSING GUARD BIT TWO STATUTORY FORMS IN ONE ROUND: EVERY GEOMETRY CASE MEASURES WHETHER A
CAPTION FITS, NONE CHECK WHAT IT SAYS.** The EA shipped `5(a) Pelepasan dituntut melalui Borang TP1` where
the agency's form says `(a) Pelepasan` — r217 wording that gained the form's numbering, so it LOOKED like
the agency's box while saying something the page does not. Both forms now check every caption against the
hand transcription beside the specimen (`docs/forms/*-transcription.txt`), which is the artifact that makes
that checkable at all. **When you trace a form, write the caption list into the transcription and pin it.**

⚠️ **THE REPLACEMENT-LEAVE NOTICE QUOTES SWITCH CAPTIONS THAT ARE ENGLISH IN ALL SIX LOCALES, AND THAT IS
CORRECT.** `admin.replacementLeave.*` is untranslated everywhere, so the notice naming "{enableSwitch}"
reads English in every language — because it interpolates the SETTINGS SCREEN'S OWN key. Translating the
quote while the screen it points at stays English would be the actual defect. The debt is the settings
screen's; do not "fix" it in the notice.

⚠️⚠️ **r218's DECISIVE FINDING: THE PERKESO FILE WAS NEVER A FORMAT DEFECT, AND ONLY GENERATING IT FROM
PRODUCTION FOUND THAT OUT.** The item said records were "split across two lines" and asked for a rewrite
against the official spec. Generating their own January 2026 file on the box gave **19 records, every one
278 characters, CRLF between and none after the last** — and the reporter's pasted example turned out to be
**our record 1, verbatim**, with the runs of spaces collapsed by whatever they pasted it into. The real
defect was in the DATA: **fourteen of the nineteen carry `TEST0001`…`TEST0014` in the name box**, a
fifteenth reads `ISMAIL` where their filed file says `MOHD RIDHUAN BIN ISMAIL`, and several ICs are one or
two digits off the filed ones (records copied, not keyed). **The plan we had already pushed told them the
example did not come from their file. It did.** `68147833` carries the correction in plain words — say it
plainly when a verification contradicts something you have already told the reporter.

⚠️ **A KILLED `gate-chunked.sh` POISONS EVERY LATER RUN — now AGENTS rule 10b, with the symptom and the
one-line fix.** The short version so nobody has to look it up mid-red: `grep "rebuild FAILED"` in the gate
log BEFORE believing a failing chunk, and start a gate with the harness's own background flag, never a
bare `&`.

⚠️ **THE VERIFYING DRY-RUN RSYNC WILL ALWAYS REPORT `next-env.d.ts` IF YOUR LAST LOCAL RUN WAS `pnpm dev`.**
Next regenerates it per build mode: dev writes `./.next/dev/types/routes.d.ts`, the server's production
build writes `./.next/types/routes.d.ts`. Both are correct for their own side. Zero-change proof means
zero-change APART from that file — diff its CONTENT before calling it a real difference, and never force
the dev-flavoured copy onto the server.

⚠️ **THE CP39 SPECIMEN IS FINALLY IN HAND, AND `lib/cp39-form-pdf.ts`'s OWN HEADER SAYS THAT WAS THE ONLY
BLOCKER.** `c99e8358`'s attachment `CP39 sample.docx` (`feedback_attachment` id `477f3fec`) is a Word file
holding TWO images: `word/media/image1.png` is OUR current output, `word/media/image2.png` is a fully
populated **CP39 Pin.2015 at 1210px, legible to the last line of the A / B / C panels**. `unzip` the docx
and it is right there. The renderer's 7ee14bbc paragraph says in as many words that the masthead and the
instruction panels are undrawn because "the specimen is not in this repository" — so step one of that
build is committing the image, not redesigning anything. **`fidelity` still stays `figures`**: it is a
vendor rendering (the DXperience family again), a tracing source, not LHDN's page.

⚠️ **THE REPORTER'S "large blue WRONG FORMAT box" IS OUR OWN ON-SCREEN HONESTY NOTICE**
(`app/payroll/cp39/preview/page.tsx:225`, `bg-blue-50`, "Our layout, not LHDN's page"). It is NOT printed
on the document. An AI summarising a screenshot of the review screen read it as part of the form. Worth
knowing before the next item that quotes a box back at us.

⚠️ **r217 LEFT A FALSE SENTENCE PRINTED ON A TAX DOCUMENT — FIX IT WITH `c99e8358`.** `0450` gave
`No. K/P Lama` and `Kod Negara` real columns and the CP39 mapper already reads them, but FOUR places still
assert they can never be filled: `lib/cp39-form-pdf.ts:461` (in Malay, ON THE PDF), `lib/cp39-form.ts:865`
(text export), `app/payroll/cp39/preview/page.tsx:318` + `blankColumnsHint` in six locales, and
`localization/my/cp39-form.ts:33`. AGENTS 18 applies: the half still true (never derive `Kod Negara` from
the nationality text) stays; the reversed half goes.

⚠️ **`5dbce839` IS NOT A FORMAT DEFECT, AND THE PROOF WAS ALREADY IN THE REPO.**
`test/perkeso-socso-file.test.ts` asserts our writer reproduces the customer's own filed `BRG8A.txt` BYTE
FOR BYTE, and the official spec (attached to `5d3acdc2`) agrees field for field. The request's "employee
split across two lines" example mixes ONE person's identity number with ANOTHER's contributions and doubles
the salary — it comes from no record of their own file. The likely cause is the READABLE `.txt` download
being uploaded instead of the fixed-width one; both sit on the same screen. **The one real difference is
`company_statutory_my.ssm_registration_no`, NULL for ISEDECOR**, so our MyCoID box is 20 spaces where the
accepted file carries `34111U` — and the same empty column blanks `No. Pendaftaran Perniagaan` on the
CP39. It is typeable at `components/company-panel.tsx:865`. The spec marks MyCoID **Mandatory = N** and
has **no SKBBK / Lindung 24 Jam field at all**, so neither is a build.

**MEASURED ON PRODUCTION FOR BOTH PLANS (2026-08-21), so the build does not re-derive it:** ISEDECOR's
`2026-01` batch is `processed` with 38 payslips, **19 carrying a SOCSO/EIS contribution**, ZERO missing or
malformed ICs, and `statutory.bases.socsoEis` present on every one — a file is produced today, unrefused.
Their filed file has 14 people and their CP39 sample says 13 / RM 15,374.70 against our 17-of-19 /
RM 6,919.45. Those are DIFFERENT EMPLOYEE SETS (r215: their reference documents name people who do not
exist in `person`), which is why both plans say in plain words that this is format work and reconciles
nothing.

⚠️ **THE FULL GATE CAUGHT A FORM GAINING BOXES NOBODY COULD FILL, and targeted runs could not.** r217's EA
work added four Section D fields to the PDF only. `test/ea-form-boxes-contract.test.ts` pins that EVERY EA
field reaches EVERY surface — and three of the four have NO payroll source, so without the amend panel they
could never hold a number at all. Adding an EA box means ALL of: `EA_FIELDS`, the derived baseline, the
exhaustive switch in `core/ea-override.ts` (no `default:`, deliberately), the PDF, the HTML statement, and
the amend panel.

⚠️ **THE EA IS ONE PAGE AND ITS GUARD MEANS IT.** Those lines did not fit at 14pt leading, so `ROW_H` is
now 12.5. If a later round adds a box and the page guard goes red, tighten the arithmetic — the published
C.P.8A is one page and a second page is not a fix. The `ea-pdf` fixture is deliberately the TALLEST form the
renderer can produce; keep its `partD` populated or the guard measures the wrong maximum.

⚠️ **A RED GATE IS NOT ALWAYS REAL, AND r217 SAW BOTH KINDS.** The first red was entirely real (the three
findings above). The second was the harness: `deadlock detected` inside `resetDb`'s TRUNCATE, nine
`Hook timed out in 30000ms`, **ZERO AssertionErrors in every chunk**, and ten failing files the round had
never touched. Run the per-chunk cause tally BEFORE believing a red — and before re-running, check
`pg_stat_activity` for a stray dev server or agent rather than simply rolling again.

⚠️ **r215's LESSON, CHEAP TO REUSE: A `method="get"` FORM DISCARDS ITS ACTION'S QUERY STRING.** The
Borang 8A validation-report button was written `formAction=".../file?report=1"` — reads correctly, passes
tsc, the suite and `next build`, and hands over THE FILE, because a GET submission rebuilds the query
from the form's fields per the HTML spec. A hidden input is the OPPOSITE trap: every button in the form
submits it, so both downloads would have returned the report. The one mechanism that works is the submit
button's OWN `name`/`value`, sent by that button alone. Pinned on both halves in
test/perkeso-socso-file.test.ts. **Both `borang-a/preview` and `borang-8a/preview` use GET download
forms**, so this applies to any button added to either — including `da4fc817`'s, if the EA gains one.

**`da4fc817`, `e4b541c6` AND `5d3acdc2` (the EA, CP39 and PERKESO items planned here) ALL SHIPPED IN
r217 — the planning detail is in `docs/HANDOFF-HISTORY.md` → r215 and r217.** The format facts that
outlived them (BRG8A is 278 chars, CRLF BETWEEN records and none after the last, numerics SPACE-padded;
the twelve-field table) live in `lib/perkeso-socso-file.ts` and `test/perkeso-socso-file.test.ts`, which
are the authority now.

⚠️ **TWO LESSONS FROM r212 THAT COST REAL AGENT TIME:**

  - **A FILE FENCE CAN SILENTLY DELETE THE DELIVERABLE.** r212's `elig` brief fenced the agent out of
    `core/read.ts` and `EntitlementBreakdown.tsx` — the two files needed to carry the employee-facing
    notice to a real page. The agent built everything else correctly and disclosed in `notBuilt` that the
    prop had no caller; the verifier confirmed it rendered NOWHERE except its own test. **When a plan's
    headline deliverable is an EMPLOYEE-facing screen, check the fence contains the read that feeds it**
    before launching. It cost a whole extra pass.
  - **THE GUARD TEST THE PLAN NAMED FOUND A REAL HOLE THE BUILD HAD MISSED.** The build skipped "a holder
    is accepted in scope and refused outside it"; the fix pass built it and it immediately failed —
    `subject?.companyId ?? null` judged the permission against tenant-wide overrides only, so an
    employment the caller COULD NOT SEE fell straight through the on-behalf gate. Fixed in the same pass.
    When a plan names a specific guard, its absence from the build report is a finding in itself.

**MEASURED, SO NOBODY RE-LITIGATES IT:** the new eligibility explanation runs once per leave type in
`no_eligibility_match`, which on this tenant is nearly every type. Reproduced locally (7 types × 4 tables,
3 rules) `/leave` rendered in **160–210ms against a 188ms baseline** — immaterial, because the explain
reuses the winner `core/read.ts` already resolved and touches only small configuration tables. This is
NOT the shape of r210's `entitlementDeleteBlocks`, which really did cost 7s at scale by re-running an
RLS SECURITY DEFINER function per ledger row.

⚠️ **THE r207 EPF DIAGNOSIS WAS WRONG; r210 FIXED THE REAL ONE. DO NOT RE-LITIGATE IT.**
"`localization/my/multicycle.ts` is unwired, wire it" was NEVER the fix — `core/payroll.ts` already ran
the increment method (`earlierRunByEmp` ~3741 + `deltaStat` ~413). The defect was in `epf()`
(localization/my/payroll.ts): it banded the NORMAL wage and added a straight percentage of the bonus.
r210 makes the Third Schedule lookup take normal + additional COMBINED, so A0001's January bonus run
went 182/199 → **176/192, the figures the reporter demanded twice**. `multicycle.ts` is STILL not wired
into the kernel and ADR-0024 §5 still gates it.

⚠️ **THE ONE CORNER WHERE r210's EPF PROMISE DOES NOT HOLD. The reporter HAS been told — see below.**
The plan promised, in plain words, that two runs in a month equal one run. Across the RM5,000 employer
step the published table steps DOWN (13%→12%), so a small bonus can make the month's combined figure
SMALLER than the regular run already contributed; `deltaStat` clamps the negative delta to 0, the bonus
payslip prints employer EPF 0.00, and the month sits up to **RM38** over the table figure. RM5,000 + RM50
= 650 + 0 against a one-batch 612. Pinned in `test/epf-combined-month-bdf7d248.test.ts`
(`twoRuns - oneRun === 38`). Nobody is short-paid — the excess is in the employee's own EPF account —
and closing it needs a negative EPF line, i.e. the reversals ADR (§6), not a code change.
**ALREADY RAISED AND CLOSED — do not raise it again.** It is board item `e52ce9b6` "EPF - the one case
where a bonus cycle does not add up to the month (RM5,000 step)", raised as CLAUDE AI on 2026-08-20 and
now `deployed` (`build_ref 1766c2b0`). The line that used to sit here said the reporter had NOT been
told; checking the board before acting on it is what caught that — AGENTS rule 7 applies to this file as
much as to a ticket.

**PROVE THE DEPLOY CLAIM INDEPENDENTLY** rather than trusting the line above: `git for-each-ref
refs/heads/build` plus a dry-run rsync FROM mainwt. **"Nothing in flight" is a claim about BRANCHES and
is NEVER a claim that `main` has been deployed** — r159 exists because those two were conflated. Every
unmerged `build/*` branch older than r209 is STALE, not pending: `r71`, `r83`, `r154` (squashed,
ancestrally unrelated), `r163-g-release3` and `r163g-picker`, whose content reached main another way
(their `0405` is on main as `0410_entitlement_reset_drop_old_layers.sql`, and `main` DELETES ~45,000
lines relative to both — that is the tell). r209's seven `build/r209-*` branches are all merged.

**IF YOU ARE ASKED TO BUILD SOMETHING, READ AGENTS RULES 23 AND 23b FIRST.** They are the most expensive
lesson in this repo: a workstream reporting tsc-clean and test-green is not evidence it is right, the
adversarial verify is the load-bearing step, and a second agent pass on the same code is where rounds go
backwards. Budget verification at roughly the cost of building.

**THE TWO THINGS STILL WAITING ON SOMEONE ELSE** (neither is a build):
  - **The EPF multi-cycle aggregation needs an ACCOUNTANT'S SIGN-OFF** before it is wired in (ADR-0024
    §5). r209 shipped the §7 worksheet that produces the evidence. See the r209 entry.
  - **Grade "Executive" maps to no Medical entitlement table.** The reporter has not said which it should
    use, and the leave health card surfaces it by name rather than guessing at someone's sick leave.

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
`pnpm exec tsc --noEmit` · **`bash scripts/gate-chunked.sh`** · `pnpm exec next build` ·
`pnpm gate:shadow` whenever a migration is involved.
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
  A full suite now takes **~950 s** (558 files / 6612 tests), longer than the 761 s recorded earlier.
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

## Entitlement facts — read before touching leave (re-verified on production 2026-07-31)

**r85 MOVED THE RULES. Anything (including old history entries) saying `leave_policy` owns earning
method or carry-forward is WRONG.**

- **Rules live on `leave_type`** (columns `0325`, engines repointed `0334`). `applyLeaveTypeRules`
  (`core/leave-compute.ts:489`) overlays them onto the resolved policy — a **whole-set** overlay
  gated on `hasAnyLeaveTypeRule`. 10 leave types carry type-level rules.
- **`leave_policy` still supplies DAYS** and is the rules fallback for types carrying none. 67 policy
  rows, 57 `earned_monthly`. **Zeroing `leave_policy` wholesale would stop accrual for every type
  that falls through** — removing the band SURFACE is safe; emptying the TABLE is not the same act.
- **DAYS precedence:** `entitledDays = max(floorDays, schemeDays ?? policyDays)`; `schemeBandDays`
  returning **null — not zero** — triggers the fallback.
- **`leave_policy` has no `updated_at`** — date a change via `leave-policy.updated` events, never
  `created_at`.
- **Coverage gap that bites at reset time:** 12 of 41 benefit schemes have zero entitlement rows;
  ISEDECOR BINA + Demo Group Holdings have no schemes at all. After a reset those employees drop to
  the statutory floor.

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

