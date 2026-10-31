/**
 * r199 fix pass. No blockers this round — but one should-fix is mislabelled: cp39 introduces a NEW 500
 * PATH on two screens that previously degraded gracefully, which is a regression on shipped behaviour and
 * is treated here as a blocker. cp39 therefore gets a re-verify; the other two do not.
 */
export const meta = {
  name: 'fix-r199',
  description: 'Apply the r199 verify findings; re-verify the stamp workstream',
  phases: [
    { title: 'Fix', detail: 'each branch addresses its own findings' },
    { title: 'Re-verify', detail: 'stamp only — the reporter already rejected one attempt at it' },
  ],
};

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean' },
    addressed: { type: 'array', items: { type: 'string' } },
    declined: { type: 'array', items: { type: 'string' } },
    commitSha: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['testsPass', 'addressed'],
};
const RE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    resolved: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'reject'] },
  },
  required: ['verdict', 'resolved', 'unresolved'],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
// The APPROVED plan text is the `plan` field of these JSON payloads — the ones actually pushed to the
// board and approved this morning. scratchpad/plans/<id>.md is the PRE-REPLAN capture and is stale for
// every item in this round; pointing a fix agent at it would scope the work to a plan nobody approved.
const PLANJSON = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad';
// Findings are EMBEDDED, not read from disk: workflow scripts have no filesystem and no Node APIs, and
// an earlier `require('fs')` here killed the run at line 1 before any agent started.
const F = {
  "stamp": [
    {
      "trap": "THE COMMENT IS THE GUARD \u2014 falsified invariant left standing in the file the change edited",
      "detail": "core/payroll.ts:3828-3830 still reads: \"Forward-only. Payslips already written keep the string they stored; nothing re-derives a historical line from today's catalogue, which would answer with today's naming about a month already paid.\" That is precisely what 417d4937's `recordLineIdentity` now makes FOUR screens do (transaction-view/history-table.tsx, history-pivot.ts, individual-payslip/page.tsx, me/payslip/[payslipId]/page.tsx). The diff touched core/payroll.ts in four hunks (468, 4287, 4721, 4958) and left this one untouched 400 lines away. It is the sentence the next kernel change will reason from, and it now says the opposite of what the system does \u2014 the exact shape of r196's finding 3 ('fixing those two left THREE more statements of the dead rule, one of them in a file the change had itself edited'). Update it in place, do not delete it: it still correctly describes what the KERNEL does; what changed is that the READ side no longer honours it."
    },
    {
      "trap": "Screen/export drift \u2014 the History tab's Excel file carries the same unrepaired names",
      "detail": "app/payroll/transaction-view/history-export.ts:198 builds the 'Recorded:' column headers from the stored line name: `for (const l of b.recordLines) if (!recordedNames.get(l.code)) recordedNames.set(l.code, l.name || '')`. No `payItemNames`, no `recordLineIdentity`, and `buildHistoryExport`'s signature was not widened. The file's own header (lines 18-20) claims 'A REGROUP, NEVER A RECOMPUTATION ... The file and the panel therefore cannot disagree, which is the whole point of an export used for reconciliation.' After this diff the panel (history-table.tsx) prints the repaired label and the sheet prints the remark, so they do disagree. Note the diff DID edit this file \u2014 only the `detailNotRecorded` comment at lines 188-194 \u2014 so the file was open and this was passed over."
    },
    {
      "trap": "Falsified invariant left standing in the same file the change edited (second instance)",
      "detail": "app/payroll/transaction-view/history-pivot.ts:263-265 \u2014 the doc on `HistoryGrid.detailNotRecorded` still reads 'At least one folded run predates the per-item stamp (862ed0ad) **or is an additional run, which never stamps one**. Its pay items were never written down and cannot be reconstructed.' The diff rewrote the same claim in three other places in this exact file (lines 34-36, 475-477, 527-529) and rewrote `payroll.transactions.view.grid.detailNotRecorded` in all six catalogues specifically to delete that clause \u2014 so the type doc now contradicts the caption it drives. Same dead sentence also survives at test/history-pivot.test.ts:323-324."
    },
    {
      "trap": "Rule (a) reversed for a population the justification does not cover \u2014 non-payable BIK record lines",
      "detail": "`recordLineIdentity` (core/payslip-earning-lines.ts:126-135) applies to EVERY entry of `statutory.recordLines` with no branch. The docblock's justification (lines 88-96) is population-specific: 'A record line's `name` is not provenance \u2014 before r196 it was a free-text remark that had no defined relationship to the item at all.' That is true only of the txn-derived lines pushed by `pushTxnLine`. `recordLines` is an explicitly MIXED array (core/payroll.ts:3684-3692 says so in as many words), and the BIK half is pushed at core/payroll.ts:4175 and 4222 as `recordLines.push({ code: c.code, name: c.name, amount: applied, nonPayable: true })` \u2014 `c.name` is the pay item's OWN description as it stood when the run folded it, i.e. genuine provenance of exactly the kind rule (a) protects. Failure case: a tenant renames pay item A0055 'MEDICAL BIK' to 'MEDICAL BENEFIT' in March. Every January payslip's BIK line now prints 'A0055 \u00b7 MEDICAL BENEFIT' with the caption `itemRemark`/`recordLineRemark` \u2014 'Entered as \"MEDICAL BIK\"' \u2014 asserting that an operator typed words the SYSTEM generated. The `nonPayable` flag is the discriminator and it is already on the line (stamped false by `pushTxnLine`, true by both BIK sites); the pre-flag population would need the unflagged-list treatment the kernel comment already prescribes."
    },
    {
      "trap": "Over-broad read \u2014 the source panel ships every employee's ledger rows into the client payload",
      "detail": "`listPayslipSourceTxns` (core/payroll-view.ts:493-512) filters on `batchIds` + `companyIds` and takes NO employment scope. app/payroll/transaction-view/page.tsx:246-258 then folds the whole result into `sourceTxnsByPayslip` and hands it to the client `HistoryTable`, so a History tab filtered to ONE employee still serialises every one-off transaction \u2014 amount, notes, pay item, employment id \u2014 for every employee in every one of the (up to HISTORY_ROW_CAP=200) shown runs, into the RSC flight payload. Nothing extra RENDERS, because the lookup is keyed `${batchId}:${employmentId}`, which is exactly why no DOM test can see it; test/source-txn-panel-417d4937.dom.test.tsx:149 pins the over-broad call as correct ('passes the scoped company ids and the runs on screen'). Not a permission break \u2014 the Individual tab under the same `scopedAdmin()` fence already lists these rows \u2014 but a 12-month filter on one employee in a 500-head company fetches and ships the whole company's ledger. The individual-payslip caller (page.tsx:257-262) also fetches the whole batch and discards with a JS `.filter(r => r.employmentId === row.employmentId)`, which is the shape the read should have had."
    }
  ],
  "paysettings": [
    {
      "trap": "incidental fix un-hides a hardcoded English string in six locales",
      "detail": "app/admin/payroll-config/actions.ts:91 \u2014 `withParam(configCompanyHref(companyId, q), 'toast', 'Payroll config saved')`. The summary's own incidental fix is what makes this reachable: on main the success `back('Payroll config saved')` threw NEXT_REDIRECT INSIDE the try, was caught, and re-emitted as `?error=NEXT_REDIRECT`, so the English toast was never rendered. Now that redirect() is outside the try, the string lands on `?toast=` and `ToastFromQuery` (globally mounted at app/layout.tsx:230) renders it RAW \u2014 in ms/ta/th/vi/zh too. The repo states the rule in the file next door (app/admin/payroll-cycle/actions.ts:65-68 `toastMsg()` \u2192 `t('toast.saved')`, and app/admin/_redirects.ts:54-55 \"Localise the text before calling \u2014 ToastFromQuery renders the raw string, so never pass an i18n key/code in the URL\"). The summary claims this action \"now uses the ok/err shape the payroll-cycle siblings always used\" \u2014 it adopted the shape but not the localisation half. Nothing can catch it: i18n-coverage checks catalogues, not string literals in redirects, and test/hrdf-contribution-rate.test.ts:196 only asserts `to).toContain('/admin/payroll-config')`, which was true before AND after the bug. Same class on the failure branch: line 78 `err = (e as Error).message` ships the raw English service message (e.g. InvalidDefaultPolicyError's sentence) into ErrorBanner, where the sibling uses `localise(e)`."
    },
    {
      "trap": "presence-vs-value on the empty state \u2014 one string doing two jobs",
      "detail": "app/admin/payroll-config/page.tsx:136 renders `t('emptyScope')` for the table's empty row. `payrollConfig.emptyScope` is \"No companies in the current scope. Use the company switcher above.\" \u2014 but that row now fires in TWO different situations, because `rows` is `companies` filtered by the new `q` search (page.tsx, `const rows = needle ? companies.filter(...) : companies`). A user who types a search term that matches nothing is told their scope is empty and pointed at a company switcher, when what they need is to clear the search box directly above. The sibling listing got this right and added a dedicated key: app/admin/payroll-cycle/page.tsx:148 renders `t('emptyCompanies')` = \"No companies match your search.\" No equivalent key was added to the payrollConfig namespace (the 14 new keys contain no `emptyCompanies`). Invisible to every gate: the key resolves, so i18n-coverage passes, tsc passes, and the page returns 200 with plausible-looking text."
    }
  ],
  "txnsearch": [
    {
      "trap": "THE COMMENT IS THE GUARD \u2014 a documented invariant is falsified and the sentence is left standing",
      "detail": "components/collapsible-employee-panel.tsx:60 still reads `/** Cookie persisting the choice. One per screen, so the two do not share a state. */`. This diff puts FIVE cookie keys on ONE screen, and its own new comment at app/payroll/transaction-view/page.tsx:80-88 says the opposite in capitals: \"ONE COOKIE PER TAB. Per TAB and not per screen, deliberately.\" The author updated the neighbouring stale sentence in the same file (the \"Six screens render this component\u2026\" order note at line ~340 was rewritten to mention all five tabs) but walked past this one. The prop doc is the contract every future consumer reads before choosing a cookieKey; leaving it saying \"one per screen\" is precisely the sentence that makes the next author collapse the five keys back into one and silently undo the per-tab behaviour this round just built. Fix is one line, in the same file the diff already touches."
    },
    {
      "trap": "Plan fidelity in the OTHER direction / an unshown trade-off \u2014 the panel is forced open in the state that is the default, so the width just granted is taken back",
      "detail": "app/payroll/transaction-view/page.tsx:315 \u2014 `tabPanelDefaultOpen = employmentId == null || cookieStore.get(TAB_PANEL_COOKIES[tab])?.value !== '0'`. When nobody is selected the cookie is IGNORED, unconditionally. But \"nobody selected\" is the DEFAULT and normal state of all four inquiry tabs \u2014 the author's own justification for `allowAll` is that these are \"cross-employee lists\" whose opening view is everybody, and History is the landing tab. Consequence: on the default view the collapse control does not survive a single server navigation. Collapse the panel on History, hit Apply filters (a GET form submit), and it is open again; same for every tab switch, refresh, or back/forward. `CollapsibleEmployeePanel` sets `lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]` when open, so the 13-column History table permanently loses ~22rem + gap in its default state and cannot keep it back.\n\nThis falsifies two comments written in this very diff: page.tsx:449-450 claims \"nothing gave up width for it, and every tab is still pageWideCls with the panel folding away to hand its width back to the table\" \u2014 the folding does not stick where it matters; and page.tsx:83 justifies per-tab cookies with \"History is thirteen columns wide and is read with the panel folded away\" \u2014 for History's default state that cookie is inert, so the stated reason for the whole TAB_PANEL_COOKIES map does not hold on the tab it cites.\n\nIt also walks straight into the warning mainwt/HANDOFF.md:186-197 calls \"THE MOST EXPENSIVE LESSON ON THIS BOARD\": r179 removed the panel for width, the reporter contested, r185 put it back, and 1372d169/152fea7f (shipped in r197, the merge immediately under this branch) gave these four tabs full width. HANDOFF says explicitly \"Full width and the left panel are the SAME trade-off they have now reversed once in each direction\" and \"Whoever plans it must show both states and say plainly that this is the choice.\" Adding the rail is defensible and is what was asked for; adding it in a mode where the reader cannot fold it away in the default view is the half nobody has been shown. Either drop the force-open to a first-visit-only rule (force open only when no cookie is set) or get the reporter to see the narrowed History tab before this ships."
    },
    {
      "trap": "What a targeted run structurally cannot see \u2014 the two new mechanisms have zero assertions",
      "detail": "Nothing anywhere asserts `defaultOpen` or `cookieKey` for the four tabs. test/employee-scope-panel-guard.test.ts's new cases read `findByType(tree, CollapsibleEmployeePanel)` only to assert `toHaveLength(1)`, and then read props off `EmployeeScopePanel` \u2014 never off the shell. So: reverting `tabPanelDefaultOpen` to a plain cookie read (deleting the `employmentId == null ||` clause the summary sells as the feature), or mistyping TAB_PANEL_COOKIES so that e.g. `history` and `outstanding` share one key \u2014 the exact drift the map exists to prevent \u2014 passes every test in this diff, passes tsc, and passes `next build`. Given the whole round's rationale for a five-entry map is that the tabs must not overwrite each other's answer, the map deserves one assertion that its five values are distinct and that `grid` is still GRID_PANEL_COOKIE (the compatibility promise in the comment at page.tsx:85)."
    }
  ],
  "holidays": [
    {
      "trap": "Rule 6 \u2014 the render check, which no source-shape test can substitute for",
      "detail": "The author flags this himself and it is genuinely owed. The MISSING_MESSAGE risk is low and I confirmed why (nav.holidays is present and translated in all six catalogues, and sidebar.tsx resolves it through the same `useTranslations('nav')` the pack rows used, so the namespace does not change with the container). What a dev-server render would actually catch, and what nothing in this diff can: the System Settings fly-out now carries SEVEN children where it carried five when its panel layout was last looked at; the parent-highlight ownership of /admin/holidays has moved from Attendance settings to System Settings via isParentActive, and the fly-out's longest-href-wins ranking (sidebar.tsx:441-443) now resolves /admin/holidays/groups inside a different node's child set. All three are rendering behaviour, all three pass tsc, the targeted suite and next build. The plan's VERIFY step \u2014 expand System Settings, confirm the row renders and highlights on both /admin/holidays and /admin/holidays/groups, confirm Attendance settings shows six children, read the dev log \u2014 remains the parent's gate before deploy."
    }
  ]
};

const WORK = [
  { slug: 'stamp', ns: 'r199stamp', id: '6b134681', reverify: true,
    head: `The reporter already rejected ONE attempt at this pair. Its BLOCKER (the Grid export missing the ` +
          `label repair) has ALREADY been fixed by hand on your branch, with a source-shape guard across ` +
          `both call sites — do not redo it and do not weaken that guard. Address the should-fix items ` +
          `below without disturbing it.` },
  { slug: 'paysettings', ns: 'r199paysettings', id: '6df24751', reverify: false,
    head: `Largest item in the round, and it carries the round's only migration (0443). Do not touch the ` +
          `migration or the journal unless a finding names them.` },
  { slug: 'txnsearch', ns: 'r199txnsearch', id: 'bd14b7e2', reverify: false,
    head: `Scoped to one page. Keep it there — sibling worktrees are editing neighbouring payroll screens ` +
          `and every file you touch outside your page is a conflict someone resolves blind.` },
  { slug: 'holidays', ns: 'r199holidays', id: '4509d2b8', reverify: false,
    head: `Verified SHIP with a single should-fix. Make the smallest correct change and stop.` },
];

const preamble = (w) =>
  `You are FIXING verify findings on an existing branch. The work is committed and green; do not regress it.\n\n` +
  `🔒 WORKTREE: ${WT}/r199-${w.slug} (branch build/r199-${w.slug}). \`cd\` there FIRST, confirm with \`pwd\` ` +
  `and \`git branch --show-current\`, run everything from there. READ ${MAIN} freely; never edit it, never ` +
  `touch a sibling worktree. Read what is already on your branch with \`git diff main...HEAD\` first — the ` +
  `findings are about THAT diff.\n\n` +
  `TEST DB NAMESPACE \`${w.ns}\` on EVERY vitest run: TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>. ` +
  `Never omit it, never invent another, never run the full suite.\n\n` +
  `APPROVED PLAN for scope (read its "plan" field): ${PLANJSON}/plan-${w.id}.json. Fixing a finding never licenses new scope.\n\n` +
  `GATE before testsPass=true: tsc clean, your touched tests green, \`pnpm build\` compiles, then commit. ` +
  `Never weaken or delete a test; if a guard asserts the opposite of your change, UPDATE the case. No dev ` +
  `server, no watch mode. Long output to a file with \`> log 2>&1\`, never a pipe.\n\n` +
  `You may DECLINE a finding you can show is wrong — put it in \`declined\` with evidence.\n\n` +
  `${w.head}\n\nFINDINGS:\n` +
  (F[w.slug] || []).map((f, i) => `\n[${i + 1}] ${f.trap}\n${f.detail}`).join('\n');

phase('Fix');
phase('Re-verify');

const results = await pipeline(
  WORK,
  (w) => agent(preamble(w), { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${w.slug}`, effort: 'xhigh' }).then((fix) => ({ w, fix })),
  (prev) => {
    const { w, fix } = prev || {};
    if (!w) return null;
    if (!w.reverify || !fix?.testsPass) return { w, fix, re: null };
    return agent(
      `Second look at a fix for a REGRESSION. Branch build/r199-${w.slug} in ${WT}/r199-${w.slug}; read it ` +
        `with \`git diff main...HEAD\`. READ-ONLY — no edits, no test suite.\n\n` +
        `The findings raised:\n` + (F[w.slug] || []).map((f) => `- ${f.trap}: ${f.detail.slice(0, 400)}`).join('\n') +
        `\n\nThe author says:\n${(fix.addressed || []).map((a) => `  - ${a}`).join('\n')}\n` +
        ((fix.declined || []).length ? `Declined:\n${fix.declined.map((d) => `  - ${d}`).join('\n')}\n` : '') +
        `\nDecide from the CODE whether each is genuinely resolved. Specifically: can you still reach a 500 ` +
        `on either screen with an input a user can produce? Construct the input if so. Then look once for a ` +
        `defect the fix introduced. verdict=ship only if nothing is left.`,
      { schema: RE_SCHEMA, phase: 'Re-verify', label: `reverify:${w.slug}`, effort: 'high' },
    ).then((re) => { log(`reverify:${w.slug} → ${re?.verdict} (${(re?.unresolved || []).length} unresolved)`); return { w, fix, re }; });
  },
);

const out = results.filter(Boolean).map((r) => ({
  slug: r.w.slug, id: r.w.id, testsPass: !!r.fix?.testsPass, commitSha: r.fix?.commitSha || '',
  addressed: r.fix?.addressed || [], declined: r.fix?.declined || [], blockers: r.fix?.blockers || [],
  reverify: r.re?.verdict || 'n/a', unresolved: r.re?.unresolved || [],
}));
log(`fix pass: ${out.filter((o) => o.testsPass).length}/${out.length} green`);
return out;
