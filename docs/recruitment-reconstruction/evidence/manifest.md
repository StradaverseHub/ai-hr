# Recruitment reference — evidence manifest

Reference captures are kept **out of this public repository** (they contain the reference vendor's
branding, marketing artwork and copyrighted copy). This file records identity, hashes and provenance
only. Raw bytes for the session that created this file live in the owning session's scratchpad and
must be moved to a private evidence store before that session is retired.

| Evidence ID | Artifact | Source | Captured (UTC+8) | Role / session | Browser / viewport / locale / tz | Action sequence → observed result | Method | Hash | Completeness / limits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EV-001 | `ref-login-capture.json` (REA evidence `ev_cb343197d324957a21d8361f7f3b24fbbc19280bc6250cd9992c5a551f464bf8`) | `https://hire-r1.mokahr.com/login?redirectUrl=%2F` | 2026-11-10 11:07 | Anonymous, empty storage | REA-owned headless Chromium 157.0.8103.50, 1440×900 @1x, en-US, Asia/Kuala_Lumpur, light, reduced motion, SW blocked | `goto` (load) → wait 4 s → login page rendered; final URL unchanged | REA `capture_browser_scenario` provider `rea-playwright-browser-scenario` v1 | capture file = REA evidence ID above | REA completeness `complete`, 127 events, 0 dropped. Network metadata only (no header values, no bodies). |
| EV-002 | `ref-login.png` (derived from EV-001 screenshot artifact) | as EV-001 | as EV-001 | as EV-001 | as EV-001 | final viewport | decoded from EV-001 | sha256 `f9acfc75f1196164e01aede6a582e8f9afeee9c5f42cd2eb461446fb45e550ee` | Viewport only; no scroll. |
| EV-003 | `ref-login.dom.html`, `ref-login.ax.txt` (derived from EV-001) | as EV-001 | as EV-001 | as EV-001 | as EV-001 | final DOM and accessibility tree | decoded from EV-001 | DOM sha256 `3a6ee001ff013eba6191514beac89000938abbba5eb5d45745986944e82048a9` | Static snapshot after 4 s settle. |
| EV-004 | `i18n_en.js` | `https://hire-r1-ats.mokahr.com/moka-fe-public/mage-i18n/javascripts/new_i18n_en_us_messages.a6c9ff8024da41aa17515b97f562f601.js` (requested by EV-001 page) | 2026-11-10 11:08 | Anonymous public static asset | `curl` | Fetched as data, **never executed**; parsed by regex | `curl` + Python regex | sha256 `dcb6f713667209a5e7e948a7ce5928cd33725a3d02d9ae500efd50986cda8a2f` | 33,137 zh→en message pairs. Shows vocabulary only; does not prove any screen is reachable for any role. |
| EV-005 | `unified_login.js` | `https://hire-r1-ats.mokahr.com/javascripts/unified_login-20261105-1430-35d1e-release.js` | 2026-11-10 11:08 | Anonymous public static asset | `curl` | Fetched as data, not executed, not yet analysed | `curl` | sha256 `3b441ec3a75159846575a891fbc68ff9e03afc87566412fb573cf717aa5816b4` | Login bundle only; the authenticated ATS bundles were never served. |
| EV-006 | Browser-pane screenshot | `https://hire-r1.mokahr.com/` in the Claude desktop built-in browser | 2026-11-10 11:10 | Built-in browser profile, no Moka session | Desktop app pane | `navigate /` → redirected to `/login?redirectUrl=%2F` | `preview_start` + screenshot | not hashed | Establishes only that this profile has no signed-in session. |

## Reference baseline

- Build: login assets tagged `unified_login-20261105-1430-35d1e-release` (EV-001 network list).
- Deployment: `hire-r1` region host; companion origins `hire-r1-ats`, `hire-r1-passport`, `hire-r1-public`, `static.mokahr.com`.
- Third-party requests observed on the anonymous login page: `cstaticdun.126.net` (NetEase captcha loader), `hm.baidu.com` (Baidu analytics).
- Authenticated application: **not observed**. No account, role or tenant was available.

## Signed-in observation — 2026-11-10 (owner session)

Conditions for EV-007…EV-020: the owner signed in themselves in the Claude desktop built-in browser
pane. The tenant is the owner's own company account, which is **live company data, not a test tenant**. The
role is the owner's own account; several dashboard tiles show "No viewing permission", so the account
is not Super Admin. Viewport is 1440×900 emulated, locale en. Collection method: `read_page`,
`get_page_text`, label-only JavaScript extraction (`javascript_tool`) and network-request metadata
(no bodies). Screenshots were viewed in-session only and are not stored. **No candidate or employee
personal data is recorded in this repository.** Business configuration (stage names, reasons, settings
text) is recorded because the owner's company owns it.

| Evidence ID | Route | Observed |
| --- | --- | --- |
| EV-007 | `/dashboard?pipelineId=…&jobPreference=all` | Shell nav, tiles, task tabs, ~90 API calls (service families below) |
| EV-008 | `/jobs?jobStatusList[0]=open` | Positions list, Opening/Closed tabs, filters, columns |
| EV-009 | `/jobs/<uuid>/info` | Job info form fields, status switch |
| EV-010 | `/jobs/<uuid>/setting` | Job settings sections |
| EV-011 | `/jobs/<uuid>/manager` | Job team roles |
| EV-012 | `/jobs/<uuid>/source` | Sourcing channel management |
| EV-013 | `/candidates?pipelineId=…&stageId=…` | Stage tabs and counts, filters, card fields, card actions |
| EV-014 | `/candidates/application/<id>/info` | Application drawer: tabs, action panel (structure only) |
| EV-015 | `/interviews/overview` | Interview schedule list, filters, columns |
| EV-016 | `/settings/*` sidebar | Full settings inventory (≈100 pages) |
| EV-017 | `/settings/stage`, `/settings/pipeline` | Stage catalogue with types; processes |
| EV-018 | `/settings/archive_reason`, `/settings/auto_refuse` | Rejection reasons, rejection-letter rules |
| EV-019 | `/settings/interview_*`, `/settings/offer*` | Rounds, scorecard, evaluation options, feedback rules, offer fields/approval/settings |
| EV-020 | `/settings/headcount_field`, `/settings/recruitment_need*`, `/settings/job_info`, `/settings/role`, `/settings/lock_management`, `/settings/repeat_candidate_management`, `/headcounts`, `/talent_pool/all` | Requisition fields, approval groups, settings; job fields; roles; locking; duplicates; requisition statuses; talent pool filters |
| EV-021 | `/interviews/overview` → `/application/<id>/interviews` | Interview tab of one application: "Add an interview", "Export feedback"; interview card with date · type, candidate response, site, recruiter, round, start time and duration; per-interviewer "Not evaluated" / "Add feedback" |
| EV-022 | `/candidates/application/<id>/interviews` (Offer stage) | Submitted feedback: per-interviewer overall result and "See scorecard"; scorecard view with interviewer and feedback time, section shortcuts, Overall feedback (evaluation result + overview text), form questions and scored sections with totals |
| EV-023 | `/candidates/application/<id>/offer` | Offer tab: Delete offer, Add background check; Offer approval (flow name, initiated date, status, Reinitiate, Edit approval process); Offer record (send channel and date, candidate decision, Re-send, Mark); Offer details field list; offer email and SMS previews. Values not recorded |
| EV-024 | `/headcounts`, `/headcounts/info/<id>` | Requisition list (HC + 6-digit numbers, status counts, approval-status filter, "modifying mandatory fields outside Draft triggers reapproval"); requisition form: JD information, vacancies table (total, remaining offers available, remaining capacity for onboarding), field list, status, associated jobs (Multi-to-One), Create job |
| EV-025 | `/talent_pool/all` | Talent pool overview: today's archived, total, sort, restore archived candidates; card fields: experience, latest employer and role, education, applied date, position, pool, archiving date, pre-archiving stage, archiving reason |
| EV-026 | `/settings/repeat_candidate_management` | Duplicate candidates: auto-merge of duplicates (off; merge keeps the "subject" profile, the subject's lock, and both histories) and its headhunter exception (off); repeated-application control (on, within 3 months: a new application to the same position is refused; existing duplicates keep the later-stage or earliest one); duplicate-check rules (system: name + work or internship experience + education + birth year + gender; ID number; any 2 of email, name, mobile) |
| EV-027 | `/settings/standard_resume`, `/settings/custom_field`, `/settings/resume` | Candidate profile sections (photo; personal info; work experience; education; languages; pre-employment declarations; family particulars; job preference incl. current and expected salary and notice period; source; consent declarations). Field catalogue with EN/CN names, type, per-field visibility permission and enable/disable; "allow viewing desensitized information" with an operation record. Resume display choices (resume file vs profile) per context; salary display on the profile; import template. Tenant-specific wording not recorded |
| EV-028 | `/settings/candidate_detail_data_share` | Sharing candidate info: HR sees all of a candidate's applications (options: assessments, background checks, attachments, notes unless private, talent evaluation); hiring managers: view other applications, assessment visibility, background information, own screening records only |
| EV-029 | `/settings/tag` | Tags: enabled, groups, tag name, type (smart tags, e.g. inferred "job hopping"/"employment gap"; manual tags), creator, edit/disable. Creator names not recorded |
| EV-030 | `/settings/privacy_statement`, `/settings/privacy_policy_settings`, `/settings/resume_period_validity`, `/settings/compliance_settings` | Privacy policy (versions per language; scopes where agreement is required; read for 3 s before agreeing); candidate authorization (consent request per source scenario, all disabled; identity verification options; 7-day confirmation window; resume-upload reminder for HR; mask full name; mark unauthorised resumes); data retention (rules per job location with unauthorised and authorised periods, none configured; mark expired resumes; clock starts at the latest archival date, moved to the consent date on consent; employed and resigned pools kept permanently; notification recipients); compliance (hide portal resume features; watermark exports) |
| EV-031 | `/settings/protection_period_setting`, `/candidates/application/<id>/info` | Protection periods for headhunter/RPO/referral credit (365/365/180 days; sourcing family, later slice). Application detail structure: lock status (not locked / locked operable / locked inoperable), resume file view, notes, candidate custom tags, add to blocked list, notify candidate. Values not recorded |

Side effects caused by observation (disclosed):
- Closing Moka's 4-step product tour sent three `POST /api/click-guide` requests, which mark the tour as seen for the owner's account.
- Opening one candidate's application drawer probably marks it "viewed" for this user (Moka has a "Viewing status" filter).
- EV-021…EV-025 (second session, same day): opened two application drawers, one scorecard view and one requisition form; viewing may mark them viewed. The requisition form is editable in place; Save was not used.
- EV-026…EV-031 (third session, same day): opened twelve settings pages and one application record (may mark it viewed); no setting or record was changed.
- No records were created, edited, moved, rejected, sent or deleted. No Save, Move, Reject, Send or Approve control was used.

Back-end service families seen in request paths (metadata only): `ats-warden` (users, business units, permissions), `ats-pipeline` (pipelines, stages, reasons, reminders), `ats-candidate`, `ats-candidate-search-left` (stage counts), `ats-interview` (rounds, feedback templates, interviewer groups), `ats-jc` (jobs, channels, headhunter contracts, privacy policy), `ats-talent` (talent pools), `ats-exam`, `moka-message-hub` (calendar, messages), `pa-permission` (data permissions), `bigdata` (reports and AI agents).
