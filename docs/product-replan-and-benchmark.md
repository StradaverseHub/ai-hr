# AI-HR — Product Strategy & Build Plan (v2 · anchor-tenant)

Status: **Active plan.** Supersedes v1. Date: 2026. Owner-confirmed.
v2 corrects v1 after an 11-agent / 2-level adversarial red team **and** new owner context (the anchor customer + team model).

---

## 0. What changed, and why (red team → anchor-tenant correction)

**The red team (verified against this repo) found v1 strategically unsound *as a speculative cold-market SaaS*:** a solo builder committed to incumbent-class breadth; build-before-sell; a "moat" marketed as "trust the numbers" while the statutory tables ship **DRAFT/approximated** (EPF Third Schedule #95 blocked, no named accountant); three **premature** platform engines built before any consumer; **spoofable PWA** attendance marketed as integrity; a config engine that **re-opens** the statutory-divergence hole; plus two pre-existing liabilities — **cross-employer PCB wrong tax** (ADR-0009) and **append-only audit ⊥ PDPA-2024 erasure** (cleartext bank in the event log).

**Owner context corrected the frame.** This is **not** a cold-market SaaS bet. It is:
- An **anchor-tenant build for Chin Hin Group** — a large, multi-entity Malaysian construction / building-materials group — used internally first, **stabilised on real usage, then productised** and sold to similar MY groups.
- **Deep** on **payroll · statutory compliance · attendance · claims**. Performance & talent **deferred**.
- Built by a **full AI team** (no budget/token ceiling).

**This defuses the red team's two fatal objections** (no GTM; build-first; solo velocity): there *is* a real, demanding customer; you build for them, not a hypothetical market; AI-team removes the human-velocity ceiling.

**What survives — and is now MORE urgent (go-live gates, not "before sale"):** real Chin Hin staff get paid and filed to LHDN/KWSP, so —
- **Cross-employer PCB is first-order** (a conglomerate has shared-services staff across subsidiaries → real under-deductions).
- **Statutory must be exact + accountant-signed** (#95 closed; sign-off obtained) before any real pay run.
- **Attendance must be native** for the deskless/site/factory workforce — PWA geofence/selfie is spoofable theatre for exactly those workers.
- **Audit-log must not hold un-erasable cleartext PII** (PDPA-2024).
- **Config must EXCLUDE statutory** (vendor-pack-only + break-glass).
- **Engines extracted from Chin Hin's REAL needs**, not designed in a vacuum (concrete-then-extract).

---

## 1. Strategy

- **Anchor-tenant first.** Correctness + operational completeness for one real multi-entity group (Chin Hin) is the bar. A wrong EPF figure or a misdirected salary is a real incident, not a demo blemish.
- **Deep wedge:** payroll, MY statutory compliance, attendance (incl. deskless), claims. **Defer** performance/talent/LMS/recruitment.
- **Real moat (only once earned):** exact MY statutory for **multi-entity groups at scale** + audit substrate + governed AI — credible only after the DRAFT/approximation is closed and **accountant-signed**.
- **Productise after stability:** add the commercial substrate (auth/signup/billing/provisioning) when Chin Hin runs clean, then sell to similar MY mid-market/enterprise groups. Benchmark **Rymnet/BrioHR on payroll·attendance·claims depth** (their relevant surface, since Chin Hin is enterprise/multi-entity/deskless) — **ignore their talent/LMS breadth.**

---

## 2. Go-live gates — must precede Chin Hin's first real pay run *(LOCKED)*

| Gate | Deliverable |
|---|---|
| **G1 · Statutory truth** | Close EPF Third Schedule exact banding (#95 — source the official KWSP table); obtain a **named licensed-accountant sign-off** of the statutory tables + the §7 multi-cycle worksheet. *Until then, no real payroll.* |
| **G2 · Cross-employer PCB** | Aggregate MTD across an employee's **concurrent employments within a tenant** (group shared-services case), or a documented contractual scope-out. → **ADR-0029.** |
| **G3 · Audit ⊥ PDPA** | Stop writing cleartext NRIC/bank/salary into the append-only event log; encrypt/tokenise/redact sensitive payloads while preserving auditability + honouring erasure. → **ADR-0030.** |
| **G4 · Bug fixes** | The 4 reported bugs: reporting-line add (runtime fail), org-chart context-aware back-nav, public-holiday admin UI, dashboard planned-absences expand. |
| **G5 · Re-gate** | Multi-cycle / typed-components stay **gated behind G1** — remove the "ungate for the demo" framing entirely. |

---

## 3. Roadmap (anchor-driven phases)

| Phase | Focus | Rationale |
|---|---|---|
| **G — Go-live gates** | §2 above | Cannot pay real staff wrong / unlawfully |
| **P — Payroll operational** | Bank GIRO + agency upload files (byte-exact, per bank/agency), payslip PDF + secure delivery, batch-by-entity/selection, pay calendars/cut-offs, recurring-deduction ledger, final-pay settlement, GL export | Chin Hin must actually run + disburse + file |
| **A — Attendance (native)** | Shift/roster engine, **native** site-worker clock (geofence + biometric + anti-spoof + offline), OT rule engine + EA-1955 monetisation, timesheets + exception engine, per-entity/group policy | The deskless core of a construction group; integrity must be real |
| **C — Claims + Leave depth** | Claims depth; leave: multi-level approval, **state holiday groups**, accrual + proration, mandatory-doc gating, statutory-leave validation (sourced from EA 2022) | Wedge completion for a large multi-state workforce |
| **F — Platform (extract)** | Workflow engine, config engine **(excl. statutory)**, RBAC — **extracted from the real needs revealed by G/P/A/C**, not pre-designed; reporting/analytics depth (charts, builder, exports) | Concrete-then-extract; satisfies the red team |
| **R — Commercialise** | Real auth/SSO, self-serve signup, billing, provisioning, public API, PDPA/DPA/indemnity, multi-tenant productisation | Only when Chin Hin is stable ("stabilise then sell") |

> **P-vs-A ordering** is provisional pending Chin Hin's workforce shape (§8): if mostly site/factory, **A** may lead; if the priority is getting payroll off the current system, **P** leads.

---

## 4. Module target states (the wedge)

Concise current → target. (Performance/talent targets exist in v1 history but are **deferred**.)

- **Payroll:** correct engine exists. Add bank GIRO/agency files, payslip PDF/email/password, ungate typed components + **BIK/PCB-only** support (remove fail-closed), pay calendars/cut-offs, batch-by-selection, maker-checker + pre-finalise variance, recurring deductions w/ balance, final-pay engine, GL export, payroll-history import + YTD, per-component rounding + EA-line, **per-body statutory versioning**, multi-cycle (post G1).
- **Attendance:** today a single fixed schedule, web-only. Add shift/roster entity (incl. overnight), **native** multi-method clock (GPS+geofence/biometric/QR/kiosk) with **server-side integrity** (nonce, server-stamped time, velocity/anomaly), configurable OT engine + EA wage-band monetisation, rounding/grace, richer breaks, period timesheets + exception queue, per-group/entity policy, live board + alerts, emit attendance as typed pay components.
- **Leave:** today single approver, one holiday calendar, whole-days, calendar-year. Add half-day/hourly, accrual+proration (EA rounding), leave cycle (anniversary/fiscal), carry-forward+expiry, **state holiday groups**, multi-level/conditional approval (via §5 workflow), eligibility gates, **mandatory-doc** gating, apply-time validation, statutory-leave validation (EA-2022 sourced), encashment + payroll handoff, TOIL.
- **Claims:** deepen (ADR-0021 base) — claim types/policies, multi-level approval, document gating, payroll/reimbursement handoff, reporting.
- **Core HR:** today thin person master. Add fat validated master (gender/marital/nationality/race for EA, photo, full statutory identity w/ validation), document vault + e-sign, position/grades/bands, lifecycle workflows (probation/confirm/transfer/promotion/rehire), onboarding/offboarding checklists, foreign-worker/expat doc tracking, data-quality scoring. **Multi-entity/concurrent-employment already strong** — but see **G2** (cross-employer PCB) before relying on it for payroll.

---

## 5. Platform discipline (red-team corrections, binding)

- **Engines are EXTRACTED, not pre-built.** Build G/P/A/C with the **simplest per-module** approval/config/role code each actually needs (as Claims/Leave/Attendance already were). Extract the Workflow / Config / RBAC engines in **Phase F**, once 2–3 modules + Chin Hin's real org reveal the true shape. Rule of three, not rule of zero. (The DomainEvents analogy was false: append-only emit ≠ hot-path read.)
- **Config engine EXCLUDES statutory tables.** Statutory stays **vendor-pack-only + break-glass** (ADR-0019/0020) — never a tenant self-serve form.
- **RBAC:** named job-function role templates + `(module × level × scope)`, designed against **Chin Hin's real multi-entity structure**. Enforce at RLS **pragmatically** — keep static policies where they suffice; avoid a per-row N-dimensional matrix lookup on the hot path (heavier than the OPA/Cedar ADR-0004 already rejected).
- **Effective-dating only where retroactive correctness needs it** (statutory, comp, assignments) — **not** report definitions / custom fields / config generally.
- **Server-side integrity** is mandatory wherever the client supplies trust (attendance punch location/photo/time): server-stamped time, server-issued nonce/QR, velocity/anomaly checks. RLS authorises rows; it does **not** validate client-supplied truth.

---

## 6. Mobile / attendance integrity

- **Native (Expo/React Native) for site-worker attendance** — moved to **Phase A** (not deferred). Geofence + biometric + device attestation + secure keystore + cert-pinning + offline secure punch. This is required by Chin Hin's deskless workforce and is the only honest integrity story.
- **PWA/web for office ESS/MSS** (approvals, leave, claims, payslips) with WebAuthn/passkeys + httpOnly cookies + CSP. On web, attendance restricted to **integrity-honest methods** (server QR/kiosk, supervisor-attested, server-to-server biometric-terminal import); GPS labelled **advisory, not enforced**.
- **Do not ingest biometric PII before the PDPA controls exist** — biometric handling (consent, retention, breach workflow) ships **with** Phase A, not in a later phase.

---

## 7. Decisions (resolved)

1. **Anchor customer: Chin Hin Group** — build internal-first, stabilise, then productise. ✅
2. **Deep wedge: payroll · compliance · attendance · claims**; **defer performance/talent.** ✅
3. **Full AI-team build, no budget/token ceiling.** ✅
4. **The 4 liabilities are go-live gates** (G1–G3 + G5) before any real Chin Hin pay run. ✅
5. **Attendance integrity = native** (Phase A); web is integrity-honest only. ✅
6. **Engines concrete-then-extract** (Phase F); **config excludes statutory.** ✅
7. **Re-benchmark Rymnet/BrioHR on payroll/attendance/claims depth**, not talent breadth. ✅
8. **Source statutory facts (EPF Third Schedule, EA-2022 leave) from official references** — never guess. ✅

---

## 8. Open input

**Chin Hin workforce shape** — total headcount, number of subsidiaries/entities, and the **deskless/site vs office split** — to finalise the **P-vs-A** ordering and the scale targets (batch sizes, attendance volume, multi-entity payroll runs).
