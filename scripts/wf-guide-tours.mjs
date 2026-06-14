export const meta = {
  name: 'guide-tours',
  description: 'Add data-tour anchors to each module page and author its interactive walkthrough steps',
  phases: [{ title: 'Author', detail: 'one agent per module: add anchors + return ordered tour steps' }],
}

const CONTRACT = `
PROJECT: ai-hr — Next.js 16 App Router, Malaysia-first HRMS. Working dir: /Users/zenlam/Projects/ai-hr.

We have an in-product TOUR engine (a spotlight walkthrough). A Knowledge Base guide can launch a
per-module walkthrough that navigates to the module and spotlights the REAL controls there. Your job is
to make ONE module tour-able:

1. ADD ANCHORS: in your assigned page file(s) ONLY, add a \`data-tour="<TOURID>-<short>"\` attribute to a
   handful of STABLE, always-present, meaningful elements — the page <h1>/PageHeader, primary action
   buttons, key section cards/headings, important form fields. Pick elements that exist in the common
   case (avoid ones that only render for a rare data state). Add the attribute directly to the JSX
   element (e.g. \`<button data-tour="leave-request" ...>\`). For a server component, a plain attribute is
   fine. Do NOT remove or change existing \`data-tour\` attributes. Change NOTHING else.

   - The PageHeader component accepts no data-tour prop, so to anchor the page title, wrap the
     <PageHeader .../> in a <div data-tour="<TOURID>-intro"> (a wrapping div is safe) OR anchor a nearby
     real element instead. Prefer anchoring real interactive elements over headers where possible.

2. RETURN STEPS: an ordered list (3–6) describing the walkthrough. Each step:
   - id: short camelCase unique within the tour (e.g. "balance", "request", "table").
   - target: the CSS selector for the anchor you added, e.g. "[data-tour=\\"leave-request\\"]", OR null for
     a centered intro/finish card.
   - route: the page path this step is on (e.g. "/leave"). Every step needs its route (the engine
     navigates there first). Multi-page tours switch route between steps.
   - title: 3–6 words, sentence case.
   - body: 1–2 short sentences, friendly and action-oriented ("Click **Request leave** to…").
   - placement: "center" (for null target), or "right"/"left"/"top"/"bottom" relative to the anchor.
     Use "bottom" for elements near the top of the page, "right" for left-column items.
   - roles: OMIT for everyone; set to the listed roles for admin/manager-only steps.

   Make the FIRST step a centered intro (target null, placement center) that says what this walkthrough
   covers, and the LAST step a short wrap-up (can be the final real control or a centered card).

HARD RULES: edit ONLY the files listed for your module. NEVER edit messages/*.json, lib/onboarding-tour.ts,
components/*, or any other page. Keep the file compiling (valid JSX/TS). The English title/body you return
become i18n source strings (they'll be keyed + translated by the orchestrator).
`

const MODULES = [
  { tourId: 'me', files: ['app/me/page.tsx'], routes: '/me',
    scope: 'Employee self-service. Walk through: the profile/contact section, the bank & statutory (approval-gated) area, the payslips list, and the leave/attendance summary. Audience: all employees.' },
  { tourId: 'leave', files: ['app/leave/page.tsx', 'app/admin/leave/page.tsx'], routes: '/leave then /admin/leave',
    scope: 'Leave. On /leave (everyone): the leave balance, the request-leave form/button, and the requests table. Then ONE admin step on /admin/leave (roles ["hr_admin","super_admin"]): where leave types/entitlements/holidays are configured. First step centered intro.' },
  { tourId: 'attendance', files: ['app/attendance/page.tsx'], routes: '/attendance',
    scope: 'Attendance. Walk through: check-in/out, the present/late/half-day/absent status, your record, and submitting a correction request. Audience: all.' },
  { tourId: 'payroll', files: ['app/payroll/page.tsx', 'app/payroll/reports/page.tsx'], routes: '/payroll then /payroll/reports',
    scope: 'Payroll (admin). On /payroll: create a batch, the batches table, statutory totals. Then a step on /payroll/reports: where EA/Form E/CP39/monthly statutory reports live. All steps roles ["hr_admin","super_admin"]. First step centered intro.' },
  { tourId: 'people', files: ['app/people/page.tsx', 'app/admin/organization/page.tsx'], routes: '/people then /admin/organization',
    scope: 'People & org. On /people (all): search, the people table, the hire form/Import CSV. Then admin steps on /admin/organization (roles ["hr_admin","super_admin"]): companies/departments/positions master data. First step centered intro.' },
  { tourId: 'performance', files: ['app/performance/page.tsx'], routes: '/performance',
    scope: 'Performance (manager/admin). Walk through: review cycles, my reviews / pending reviews, and creating/opening a cycle. All steps roles ["manager","hr_admin","super_admin"].' },
  { tourId: 'approvals', files: ['app/approvals/page.tsx'], routes: '/approvals',
    scope: 'Approvals inbox (manager+). Walk through: the pending requests, approve/reject, and the no-self-approval / scope notes. All steps roles ["manager","hr_admin","super_admin"].' },
  { tourId: 'org', files: ['app/org/page.tsx'], routes: '/org',
    scope: 'Org chart. Walk through: search, collapse/expand & zoom controls, and reading reporting lines. Audience: all.' },
  { tourId: 'admin', files: ['app/admin/users/page.tsx', 'app/admin/audit/page.tsx'], routes: '/admin/users then /admin/audit',
    scope: 'Admin (roles ["hr_admin","super_admin"]). On /admin/users: roles, assigning/revoking, scoped admins. Then a step on /admin/audit: the audit trail over the event log. First step centered intro.' },
]

const SCHEMA = {
  type: 'object',
  required: ['tourId', 'filesEdited', 'steps'],
  additionalProperties: false,
  properties: {
    tourId: { type: 'string' },
    filesEdited: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'target', 'route', 'title', 'body', 'placement'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          target: { type: ['string', 'null'] },
          route: { type: ['string', 'null'] },
          title: { type: 'string' },
          body: { type: 'string' },
          placement: { type: 'string', enum: ['center', 'top', 'bottom', 'left', 'right'] },
          roles: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const results = await parallel(
  MODULES.map((m) => () =>
    agent(
      `${CONTRACT}\n\nMODULE / TOUR ID: ${m.tourId}\nFILE(S) TO EDIT (only these): ${m.files.join(', ')}\nROUTE(S): ${m.routes}\n\nWALKTHROUGH SCOPE: ${m.scope}\n\nAdd the data-tour anchors now, then return the ordered steps.`,
      { label: `tour:${m.tourId}`, phase: 'Author', schema: SCHEMA },
    ),
  ),
)

const ok = results.filter(Boolean)
log(`Authored ${ok.length}/${MODULES.length} module tours.`)
return { tours: ok }
