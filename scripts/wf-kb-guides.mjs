export const meta = {
  name: 'kb-guides',
  description: 'Author comprehensive AI-HR user guides (employee / manager / HR-admin perspectives) grounded in the real app',
  phases: [{ title: 'Author', detail: 'one agent per guide reads the real module code and writes content/guides/<slug>.md' }],
}

const CONTRACT = `
You are writing official end-user documentation for "AI HR" — a Malaysia-first, multi-company HRMS
(Next.js 16 App Router). Working dir: /Users/zenlam/Projects/ai-hr.

The product's modules (sidebar): Dashboard, My workspace (/me — employee self-service), People (/people),
Org chart (/org), Leave (/leave), Attendance (/attendance), Approvals (/approvals, manager+), Performance
(/performance), and Admin: Organization (/admin/organization), Leave config (/admin/leave), Payroll
(/payroll) + Reports (/payroll/reports), Users & roles (/admin/users), Audit trail (/admin/audit).
Roles: employee, manager, hr_admin, super_admin. Malaysia statutory: EPF/KWSP, SOCSO/PERKESO, EIS/SIP,
PCB/MTD, LHDN, EA form, Form E/CP8D, CP39, CP22/CP22A.

YOUR TASK: write ONE comprehensive, accurate, friendly user GUIDE in GitHub-flavored Markdown, from the
specified PERSPECTIVE, and write it to the given file path. Nothing else.

GROUND IT IN THE REAL APP — do not invent features:
- READ the listed source files first (pages under app/, services under core/, components/). Use the ACTUAL
  navigation, button/label text, field names, statuses, and flows you find there. If the code shows a
  control labelled "Update pay", say "Update pay" — don't guess "Edit salary".
- If something in your scope genuinely isn't in the code, omit it rather than fabricate.

STYLE & STRUCTURE:
- Start with a short intro paragraph: who this guide is for and what they'll be able to do.
- Then step-by-step sections with REAL navigation cues, e.g. "In the left sidebar, click **People**, then…".
- Use ## and ### headings, numbered steps for procedures, bullet lists, **bold** for UI labels/buttons,
  \`code\` for field values/statuses, and Markdown tables where they help.
- Describe what the user will SEE on screen (so it reads like a real walkthrough). Add **Tips** and
  **Note** call-outs (as bold lead-ins) and a short "Common pitfalls" or "Troubleshooting" list where useful.
- Malaysian context where relevant. Concise but THOROUGH (roughly 700–1500 words to scope).
- Do NOT add YAML frontmatter and do NOT use a top-level # title (the app shows the title separately) —
  begin with the intro paragraph or a ## section heading.

OUTPUT: write the complete Markdown to the file path given below (overwrite). Return a short summary.
`

const GUIDES = [
  { slug: 'getting-started-admin', audience: 'HR administrator (first-time setup)',
    read: 'app/admin/organization/page.tsx, components/company-panel.tsx, app/admin/users/page.tsx, app/admin/leave/page.tsx, app/people/page.tsx, app/people/import/page.tsx, app/payroll/page.tsx, app/payroll/reports/page.tsx, core/org.ts, core/admin.ts, db/seed.ts',
    scope: 'THE flagship setup guide: taking the system from an empty/fresh database to a running HR operation. Cover, in order: (1) first login & the dev identity/role concept; (2) create your company structure (a holding company and the operating legal entity, departments, positions, cost centres) on /admin/organization; (3) add people — hiring one-by-one on /people vs bulk CSV import on /people/import; (4) set each employee’s Malaysian statutory profile (IC, EPF, SOCSO, tax no., PCB category, children, bank); (5) configure leave (leave types, entitlement policies vs statutory floor, public holidays, opening the leave year) on /admin/leave; (6) set the attendance policy; (7) assign user roles on /admin/users; (8) run your first payroll batch on /payroll and review statutory deductions; (9) where to find statutory reports (EA, Form E, CP39) on /payroll/reports. End with a "you’re live" checklist.' },
  { slug: 'admin-people-org', audience: 'HR administrator',
    read: 'app/people/page.tsx, app/people/[employmentId]/page.tsx, app/admin/organization/page.tsx, components/company-panel.tsx, app/people/import/page.tsx, core/org.ts',
    scope: 'Managing people and the org: companies/departments/positions/cost-centres CRUD; hiring; the employee detail page (personal details, compensation "Update pay", statutory, assignment history); effective-dated transfers; reporting lines (administrative/functional/project/dotted); termination; and CSV import (dry-run then commit).' },
  { slug: 'admin-leave-attendance', audience: 'HR administrator',
    read: 'app/admin/leave/page.tsx, components/leave-type-panel.tsx, app/leave/page.tsx, app/attendance/page.tsx, core/leave.ts, core/admin.ts, localization/my/leave.ts',
    scope: 'Leave configuration: leave types, entitlement policies layered over the EA-1955 statutory floor (the system takes the higher of the two), inline entitlement editor, public holidays, opening a new leave year with carry-forward. Attendance: the attendance policy, day-type classification, and how attendance correction requests work.' },
  { slug: 'admin-payroll-statutory', audience: 'HR administrator / payroll officer',
    read: 'app/payroll/page.tsx, app/payroll/[batchId]/page.tsx, app/people/[employmentId]/page.tsx, core/payroll.ts, localization/my/statutory.ts',
    scope: 'Running payroll: the employee statutory profile (IC, EPF/SOCSO/tax numbers, PCB category 1/2/3, children, EIS eligibility, tax residency, TP3 opening balances); creating a payroll batch; generating payslips; how EPF (employee+employer), SOCSO, EIS and PCB/MTD are computed; bonuses/additional remuneration; proration and OT/unpaid-leave inputs; closing a batch (immutability); and the final-pay advisory for leavers.' },
  { slug: 'admin-compliance-reporting', audience: 'HR administrator / compliance officer',
    read: 'app/payroll/reports/page.tsx, app/payroll/reports/ea/[employmentId]/page.tsx, core/reporting.ts',
    scope: 'Statutory reporting & compliance: the annual EA form per employee; Form E / CP8D; the CP39 monthly PCB submission text file; the CP22/CP22A new-hire/cessation worklist driven from the event log; monthly EPF/SOCSO/EIS/PCB figures; CSV exports and the bank payment summary. Note what is a ready-to-submit file vs a draft/advisory.' },
  { slug: 'admin-performance', audience: 'HR administrator',
    read: 'app/performance/page.tsx, app/performance/[cycleId]/page.tsx, core/performance.ts',
    scope: 'Performance & talent (ADR-0013): creating a review cycle; the lifecycle draft → open → calibration → closed; how self-reviews and manager reviews flow; the single overall rating on a labelled scale; the release gate (employees can’t see ratings until released); and comp actions — managers RECOMMEND merit/bonus, an admin ENACTS them (the system never writes pay directly). Mention the merit budget pool.' },
  { slug: 'admin-users-roles-audit', audience: 'HR administrator',
    read: 'app/admin/users/page.tsx, app/admin/audit/page.tsx, components/audit-table.tsx, core/admin.ts',
    scope: 'Users, roles & audit: the four roles (employee, manager, hr_admin, super_admin); group-wide vs company-scoped admin grants; sub-delegation (a company admin assigning roles within their subtree); revoking roles; and the audit trail — the /admin/audit view and the per-record History, both reading the append-only domain-event log.' },
  { slug: 'manager-overview', audience: 'people manager',
    read: 'components/sidebar.tsx, app/approvals/page.tsx, app/org/page.tsx, app/performance/page.tsx, app/page.tsx',
    scope: 'Orientation for a manager: what the Manage section unlocks (Approvals, Performance), how the dashboard and org chart help you see your team, and a short "your daily/weekly workflow" overview that links to the deeper manager guides.' },
  { slug: 'manager-approvals', audience: 'people manager',
    read: 'app/approvals/page.tsx, core/approvals.ts, core/leave.ts, core/attendance.ts',
    scope: 'The unified Approvals inbox: approving/rejecting leave requests, attendance correction requests, and profile-change requests for your reports; the reporting-line scope (you only see your line); the no-self-approval rule; and what each decision does downstream (e.g. an approved leave debits the balance).' },
  { slug: 'manager-team-org', audience: 'people manager',
    read: 'app/org/page.tsx, components/org-chart.tsx, app/people/[employmentId]/page.tsx',
    scope: 'Seeing and understanding your team: the org chart (collapse/expand, zoom, search), reporting-line types (administrative vs functional vs project vs dotted), and what you can view on an employee’s detail page within your scope.' },
  { slug: 'manager-performance', audience: 'people manager (as reviewer)',
    read: 'app/performance/page.tsx, app/performance/[cycleId]/page.tsx, app/performance/review/[reviewId]/page.tsx, core/performance.ts',
    scope: 'Running reviews for your team: finding your pending reviews, writing the manager review after the employee’s self-review, giving the overall rating, and recommending merit/bonus — emphasising that you RECOMMEND and HR/admin ENACTS pay. Acknowledgement flow.' },
  { slug: 'employee-overview', audience: 'employee (first-time user)',
    read: 'app/me/page.tsx, components/sidebar.tsx, app/page.tsx, components/language-switcher.tsx',
    scope: 'Welcome orientation: logging in, the My workspace (/me) home, the sidebar modules an employee can use (My workspace, People directory, Org chart, Leave, Attendance), switching language (the 文A switcher: English / 简体中文 / Bahasa Melayu / தமிழ் / ไทย / Tiếng Việt) and light/dark theme. A friendly "here’s where everything is" tour in prose.' },
  { slug: 'employee-leave', audience: 'employee',
    read: 'app/leave/page.tsx, app/me/page.tsx, core/leave.ts',
    scope: 'Leave for employees: checking your balance (accrued/used/pending), requesting leave (type, dates), what the statuses mean (pending/approved/rejected/cancelled), who approves it, and cancelling a request. Mention that balances are private to you.' },
  { slug: 'employee-attendance', audience: 'employee',
    read: 'app/attendance/page.tsx, app/me/page.tsx, core/attendance.ts',
    scope: 'Attendance for employees: checking in and out, what present/late/half-day/absent mean, viewing your record, and submitting an attendance correction request (with a reason) when a clock-in is wrong — which your manager approves.' },
  { slug: 'employee-payslips', audience: 'employee',
    read: 'app/me/page.tsx, app/me/payslip/[payslipId]/page.tsx, app/payroll/reports/ea/[employmentId]/page.tsx',
    scope: 'Payslips & EA: finding your payslips on /me, opening a payslip and reading the earnings/deductions (EPF employee, SOCSO, EIS, PCB) and net pay, downloading/printing it, and downloading your annual EA form for income-tax filing.' },
  { slug: 'employee-profile-performance', audience: 'employee',
    read: 'app/me/page.tsx, app/performance/review/[reviewId]/page.tsx, core/profile.ts',
    scope: 'Self-service profile & reviews: editing low-risk contact details directly (phone, address, emergency contact) vs pay-affecting details (bank account, PCB category) which go through an approval request; and completing your performance self-review and acknowledging your manager’s review once released.' },
]

const SCHEMA = {
  type: 'object',
  required: ['slug', 'wrote', 'approxWords'],
  additionalProperties: false,
  properties: {
    slug: { type: 'string' },
    wrote: { type: 'boolean' },
    approxWords: { type: 'number' },
    sections: { type: 'array', items: { type: 'string' } },
  },
}

const results = await parallel(
  GUIDES.map((g) => () =>
    agent(
      `${CONTRACT}\n\nPERSPECTIVE / AUDIENCE: ${g.audience}\nOUTPUT FILE: content/guides/${g.slug}.md\n\nREAD THESE SOURCE FILES FIRST (for accurate navigation, labels, flows): ${g.read}\n\nGUIDE SCOPE — cover thoroughly: ${g.scope}\n\nWrite the complete Markdown guide to content/guides/${g.slug}.md now.`,
      { label: `guide:${g.slug}`, phase: 'Author', schema: SCHEMA },
    ),
  ),
)

const ok = results.filter(Boolean)
log(`Authored ${ok.length}/${GUIDES.length} guides.`)
return { authored: ok.length, total: GUIDES.length, guides: ok.map((r) => ({ slug: r.slug, words: r.approxWords })) }
