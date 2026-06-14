export const meta = {
  name: 'i18n-extract',
  description: 'Extract hardcoded UI copy across all ai-hr pages into next-intl namespaces, then verify each',
  phases: [
    { title: 'Extract', detail: 'one agent per page/component group wires t() and returns its English keys' },
    { title: 'Verify', detail: 'a second agent re-reads each unit, fixes leftovers/broken t(), returns final keys' },
  ],
}

const CONTRACT = `
PROJECT: ai-hr — Next.js 16 App Router, next-intl v4 ALREADY configured. The i18n foundation exists:
- messages/en.json is the English source catalog (nested namespaces). Missing keys fall back to English at runtime.
- Server Components (file does NOT start with 'use client'): add \`import { getTranslations } from 'next-intl/server';\`
  then \`const t = await getTranslations('<NAMESPACE>');\` at the top of the async component body; use \`t('key')\`.
  If a separate non-async helper/sub-component in the same file renders copy, either make it async and await
  getTranslations there too, or pass t / the resolved strings down as props. Prefer resolving where rendered.
- Client Components (file starts with 'use client'): add \`import { useTranslations } from 'next-intl';\`
  then \`const t = useTranslations('<NAMESPACE>');\` inside the component; use \`t('key')\`.
- Nested namespaces: pass the dotted path to getTranslations/useTranslations (e.g. getTranslations('payroll.batch')),
  then call t('subkey'). Your NAMESPACE path is given below.

YOUR JOB: in your assigned file(s) ONLY, replace hardcoded ENGLISH user-facing copy with t() calls under YOUR
namespace, keep the file compiling, and RETURN the flat English key→value map you created.

EXTRACT (user-facing copy only):
- Visible JSX text: headings, labels, paragraphs, table headers, cell labels, empty states, hints, badges, buttons.
- Attribute copy: aria-label, title, placeholder, alt.
- Toast/notification text, confirm-dialog prompts.

DO NOT TOUCH:
- className, data-*, href, key, id, style, CSS.
- Enum/status string VALUES used in logic (status === 'draft'): keep the logic value; you MAY translate a
  separately-displayed label for it.
- Number/currency/date FORMATTING code: toLocaleString, Intl.*, MONTHS/WK arrays, the 'RM ' prefix. Leave
  numeric/date formatting exactly as-is; only translate surrounding words.
- console.*, comments, identifiers, import paths, anything already using t().

INTERPOLATION (ICU MessageFormat — required):
- Variable: value "{count} of {total} companies", call t('overview', { count, total }).
- Plural: value "{d, plural, one {# day} other {# days}}", call t('days', { d }). Use ICU plural for EVERY
  count-dependent phrase (1 employee / N employees, in N days, joined N days ago, etc.). Keep the number var; wrap
  the WORDS in the plural.
- NEVER build a sentence by concatenating translated fragments with +. One ICU message per phrase, with placeholders.
- Preserve non-letter glue (· – / : %) inside the message string.

KEYS:
- camelCase leaf keys grouped logically. Return FLAT full-dotted keys (e.g. "payroll.batch.title") → English value.
- Reuse one key when the identical English string appears more than once in your files.

HARD CONSTRAINTS:
- Edit ONLY the files in your list. NEVER edit messages/*.json (the orchestrator merges your returned keys).
  NEVER edit components/sidebar.tsx, language-switcher.tsx, or any shared component not in your list — those are
  owned by other agents. If a shared component you render shows text passed as a PROP, translate the prop value in
  YOUR page and pass it in.
- A 'common' namespace exists (save, cancel, loading, search) and 'nav'/'dashboard' are partly done — do not write
  to 'common'/'nav'; keep everything else under YOUR namespace.
- Keep TypeScript valid: correct imports, server t is awaited, client t is not, valid JSX.
`

const UNITS = [
  { unit: 'dashboard', ns: 'dashboard', files: ['app/page.tsx'], kind: 'server',
    hint: "The 'dashboard' namespace ALREADY has these keys — reuse them verbatim for those strings, add new keys for the rest: title, recentActivity, recentActivitySubtitle, noActivity, viewAll. Do NOT edit planned-absences.tsx or timeline-nav.tsx (shared). The StatCard labels (HEADCOUNT, PENDING LEAVE, COMPANIES, LATEST PAYROLL), their hints (Active employees, Awaiting approval, N departments, No runs yet), Onboarding/Upcoming events/Headcount by company/Latest payroll run/Recent activity sections, and relative-time phrases (today/tomorrow/in N days, joined N days/weeks/months ago — use ICU plural) all need extraction." },
  { unit: 'people-list', ns: 'people.list', files: ['app/people/page.tsx'], kind: 'server',
    hint: 'People directory: page title, search placeholder, table headers, pagination controls, empty state, hire/add buttons.' },
  { unit: 'people-detail', ns: 'people.detail', files: ['app/people/[employmentId]/page.tsx'], kind: 'server',
    hint: 'Employee detail: all section headings, field labels, compensation/statutory/tax cards, edit forms, buttons. Do NOT edit audit-table.tsx (shared) — it renders the History section itself.' },
  { unit: 'people-import', ns: 'people.import', files: ['app/people/import/page.tsx', 'app/people/import/employee-import.tsx'], kind: 'mixed',
    hint: 'CSV importer. page.tsx is a Server Component; employee-import.tsx starts with "use client" (use useTranslations). Column mapping, dry-run/commit buttons, validation messages, instructions.' },
  { unit: 'leave', ns: 'leave', files: ['app/leave/page.tsx'], kind: 'server',
    hint: 'Leave page: balances, request form, requests table, status labels, approve/reject. Do NOT edit planned-absences.tsx or timeline-nav.tsx (shared).' },
  { unit: 'attendance', ns: 'attendance', files: ['app/attendance/page.tsx'], kind: 'server',
    hint: 'Attendance: status legend (present/late/half-day/absent), check-in/out, gap analysis, correction requests. Do NOT edit timeline-nav.tsx (shared).' },
  { unit: 'org', ns: 'org', files: ['app/org/page.tsx', 'components/org-chart.tsx'], kind: 'mixed',
    hint: 'Org chart. page.tsx Server Component; org-chart.tsx starts with "use client" (useTranslations). Search placeholder, zoom/collapse/expand controls, empty state, legend.' },
  { unit: 'me', ns: 'me', files: ['app/me/page.tsx'], kind: 'server',
    hint: 'Employee self-service workspace: profile, bank, payslips list, leave, attendance sections; edit/save with approval-gated messaging. Highest string density — be thorough.' },
  { unit: 'payslip', ns: 'me.payslip', files: ['app/me/payslip/[payslipId]/page.tsx'], kind: 'server',
    hint: 'Payslip detail: earnings/deductions/contributions line labels, totals, headings. Keep RM/number formatting as-is. Do NOT edit print-button.tsx (shared).' },
  { unit: 'approvals', ns: 'approvals', files: ['app/approvals/page.tsx'], kind: 'server',
    hint: 'Unified approvals inbox: tab/section labels, request rows, approve/reject buttons, empty state.' },
  { unit: 'performance-list', ns: 'performance.list', files: ['app/performance/page.tsx'], kind: 'server',
    hint: 'Performance cycles list: cycle status labels, create-cycle, my reviews / pending reviews sections, empty states.' },
  { unit: 'performance-cycle', ns: 'performance.cycle', files: ['app/performance/[cycleId]/page.tsx'], kind: 'server',
    hint: 'Cycle detail: state machine actions (open/calibration/release/close), participant table, comp-action enact/decline labels.' },
  { unit: 'performance-review', ns: 'performance.review', files: ['app/performance/review/[reviewId]/page.tsx'], kind: 'server',
    hint: 'Review form: self/manager review fields, rating scale labels, submit/acknowledge buttons.' },
  { unit: 'payroll-list', ns: 'payroll.list', files: ['app/payroll/page.tsx'], kind: 'server',
    hint: 'Payroll batches list: create batch, status labels, table headers, totals. Do NOT edit payroll-tabs.tsx (shared).' },
  { unit: 'payroll-batch', ns: 'payroll.batch', files: ['app/payroll/[batchId]/page.tsx'], kind: 'server',
    hint: 'Batch detail: payslip table, generate/close actions, statutory totals labels, status. Keep numbers/RM as-is.' },
  { unit: 'payroll-reports', ns: 'payroll.reports', files: ['app/payroll/reports/page.tsx'], kind: 'server',
    hint: 'Statutory reports hub: report names/descriptions, period controls, CSV labels. Do NOT edit payroll-tabs.tsx or download-csv.tsx (shared).' },
  { unit: 'payroll-ea', ns: 'payroll.ea', files: ['app/payroll/reports/ea/[employmentId]/page.tsx'], kind: 'server',
    hint: 'Annual EA form view: section/line labels. Keep numbers as-is. Do NOT edit print-button.tsx (shared).' },
  { unit: 'admin-home', ns: 'admin.home', files: ['app/admin/page.tsx'], kind: 'server',
    hint: 'Admin landing: section cards/links, descriptions.' },
  { unit: 'admin-organization', ns: 'admin.organization', files: ['app/admin/organization/page.tsx', 'components/company-panel.tsx'], kind: 'mixed',
    hint: 'Org admin. page.tsx Server; company-panel.tsx starts with "use client" (useTranslations). Companies/departments/positions CRUD, add/edit/archive, labels, empty states. Do NOT edit editable-row.tsx (shared).' },
  { unit: 'admin-leave', ns: 'admin.leave', files: ['app/admin/leave/page.tsx', 'components/leave-type-panel.tsx'], kind: 'mixed',
    hint: 'Leave config. page.tsx Server; leave-type-panel.tsx starts with "use client" (useTranslations). Leave types, entitlement editor, holidays, policy labels.' },
  { unit: 'admin-users', ns: 'admin.users', files: ['app/admin/users/page.tsx'], kind: 'server',
    hint: 'Users & roles: role assignment UI, principal rows, role labels, scope, buttons.' },
  { unit: 'admin-audit', ns: 'admin.audit', files: ['app/admin/audit/page.tsx'], kind: 'server',
    hint: 'Audit trail page chrome (title, filters, empty state). Do NOT edit audit-table.tsx (shared) — it is handled separately.' },
  { unit: 'topbar', ns: 'topbar', files: ['components/company-switcher.tsx', 'components/dev-identity-switcher.tsx'], kind: 'client',
    hint: 'Both start with "use client" (useTranslations). Company context switcher (All companies, N companies, Company context) and the dev identity switcher label/options chrome.' },
  { unit: 'shared-1', ns: 'components', files: ['components/planned-absences.tsx', 'components/timeline-nav.tsx', 'components/audit-table.tsx', 'components/payroll-tabs.tsx', 'components/print-button.tsx'], kind: 'mixed',
    hint: 'Multi-consumer shared components. Give each its own sub-namespace under components.* (e.g. components.plannedAbsences.*, components.timelineNav.*, components.auditTable.*, components.payrollTabs.*, components.printButton.*). Check each for "use client" and use the right hook. Extract column headers, control aria-labels (prev/next/today), tab labels, Print, empty states. Some text may arrive via props — only extract copy that is HARDCODED inside these components.' },
  { unit: 'shared-2', ns: 'components', files: ['components/download-csv.tsx', 'components/editable-row.tsx', 'components/ui/confirm-submit.tsx', 'components/theme-toggle.tsx', 'components/ui.tsx'], kind: 'mixed',
    hint: 'Shared atoms. Sub-namespaces under components.* (components.downloadCsv.*, components.editableRow.*, components.confirmSubmit.*, components.themeToggle.*, components.ui.*). Extract: Download CSV, editable-row Save/Cancel, confirm-submit default prompt (only if hardcoded, not prop), theme-toggle aria-label, and any hardcoded labels in ui.tsx (Field/PageHeader/StatusBadge). Leave prop-driven text alone.' },
]

const KEYS_SCHEMA = {
  type: 'object',
  required: ['unit', 'filesEdited', 'keys'],
  additionalProperties: false,
  properties: {
    unit: { type: 'string' },
    filesEdited: { type: 'array', items: { type: 'string' } },
    keys: { type: 'object', additionalProperties: { type: 'string' } },
    leftover: { type: 'array', items: { type: 'string' } },
  },
}

const results = await pipeline(
  UNITS,
  (u) =>
    agent(
      `${CONTRACT}\n\nUNIT: ${u.unit}\nNAMESPACE: ${u.ns}\nKIND: ${u.kind}\nFILES (edit only these): ${u.files.join(', ')}\n\nHINT: ${u.hint}\n\nDo the extraction now. Edit the file(s), then return your flat key map. Keys must be FULL dotted paths beginning with "${u.ns}.".`,
      { label: `extract:${u.unit}`, phase: 'Extract', schema: KEYS_SCHEMA },
    ),
  (extracted, u) =>
    agent(
      `${CONTRACT}\n\nVERIFY UNIT: ${u.unit}\nNAMESPACE: ${u.ns}\nKIND: ${u.kind}\nFILES: ${u.files.join(', ')}\n\nThe extractor wired these keys:\n${JSON.stringify(extracted?.keys ?? {}, null, 2)}\n\nRe-read the file(s) and VERIFY against the contract. Then FIX any problem directly in the file(s):\n- any user-facing English string still hardcoded (wire it, add a key)\n- broken/missing t() import or hook (server: await getTranslations; client: useTranslations)\n- invalid ICU interpolation or concatenated fragments (convert to one ICU message)\n- TypeScript/JSX that won't compile\n- a key whose English value doesn't match what the file now renders\nReturn the FINAL authoritative flat key map for this unit (extractor's keys plus anything you added/changed, minus anything removed). Same contract.`,
      { label: `verify:${u.unit}`, phase: 'Verify', schema: KEYS_SCHEMA },
    ),
)

const ok = results.filter(Boolean)
const merged = {}
let keyCount = 0
for (const r of ok) {
  for (const [k, v] of Object.entries(r.keys ?? {})) {
    merged[k] = v
    keyCount++
  }
}
log(`Units done: ${ok.length}/${UNITS.length}. Collected ${keyCount} keys (${Object.keys(merged).length} unique).`)

return {
  unitsDone: ok.length,
  unitsTotal: UNITS.length,
  failed: UNITS.filter((u) => !ok.some((r) => r.unit === u.unit)).map((u) => u.unit),
  keys: merged,
  leftovers: ok.flatMap((r) => (r.leftover ?? []).map((l) => `${r.unit}: ${l}`)),
}
