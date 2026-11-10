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
