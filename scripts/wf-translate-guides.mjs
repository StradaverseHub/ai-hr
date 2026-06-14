export const meta = {
  name: 'translate-guides',
  description: 'Translate each Knowledge Base system guide (Markdown) into zh/ms/ta/th/vi',
  phases: [{ title: 'Translate', detail: 'one agent per guide writes content/guides/i18n/<slug>.<locale>.md + translated titles' }],
}

const CONTRACT = `
You are translating one official Knowledge Base GUIDE for the ai-hr app (a Malaysia-first HRMS) from
English into FIVE languages. Working dir: /Users/zenlam/Projects/ai-hr.

SOURCE: content/guides/<SLUG>.md (a complete Markdown user guide, ~1000–1500 words).
TARGETS: zh (Simplified Chinese 简体中文), ms (Bahasa Melayu), ta (Tamil தமிழ்), th (Thai ไทย — unspaced),
vi (Vietnamese Tiếng Việt). ta/th are best-effort and flagged for native review.

TASK:
1. Read content/guides/<SLUG>.md.
2. For EACH of the 5 locales, translate the full guide and WRITE it to content/guides/i18n/<SLUG>.<locale>.md
   (5 files total). Also translate the guide's TITLE (given below) for each locale.

PRESERVE EXACTLY (translate only natural-language prose):
- Markdown STRUCTURE: heading levels (##, ###), bullet/numbered lists, tables (keep the | and ---
  pipes and column count), **bold**, _italics_, > blockquotes, links [text](url) (translate the text,
  keep the url), and inline \`code\`. Keep blank-line spacing so it renders the same.
- Code/identifiers/values in backticks, and brand/statutory acronyms VERBATIM: AI HR, Malaysia, EPF,
  KWSP, SOCSO, PERKESO, EIS, SIP, PCB, MTD, LHDN, MyInvois, EA, Form E, CP8D, CP22, CP22A, CP38, CP39,
  TP1, TP3, IC, SSM, MYR, RM, CSV, WorkOS. UI labels that the app shows translated (e.g. menu names like
  People, Leave, Payroll) should be translated to match the app's own translations for that market.
- Numbers, dates, and currency unchanged.

STYLE: clear, friendly instructional prose in the target language; Thai is written without spaces between
words. Keep the same meaning and completeness as the English — do not summarize or drop sections.

Return the 5 translated titles. Do NOT edit any file other than the 5 content/guides/i18n/<SLUG>.<locale>.md.
`

// slug + English title (from content/guides/manifest.json)
const GUIDES = [
  { slug: 'getting-started-admin', title: 'Getting Started: From an Empty System to Running HR' },
  { slug: 'admin-people-org', title: 'Admin Guide: People, Companies & Org Structure' },
  { slug: 'admin-leave-attendance', title: 'Admin Guide: Leave Policies, Holidays & Attendance' },
  { slug: 'admin-payroll-statutory', title: 'Admin Guide: Payroll & Malaysian Statutory (EPF/SOCSO/EIS/PCB)' },
  { slug: 'admin-compliance-reporting', title: 'Admin Guide: Statutory Reporting & Compliance (EA, Form E, CP39, CP22)' },
  { slug: 'admin-performance', title: 'Admin Guide: Performance & Talent Cycles' },
  { slug: 'admin-users-roles-audit', title: 'Admin Guide: Users, Roles & the Audit Trail' },
  { slug: 'manager-overview', title: 'Manager Guide: Your Surfaces & Daily Workflow' },
  { slug: 'manager-approvals', title: 'Manager Guide: Approving Leave, Attendance & Profile Changes' },
  { slug: 'manager-team-org', title: 'Manager Guide: Your Team, Reporting Lines & Org Chart' },
  { slug: 'manager-performance', title: 'Manager Guide: Running Reviews for Your Team' },
  { slug: 'employee-overview', title: 'Employee Guide: Getting Started in Your Workspace' },
  { slug: 'employee-leave', title: 'Employee Guide: Checking Your Balance & Requesting Leave' },
  { slug: 'employee-attendance', title: 'Employee Guide: Clocking In/Out & Correction Requests' },
  { slug: 'employee-payslips', title: 'Employee Guide: Payslips & Your Annual EA Form' },
  { slug: 'employee-profile-performance', title: 'Employee Guide: Updating Your Profile & Self-Reviews' },
]

const SCHEMA = {
  type: 'object',
  required: ['slug', 'titles', 'wroteFiles'],
  additionalProperties: false,
  properties: {
    slug: { type: 'string' },
    wroteFiles: { type: 'number' },
    titles: {
      type: 'object',
      required: ['zh', 'ms', 'ta', 'th', 'vi'],
      additionalProperties: false,
      properties: {
        zh: { type: 'string' },
        ms: { type: 'string' },
        ta: { type: 'string' },
        th: { type: 'string' },
        vi: { type: 'string' },
      },
    },
  },
}

const results = await parallel(
  GUIDES.map((g) => () =>
    agent(
      `${CONTRACT}\n\nSLUG: ${g.slug}\nENGLISH TITLE: ${g.title}\n\nTranslate now: read content/guides/${g.slug}.md and write content/guides/i18n/${g.slug}.{zh,ms,ta,th,vi}.md, then return the 5 translated titles.`,
      { label: `tr:${g.slug}`, phase: 'Translate', schema: SCHEMA },
    ),
  ),
)

const ok = results.filter(Boolean)
const titles = {}
for (const r of ok) titles[r.slug] = r.titles
log(`Translated ${ok.length}/${GUIDES.length} guides into 5 languages.`)
return { translated: ok.length, total: GUIDES.length, titles }
