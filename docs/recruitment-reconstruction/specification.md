# Recruitment — reference-derived specification (core hiring path)

Basis: EV-007…EV-020 (signed-in, read-only, the owner's live tenant, 2026-11-10). Owner decision B-002:
match workflows and rules, render in AI HR's design system, do not copy Moka branding or text.
Stage names, reasons and form content below are **the owner's company configuration**. AI HR ships
them as editable seed defaults, not as hard-coded behaviour.

Classifications: **O** = OBSERVED, **I** = INFERRED, **U** = UNKNOWN, **D** = IMPLEMENTATION DECISION.

## F1. Navigation shell (EV-007)

- O: Primary menu order is Dashboard, Candidates, Interviews, Positions, Talent pool, Report, Settings, plus a global Search and an "Add" quick-create button.
- D: AI HR shows one "Recruitment" menu entry. Its sub-pages follow the same order: Overview, Candidates, Interviews, Positions, Talent pool (later), Reports (later), Settings.
- O: The Positions area has two sub-tabs, Positions and Job requisitions (`/jobs`, `/headcounts`), each with a Positions/Approval toggle.

## F2. Overview / dashboard (EV-007)

- O: Scoped by recruitment process (pipeline selector) and "All jobs" / my jobs (`jobPreference`).
- O: Tiles:
  - Today's applications and Today's interviews;
  - Resume screening (To assign, To screen);
  - Hired (To offer, Onboarding);
  - Interview (To be scheduled, Awaiting feedback, To process).
- O: Each tile links to the Candidates list, pre-filtered by stage and status.
- O: The account lacks permission for some tiles; those links read "No viewing permission".
- I: Counts are derived from application state; counts per stage come from a stage-counts service.
- O: A Tasks panel has tabs @Reminder, Job Requisitions, Jobs, Interviews, Offers, Referrals and Other, with unread badges and "All marked as read".
- Acceptance: every tile number equals a count query over applications visible to the viewer. Tiles the viewer cannot open render as non-links.

## F3. Positions (jobs) (EV-008…EV-012, EV-020 job fields)

### List

- O: Status tabs Opening and Closed, with counts.
- O: Filter panel: Job title, Job number, Department, Channel, Recruiter, plus "Add field to match".
- O: Columns: Basic info (title, job number `MJ000195`, country · department), Recruiter, Source, Candidates, Onboarded, Interview plan.

### Job record

- Job info (O):
  - Job title *;
  - Job description (rich text);
  - Job level * (multi-select);
  - Work location *;
  - Recruitment Type * (e.g. Budgeted);
  - Employment type * (e.g. Project Based);
  - Employee to be replaced;
  - Business Group *;
  - Company *;
  - Department.
- Job number (O): automatic `MJ` + 6 digits.
- Job fields (O): configurable, each with type, required, needs review, enabled.
- Status (O): Open / On hold / Closed, switched from the job header.
- Job settings (O):
  - Job language;
  - Position attribute: Regular or Evergreen, unmodifiable after creation;
  - Process: **cannot be changed once the job has an application or an associated position**;
  - linked Job requisition(s) (multi-to-one) with Priority, Date opened and Target on-board date;
  - Screening evaluation form;
  - Interview plan: ordered rounds, each with an evaluation form;
  - automatically archive after rejection;
  - Offer approval process.
- Owner (O):
  - Recruiter: one; full operation access to the job.
  - Recruitment assistant: many; operation access.
  - Hiring manager: many; resumes are recommended to them first.
  - Interviewer: many; preferred when adding an interview.
- Sourcing channel (O, later slice): job-board accounts, career page, referral portal, agency/RPO.
- U: Validation timing and error text on save; exact rules for the job-number sequence.

## F4. Recruitment processes and stages (EV-017)

- Stage catalogue (O):
  - Each stage has a name and a **type**: System default, Screening, Interview, Offer, Test, or No type.
  - Every stage except the system defaults can be disabled.
  - System defaults are Application Review and Onboarding.
- Processes (O): named, scoped to departments, enabled or disabled. "CH Recruitment Process" applies to all departments; "Default recruitment process" is disabled.
- Stages of "CH Recruitment Process", in order (O): Application Review → Recruiter's Screening → AI Interview → Hiring Manager Review → Interview → Offer → Medical check-up → Background check → Onboarding → Hired. The terminal buckets are Hired and Archived.
- O: Deactivating a stage does not affect applications already in the process.
- I: Hired and Archived are terminal buckets (stage ids −1 and −2 in the URLs), not configurable stages.
- D: AI HR seeds this process as an editable default for a company.

## F5. Candidates and applications (EV-013, EV-014)

- O: One candidate can have several applications ("1 Application" chip); a pipeline card is an **application**.
- List (O):
  - stage tabs with live counts;
  - a left job tree (All / per job, job groups);
  - filters: Position, Degree, Channel, Job, Last Employment, Company, Candidate status (Followed, Locked states, timeout states), Gender, Age;
  - saved filter sets;
  - quick filters: AI evaluation result, Matching rate, Viewing status.
- Card (O): applied date · job · source; name; latest employer and role; education; Candidate owner; Assignment status (Not Assigned…); AI evaluation; tags.
- Card actions (O): Move forward, Reject, Notes, Assign to hiring manager.
- Application drawer (O):
  - header: name, "Potential Duplicate" flag, application chip, age, contact, years of experience, education, tags;
  - tabs: Basic info (résumé viewer), Screening, Interview, Exams/Evaluations/AI Interviews, Offer, Notes, Additional info, Activity feed;
  - right panel: stage stepper; a primary "Move to <next stage>" split button; Assign to hiring manager; Request candidate to update info; Follow-up; Transfer; Reject; Archive to talent pool; Follow; Notes; More (Notify candidate, Add to blocked list); Candidate owner; custom tags;
  - previous/next arrows step through the list.
- Rules:
  - I: "Move forward" moves to the next enabled stage of the job's process; the split button allows choosing another stage.
  - O: Reject requires an archive reason (EV-018) and archives the application.
  - O: Duplicates — candidates can be merged automatically by configurable rules; repeat applications to the same job within a period are controlled (EV-020).
  - O: Locking — whole process / by phase / off (EV-020).
  - U: Whether Move forward can skip stages; server validation on illegal moves.

## F6. Rejection / archive reasons (EV-018)

- O: Reasons are grouped by who ended it ("We reject candidate"; a candidate-side tab is I).
- O: Each reason has an internal Reason, an **External reason** shown to the candidate, and a type (Default or Customized). Default reasons can be Displayed or Hidden; Customized ones can also be Deleted.
- O: The rejection letter is sent manually or automatically, by Email or SMS, in real time or delayed (e.g. 2 days after entering the talent pool). Conditions: every archived application, or the candidate's last application archived manually, or manually or automatically.

## F7. Interviews (EV-015, EV-019)

- O: Interview schedule is a list or calendar view, grouped by day ("Today (n)").
- O: Filters are Positions, Recruiter, Interviewer, Interview type, Interview site and More.
- O: Columns are Interview Details (round, type such as On-site or Video), Candidate, Contact, Position, Interview site, Meeting room, Recruiter, Status (e.g. "2 interview feedback"), with a Feedback reminder action.
- O: Rounds are configurable (1st, 2nd, 3rd), each bound to an evaluation form.
- Scorecard "CHG Interview Evaluation Form" (O):
  - a rating scale of 1–5 with a defined meaning per number;
  - Section A, Foundational assessment: 5 criteria, total /25, each with a suggested question, a 1–5 rating and notes up to 500 words;
  - Section B: 7 leadership principles;
  - Section C: Summary;
  - an Overall feedback option.
- O: Overall feedback options are Recommended to Hire (positive), Keep In View (neutral) and Not Suitable (negative).
- Feedback rules (O):
  - overall rating is required or optional;
  - interviewers cannot see each other's scorecards, but the hiring manager can;
  - editing feedback is allowed at any stage, or locked after the move to the next stage, or locked after archiving.
- O: An interview-result rule can summarise all interviewers' evaluations a set number of hours after the interview (currently enabled, 2.5 h, no rules defined).

## F8. Offers (EV-019)

- O: Offer fields are configurable per module ("Offer stage information collection", "Offer details"), each with type, required, approval-required and private flags.
- O: Offer approval is a named approval flow ("Job Offer Approval") in approval groups, with who can initiate and an admin.
- Offer settings (O):
  - the offer link is valid for **15 days**;
  - optional automatic handling: when the candidate accepts, they move to the next stage; when they reject, to the talent pool;
  - viewing permission: position team, or offer creator, sharer, creator's reporting chain and super admin;
  - CC can be required on send;
  - notify the hiring manager or offer creator on accept/reject;
  - watermark attachment previews;
  - offer attachment templates.
- D: AI HR never sends the offer letter itself in slice 1. A send is a human action, and pay figures are entered by people, never computed by a model.

## F9. Job requisitions (EV-020)

- O: Statuses: Draft, Not started, In progress, Paused, Completed, Cancelled, Expired. Completed and Cancelled are terminal (cannot be changed manually).
- O: Filters are Department, Team leader and Requisition creator; there is an "Add job requisition" button.
- O: Fields (configurable): Job requisition No., Job title, JD attachment, Job level, Hiring Manager, People Business Partner, Recruiter, Total number of vacancies, …
- O: Approval: optional approval chain after submission, with approval groups per business unit (Default, CHGB, CHBM, CHCE, CHGP, Fiamma, Signature, SAG, Others).
- O: Task mode: remaining offers allowed = positions needed − historical onboarding − offers in process; remaining headcount = positions needed − historical onboarding.
- O: Co-manager (collaborator) permissions are configurable: edit, delete, change status, initiate approval, associate job.

## F10. Roles (EV-020)

- O: Roles are People Business Partner (HR), Recruiter (HR), People Operations (HR), Hiring Manager, Hiring Manager (For CHGP Only), Interviewer and Super Admin. Each has function authority and data permissions.
- D: AI HR maps these onto ADR-0049. The Recruiting Partner company-scoped grant covers recruiter / PBP / People Ops. Hiring manager and interviewer are per-job team memberships (F3 Owner), not global roles.

## Later slices (observed, not in slice 1)

Talent pool, sourcing channels and career portal, referrals, agencies, exams and AI interviews,
background check, medical check-up integrations, messaging templates, reports, duplicate merge,
locking, protection period, candidate privacy and retention.

## Slice 1 acceptance cases (D: the first build)

1. Recruitment menu is hidden, and its routes refuse access, for a company without the `recruitment` module. With the module enabled, it is visible to HR admins and Recruiting Partners.
2. A company gets the seeded process: 10 ordered stages with types, Hired and Archived as terminal buckets, and the 7 default archive reasons plus editable custom reasons.
3. Create a job with the required fields: title, job level, work location, recruitment type, employment type, company. A missing required field is refused by the service, not only the form. The job number is allocated in sequence per company.
4. Job status moves Open ↔ On hold → Closed. The Opening tab lists Open and On hold jobs; Closed lists Closed.
5. The job's process cannot be changed once it has an application (service refusal, audited).
6. Add a candidate application to a job; it starts at the first stage. "Move forward" goes to the next enabled stage; the stage tab counts change accordingly.
7. Reject requires a reason and moves the application to Archived, keeping the stage it left.
8. Users without access cannot read or move applications (server-checked; RLS on every table).
9. Every move and rejection is in the application history with actor and time.

## Slices 2–4 (owner decisions 2026-11-10)

Scope: the rest of the core hiring path, plus job requisitions and a basic talent pool. Reports (F12) stay out
because they were never observed. Each slice ships its own migration, service functions, pages, six-locale labels
and tests. New tables get forced RLS and grants, and every service entry point runs inside `withRecruitmentTenant`.

### Slice 2 — Hiring team access and interviews (EV-011, EV-015, EV-019, EV-021, EV-022)

Access (D, refines D-004):
- A job's team members (F3 Owner) gain per-job access. Recruiter and recruitment assistant: full operation on that
  job's applications. Hiring manager: read the job's applications, move forward or reject, see every scorecard on
  the job. Interviewer: read only the applications they are scheduled to interview, and write only their own
  feedback.
- Enforced in the database: new predicate(s) next to `app.can_admin_recruitment_for`, used by RLS and checked by the
  service. HR admins and Recruiting Partners keep company-wide access.
- The Recruitment menu shows for anyone who is on at least one job team, as well as for administrators. Team
  members see only Candidates, Interviews and their own jobs; Settings stays administrator-only.

Interviews:
- An interview belongs to one application. Fields: round (from the job's interview plan, default 1st/2nd/3rd),
  type (On-site, Video, Phone), start time, duration, site (free text), meeting room (optional), interviewers (one or
  more users), and candidate response (Pending, Accepted, Declined). It is scheduled by a recruiter or
  administrator.
- Status is derived:
  - Scheduled — before its start;
  - Awaiting feedback — after its end, with any interviewer not submitted;
  - Feedback complete;
  - Cancelled.
- Schedule page: groups Today, Upcoming and Recent. Columns: round and type, time, candidate, position, site,
  recruiter, and status ("n interview feedback" / Awaiting feedback). Filters: position, recruiter, interviewer,
  type.
- Application drawer, Interview tab: "Add an interview", interview cards; per interviewer either "Not evaluated" with
  "Add feedback" (only for that interviewer) or the overall result with "See scorecard".

Scorecards (EV-019, EV-022):
- An evaluation form (company setting) has an ordered list of sections. Each section has criteria, each criterion a
  1–5 rating with optional notes (max 500 words) and an optional suggested question. A section total is shown as
  sum/(5 × criteria).
- Overall feedback: an evaluation result (Recommended to hire, Keep in view, Not suitable) and an overview text.
  Whether the result is required is a company setting. The seed default form is a generic 5-criterion foundational
  assessment. The owner's own form text is not copied.
- Rules (company settings, seeded on):
  - interviewers cannot see each other's scorecards; the hiring manager, recruiter and administrators can;
  - feedback editing is allowed (a) at any stage, (b) until the application moves past the interview's stage, or
    (c) until it is archived. Default: (b).
- Section totals are computed by deterministic SQL/TS, never by a model.

Overview tiles (F2): add Today's interviews, To be scheduled (active in an Interview-type stage with no future
interview), and Awaiting feedback. A tile the viewer cannot open renders as text, not a link.

### Slice 3 — Offers with approval, and the hire hand-off (EV-019, EV-023)

Offers:
- One current offer per application (re-issuing replaces it; history is kept in events).
- Details are fields from a company offer-field set: type (text, number, date, single choice, money), required,
  needs approval and private flags. The seeded fields are generic: job offered, department, reporting to, job level,
  commencement date, work location, basic salary (money with currency), and probation months. Money is entered by
  people and stored as a decimal with currency. No model or rule computes pay.
- Private fields are visible only to administrators, the job's recruiter and the offer's creator.
- Approval:
  - a company offer-approval flow: an ordered list of approver users (one step = one approver);
  - states: Draft → Pending approval → Approved, or Rejected (back to Draft, with a comment);
  - Withdraw is available while pending. Reinitiate after a change to a field that needs approval re-runs the
    approval from step 1;
  - approvers act only on their own pending step;
  - the creator cannot approve their own offer.
- Sending: AI HR does not send email or SMS in this build. "Mark as sent" records channel (email/SMS/other), the time
  and the actor. Candidate decision: Pending, Accepted, Declined — recorded by a person. The link validity
  (default 15 days from sent) is shown as an expiry date; it only labels the offer "Expired"; nothing is sent.
- Optional automation (company setting, off by default): on Accepted, move the application to the next stage; on
  Declined, archive to the talent pool with a "Candidate declined the offer" reason.

Hire hand-off (owner decision: HR confirms on the hire form):
- When an application reaches Onboarding or Hired, administrators see "Start new hire". It opens the existing
  short create form (`/admin/personnel/new`) with company, full name and email pre-filled. The server loads them from
  the application after re-checking access; it never takes them from the URL.
- HR reviews and saves; that creates an employee draft through the existing writers (`createEmployeeDraftWithReservedCode`).
  The draft id is linked back to the application. Recruitment never creates a person, employee or employment
  itself.
- Accepted-offer details that the personnel draft already supports (for example the job title and the commencement
  date as the hire date) may be offered as defaults on the continue form. Pay is not copied automatically; HR enters
  it.

### Slice 4 — Job requisitions and talent pool (EV-020, EV-024, EV-025)

Job requisitions:
- Number `HC` + 6 digits, in sequence per company.
- Fields: job title; description (rich text); total vacancies (≥1); job level(s); hiring manager; people business
  partner; recruiter; work location; employment type; recruitment type; employee to be replaced; company;
  department; date opened; target on-board date; years of experience; education requirement; salary range
  (min ≤ max, per month); working days; working hours; mandatory and preferred skills; benefits text.
- Statuses: Draft, Not started, In progress, Paused, Completed, Cancelled, Expired.
  - Completed and Cancelled are terminal; Expired is set only by date (target on-board date passed while not
    terminal).
  - Allowed manual moves: Draft → Not started (by submitting); Not started ↔ In progress ↔ Paused;
    any non-terminal → Completed or Cancelled.
- Approval: optional per-company requisition approval flow (same shape as the offer flow). Submitting a Draft starts
  approval when a flow exists. Editing a required field outside Draft resets approval.
- Vacancies table:
  - remaining offers available = vacancies − hires already onboarded − offers in process;
  - remaining capacity for onboarding = vacancies − hires already onboarded.
  Both are deterministic counts, never below zero in the display (a negative is shown as 0 with an over-filled
  warning).
- Associate jobs: many jobs to one requisition ("Multi-to-One"); "Create job" pre-fills a new job from the
  requisition.
- The requisition list has status tabs with counts, filters (department, hiring manager, creator, has associated job)
  and an approval-status filter.

Talent pool:
- An application archived by Reject (slice 1) or by "Archive to talent pool" lands in the pool. One public pool per
  company.
- List: the latest application per candidate in the pool. Card: name, latest employer and role if captured,
  applied date, position, archiving date, pre-archiving stage, archiving reason. Filters: position, archiving
  reason, archived since. Totals: today's archived and total.
- "Add to job": create a new application for the candidate on an open job; it starts at the first stage, and the
  archived application stays archived.

### Slices 2–4 acceptance cases

10. An interviewer sees only the applications they interview and can write only their own scorecard; another
    interviewer's scorecard is hidden from them but visible to the hiring manager (DB + service).
11. A user on no job team who is not an administrator gets no Recruitment menu and no rows.
12. Interview status is derived correctly for before-start, after-end-with-missing-feedback and complete.
13. Feedback editing follows the company lock setting (default: locked once the application leaves the stage).
14. An offer needs approval in step order; the creator cannot approve their own; a rejected step returns to Draft;
    a change to an approval field after approval re-runs approval.
15. Private offer fields are hidden from users without access (DB + service).
16. "Start new hire" is available only at Onboarding/Hired, pre-fills from the server, and the employee is created
    only when HR saves; the draft is linked back to the application.
17. A requisition moves only along the allowed statuses; terminal statuses refuse changes; remaining offers and
    onboarding capacity match independent counts.
18. A rejected application appears in the talent pool with its pre-archiving stage and reason; "Add to job" creates a
    new active application and leaves the archived one archived.

## Slice 5 — Candidate records and privacy (owner decision 2026-11-10; EV-026…EV-031)

Scope: a fuller candidate record, resume files, duplicate detection, manual tags, and PDPA consent, retention and
destruction. One migration (4405, after a fresh peer survey), service functions in the pack, pages, six-locale labels
and tests. New tables get forced RLS, explicit grants and none to PUBLIC; every service entry point runs inside
`withRecruitmentTenant`. Nothing here calls a model, parses a resume or infers anything about a candidate.

### Candidate profile (EV-027)

- Besides name, email and mobile: location, current company, current title, highest education (choice), notice
  period, source (choice: referral, job board, career page, agency, walk-in, other) and repeatable entries for work
  experience (from, to or present, company, title) and education (school, qualification, from, to).
- Restricted fields: current salary, expected salary (amount + ISO currency, typed by people, never computed) and
  ID number (NRIC or passport). Stored apart from the candidate row. Readable and writable only by recruitment
  administrators and the operators (recruiter, assistant) of a job the candidate has applied to; hidden from hiring
  managers, interviewers, approvers and other companies by row security, not only by the screen.
- Editing: administrators and operators of any of the candidate's jobs. Hiring managers and interviewers read the
  non-restricted profile of a candidate whose application they may read.
- Not collected (D-013): race, religion, health or disability, pregnancy, criminal record and family particulars.
  The reference collects them through a tenant-configured form; under the PDPA these are sensitive personal data
  and several invite discriminatory decisions. Adding any of them needs an owner and legal decision.

### Resume and attachments (EV-027, EV-030)

- Files on a candidate: kind `resume` or `attachment`; PDF, Word or image; at most 10 MB each; bytes in a side table
  (same pattern as `employee_document`). Upload by administrators and the candidate's job operators.
- Upload asks the uploader to confirm they have the candidate's permission to store the file (the reference's
  "resume upload reminder"); the confirmation is recorded with the file.
- Anyone who may read one of the candidate's applications may view and download the resume; other attachments are
  for administrators and operators. Every download appends an audit event. Event payloads carry ids, kind and size,
  never file bytes or file names.
- Delete by administrators and operators, with an event.

### Duplicate detection and repeated applications (EV-026)

- When a candidate is added, the service checks the company's candidates: the same ID number; or any two of email
  (case-insensitive), name (normalised spacing and case) and mobile (digits only). One matching item is not a
  duplicate.
- A caller who may not read the matching candidate learns only that a possible duplicate exists ("ask an HR
  administrator"); no name, contact or job is disclosed. An administrator sees the matches and may add the new
  application to the existing candidate instead, or confirm creating a separate candidate.
- Repeated applications: a company setting, on by default with 3 months (choices: off, 1, 3, 6, 12 months). A new
  application by the same candidate to the same job while an earlier one is active, or archived within the window,
  is refused. Different jobs are allowed.
- No automatic or manual merge in this slice (D-014).

### Tags (EV-029)

- Company tag groups and manual tags (unique name within a group; enable or disable). Administrators manage them.
  Administrators and operators add or remove tags on candidates; hiring managers see a candidate's tags;
  interviewers do not. Filter the Candidates board and the talent pool by tag. A disabled tag stays on candidates
  but is no longer offered.
- No smart tags (D-015): the reference's inferred tags ("job hopping", "employment gap") are automated profiling of
  candidates; they are not built.

### Consent, retention and destruction (EV-030)

- Consent record per candidate, entered by a person (no candidate portal yet): status (not recorded, consented,
  withdrawn), date, method (written form, email, online form, recorded verbally), notice reference and who recorded
  it. History is kept. Candidate pages show "No consent recorded" or "Consent withdrawn" to administrators and
  operators.
- Retention settings per company (D-016): months kept without consent (default 6) and with consent (default 24).
  The clock starts at the candidate's latest archival date, or at the consent date if later; withdrawal restarts it
  as "without consent" from the withdrawal date. A candidate with an active application is never due. A candidate
  with a hired application is excluded (the employee record takes over). Dates come from the repository's HR date
  owner (Asia/Kuala_Lumpur).
- Due candidates are marked "Retention period ended" and listed for administrators (Settings › Privacy). Nothing is
  destroyed automatically.
- Destruction: an administrator selects due candidates and confirms. It removes the candidate's personal data:
  name replaced by a neutral label, contact details, restricted values, profile entries, files, tags, consent
  details, scorecard notes and overviews and rejection comments on their applications, and their offer values. The
  application skeleton (job, stages, dates, state, archive reason) stays so counts do not change. One event records
  the destruction without personal data. Refused for a candidate with an active or hired application. Personal
  data in earlier event payloads must already be absent (verify; redact if not).

### Slice 5 acceptance cases

19. Profile and restricted fields: an operator edits the profile and salary; the hiring manager, an interviewer, an
    approver and another company's partner cannot read the restricted values through the service or the table.
20. Files: allowed type and size only; the permission confirmation is required; an interviewer of the application
    downloads the resume but not other attachments; a bystander gets nothing; each download appends an event with
    no file name or bytes.
21. Duplicates: ID number match and two-of-three contact match are found, one-of-three is not; an operator without
    access to the match learns only that one exists; an administrator sees it and adds the application to the
    existing candidate.
22. Repeated applications: same job within the window refused (active or recently archived); after the window or
    with the setting off, allowed; another job allowed.
23. Tags: administrators manage groups and tags; operators tag; hiring managers see; interviewers do not; filters
    return the tagged candidates; a disabled tag is kept on candidates but not offered.
24. Consent: recorded and withdrawn by people with history kept; the due date moves as specified.
25. Retention: due dates from fixed dates through the HR date owner; active applications never due; hired excluded;
    the due list and marker show only due candidates, to administrators only.
26. Destruction: administrator only, explicit confirmation, refused for active or hired; afterwards no sentinel
    personal value remains in any recruitment table (including files, scorecards, offer values and events); stage
    and pipeline counts are unchanged; the event carries no personal data.
27. Every new table has forced RLS, grants to the app role and none to PUBLIC; the AI Centre recruitment read still
    returns counts only.

## Slice 6 — Recruitment reports (owner: "continue the next one", 2026-11-10; EV-032…EV-034)

Scope: a Reports tab with four fixed dashboards computed by deterministic SQL aggregation in the pack. No report
designer, template library or custom data sources (D-017). Nothing calls a model. Reports show counts, rates and
durations only — never a candidate's name, contact or any restricted value. One migration only if indexes are needed
(next free number after a fresh peer survey).

### Access (EV-034: role-scoped data sources)

- Recruitment administrators and Recruiting Partners: every company they administer.
- Recruiters, assistants and hiring managers: the same dashboards restricted to the jobs they are on (Overview,
  Positions, Interviews). The Team dashboard is for administrators only (D-018).
- Interviewers and everyone else: no Reports tab; the service refuses.
- Enforced by the existing row security and job predicates; the service never widens a query beyond what the caller
  may read.

### Filters

Company, job (any of the caller's), department, and a period (from, to; Kuala Lumpur calendar days through the HR date
owner; at most 24 months; default the last 3 months). A period filters by the application's creation date unless a
measure says otherwise. Trends bucket by Monday-start week for periods up to 13 weeks, otherwise by calendar month.

### Dashboards

1. **Overview** (EV-033 Overview): applications in the period; offers created; offers sent; hired; now at Onboarding;
   requisitions in the period and their completion rate (filled vacancies ÷ total vacancies, from the slice 4
   figures); application trend; current active applications by stage; per-job progress (applications, interviews,
   offers, hired against vacancies when a requisition is linked); applications by source (slice 5 source field).
2. **Positions** (EV-033 Position): one row per job — applications, interviewed, offers created, offers sent, hired,
   rejected; applications per hire; offer acceptance rate (accepted ÷ decided); average days from application to hire;
   stage funnel (applications that ever reached each stage of the job's process, from the application history).
3. **Interviews** (EV-033 Interview analysis): interviews held (past, not cancelled) with change against the previous
   period of equal length; feedback rate (submitted scorecards ÷ interviewer places on held interviews); pending
   feedback; upcoming interviews; result distribution (recommended, keep in view, not suitable); interview pass rate
   (interviewed applications that later moved past the interview's stage or were hired ÷ interviewed applications
   with an outcome).
4. **Team** (EV-033 HR's efficiency; administrators only): per job recruiter — applications moved out of the first
   stage, interviews scheduled, offers created, hires. Counts of work done, not a rating of people (D-018).

Rules: a rate with a zero denominator shows "—", never 0 or an error. Durations are whole days in Kuala Lumpur
calendar days. Removed candidates (slice 5) still count, anonymously. Not built: gender distribution (gender is not
collected, D-013), candidate satisfaction (no survey exists), headhunter and referral dashboards (channels not built),
export (D-019).

Performance (owner scale bar): each dashboard is a bounded number of aggregate queries in one read-only snapshot
transaction with a local statement timeout; indexes support (tenant, company, created date) and stage-history scans;
per-job tables are limited to the 100 jobs with the most applications in the period, with a "showing 100 of N" note.
A slow report must never block writes.

### Slice 6 acceptance cases

28. Access: administrators see their companies; a partner only theirs; a recruiter or hiring manager only their jobs'
    figures; interviewers and bystanders get no tab and a refusal; no candidate name, email, phone or restricted value
    appears in any report result (sentinel check).
29. Overview figures equal independent SQL counts on a fixture with fixed dates, including period edges at Kuala
    Lumpur midnight.
30. Positions: applications per hire, acceptance rate and average days to hire match hand-computed values; zero
    denominators show "—".
31. Funnel counts applications that reached each stage even when later archived, from the application history.
32. Interviews: feedback rate, pending feedback, result distribution, pass rate and the previous-period change match
    hand-computed values; cancelled interviews are excluded.
33. Team dashboard: administrators only; per-recruiter counts match.
34. Periods over 24 months are refused; trends bucket correctly across month and week boundaries; removed candidates
    are counted without any personal data; every query runs read-only.
