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

## Slice 7 — Employee referrals (owner choice 2026-11-11; EV-031, EV-035…EV-038)

Moka verifies referrers by company e-mail domain or mobile code and runs a separate referral website (EV-035,
EV-036). AI HR already knows who its employees are, so the referrer is the signed-in user and the portal lives in the
employee's own area. Rewards, notifications, posters and sharing links are not built (D-021, D-022).

### Actors and access

- Referrer (D): a signed-in user whose person has an **active employment** in a company where Recruitment is enabled.
  Active uses the repository's employment rule: not voided or blacklisted, started on or before today (Kuala Lumpur),
  and not ended (the earliest of resignation, last working date and termination). "Enabled" is the same tenant-wide
  Recruitment grant the HR pages require, so a referral can never land where no HR user can see it. Nothing else is needed: no e-mail-domain list or mobile code (EV-035 replaced by the employment record, D-020).
- Recruitment administrators and the job's operating team (slice 2) see who referred an application. Reviewers and
  interviewers see that it is an employee referral, with the referrer's name, like any other source (EV-036 shows the
  referrer on the recruiter-facing records page).
- A referrer never gains any other Recruitment access by referring: they cannot open the application, the candidate,
  the job record or any HR page.

### Job visibility on the portal (EV-037)

- O: each job has "Displayed on referral portal" in its sourcing channels.
- D: a job setting **Show on the referral portal**, default off, changed only by a recruitment administrator for the
  job's company (service and database). The portal lists a job only while it is Open (not On hold or Closed) and the
  setting is on.
- The portal shows, per job: title, job number, company, work location, employment type, recruitment type, job level
  and the job description text if recorded. Never: salary, hiring team, application counts, requisition details.

### Referring a candidate (EV-038)

- Fields: candidate full name (required); e-mail and mobile (at least one required); resume file (optional, same type
  and size rules as slice 5); referral reason (required, at most 1,000 characters); a required confirmation that the
  candidate agreed to be referred and to be contacted by HR (stored with the referral as the time it was given).
- On success: a candidate and an application at the job's first enabled stage, source "Employee referral", and a
  referral record (referrer person and user, job, application, reason, confirmation time, created time) in one
  transaction, audited. The slice 5 duplicate check runs as for any new application and may flag it for HR. The
  candidate's consent status stays "not recorded" until HR records it (slice 5).
- Refused (one generic message to the referrer, the specific reason in the audit event for HR, D-023):
  - the job is not Open or not on the portal, or the company does not have Recruitment, or the referrer has no active
    employment there;
  - the candidate (matched on normalised e-mail or mobile, as in slice 5) already has an application for this job
    that is not archived ("similar application in the system");
  - within the company's **referral protection period** another employee referred the same candidate (any job in the
    company): the first referrer keeps the credit ("already referred internally"). The period is a per-company
    setting, default 180 days (EV-031, EV-035), 0 switches it off. The same referrer may refer the same person to a
    different job;
  - the referrer has made 20 referral attempts today, accepted or refused (Kuala Lumpur date): a stop against mass
    entry and against using refusals to probe who has applied (D-023, D-024).
- Concurrency: two referrals of the same person at the same time result in exactly one accepted (lock on company and
  normalised identity).

### My referrals (EV-036 "recommend records", EV-038 "No referral history")

- The referrer sees only their own referrals: candidate name as entered, job title, referral date, and a coarse
  status derived from the application: In review (screening stages), Interviewing, Offer, Hired, Not progressing
  (archived). Never: stage names, rejection reasons, interview times, scores, feedback or offer terms.
- If the candidate was removed under slice 5 retention or a removal request, the row keeps only job and date and
  reads "Removed"; the referral record holds no personal data of its own beyond what the candidate record holds.

### Settings

- Per company, administrators: referral protection period in days (0–730, default 180).

### Slice 7 acceptance cases

35. The portal lists exactly the Open jobs with the portal setting on, in the companies where the user has an active
    employment and Recruitment is enabled; nothing for a user without one; another company's or tenant's jobs never.
36. Only a recruitment administrator can change a job's portal setting (service refusal and direct-database refusal).
37. A referral creates the candidate, the application at the first enabled stage with source "Employee referral", and
    the referral record, in one transaction with an audit event; the referrer cannot read any of those rows directly.
38. Missing name, missing both e-mail and mobile, missing reason, a reason over 1,000 characters, a missing
    confirmation or a bad file are refused by the service; a closed, on-hold or hidden job is refused by the database.
39. An active application for the same job refuses the referral with the generic message; the audit event names the
    reason; nothing is created.
40. Another employee's referral within the protection period refuses; after the period, or with the period set to 0,
    it is accepted; the same referrer may refer the same person to a second job.
41. Two concurrent referrals of the same person: exactly one is accepted.
42. The 21st referral attempt on one Kuala Lumpur day (refused attempts included) is refused, with the day boundary at
    Kuala Lumpur midnight.
43. My referrals shows only the user's own rows with the coarse status; no reason, stage name, score or offer field is
    in the page data (sentinel check); a removed candidate shows "Removed".
44. HR sees "Employee referral" and the referrer on the application; a company without Recruitment hides the portal
    and refuses the submission.
45. Slice 5 removal deletes the referral's personal data with the candidate and leaves no orphan rows.

## Slice 8 — Careers page and online applications (owner choice 2026-11-11; EV-039…EV-046)

Moka runs one or more designed career websites per tenant (`/apply/<org>/<site>`), lists the published jobs with
search and filters, and makes an applicant sign in with an e-mail one-time code before the application form
(EV-039…EV-043). AI HR builds one plain careers page per company in the AI HR look, with a short application form and
no applicant accounts. It is the first page of Recruitment that people who are not signed in can open, so everything
public goes through narrow definer functions and returns only the fields listed here.

### Actors and access

- Visitor (anonymous): anyone on the internet. Reads the careers page and job pages of a company whose page is
  published; submits applications. No session, cookie or account is created (D-026). They never read any other row.
- Recruitment administrators of the company: publish or withdraw the page and edit its content and privacy notice;
  turn "Show on careers page" on or off per job (service and database, like slice 7's portal flag).
- The job's operating team and reviewers: see the resulting applications like any other, with source "Careers page"
  and the consent the applicant gave.

### Publishing (EV-039, EV-044, EV-045)

- O: the tenant has career websites (list with name, Default tag, enabled filter, Create, Rename, Copy), a system
  channel per website on the Sources page, and per job "Career page — Displayed on experienced hires website" with
  the websites listed and Add.
- D (D-025): one careers page per company. Company settings (administrators): Published (default off); address
  (`/careers/<address>`, 3–40 lowercase letters, digits and hyphens, not starting or ending with a hyphen, unique in
  the installation); display name (required, ≤120); headline (≤160); introduction (plain text, ≤4,000); privacy
  notice (plain text, required to publish, ≤20,000). The page cannot be published without an address, a display
  name and a privacy notice. Changing the privacy notice text creates a new numbered version; earlier versions are
  kept unchanged so HR can show what an applicant agreed to.
- Per job: **Show on careers page**, default off, changed only by a recruitment administrator of the job's company
  (service refusal and direct-database refusal). A job is public only while the company page is published, the job is
  Open and the flag is on. Otherwise every public URL for it returns the same Not found page.
- No page designer, images, custom HTML, multiple sites, job-board posting, posters or QR codes (D-025).

### Public pages (EV-040…EV-042)

- `/careers/<address>`: display name, headline, introduction, then the job list. Search by job title keyword; filter
  by work location and employment type; count of results; 30 jobs per page with page links. Each job: title, job
  number, employment type, work location, date it was put on the careers page ("Posted on", Kuala Lumpur date),
  link to the job. Newest first.
- `/careers/<address>/jobs/<jobId>`: breadcrumb (careers page / job), title, job number, employment type, work
  location, posted date, the job description as plain text with line breaks, and the application form. "Copy link"
  copies the page URL. No referral sharing (D-022).
- Never shown: salary, hiring team, department head, application counts, requisition, stage or process data,
  internal notes, any candidate data.
- Language: the visitor chooses among the six AI HR locales (`?lang=`, default from `Accept-Language`, else en); the
  company's own text is shown as entered.
- No cookies are set, so there is no cookie banner (the reference's banner covers its own tracking cookies). Pages
  send `x-robots-tag: noindex` until the owner decides on search indexing (D-028). Responses carry a restrictive
  content security policy; nothing from another origin is loaded.
- An unknown address, an unpublished page, or a hidden, closed or other-company job all return the same Not found
  page with no detail.

### Applying (EV-043; slice 5 rules)

- O: "Apply now" opens an e-mail + verification code sign-in; the first sign-in creates an applicant account; the
  applicant agrees to the vendor's privacy policy. The application form itself was not observed (no account was
  created).
- D (D-026): no applicant account and no e-mail code. The form is plain HTML (works without JavaScript) and posts to
  a route handler:
  - full name (required, ≤120), e-mail (required, valid), mobile (optional, 7–20 digits after removing spaces, `+`,
    `-`, brackets), résumé (optional; slice 5 types and 10 MB limit, type read from the bytes), a short message
    (optional, ≤1,000);
  - a required tick: "I have read the privacy notice and agree that <display name> may use my details for
    recruitment", with the current notice shown on the page or one click away;
  - an invisible honeypot field; a filled honeypot is treated as accepted and stores nothing.
- On success, in one transaction: a candidate, an application at the job's first enabled stage with source
  "Careers page", the résumé as a slice 5 file (permission confirmation recorded as given by the applicant), a slice 5
  consent record (consented, method "online form", the notice version, the date), and an audit event without
  personal data. The slice 5 duplicate check runs and may flag the candidate for HR; a public submission is never
  attached to an existing candidate automatically (an unverified e-mail must not write into someone's record).
- Refusals and limits (D-027): every well-formed submission gets the same "Thank you, your application was received"
  page, including when nothing is stored because the slice 5 repeated-application rule matches (same normalised
  e-mail, same job, active or archived within the window) or the honeypot is filled. The audit event records the
  reason for HR. Missing or invalid fields return the form with field messages (these depend only on what was typed).
  Too many submissions return "Too many applications from this connection. Try again later." (HTTP 429):
  - at most 5 submissions per hour from one client address (stored only as a keyed hash, kept 2 days). The address
    comes only from the installation's verified ingress header; without that step the form returns "Online
    applications are not available right now" and stores nothing (local development excepted);
  - at most 300 accepted submissions per company per Kuala Lumpur day; beyond that, "This page is not accepting
    applications right now. Try again later." Both limits are fixed in this slice (D-027).
  - the request body is refused above 11 MB before it is read.
- A job that stops being public between viewing and submitting returns Not found and stores nothing.
- No confirmation e-mail to the applicant and no notification to HR (D-029). New applications appear on the
  Candidates board like any other.

### HR pages

- Settings › Careers page (administrators): the fields above, a Publish switch that explains what is missing, "Open
  careers page" link, and the privacy notice version history (version, date, who changed it; text viewable).
- Position page: "Show on careers page" switch (administrators), the public link while the job is public.
- Application page: source "Careers page"; consent shows "Online form, careers page notice version N, <date>".

### Data

- One migration in the recruitment block (4408, renumbered with 4400–4407 before any merge): company careers settings
  columns, a notice version table, the job flag and its posted date with a guard trigger, a private attempt table,
  and definer functions for the public reads and the submission. Forced RLS and explicit grants on new tables; none to
  PUBLIC. The public functions take the address and job id only and return only the listed fields.
- The AI Centre recruitment read stays counts only.

### Slice 8 acceptance cases

46. An unpublished page, an unknown address, a closed or on-hold job, a job with the flag off and another company's
    job each return the same Not found page; the published page lists exactly the Open, flagged jobs of that company.
47. Publishing is refused without an address, display name and privacy notice; the address format and installation
    uniqueness are enforced; only a recruitment administrator of the company can change the settings or a job's flag
    (service refusal and direct-database refusal).
48. Public page data contains no salary, team, count, stage or candidate field (sentinel values set on the job and on
    existing applications are absent from the HTML).
49. Search, location and employment-type filters and paging return the expected jobs in posted-date order, checked
    against an independently computed list.
50. A valid submission creates exactly one candidate, one application at the first enabled stage with source
    "Careers page", the résumé file, the consent record with the current notice version, and one event without
    personal data, in one transaction; nothing is attached to an existing candidate with the same e-mail.
51. Invalid input (missing name, bad e-mail, bad mobile, message too long, no consent tick, bad file type, file over
    10 MB) stores nothing and returns field messages; a body over 11 MB is refused before parsing.
52. A repeated application within the window and a filled honeypot each return the same thank-you page and store no
    candidate; the audit event names the reason.
53. The 6th submission in an hour from one client address returns 429; the 301st accepted submission on a Kuala Lumpur
    day for a company is refused, with the day boundary at Kuala Lumpur midnight; no raw client address is stored.
54. Two concurrent submissions with the same e-mail to the same job: exactly one is stored.
55. Changing the privacy notice creates version N+1 and keeps version N unchanged; a submission records the version
    shown.
56. The public routes work signed out under each authentication provider branch of the middleware and set no cookie;
    every other route still requires sign-in.
57. Slice 5 removal of a careers applicant leaves no personal data, including in the attempt table and events.
58. Rendered: the careers page, a job page, the form with field errors, the thank-you page and the 429 page in a
    signed-out browser; the HR settings and job switch as an administrator; the application page showing the source
    and consent.

## Slice 9 — Recruitment tasks and updates (owner choice 2026-11-11; EV-007, EV-047)

Moka's dashboard has a Tasks panel of notifications in seven tabs (@Reminder, Job Requisitions, Jobs, Interviews,
Offers, Referrals, Other), each with its own filters, unread badges, "All marked as read" and items such as
"<person> initiates approval for the job requisition named <title>. You are still looking forward to approval" and
"Candidate <name> accepted the offer" (EV-047). AI HR already has a bell with notifications and "open tasks", and
modules add live to-dos to it (`PACK_TASK_SOURCES` in core/approvals-inbox.ts). AI HR's notification engine stores
frozen title and body text; candidate names frozen there would survive slice 5 removal. So this slice builds
**live** items computed from current recruitment records under the viewer's current access, and stores only a
per-user "read up to" time per category (D-031).

### To do (things waiting for the viewer's action)

Computed live; an item disappears as soon as the action is done or the viewer loses access. Each links to the page
where the viewer acts.
- Requisition approvals at the viewer's current step (slice 4).
- Offer approvals at the viewer's current step (slice 3). Approval to-dos are tenant-wide, like the Approvals page,
  and do not follow the company switcher.
- Interview feedback due: interviews where the viewer is an interviewer, the interview has started (Kuala Lumpur time
  through lib/hr-date), it is not cancelled, the candidate has not declined it, and the viewer has not submitted a
  scorecard (slice 2).
- Interviews to schedule: for the job's recruiter and assistants (slice 2 team), applications in an Interview-type
  stage with no upcoming or completed interview in that stage. One item per job with a count, not one per candidate.
- Applications to screen: for the job's recruiter and assistants, applications in the job's first enabled stage that
  have not moved since they arrived. One item per job with a count ("3 new applications to screen"), any source,
  including careers page and employee referrals.
- Interviews to schedule and applications to screen come only from jobs that are Open or On hold; closed jobs give
  no to-dos.
- To-dos join the AI HR bell through a recruitment entry in `PACK_TASK_SOURCES` (kinds and bell labels in the
  registry), gated by the Recruitment module and the viewer's Recruitment access. The item text names the job or
  requisition; for interview feedback and offer approvals it names the candidate as the HR pages already show it to
  that viewer, read live (a removed candidate shows the neutral label).

### Updates (things that happened, with unread counts)

Derived live from recruitment records and their history; nothing is copied. Categories and what each shows to whom:
- Requisitions: for the requisition's requester — approved, denied (slice 4).
- Offers: for the offer's creator and the job's recruiter — offer approved, approval denied, candidate accepted,
  candidate declined (slice 3).
- Interviews: for the job's recruiter and assistants — feedback submitted on an interview of their job.
- Applications: for the job's recruiter and assistants — new application from the careers page (slice 8) or an
  employee referral (slice 7). Never shows the referral reason or the applicant's message.
- Each update: what happened, the job or requisition, the candidate as the viewer may see them, and when (Kuala
  Lumpur time), linking to the record. Only updates from the last 90 days are shown, newest first, 20 per page.
- Unread: an update is unread when it happened after the viewer's "read up to" time for its category (default: the
  first time the viewer opens the panel, so a new user does not start with a backlog). "Mark all as read" sets the
  time for one category or for all. Opening an item does not change the read state (D-032).
- Updates caused by the viewer themselves are not shown.

### Where it appears

- Recruitment › Overview: a Tasks panel beside the existing tiles, with tabs To do, Requisitions, Offers, Interviews,
  Applications; badge counts; "Mark all as read". It respects the Overview's company selection.
- The AI HR bell and the My tasks page: only the viewer's personal to-dos (approvals at their step and interview
  feedback due), through the pack task source, so the My tasks badge and the page agree. The per-job counts
  (applications to screen, interviews to schedule) appear only in the Overview's To do tab, which loads them
  separately so the rest of the page never waits for them (D-035). Home and the mobile app are unchanged until the
  owner decides (D-034). Updates are not pushed to the bell or e-mail
  (D-029 stays open for e-mail).
- Not built (D-033): @mentions and follow-up reminders, agency contract expiry, assessment reports, probation and
  work-trial reminders, candidate satisfaction surveys, self-scheduling, message records — their features do not
  exist in AI HR yet.

### Data

- One migration (4409, in the unapplied block): a per-user, per-company, per-category read marker table
  (tenant, company, user, category, read_up_to) with forced RLS so a user reads and writes only their own rows, and
  any indexes the live queries need. No other new table; nothing stores candidate data.
- The AI Centre recruitment read stays counts only.

### Slice 9 acceptance cases

59. To do lists exactly the viewer's pending requisition and offer approval steps, due interview feedback, jobs with
    applications to schedule and to screen (with counts), checked against independently computed sets; an item
    disappears after the action and when the viewer loses access to the job.
60. A viewer never sees a to-do or update for a job, requisition, offer or company they cannot read on the HR pages
    (bystander, interviewer of another job, another company's recruiter, another tenant).
61. Interview feedback becomes due at the interview's start in Kuala Lumpur time and not before; cancelled
    interviews and submitted scorecards produce no item.
62. Updates show the specified events to the specified people, exclude the viewer's own actions, never include the
    referral reason, the applicant's message, salary or scores (sentinel check), and show the neutral label for a
    removed candidate with no personal data.
63. Unread counts per category follow the read-up-to times; "Mark all as read" for one category leaves the others;
    a user can neither read nor change another user's markers (service and direct database).
64. The bell shows the recruitment to-dos with working links only for users with Recruitment access and only while
    the module is enabled; the existing bell items and counts are unchanged otherwise.
65. Rendered: the Overview Tasks panel for a recruiter, an interviewer and an approver; the bell with recruitment
    items; Mark all as read.

## Slice 10 — Agencies and headhunters (owner choice 2026-11-11; EV-031, EV-045, EV-048…EV-051)

Moka keeps headhunter and RPO contracts with agency companies, gives agency consultants their own login to a
headhunter platform where they submit candidates to the jobs released to them, checks each submission for
duplicates, lets HR accept or reject it, and protects the submitting channel's credit for a period (EV-048…EV-051).
AI HR builds the HR side only: agencies, contracts, consultants as contact records, which jobs each contract may
work on, and submissions **recorded by HR** on the agency's behalf, with the duplicate and protection rules. There
is no agency login, platform, e-mail or invitation (D-036).

### Actors and access

- Recruitment administrators of a company: manage agencies, tags, contracts, consultants and job assignments; see
  fee rates and contract files; accept or reject submissions waiting for review.
- The job's recruiter and assistants (slice 2): record a submission for their job from a contract assigned to the
  job; see the agency, contract name and consultant on the application.
- Hiring managers, interviewers and approvers see the application's source "Agency" and the agency name only.
- Nobody else sees agency data. Fee rate and contract file are for administrators only (service and database).

### Agencies, tags and contracts (EV-048, EV-049)

- Agency (per company): name (required, unique in the company, ≤120), tags (company list of agency tags, managed by
  administrators; a tag in use can be disabled, not deleted).
- Contract (per agency): name (required, ≤120; distinguishes several contracts with one agency), type (Headhunter or
  RPO), status (Enabled or Disabled), fee rate in percent (0–100, two decimals; shown, never calculated into an
  amount, D-037), contract period (start and end dates, end on or after start), contract file (optional PDF, slice 5
  file rules), HR contact (a user with Recruitment access in the company), access (Public: every recruiter of the
  company may use it; Restricted: only the listed users), protection period override in days (optional, 0–730).
- Consultants (per contract): name (required), e-mail, mobile, status (Active or Disabled). They are contact records,
  not users; no login and no message is sent.
- A contract is **usable** on a date when it is Enabled and the date is within its period (Kuala Lumpur dates through
  lib/hr-date).
- Contract list (administrators): filters by agency name, tag, type and status; columns contract name, agency, tags,
  consultants (active count), rate, status, period. Contract page: details, consultants, and Positions with per-job
  counts: submitted, accepted, interviewed, offered, hired (derived live, slice 6 rules).
- Expiry to-do (EV-047 "Agency contract expiration reminder"): the contract's HR contact gets a personal to-do in the
  bell and Overview (slice 9 pack task source) from 30 days before the end date until the end date, while Enabled.

### Jobs released to agencies (EV-045 "Post to agency/RPO")

- On the job's sourcing settings, administrators and the job's recruiter assign contracts usable today (Public, or
  Restricted with the actor listed) and may add requirements text for agencies (≤2,000). Removing an assignment stops
  new submissions; existing ones stay.

### Recording a submission (EV-049 "Headhunter referral field"; slice 5 rules)

- From the job's Candidates board ("Add agency submission"): contract (assigned to the job and usable today),
  consultant (active, of that contract), candidate full name (required), e-mail and mobile (at least one), ID number
  (optional, slice 5 restricted value), current and expected salary (optional, slice 5 restricted values), résumé
  (optional, slice 5 file rules, with the permission confirmation), agency comments (optional, ≤2,000; shown to
  administrators and the job's operators only), submission date (default today, not in the future, not before the
  contract start).
- Duplicate check, run in the service and enforced in the database:
  - **Duplicate**: the same ID number, or the same normalised name plus the same e-mail, or the same normalised name
    plus the same mobile (EV-050 "simple checking") as a candidate who already has an application in the company.
  - **Suspected**: any two of name, e-mail and mobile match but not as above (slice 5 rule).
  - **New**: neither.
- Protection (EV-031, EV-051): an existing application protects its channel's credit for a period counted from its
  application date: agency or RPO 365 days unless its contract overrides it, employee referral 180 days (slice 7
  setting), any other source 0 days. Archived applications protect too until the period ends.
- Outcome:
  - New: accepted at once (D-038): a candidate, an application at the job's first enabled stage with source
    "Agency", and the submission record (contract, consultant, submission date, comments, outcome) in one
    transaction, audited.
  - Duplicate inside another channel's protection: refused. The submission is kept as Refused with the reason
    "protected by an earlier application" so the agency's history is complete; no candidate or application is
    created. The recorder sees the reason without the earlier candidate's details unless they may read that candidate
    (slice 5 rule).
  - Duplicate outside any protection, or Suspected: stored as **Waiting for review** with the matches listed for
    administrators. An administrator accepts (the application is added to the existing candidate for a Duplicate, or
    a new candidate is created for Suspected, as the administrator chooses) or rejects with a reason. Recruiters see
    "waiting for an administrator".
- The same agency cannot submit the same person to the same job twice while an earlier submission is waiting,
  accepted and active, or inside the repeated-application window (slice 5).
- Concurrency: two submissions of the same person at the same time yield one outcome each in order, never two
  applications (lock on company and normalised identity, the same key as slices 7 and 8).
- At most 50 submission attempts per recorder per Kuala Lumpur day (accepted, waiting, refused and repeats all
  count), like slice 7's cap, so the protection answer cannot be used to probe who is in the company (D-039).
- The contract's HR contact must be a recruitment administrator of the company, and stops seeing the contract and
  its expiry to-do when they no longer are. A Restricted contract is usable only by the users listed on it,
  administrators included (administrators can list themselves). Protection is counted against today's Kuala Lumpur
  date, never the typed submission date.
- Accepting onto an existing candidate does not overwrite that candidate's profile or restricted values; the typed
  values stay on the submission and the résumé moves to the candidate's files.
- Personal data of Refused and Rejected submissions: an administrator can remove it (name, contacts, ID number,
  salaries, comments, held résumé; job, contract, consultant, dates and outcome stay). Decided submissions older than
  the company's slice 5 "months kept without consent" are listed in Settings › Privacy as due. Nothing is removed
  automatically. Slice 5 removal of a candidate clears the submission accepted onto them and any undecided
  submission whose only match was that candidate as a Duplicate (closing it as rejected if it was waiting); a
  Suspected match, or one of several matches, only loses its link, and another person's submission never changes.

### Where it shows

- Settings › Agencies (administrators): agencies, tags, contracts, consultants.
- Job sourcing settings: assigned contracts and requirements.
- Candidates board: "Add agency submission"; a Waiting for review list for administrators.
- Application page: source "Agency", agency, contract name, consultant, submission date, and comments for
  administrators and operators.
- Overview Tasks (slice 9): administrators get a personal to-do per submission waiting for review; the Applications
  updates tab includes accepted agency submissions for the job's recruiter and assistants.

### Data

- One migration in the recruitment block (4410): agency, agency tag, contract, contract user (restricted access),
  consultant, job assignment, and submission tables, with forced RLS, explicit grants, none to PUBLIC; fee rate and
  contract file readable by administrators only (column grants or a separate table); guards so only administrators
  change agencies and contracts; the submission path as a service under the actor's own access, using a definer
  function only for the duplicate and protection check across candidates the actor may not read, returning only the
  outcome and, for administrators, match ids. Slice 5 removal clears submission personal data (name, contacts,
  comments, ID number, salaries) with the candidate; company setup deletion covers the new tables.
- The AI Centre recruitment read stays counts only.

### Slice 10 acceptance cases

66. Only administrators manage agencies, tags, contracts and consultants (service and database); fee rate and
    contract file are invisible to recruiters, hiring managers and interviewers through the service and the tables.
67. Usability: a contract is offered and accepted only when Enabled and within its period on the Kuala Lumpur date,
    and only to permitted users when Restricted; assignment to a job and submission respect that.
68. A New submission creates the candidate, the application at the first enabled stage with source "Agency" and the
    submission in one transaction with an audit event.
69. Duplicate inside protection (agency 365 days, contract override, referral 180 days, archived application inside
    its period) is refused and stored as Refused with no candidate or application; outside protection it waits for
    review; the day boundaries use Kuala Lumpur dates.
70. Suspected waits for review; an administrator accepts (new candidate or existing candidate) or rejects with a
    reason; a recruiter cannot; the recruiter never sees the matched candidate's details without access.
71. Repeat submission of the same person to the same job by the same agency is refused while waiting, active, or
    inside the repeated-application window; two concurrent submissions give one application.
72. Contract positions counts and the expiry to-do (from 30 days before the end date to the end date, HR contact only)
    match independently computed values.
73. Slice 5 removal leaves no personal data in submissions; company setup deletion removes every new table's rows;
    every new table has forced RLS and grants with none to PUBLIC; the AI Centre read is counts only.
74. Rendered: settings (agency, contract, consultant), job assignment, recording New, Duplicate-protected and
    Suspected submissions, the review list and accept/reject, the application page, the expiry to-do.

## Slice 11 — Resume screening by hiring managers (owner choice 2026-11-11; EV-013, EV-052…EV-054)

Moka lets a recruiter "Assign to hiring manager" (one or more applications; reviewers default to the job's hiring
manager; notes; what to share; the button also moves the application to the next stage), shows each card's
assignment status, filters the stage by Not assigned / Awaiting feedback / Latest feedback is positive / Latest
feedback is negative, and has a screening evaluation form whose default question is single choice Advance, Reject or
Pending (EV-052…EV-054). AI HR builds the same request-and-feedback loop on its existing job teams.

### Actors and access

- The job's recruiter and assistants, and recruitment administrators: assign, reassign and withdraw screening
  requests; see every request and answer on the job.
- Reviewers: the job's hiring managers (slice 2 team role). A request names one or more of them. A reviewer sees the
  requests addressed to them and gives feedback; they already read the job's applications and résumés (slices 2, 5).
- Other hiring managers of the job see the answers on the application, like scorecards (slice 2). Interviewers,
  approvers and anyone else see nothing of screening.

### Assigning (EV-053)

- From the Candidates board (one card or several selected in the same job) or the application page: "Send to hiring
  manager". Choose reviewers among the job's hiring managers (default: all of them), add a note (optional, ≤1,000),
  and optionally move the applications to a later stage at the same time (offered: the next enabled stage of the
  job's process; default on, as in the reference). Archived or hired applications cannot be sent.
- A reviewer who already has an open request on the application is not asked twice. "Reassign" adds reviewers;
  "Withdraw" closes an open request without an answer.

### Feedback (EV-054)

- One company screening form: the result (Advance, Reject or Pending, required) and a comment (optional, ≤2,000). No
  custom forms or scored questions in this slice (D-040).
- A reviewer answers each open request once; Pending is an answer meaning "need more information" and the reviewer
  may later answer the same request again with Advance or Reject (history kept). Answers never move or reject the
  application by themselves: the recruiter acts on them (slice 1 moves).
- Assignment status of an application (derived, EV-052), in this order of precedence (D-042):
  1. Awaiting feedback — at least one request is open (no answer yet, or its latest answer is Pending);
  2. Positive or Negative — otherwise, the most recent final answer (Advance or Reject) from any reviewer;
  3. Not assigned — otherwise: never sent, or every request was withdrawn or closed without a final answer.
- Open requests close automatically, without an answer, when the application is archived or hired, or when the
  reviewer stops being a hiring manager of the job; they then leave the reviewer's To screen list, to-dos and counts.
- Sending with the move option moves only the applications that received at least one new request.

### Where it shows

- Candidates board: each card's assignment status for operators and administrators; a filter by assignment status
  with counts per stage; "Send to hiring manager" on cards and for a selection.
- Application page: a Screening section with each request (reviewer, sent by, sent at, note) and its answers
  (result, comment, time). Reviewers see only their own requests plus the answers of others on that application.
- Hiring manager: a "To screen" list of their open requests (job, candidate, sent at, note) with the feedback form.
- Tasks (slice 9): a personal to-do per open request for the reviewer ("Screen <candidate> for <job>"); an update in
  the Applications category for the job's recruiter and assistants when an answer arrives.

### Not built

- "To assign" résumés with no job (the reference's unassigned-résumé pool) — AI HR has no job-less applications.
- Long-unprocessed reminders and automatic archiving, scoring rules, smart tags (EV-052; D-015 stays).
- Sharing options (résumé file versus profile): reviewers already see both under slices 2 and 5.

### Data

- One migration in the recruitment block (4411): screening request (tenant, company, job, application, reviewer
  user, sent by, sent at, note, closed at, closed reason) and screening answer (request, result, comment, answered at,
  answered by) tables with forced RLS, explicit grants, none to PUBLIC; guards so only operators and administrators
  send, reassign and withdraw, only the named reviewer answers their own open request, and a reviewer must still be a
  hiring manager of the job when sending and answering. Slice 5 removal clears notes and comments; company setup
  deletion and the AI Centre read (counts only) cover the new tables.

### Slice 11 acceptance cases

75. Only operators and administrators send, reassign and withdraw (service and database); reviewers must be the job's
    hiring managers; archived and hired applications cannot be sent; the optional move goes to the next enabled stage
    in the same transaction.
76. Only the named reviewer answers their open request (service and database); Pending can be followed by Advance or
    Reject with history kept; a withdrawn request cannot be answered.
77. Assignment status for each application and the per-stage filter counts match independently computed values for
    Not assigned, Awaiting feedback, Positive and Negative, including several reviewers.
78. Visibility: operators and administrators see all requests and answers on the job; a reviewer sees their own
    requests and the answers on that application; interviewers, approvers, other jobs' teams, other companies and
    other tenants see nothing (service and direct database).
79. The reviewer's to-do appears while a request is open and disappears when answered or withdrawn; the recruiter's
    update appears when an answer arrives; neither carries the comment text.
80. Slice 5 removal clears notes and comments; company setup deletion covers the new tables; every new table has
    forced RLS and grants with none to PUBLIC; the AI Centre read is counts only.
81. Rendered: sending one and several cards with the move; the hiring manager's To screen list and feedback; the
    board filter and statuses; the application's Screening section; the to-do and update.

## Slice 12 — Background checks (owner: "build another slice", 2026-11-12; EV-023, EV-055, EV-056)

Moka connects background-check providers (none connected in the observed tenant) and otherwise lets HR add a
manual background check on the offer tab: a name, a free-text result and a report file up to 50 MB (EV-023, EV-055,
EV-056). Background-check reports can contain criminal-record, credit and other sensitive personal data. AI HR builds
the manual record only, with structured status and outcome, the candidate's authorisation recorded first, and the
report and details restricted to the people who run the check. There is no provider connection (D-043).

### Actors and access

- Recruitment administrators and the job's recruiter and assistants: manage the company's check types, record checks,
  read every detail, upload and download the report.
- Hiring managers of the job: see each check's type, status and outcome only — never the summary, provider reference
  or report (D-045).
- Interviewers, approvers, referrers and anyone else: nothing, including that a check exists.

### Check types (settings)

- Company list maintained by administrators: name (unique, ≤80), description (≤500), enabled. Defaults offered on
  first use: Employment history, Education, Professional licence, Identity, Criminal record, Credit. A type in use can
  be disabled, not deleted.

### Recording a check

- On an active application whose current stage is at or after the job's first Offer-type stage, or is the seeded
  Background check stage (identified by its fixed system key, not its editable name): "Add background
  check" with one or more enabled types, the provider (free text, ≤120, e.g. the external firm), and an optional
  provider reference (≤120).
- **Authorisation first** (D-044): a check starts as Awaiting authorisation. It moves to In progress only after the
  recorder confirms the candidate's written authorisation (date, method: signed form / e-mail / online form, and an
  optional authorisation file with slice 5 file rules). The authorisation is kept with the check.
- Status: Awaiting authorisation → In progress → Completed or Cancelled (with a reason). Completed needs an outcome:
  Clear, Concerns found, or Could not verify, an optional summary (≤2,000) and an optional report file (PDF or Word,
  10 MB, slice 5 type checks). Completed and Cancelled are final; a new check can be added.
- Every status change, upload and download appends an audit event with ids only — never the summary, outcome text,
  provider reference or file name.
- The offer approval and hire hand-off (slice 3) do not depend on checks in this slice; HR decides (D-046).

### Where it shows

- Application page: a Background checks section (operators and administrators see everything; hiring managers see
  type, status and outcome).
- Candidates board: a small status marker on cards for operators and administrators (In progress, Concerns found).
- Tasks (slice 9): a personal to-do for the recorder while a check they recorded waits for authorisation or has been
  In progress for more than 14 Kuala Lumpur days.
- Reports: counts by status on Reports › Overview, for administrators only. The AI Centre read is unchanged in this
  slice (D-047); never outcomes for a named candidate.
- Restricted with the summary and report: the provider name, provider reference, cancellation reason and the
  authorisation method and file. The card marker shows one state per card (Concerns found before In progress).
- Removing a candidate cancels their open checks with the reason "candidate removed" (stored without personal data)
  and deletes the restricted details and files.

### Privacy

- Slice 5 removal deletes the candidate's checks' summaries, references, authorisation files and reports and keeps
  only type, status, outcome category and dates on the anonymised application. Company setup deletion covers the new
  tables. Background-check data is never copied to the employee record at hire (D-046).

### Data

- One migration in the recruitment block (4412): check type, check, check-type link, and file side tables with
  forced RLS, explicit grants, none to PUBLIC; summary, provider reference and report bytes readable only by operators
  and administrators (separate table or column privileges); guards for the status machine, authorisation-first and
  who may write.

### Slice 12 acceptance cases

82. Only administrators manage check types; only operators and administrators record, change and read checks in full
    (service and database); hiring managers read type, status and outcome only; everyone else reads nothing.
83. A check cannot reach In progress without a recorded authorisation; Completed needs an outcome; Completed and
    Cancelled are final; checks only on active applications at or after Offer (or a background-check stage).
84. Summary, provider reference, authorisation file and report are absent for hiring managers, interviewers and others
    in service results, page data and direct database reads (sentinel check); downloads are audited without file names.
85. The recorder's to-do appears while awaiting authorisation and after 14 Kuala Lumpur days in progress, and not
    otherwise; the day boundary uses Kuala Lumpur dates.
86. Slice 5 removal leaves no summary, reference, file name or file bytes; company setup deletion covers the new
    tables; every new table has forced RLS and grants with none to PUBLIC; the AI Centre read is counts only.
87. Rendered: settings types; adding a check, recording authorisation, completing with an outcome and report; the
    hiring manager's restricted view; the card marker and to-do.

## Slice 13 — Talent pools and the blocked list (owner: "next slice", 2026-11-12; EV-025, EV-057…EV-059)

Moka keeps system pools (Public talent pool, Blocked list, Hired employee, Former employee, potential talent) and
HR-made pools with sub-pools, a description and sharing ("disclosed to all HRs by default; modify access in Share");
each candidate card in the talent pool names its pool, and an application's More menu has "Add to blocked list"
(EV-057…EV-059, EV-014 vocabulary). AI HR extends slice 4's single public pool with custom pools and a blocked list.

### Actors and access

- Recruitment administrators: create, edit, share and delete custom pools; add and remove blocked-list entries; see
  blocked-list reasons; clear blocked-list matches.
- The company's recruiters and assistants (operators of any job in the company): see the pools shared with them and
  add or remove candidates they can read; see that a candidate is on the blocked list or matches it, never the
  reason.
- Hiring managers and interviewers: no pools; on an application they can read, they see only "Needs an
  administrator's review" when it matches the blocked list.

### Custom pools (EV-057)

- Per company: name (unique among siblings, ≤80), description (≤500), parent (optional; at most two levels: pool
  and sub-pool), sharing: All recruiters (default) or Only listed users (administrators always see every pool).
- A candidate can be in any number of custom pools, with who added them and when. Adding works from the talent pool
  list, the candidate's application page and the Candidates board; removing from the same places. Deleting a pool
  removes its memberships, not the candidates; a pool with sub-pools cannot be deleted until they are.
- The slice 4 public pool is unchanged: rejected or archived applications still appear there.

### Talent pool page (EV-059)

- A pool list (Public talent pool for administrators, as in slice 4; custom pools with sub-pools; Blocked list for
  administrators and operators) with counts; choosing a pool filters the list. Cards add "Pools: …". Existing
  filters stay. A sub-pool follows its parent's sharing; listed users are set on top-level pools.

### Blocked list (D-049)

- Administrators add a candidate with a reason (required, ≤500; administrators only) and remove them with a reason.
  History is kept. The entry stores the candidate and the normalised identity values already on their record (ID
  number, e-mail, mobile, name), used only for matching.
- Effect: any of the candidate's active applications, and any new application from any channel (manual, careers
  page, employee referral, agency) whose candidate matches a blocked entry (same ID number; the same normalised name
  plus the same e-mail or mobile; or the same e-mail and the same mobile) is marked **Needs an administrator's
  review**. A new application of a candidate who already has an open mark on another application is marked too.
  While marked it cannot change stage (forward or back), receive or progress an offer, or be hired (service and
  database); it can still be rejected and an open offer withdrawn. Matching runs when an application is created and
  when an entry is added, not when an ID number is added to an existing candidate later. Public
  channels behave exactly as before towards the person (no different message), so the list cannot be probed.
- An administrator resolves a mark: "Not the same person" (clears it, and that candidate is not marked again for
  that entry) or "Remove from blocked list" (clears the entry and every mark from it). Resolutions are audited.
- A marked application can still be rejected, an open offer withdrawn, and a candidate's decline recorded.
- Slice 5 retention does not destroy a blocked candidate automatically; removal of a blocked candidate deletes the
  entry and its identity values, and is refused while that entry still holds an open mark on another candidate's
  active application (an administrator resolves those first, so no hold is lifted without a decision).

### Not built (D-048)

- Hired employee and Former employee pools (AI HR's employee records already hold them), the potential-talent pool,
  talent activation rules, online talent search and similar-candidate counts.

### Data

- One migration in the recruitment block (4413): pool, pool share, pool membership, blocked entry (with restricted
  reason and identity values in an administrator-only table), blocked history, and application review mark tables;
  forced RLS, explicit grants, none to PUBLIC; guards for the two-level tree, administrator-only blocked-list writes,
  and the move/offer/hire refusal while marked (added to the existing move, offer and hire guards); matching at
  application insert for every channel through the existing definer paths (careers, referrals, agencies, manual).
  Removal and company deletion restated from 4412 with the new steps.

### Slice 13 acceptance cases

88. Only administrators create, edit, share and delete pools; sharing to listed users hides the pool and its
    membership from others (service and database); two levels at most; deleting a pool keeps the candidates.
89. Operators add and remove candidates they can read to pools they can see; the talent pool list filters by pool
    with counts matching independently computed values.
90. Only administrators add and remove blocked entries and read reasons; operators see the flag without the reason;
    hiring managers and interviewers see only "Needs an administrator's review" on applications they can read.
91. Marking: the blocked candidate's active applications and new applications matching by ID number, or name plus
    e-mail or mobile, from manual entry, careers page, referral and agency are marked; one-field matches are not; a
    marked application cannot move, get an offer or be hired (service and database); public channels respond
    exactly as for an unmarked person.
92. "Not the same person" clears one mark; removing the entry clears all its marks; history and audit events carry no
    reason text or identity values.
93. Slice 5 removal deletes blocked entries and identity values; company deletion covers new tables; forced RLS and
    grants with none to PUBLIC; the AI Centre read is counts only and never reveals blocked status.
94. Rendered: pools with a sub-pool and sharing; adding candidates; filtering; blocking a candidate; a matching
    careers application marked and refused a move; resolving the mark.

## Slice 14 — Custom candidate and job fields (owner: group 1 "without pausing", 2026-11-12; EV-027, EV-060, EV-061)

Moka's candidate field management groups fields into sections (Upload, Personal info, Job preference, Work
experience, Education, Internship experience, Projects, Language proficiency, About me, Awards); each field has an
English and a Chinese name, a type (single line text, multiple lines text, single choice, multiple choice, date y/m/d,
date y/m, number, region single choice, file, image, résumé file) and a visibility permission, and "Create field"
adds custom ones; "allow viewing desensitised information" logs who unmasks a hidden value (EV-027, EV-060). Job fields
list each field's type, Required or Optional, whether a change needs review, and Enabled or Disabled, with
"Create field" (EV-061). AI HR adds company-defined custom fields for candidates and jobs on top of the fixed
profile and job form from slices 1 and 5.

### Actors and access

- Recruitment administrators: define, edit, order, enable and disable custom fields for their company.
- Whoever may edit a candidate profile (slice 5) or a job (slice 1) fills in that record's custom fields; whoever may
  read the record reads its custom values, except fields marked **Restricted**, which follow slice 5's restricted
  values rule (administrators and the candidate's job operators only).

### Field definitions

- Per company and per record kind (candidate, job): label in each of the six locales (English required, others
  optional and falling back to English), help text (≤200), type, required (yes or no), restricted (candidates only),
  enabled, position.
- Types: short text (≤200), long text (≤4,000), number (with optional minimum, maximum and decimals 0–4), date,
  year and month, single choice and multiple choice (options with labels per locale; an option in use can be
  disabled, not deleted), yes or no. File and image fields are not added: slice 5 files cover documents (D-051).
- A field's type cannot change once any record has a value; disabling hides it from forms and lists but keeps
  values. Deleting is allowed only for a field with no values.
- Candidate fields that would collect sensitive personal data are refused by label, help text and option for the
  categories slice 5 excludes (race, religion, health, pregnancy, criminal record, family details), with a plain
  explanation; this is a deterministic phrase list, not a model (D-052). Job fields are not checked. Restricted field
  definitions are visible only to administrators and operators.

### Filling and showing

- Candidate profile form (slice 5) and job form (slice 1) show the enabled custom fields after the fixed ones, in
  order, validated by type and required; values are stored typed (not as free text) per record and field.
- Candidates board and talent pool: an optional filter by one custom single-choice, multiple-choice or yes-or-no field
  per company; job list: same for jobs.
- Careers page (slice 8) and referral form (slice 7) do not ask custom candidate fields in this slice (D-053).
- Changes to values are audited with field ids only (restricted values never in events); slice 5 removal deletes all
  custom candidate values; company deletion covers definitions and values.

### Data

- One migration (next in the renumbered block): field definition, option, candidate value and job value tables with
  forced RLS, explicit grants, none to PUBLIC; restricted candidate values in a table readable as slice 5's restricted
  values; guards for type immutability once used, option deletion when used, required values on save done in the
  service (records created before a field became required stay valid until next edit).

### Slice 14 acceptance cases

95. Only administrators define fields (service and database); type changes are refused once a value exists;
    disabling hides from forms but keeps values; deleting is refused when values exist.
96. Values validate by type, range and options; required is enforced on save; multiple choice stores option ids.
97. Restricted candidate fields are readable only by administrators and the candidate's job operators (service,
    page data and direct database), never in events.
98. Filters by a choice field return exactly the matching candidates and jobs (independently computed).
99. Sensitive-category field names are refused with an explanation; locale fallbacks work.
100. Slice 5 removal deletes custom values; company deletion covers the new tables; forced RLS and grants with none to
     PUBLIC; the AI Centre read is unchanged.
101. Rendered: defining fields of several types; filling them on a candidate and a job; a restricted field hidden from
     a hiring manager; a filter.

## Slice 15 — Position templates (owner: group 1, 2026-11-12; EV-062)

Moka keeps position templates (template name, job title, associated functional types, department) used to create
requisitions and positions, and can auto-fill a title and description from an industry JD library (EV-062). AI HR adds
company position templates that pre-fill the new-position form; there is no industry JD library (D-054).

### Actors and access

- Recruitment administrators: create, edit, disable and delete templates for their company; turn the feature on or off
  for the company (Settings › Position templates).
- Anyone who may create a position in a company (slice 1) may start from that company's enabled templates. Templates
  hold no personal data.

### Template content

- Name (unique in the company, ≤120), job title, job description, work location, employment type, recruitment type,
  job levels, business unit and department (when the company uses them), the default recruitment process, the
  interview plan (rounds and scorecard templates, slice 2), and values for enabled custom job fields (slice 14).
  Every field is optional except the name and the title.
- A template is a starting point: "New position from template" opens the normal new-position form pre-filled; the
  user edits anything before saving, and every normal position rule applies on save. The position does not stay
  linked; later template edits never change existing positions. The position records which template it came from
  (for reporting), and that is all.
- Requisitions (slice 4): "Create job" from an approved requisition may also start from a template; requisition
  values (title, vacancies, department) win over the template's where both exist.
- A template whose process, levels, department, business unit, scorecard template or custom field option has since
  been disabled or removed still opens; the missing parts are left empty with a plain note.

### Data

- One migration: template and template custom-value tables (forced RLS, explicit grants, none to PUBLIC), a nullable
  `created_from_template_id` on job openings, a company setting for the feature; administrator-only writes in the
  database; company setup deletion covers the new tables (restated from the latest body plus steps).

### Slice 15 acceptance cases

102. Only administrators manage templates and the setting (service and database); users who may create positions see
     only their company's enabled templates; nobody else sees any.
103. "New position from template" pre-fills every stored field; saving creates a normal position validated by the
     normal rules; later template edits leave the position unchanged; the position records its template.
104. Disabled or removed references are left empty with a note, never copied; custom field values follow slice 14
     validation.
105. Requisition "Create job" with a template merges values with the requisition's winning.
106. Company setup deletion covers the new tables; forced RLS and grants with none to PUBLIC.
107. Rendered: creating a template; creating a position from it and editing before saving; a template with a disabled
     reference.
