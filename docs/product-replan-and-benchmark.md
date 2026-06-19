# AI-HR — Product Replan & Market Benchmark (2026)

Status: **Draft for owner decision.** Sources: consultant feedback workbook (round 2 — Yi Wei, Jess, Terrence, "TT"), owner offline feedback ("too generic/simple/incomplete; payroll workflow not fully developed; attendance not flexible enough"), and a 9-stream competitive benchmark vs Workday, BambooHR, HiBob, Rippling, Gusto, Deel and the MY/SEA set (Rymnet, BrioHR, Talenox, Swingvy, Kakitangan, PayrollPanda).

> **Do not redeploy until the prioritised tracks below are built.** This doc replans every module against best-in-market and sequences the work.

---

## 1. Strategic verdict

**AI-HR is a world-class Malaysian payroll *engine* wearing a thin HRMS surface.**

- **Genuine moat (ahead of every SEA incumbent):** full LHDN computerised PCB/MTD with prior-month accumulators (TP1/zakat, non-resident 30%, age rules), exact 2026 EPF/SOCSO/EIS bands, HRDF levy, EPF contribution modes, gated multi-cycle/off-cycle payroll, **signed/versioned statutory data-packs** (rate changes without redeploy, per-payslip provenance), append-only **DomainEvent audit substrate**, RLS multi-tenancy + multi-entity/concurrent-employment, and a **governed BYOK AI gateway** (PII-redacted, never-autonomous). No MY/SEA competitor matches the payroll exactness; no global player runs native MY statutory payroll.
- **The gap = the surface:** the engines are *correct but shallow on configurability, workflow and breadth*. That is the precise mechanism behind "too generic/simple/incomplete."

**Positioning:** sit between the payroll-purists (PayrollPanda/Kakitangan — shallow HR/analytics) and the global suites (Workday/HiBob/Rippling — expensive, no native MY payroll). Win by **out-localising on statutory depth + freshness + governed AI**, while **thickening the HRMS surface** to BrioHR/Rymnet-class breadth. Lead with "world-class MY payroll you can trust + the HR depth the locals lack."

---

## 2. Competitive landscape

| Vendor | Tier / region | Threat | What they teach us |
|---|---|---|---|
| **Rymnet** (≈ "Rhyment") | MY-first HRMS+payroll, talent+LMS+recruitment, AI chatbot+OCR; ~1,500 cos | **Direct, high** | The breadth target — talent/recruitment/e-learning/engagement + AI chatbot+OCR is the "depth" we lack |
| **BrioHR** | MY-HQ full-suite SEA mid-market | **Very high** | Closest to our ambition — out-execute on statutory exactness + governed AI + audit |
| **Talenox / Swingvy** | SEA SME HRIS+payroll | **High** | Clean UX + accounting export + mobile; we beat them on payroll edge-cases + analytics |
| **Kakitangan / PayrollPanda** | MY SME payroll | **High** | We already exceed payroll depth; must match **bank GIRO files** + **flexible attendance** |
| Workday / HiBob / Rippling / Gusto / Deel | Global | Low-med | Reference ceilings for analytics/talent/automation UX; don't chase breadth, out-localise |

**Where a MY-first challenger wins:** (1) own the statutory moat as the wedge; (2) sell compliance *freshness* (signed packs); (3) **close the attendance-flexibility gap** (the owner's weakness *and* the incumbents' weakness — PayrollPanda has no shifts/geo/biometric); (4) ship **bank GIRO files** (deal-blocker today); (5) differentiate on **governed AI + audit substrate**; (6) **thicken the HRMS surface** to neutralise "too generic."

---

## 3. Module-by-module replan

Format per module: **Today → Best-in-market target → Priority gaps → Replanned functions.**

### 3.1 Core HR & People  *(thin master record = #1 reason it "feels simple")*
- **Today:** ~8 free-text `person` fields; statutory IDs only in payroll-scoped `employeeStatutoryMy`; flat `position` (title+family); effective-dated assignments/reporting-lines (a real strength); CSV importer; org chart (a strength).
- **Target:** 30–50+ structured/validated master fields (gender, marital, nationality, race/religion for EA, photo, full statutory identity with IC/EPF/SOCSO format validation); **custom-fields/tables engine (no migration)**; **employee document vault** (folders, HR-vs-employee visibility, expiry alerts) + **e-signature**; **position management** (grades/bands, FTE/headcount, job descriptions, vacancies); **lifecycle as workflow** (probation→confirm with reminders, transfer/promotion/rehire actions); onboarding/offboarding checklists; profile-completeness + duplicate/expiry data-quality engine; foreign-worker/expat doc tracking.
- **Replanned functions:** `customField` engine · `employeeDocument` vault + e-sign · `jobGrade`/`salaryBand`/position-headcount · `probationReview`/`transfer`/`promotion`/`rehire` actions · `onboardingTask`/`offboardingTask` · profile-completeness score · expanded `person`/`employment` master schema with validators.

### 3.2 Payroll  *(owner: "not fully developed")*
- **Today:** correct engine (PCB accumulators, EPF modes, HRDF, multi-cycle gated, typed components gated, fail-closed on BIK); whole-company batch; on-screen payslip; neutral payment CSV; statutory config page.
- **Target:** **bank GIRO/IBG files** per MY bank (Maybank/CIMB/PB/RHB/HLB/Ambank/OCBC/BIMB); **verified agency upload files** (KWSP CSV, PERKESO ASSIST, LHDN e-PCB/CP39 non-draft); **payslip PDF** (branded template, YTD, multi-lang) + email + password; **ungate typed components** + support BIK/PCB-only (remove fail-closed); **pay calendars/cut-offs/payment-basis**; **batch-by-selection** (dept/group/individual); **multi-level payroll approval** (maker-checker) + **pre-finalise variance report**; recurring deductions w/ balance (loans/advances/CP38/PTPTN, priority); **final-pay settlement** engine (encashment auto-pay, notice pay, CP21/CP22A); **GL/journal export** + Xero/QuickBooks; payroll-history opening-balance import + YTD on payslip; per-component **rounding** + **EA-line mapping**; ungate multi-cycle (post sign-off) + foreign-worker Oct-2025 2%/2% EPF + exact EPF Third Schedule (#95).
- **Replanned functions:** `bankFile` generators · `payslipPdf` + delivery · `payCalendar`/cut-off config · batch-scope selector · `payrollApproval` workflow + `payrollVariance` · `recurringDeduction` ledger · `finalPaySettlement` · `glExport` · payroll-history importer · component `rounding`/`eaLine` fields.

### 3.3 Time & Attendance  *(owner: "not flexible enough" — structural)*
- **Today:** one global fixed schedule per company (`workStart/End`, `lateAfter`, `halfDayBefore`); web check-in only; one auto-deducted break at 6h; OT classified (day-type) but **not monetised**; corrections flow (a strength); 45h/104h flags.
- **Target:** a first-class **shift/schedule entity** + **roster/scheduling board** (named shifts, patterns, split, **overnight/cross-midnight**); **multiple clock methods** (mobile GPS+geofence, selfie, QR/kiosk, biometric-terminal import); **configurable OT rule engine** (daily/weekly/period thresholds, multipliers, caps) + **EA-1955 monetisation** (1.5×/2.0×/3.0×, rest-day ½/1/2-day wage bands, PH ordinary+3×, RM4,000 gate, ORP); configurable **rounding** + **grace**; richer break model (paid/unpaid, multiple, "no break"); **period timesheet** (submit→approve→lock) + **exception engine** (missing punch, unapproved OT); **per-group/dept/individual policy**; real-time "who's-in" board + alerts; emit attendance as **typed pay components** into payroll.
- **Replanned functions:** `shift`/`schedule`/`roster` · clock-method capture + geofence · `otRule` engine + EA wage-band monetiser · rounding/grace config · `timesheet` + exception queue · policy-resolution-by-scope · live board + alerts · attendance→pay-component bridge.

### 3.4 Leave & Absence  *(heavy consultant feedback; MY-critical)*
- **Today:** custom types (paid/unpaid, counting); entitlement floor-vs-policy `max`; **single binary approver**; **one flat holiday calendar**; calendar-year cycle only; upfront grant only; whole-days only; append-only ledger (a strength); sick/hospitalization bands encoded.
- **Target:** **half-day/hourly**; **periodic accrual** + **proration on hire/resign/grade-change** (EA rounding); **leave cycle** (calendar/anniversary/fiscal) + **carry-forward with cap + expiry + forfeiture**; **holiday groups by state** (13 + FT); **multi-level/conditional approval** (via §4 engine) + delegation/escalation; **eligibility gates** (probation, min-service, gender, married, birth-count); **mandatory document upload** per type (MC/RMP/hospital letter) blocking submit; **apply-time validation** (projected balance, overlap, max-consecutive, notice); **statutory leave validation** (maternity/paternity/sick/hospitalization — *figures to be sourced from EA 2022, not guessed*); **encashment** + payroll handoff; **TOIL/replacement** from OT/holiday work; lifecycle **notifications**; leave-liability reporting; segment-scoped policy assignment.
- **Replanned functions:** half-day/hourly request path · `accrualRule` + proration engine · `leaveCycle`/carry-forward engine · `holidayGroup` by state · eligibility predicates + mandatory-doc gate · apply-time validators · `leaveEncashment` ledger + payroll bridge · TOIL conversion.

### 3.5 Performance  *(has Phase A/B — market it; deepen)*
- **Today:** structured self/manager reviews, goals (flat, weighted), 1:1 check-ins, 360 (side flow), calibration (text distribution + advisory), AI-assisted drafting, **rating→effective-dated MY-compliant raise/bonus** (a genuine differentiator).
- **Target:** **review form/template builder** (sections, question types, per-audience, weighting); **goal cascading/alignment** (company→team→individual rollup) + **locking/sign-off gates**; **competency framework** (library, anchors, career levels); **visual calibration** (9-box, side-by-side, guided distribution, leniency flags); **succession/9-box + talent pools**; **development plans/IDPs**; probation/project review types; continuous recognition/feedback primitives.
- **Replanned functions:** `reviewTemplate` builder · goal hierarchy + lock/sign-off · `competency` library + review mapping · 9-box/calibration board · `succession`/`talentPool` · `developmentPlan` · recognition feed.

### 3.6 Reporting & Analytics  *(no charts = #1 "feels generic")*
- **Today:** 5 hard-coded reports (headcount/turnover/new-hire/termination/master-data) + CSV; statutory views; CP39 **draft** only; **no chart library**; single date-range filter; point-in-time statutory artefacts (a strength).
- **Target:** **charts** (bar/pie/line/trend) + KPI tiles + drill-through; **ad-hoc report builder** (any field, multi-dim group/filter, save/share); **XLSX + PDF** (and docx/png/pptx) export; **scheduled/emailed reports**; **persona dashboards** (exec/HR/manager via existing RLS); **25–40 standard reports**; **workforce analytics** (attrition split, retention/tenure, absenteeism, headcount trend, diversity, comp-ratio/pay-gap); **payroll register + variance**; **statutory agency files** (KWSP CSV, PERKESO ASSIST, bank GIRO — shared with §3.2); **import templates** (per-entity, mapping, statutory validation, dry-run + error file).
- **Replanned functions:** chart components + dashboard framework · `reportBuilder` (fields/filters/groups/save) · multi-format `exporter` · `scheduledReport` · standard-report catalog · analytics queries · `importTemplate` engine.

### 3.7 ESS / MSS / Workflow  *(the cross-cutting unlock — see §4)*
- **Today:** ESS profile/bank/payslip/leave; single-step approval (`assertCanDecide`); **topbar pending-count only** (no real notifications); 4 hardcoded request types; **no tasks, no mobile, no e-sign, no onboarding/offboarding**.
- **Target:** see **§4 Workflow & Notification Engine** — multi-level/parallel/conditional routing + delegation/escalation/SLA; 3 notification channels (in-app/email/push); **task primitive**; configurable **field-level "requires approval"**; approver UX (diff, comments, send-back, bulk); admin-defined request catalog; onboarding/offboarding; mobile (PWA→native); e-signature.

### 3.8 Admin / Roles / Security  *(fixed enum roles = "generic" tell; SSO = procurement gate)*
- **Today:** 4 enum roles; field gating in code; people-scope = company + manager-subtree; RLS/SECURITY-DEFINER DB enforcement (a strength); audit substrate; dev-cookie auth (WorkOS seam designed, **SSO not shipped**); **no public API**.
- **Target:** the **module-scoped Access Model in §4.3** — named job-function role *templates* + per-module grant/revoke, each with **access level (none→view→edit→approve→admin) × hierarchy/scope (self→team→dept→company→group)**, field-level overrides, all resolved at the RLS layer; **SSO (SAML/OIDC) + SCIM**; **public API + webhooks** (cheap atop the event log) + scoped service accounts; **PDPA-2024** posture (retention/purge, consent register, DPO, breach workflow, biometric handling, residency); SoD/restricted-admin tiers + delegation; access-review/recertification export.
- **Replanned functions:** access-point **registry** per module · role-template + `(module×level×scope)` matrix resolver · field-level overrides · SSO/SCIM · public API + webhooks · PDPA controls · access-review export. *(Engine designed Track 1 / ADR-0026; builder UI Track 7.)*

---

## 4. Cross-cutting platform foundations (build/design first — every module plugs in)

Three substrate capabilities sit beneath the modules. Their **design (ADR)** is done in **Track 1** so Tracks 2–6 are built against them; their full **builder UIs** ship in Track 7. Skipping this ordering forces a painful per-module retrofit.

### 4.1 Workflow & Notification Engine
Single highest-leverage build. Today approvals are hardcoded single-step. A real **engine** — steps-as-data (sequential/parallel/conditional), delegation, escalation, SLA timers — + a **task primitive** + **3-channel notifications** (in-app / email / push) wired to the existing DomainEvent log unblocks in one stroke: leave multi-level approval, ESS sensitive-field approval (consultant #24), onboarding/offboarding, payroll maker-checker, claims/perf routing, and an admin-defined request catalog. **Build before any module-level approval feature.**

### 4.2 Configuration Engine *(owner add-on: "config engine should be more comprehensive")*
Today configuration is scattered (statutory config, leave policy, attendance policy — each ad hoc). Replace with **one unified configuration framework**: a typed settings/registry layer that is **effective-dated**, **scope-overridable** (tenant → company → department/segment → individual), **validated**, **audited** (every change appends a DomainEvent), and **admin-UI-generated** from declarations. Every configurable surface registers against it — pay components, leave types/accrual, attendance/shift policies, workflows, **roles/permissions (4.3)**, custom fields, report definitions, statutory rules. This is the antidote to "too generic": tenants self-serve depth without code.

### 4.3 Access Model — module-scoped RBAC *(owner decision #4)*
The roles model is a **(role/user × module × level × scope) matrix**, not a name list:
- **Named job-function roles** are *templates* (Recruiting / Payroll / Compensation / Performance Partner, HR Admin, Manager, Employee…) that seed the matrix and can then be customised.
- Access is **granted/revoked per module** — each module **declares its access points** (a registry).
- Each granted module carries an **access level**: `none → view → edit → approve → admin`.
- …**× a hierarchy/scope**: `self → team → department → company → group`.
- Resolution is enforced at the **Postgres RLS / SECURITY-DEFINER layer** (existing strength) so a missed UI check cannot leak — the configurable role layer sits *on top* of the hard DB enforcement.
- Includes field-level overrides (sensitive fields: NRIC/bank/salary), separation-of-duties tiers, delegation, and an access-review/recertification export.

**Design now (ADR-0026 Access Model, ADR-0027 Configuration Engine, ADR-0028 Workflow Engine); build the engines in Track 1; ship the builder UIs in Track 7.** Modules in Tracks 2–6 must register their access points + config schema against these from their first commit (the same discipline as the DomainEvents substrate).

---

## 5. Phased roadmap (recommended sequence)

Sequenced by leverage + the owner's named pain + "feels incomplete" drivers. Each track ≈ a multi-slice wave with its own ADR.

| # | Track | Why here | Headline deliverables |
|---|---|---|---|
| **0** | **Bug-fix + ungate** | trust + cheap | Fix TT bugs (reporting-line add, org-chart back-nav, public-holiday config, dashboard expand); **ungate typed pay-components + multi-cycle** for the demo; employee PDF payslip/attendance |
| **1** | **Platform foundations (§4)** | unblocks everything | Workflow/notification engine **+ Configuration engine + Access model** (ADR-0028/0027/0026); engines built now, modules in Tracks 2–6 register their access points + config against them |
| **2** | **Attendance v2** | owner pain #2; vertical-blocker | Shift/roster entity, clock methods (mobile/GPS/QR/biometric), OT engine + EA monetisation, timesheets, exceptions |
| **3** | **Payroll completion** | owner pain #1; deal-blockers | Bank GIRO files + agency upload files, payslip PDF/email, pay calendars/cut-offs, batch-by-selection, maker-checker + variance, recurring deductions, final-pay, GL export |
| **4** | **Leave v2** | heavy consultant; MY-critical | Half-day/hourly, holiday groups by state, accrual+proration, mandatory docs, statutory validation (sourced), multi-level approval (via #1), encashment |
| **5** | **Reporting & Analytics v2** | "feels generic" #1 | Charts + report builder + XLSX/PDF + statutory files + workforce analytics + import templates |
| **6** | **Core HR depth** | thin master record | Fat master + custom fields + document vault + e-sign + grades/bands + lifecycle workflows + onboarding/offboarding (via #1) |
| **7** | **Security & Platform** | procurement gate | Custom role builder + field perms + **SSO/SCIM** + public API/webhooks + PDPA-2024 |
| **8** | **Mobile + Performance/Talent depth** | parity/breadth | PWA→native daily loop; review builder + competencies + 9-box/succession |

**Suggested "demo-ready" milestone:** after Tracks 0–5 the product *feels complete* across the daily HR loop (attendance, payroll, leave, reporting, workflow) — that's the natural redeploy point. Tracks 6–8 are the enterprise/breadth push.

**Mobile (owner decision #3):** ship a **hardened PWA within the Track 2–3 window** (daily loop — clock-in, approvals, leave/claims, payslips; WebAuthn/passkeys, httpOnly cookies, CSP, Web Push). Build the **native app (Expo/React Native) in Track 8** for the deskless / high-assurance segment (background geofence + anti-spoof + device attestation, secure keystore + biometric lock, cert pinning, offline secure punch, biometric-terminal sync). PWA-first because it is secure enough for office/knowledge workers and fastest to a complete-feeling demo; native where attendance *integrity* is itself the product.

---

## 6. Consultant feedback → track mapping (nothing lost)

- **Already shipped (verify intent, may need depth):** #4 profile nav, #5 comp access, #7 HRDF, #8/#10 leave declutter, #11 bell, #9/#12/#21 pay components (gated), #1 multi-cycle (gated), #3/#26 partial (Wave 4 reports).
- **Track 0:** TT bugs; ungate #9/#1.
- **Track 1:** #11 (done), #24 ESS approval, #18 multi-level approver.
- **Track 2:** attendance flexibility (offline), OT.
- **Track 3:** #2 EPF modes, #6 per-body versioning, #14 EA-line, #15 rounding, #17 payroll config, #22 payslip PDF, #23 batch-by-selection, #73 bank/agency files, #95 EPF Third Schedule.
- **Track 4:** #18 leave cycle/category/holiday-group/multi-level, #25 statutory leave validation.
- **Track 5:** #3 report catalog + export formats, #26 charts/dashboards, #27 import templates.
- **Track 6:** #4 profile depth, #13 people filters, #16 photo upload, #24 document/fields, expanded master.
- **Track 7:** #19 granular roles.
- **Track 8:** #28 performance lifecycle depth.

---

## 7. Owner decisions (RESOLVED, 2026)

1. **Benchmark target: Rymnet** (enterprise/talent-heavy, retail-focused, AI chatbot + OCR) — the breadth bar to reach. ✅
2. **Sequence: Tracks 0 → 5** in order, to the demo-ready milestone. ✅
3. **Mobile: PWA-first (Track 2–3 window), native (Expo/RN) in Track 8** for the deskless/high-assurance segment — see §5 mobile note. ✅
4. **Roles: module-scoped Access Model** — named job-function role templates + per-module grant/revoke, each with **access level × hierarchy/scope**, RLS-enforced. See §4.3. ✅
5. **Statutory leave figures sourced from EA 2022 / official references before building** (no guessing). ✅
6. **Configuration engine elevated** to a cross-cutting foundation (§4.2) — comprehensive, no-code, effective-dated, scope-overridable, audited. ✅
7. Program runs as **sequenced waves, one ADR per track**; foundational ADRs (Access Model 0026, Config Engine 0027, Workflow 0028) authored in Track 1.

## 8. Immediate next step

**Track 0** (low-risk, high-trust, independent of the foundation ADRs): fix the four reported bugs (reporting-line add, org-chart back-nav, public-holiday config, dashboard expand), **ungate** typed pay-components + multi-cycle for the demo, and add employee PDF payslip/attendance downloads. Then open **Track 1** with the three foundational ADRs.
