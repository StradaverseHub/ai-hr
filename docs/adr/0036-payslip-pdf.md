# ADR-0036 — Payslip PDF + template (#22)

Status: Accepted · 2026-06-23 · Consultant feedback #22 (High)

## Context

#22: *"No payslip template is available for selection, and the system is currently unable to generate
payslips."* The consultant wants: payslip **templates** + **PDF generation** + **email delivery** +
**password/encryption** + **A5 print**.

Today there is a payslip detail page (`/me/payslip/[id]`) with all the figures (earnings, statutory
deductions EPF/SOCSO/EIS/PCB, net, employer contributions) and a browser **Print** button — but no real
downloadable PDF and no formal payslip layout. The "PDF generation" + "password/encryption" asks imply a
**server-generated PDF**, not a browser print (you can't password-protect a browser print).

## Decision

Generate the payslip server-side as a real PDF and serve it from an RLS-gated route.

- **Library: `pdf-lib`** (pure JavaScript — no WASM/native deps, so no Next.js bundler friction, unlike
  `@react-pdf/renderer`; it also supports document encryption for the deferred password phase). A
  `renderPayslipPdf(data, labels)` function draws an **A5** payslip: company letterhead (legal name +
  registration no), the "PAYSLIP" title + pay period, the employee block (name + employee code), an
  earnings section, a statutory + other-deductions section, the highlighted **net pay**, and the
  employer-contributions section. Amounts are right-aligned, tabular RM.
- **Route: `GET /me/payslip/[payslipId]/pdf`** — resolves the session, reads `payslipDetail` (which is
  already RLS-gated to own-or-admin, so the route inherits ABAC for free: an employee can only fetch
  their own payslip, an admin any), renders the PDF, and streams it with
  `Content-Type: application/pdf` + `Content-Disposition: attachment; filename="payslip-<period>-<code>.pdf"`.
- **UI:** a **Download PDF** button on the payslip detail page (the Print button stays for quick on-screen
  printing). The same route is linkable from the admin payroll batch + the `/me` payslip list.
- **Labels are i18n'd** — the route resolves `getTranslations` and passes the localized labels into the
  renderer, so the PDF respects the viewer's locale (reusing the existing `me.payslip` namespace).

### Template selection

Phase 1 ships **one** clean A5 template. The renderer takes a `template` argument and the route is the
single seam, so adding selectable templates later (per-company letterhead/logo, alternate layouts) is a
local change — no re-architecture. A `company.payslip_template` column can drive selection when more than
one exists; not added now (YAGNI).

## Deferred (later phases)

- **Email delivery** — depends on the notification-channels work (ADR-0034); a payslip-ready email with
  the PDF attached is a clean follow-up once a channel exists.
- **Password / encryption** — `pdf-lib` can encrypt; the natural key is the employee's IC or a per-payslip
  password. Deferred so phase 1 stays focused on "generate a payslip at all".
- **Multiple selectable templates + company logo upload.**
- **Full-Unicode names** — phase 1 uses the built-in Helvetica (WinAnsi), which covers Latin/romanized MY
  names (all demo employees + the overwhelming majority of real ones); names in non-Latin scripts are
  encode-guarded so they never crash the render. Embedding a Unicode font (Noto) is the follow-up.

## Consequences

- Employees and admins get a real, downloadable, formal payslip — the headline of #22 — without a heavy
  PDF/headless-browser dependency. The browser Print path still works for quick prints.
- The renderer is a pure function over the existing `payslipDetail` read, so it is unit-testable (assert a
  `%PDF` document of non-trivial size) and reused identically by every surface that links the route.
