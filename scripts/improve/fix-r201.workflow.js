/**
 * r201 fix pass. No blockers this round — but one should-fix is mislabelled: cp39 introduces a NEW 500
 * PATH on two screens that previously degraded gracefully, which is a regression on shipped behaviour and
 * is treated here as a blocker. cp39 therefore gets a re-verify; the other two do not.
 */
export const meta = {
  name: 'fix-r201',
  description: 'Apply the r201 verify findings; re-verify tp1 and bora, which move money and print statutory documents',
  phases: [
    { title: 'Fix', detail: 'each branch addresses its own findings' },
    { title: 'Re-verify', detail: 'tp1 and bora — money-affecting and statutory-document changes' },
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
  "b8a": [
    {
      "sev": "should-fix",
      "trap": "Printed heading struck through by its own column rule \u2014 the exact defect class this round claims to have eliminated, and the one column the new fit test structurally cannot see",
      "detail": "lib/borang-8a-pdf.ts, amount-column heading block: `TC('CARUMAN', cx, headBot + 21, 6.5, bold)` with `cx = (COL.rm.x + RIGHT) / 2`, drawn inside the band that `for (const x of EDGES) vline(x, ey, headBot)` rules. Measured with the real embedded Helvetica-Bold: 'CARUMAN' at 6.5pt is 33.4pt wide, centred at 521.14, so it spans x=504.4..537.9 \u2014 and EDGES contains COL.sen.x = M+499 = 533, whose vertical rule runs the FULL height of the heading band (ey down to headBot, and CARUMAN sits at headBot+21, well inside it). The RM/SEN divider therefore prints straight through the word, between its 'A' and 'N'. This is the same defect the round explicitly fixed one screen earlier for the empty band (\"NO INTERNAL DIVIDERS ON AN EMPTY SHEET\u2026 drawing the usual six edges through it struck the sentence out with three vertical rules\"), and it contradicts the acceptance claim that the pages were rasterised and read at 1/20/25/0 employees \u2014 a struck-through column heading is visible on every single sheet. The new `wrapTo` fit test cannot catch it for two independent reasons: (a) the amount column is not in BORANG_8A_HEADINGS at all \u2014 the four measured headings are date/status/ic/name, while 'CARUMAN', '(5)', 'RM' and 'SEN' are hand-placed outside the exported geometry; (b) the test only measures a line's width against `col.w - PAD`, never against where the vertical rules actually fall, so a heading deliberately spanning two columns is outside its model. ('(5)' at 517.2..525.1, 'RM' at 501.9..512.1 and 'SEN' at 540.5..553.8 are all clear; only 'CARUMAN' crosses.)"
    },
    {
      "sev": "should-fix",
      "trap": "The one payroll-derived string on the page that is NOT clipped is the one the clipping helper's own comment names \u2014 and this round is what gave it a neighbour to collide with",
      "detail": "lib/borang-8a-pdf.ts: `T(form.employerName, M + 4, y4 - 14, 10, bold)` \u2014 plain `T`, no clip \u2014 while the address lines immediately below it in the same cell ARE clipped: `TClip(l, M + 4, ay, d1 - M - 10, 8.5, font, muted)`. The helper it skips is declared with the comment \"Clip to a width so a long legal name can never run into the next column.\" Available width is d1 - (M+4) = 364 - 38 = 326pt. Measured at 10pt Helvetica-Bold: 'MALAYSIAN TECHNOLOGY DEVELOPMENT CORPORATION SDN BHD' (52 ch) = 334.8pt \u2192 OVER; 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SEMBILAN SDN BHD' (56 ch) = 357.3pt \u2192 OVER. The overflow crosses the `vline(d1, y3, y5)` rule and lands in the Lembaran / Bil. Pekerja value cells, which sit in the same horizontal band: the name's baseline is y4-14 = 680.89 and those values are TC'd at y4-11.5 = 683.39, both between y4v (678.89) and y4 (694.89), with 'Lembaran' centred at (d1+d2)/2 = 414. Before this round the name was drawn at `text(form.employerName, M, 10, bold)` across the full 527pt page width with nothing to its right, so the round created the collision without adding the clip. `co.legalName` is unbounded (localization/my/borang-8a.ts:153), so this fires on any ~52+ character registered name. Not visible to the test run: nothing renders the PDF and inspects glyph positions, and the reporter's own specimen name ('ENGENIOUS SOLUTIONS SDN BHD', 169.5pt) fits comfortably."
    }
  ],
  "bora": [
    {
      "sev": "blocker",
      "trap": "Silent mid-word truncation of the authorised representative on a signed statutory form",
      "detail": "BLOCKER. /Users/zenlam/Projects/ai-hr/.claude/worktrees/r201-bora/lib/borang-a-pdf.ts:432 draws every representative value through atClip at SIG_VALUE_W = 98pt (line 124) at 8pt Helvetica-Bold \u2014 a budget of about 20 characters. On main these values were drawn UNCLIPPED (`text(v, M + 110, 8, bold)`). I rendered the form with production-shaped values and read the content stream back: repName 'NURUL HUDA BINTI ISMAIL' prints as 'NURUL HUDA BINTI ISM', repPosition 'ASSISTANT MANAGER, PEOPLE OPS' prints as 'ASSISTANT MANAGER, P', repEmail 'payroll@strada.example.com' prints as 'payroll@strada.example.'. No ellipsis, no marker \u2014 the page reads as if that is the person's name. The test fixture at test/borang-a.test.ts (repName 'CHONG PEI YUH' 63.0pt, repPosition 'ASSISTANT MANAGER' 87.8pt, repEmail 'rep@example.com' 71.0pt) is the only rep data any test exercises, and all three sit just under 98pt, so 318/318 green proves nothing about this. The new overprint guard cannot see it either: clipping is precisely how you make an overprint invisible to a collision check. Note the budget is forced by the design, not tunable: COP_BOX_X = M+178 = 212 (line 125) and the stamp box spans y 128..226, which is exactly the band the six rep rows occupy (y 220,203,186,169,152,135), so the value column genuinely cannot pass 212. The author's summary presents 'the representative's Jawatan and E-mel printed through the Cop Rasmi Majikan box \u2026 now fixed' as a win; the fix traded an overprint for a silent truncation of the signatory's legal identity on a KWSP filing. The stamp box needs to move (e.g. below the labels, or right of CATATAN) rather than the values being cut."
    },
    {
      "sev": "should-fix",
      "trap": "A guard comment asserting the opposite was left in place while the behaviour it guards was changed",
      "detail": "lib/borang-a-pdf.ts:291 now reads `for (const l of form.employerAddress.slice(0, 3))`. `addressLines` in localization/my/borang-a.ts:100-110 (and the identical core/reporting.ts:710) builds UP TO FOUR entries \u2014 addressLine1, addressLine2, addressLine3, and a `postcode city, state` tail. I rendered a 4-line address: the drawn page prints 'Level 12, Menara Satu' / 'Jalan Ampang' / 'Bukit Bintang' and DROPS '50450 Kuala Lumpur, Wilayah Persekutuan'. The postcode/state line is the one a counter clerk needs. Three things make this invisible: (a) every Borang A fixture has exactly two address lines, so no test can reach the 4th; (b) borangATextExport (lib/borang-a.ts:502) still iterates `.entries()` and prints all four, so the PDF and its 'mirror' now disagree while the mirror tests pass; (c) lib/borang-a.ts:357 still says, as the documented reason employerAddress is not a required header field, `employerAddress is excluded too: the form prints however many address lines exist` \u2014 that sentence is now false and was not updated. Separately at line 289 `atClip(form.employerName, M + 6, empTop - 20, 240, 9, bold)` newly clips the employer's legal name at 240pt: 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SELANGOR SDN BHD' (325.6pt) prints as 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI S'. On main the name was unclipped across the full page width."
    },
    {
      "sev": "should-fix",
      "trap": "The place to sign was deleted, the plan asked for it to be kept, and the text twin now advertises one the PDF does not have",
      "detail": "Plan step 5 says: 'split the single box into TANDATANGAN and COP RASMI MAJIKAN, add COP AGEN KUTIPAN.' main drew `box(M + 330, REP_BAND_TOP - 64, 197, 58)` captioned 'Tandatangan & Tarikh'. The branch draws ONE box, captioned 'Cop Rasmi Majikan' (lib/borang-a-pdf.ts:445-446). I dumped every string on the last sheet: the only 'Tandatangan' on the drawn page is the band HEADING at lib/borang-a-pdf.ts:414 ('Tandatangan Wakil Majikan', y=236). The six rep rows are Nama / No. Kad Pengenalan / Jawatan / No. Tel / Bimbit / E-mel / Tarikh \u2014 the Tarikh rule is the only blank rule, and there is no signature rule or box anywhere. Meanwhile lib/borang-a.ts:593 ADDS `'  Tandatangan       : ____________________'` to the text export, so the two outputs now disagree about whether the form can be signed. The new 'nine blocks' test asserts `flat` contains 'Tandatangan Wakil Majikan' \u2014 satisfied by the band heading alone \u2014 so the guard passes over the missing block it appears to cover."
    },
    {
      "sev": "should-fix",
      "trap": "Approved-plan wording promised five tick boxes; two shipped, and the deviation is recorded only in the renderer's own comments",
      "detail": "The approved board plan says 'a payment-method band with tick boxes for Wang Tunai, Cek, Kiriman Wang, Wang Pos and Draf Bank, plus a No. / EFT / TT reference box', and plan step 3 repeats 'five tick boxes plus a No. / EFT / TT bordered field'. lib/borang-a.ts:232 ships `['Wang Tunai', 'Cek/Kiriman Wang/Wang Pos']` \u2014 two ticks, with Draf Bank folded onto the reference line. Approve carries no payload, so the reporter approved that sentence; an operator paying by Wang Pos now ticks a box that also means Cek and Kiriman Wang. The justification ('the specimen groups them') is asserted in a comment and is not checkable from the diff. Also, the reference label literal at lib/borang-a.ts:235 is `'/Draf Bank*No /EFT /TT. :'` \u2014 a leading slash, an inline `*No`, and a stray full stop before the colon. That string prints verbatim on the form; the Latin-1 test only proves it round-trips, not that it reads as Malay. Compare the sibling form, which uses 'No. Cek / Kiriman Wang'. Both of these want a line in whatever goes back to the reporter, not just in the source."
    }
  ],
  "tp1": [
    {
      "sev": "blocker",
      "trap": "Per-month records feed payroll latest-wins, but the limit check accumulates across months \u2014 no data entry is both accepted and correct",
      "detail": "core/payroll.ts:2118-2121 still resolves ONE annual figure per person: `if (!annualByPerson.has(d.personId)) annualByPerson.set(d.personId, Number(d.amount)) // latest wins`, over rows ordered `desc(createdAt)`. That was right when a year held one declaration. This round makes a year hold twelve (deduction_month) and makes core/tax-relief.ts assertWithinRemaining ADDITIVE across them \u2014 the screen's strip reads `remaining = limit - accumulated` and the refusal says \"RM X has already been approved... so at most RM Y can be claimed now\", which teaches the user to enter only the INCREMENT. Concrete: January C4 medical 3,000 approved, fed 3,000 (lpAcc=3,000). June: HR files a second TP1 for another 2,000 medical; validation accepts (3,000+2,000 <= the 10,000 group limit); approved from June. The June prefill now takes annual = 2,000 (latest row) and feeds `max(0, 2000 - 3000) = 0`. The employee's year-to-date relief stays 3,000 instead of 5,000 and the newly approved 2,000 never reaches payroll at all \u2014 silently, with no error anywhere. The branch's own passing fixture builds this state (test/tp1-2026-form.test.ts:234-250 approves Jan C5=1,800 then accepts Feb C5=700) but never runs prefillTp1FromSelfRelief afterwards, which is exactly why the targeted run is green. The alternative reading \u2014 restate the cumulative total each month \u2014 is also accepted by the server and then double-counts on the third declaration. ADR-0081 (lines 47, 54-61) states both halves and never reconciles them. Either the feed must sum the approved months (and the delta method re-derived), or the accumulation must be dropped and each month treated as a full restatement; the two cannot ship together."
    },
    {
      "sev": "blocker",
      "trap": "A correction to an already-approved month is refused by its own prior figure, and the HR screen's \"remaining\" strip disagrees with the server",
      "detail": "submitTp1ForPersonId (core/tax-relief.ts, the block introduced before the INSERT) accumulates over EVERY approved row for the person/year with no exclusion: `.where(and(eq(personId), eq(assessmentYear, year), eq(status,'approved')))` then `assertWithinRemaining(categories, accumulate(rows))`. Approval is an UPDATE, and a correction is a NEW row, so the superseded approved row is still status='approved' and still counted. January C5 = 2,500 approved (limit 2,500); HR opens January to correct it to 2,400 and the server refuses with \"RM 2,500.00 has already been approved for this assessment year, so at most RM 0.00 can be claimed now\" \u2014 the row is refusing itself, and no correction to any approved catalogue declaration is possible. Meanwhile the HR page (app/payroll/transactions/tp1/[year]/[month]/page.tsx) passes `excludeRowId: latest?.id`, so the strip shows remaining 2,500 while the server enforces 0. That directly falsifies the header claim at core/tax-relief.ts getTp1AccumulatedForPerson (\"the SAME function on both sides, so the number the screen shows as remaining is the number the server will enforce. Not two implementations that agree today\") and the same claim in the form's header. Third disagreement: /me passes NO excludeRowId (app/me/tax-relief/page.tsx `getTp1Accumulated(s, { assessmentYear: selectedYear })`), so the one shared form shows two different remaining figures on its two surfaces. No test covers correct-after-approve: test/tp1-2026-form.test.ts:508 exercises a January correction only while the first row is still unapproved."
    },
    {
      "sev": "should-fix",
      "trap": "The generated statutory form prints as '?' for four of six locales \u2014 the repo's own EA_LANGS guard was not copied",
      "detail": "app/payroll/transactions/tp1/[year]/[month]/pdf/route.ts:69 calls `getTranslations('taxRelief')` with no locale restriction, and every word of the form body comes from it: 17 item labels, ~25 sub-line labels, the frequency notes, `declarationText` and the provenance band. lib/tp1-pdf.ts embeds StandardFonts.Helvetica (WinAnsi) and folds with `safe = (s) => fold(s).replace(/[^\\x20-\\x7E\\xA0-\\xFF]/g, '?')`. messages/ta.json, zh.json, th.json and vi.json translate every one of those keys (e.g. taxRelief.items.c1.label = '\u0baa\u0bc6\u0bb1\u0bcd\u0bb1\u0bcb\u0bb0\u0bcd/\u0ba4\u0bbe\u0ba4\u0bcd\u0ba4\u0bbe \u0baa\u0bbe\u0b9f\u0bcd\u0b9f\u0bbf\u0b95\u0bcd\u0b95\u0bbe\u0ba9 \u0b9a\u0bc6\u0bb2\u0bb5\u0bc1\u0b95\u0bb3\u0bcd', '\u7236\u6bcd\uff0f\u7956\u7236\u6bcd\u7684\u652f\u51fa', '\u0e04\u0e48\u0e32\u0e43\u0e0a\u0e49\u0e08\u0e48\u0e32\u0e22\u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e1a\u0e34\u0e14\u0e32\u0e21\u0e32\u0e23\u0e14\u0e32/\u0e1b\u0e39\u0e48\u0e22\u0e48\u0e32\u0e15\u0e32\u0e22\u0e32\u0e22', 'Chi ph\u00ed cho cha m\u1eb9/\u00f4ng b\u00e0' \u2014 Vietnamese diacritics are outside Latin-1 too). A ta/zh/th/vi session downloading their TP1 gets a form whose entire Section C reads as rows of '?'. The repo already solved this: app/me/ea/[employmentId]/pdf/route.ts:28 pins `EA_LANGS = ['en','ms']` and app/payroll/statutory-forms/[formId]/page.tsx:47 mirrors it, both pinned by test/statutory-forms-page.test.ts:411,801. The new route copied the CP22 route's shape but not that guard. No test renders the PDF (the suite mocks getTranslations to an identity function), so nothing can see it."
    },
    {
      "sev": "should-fix",
      "trap": "Section F's approver Name is never rendered or printed \u2014 hardcoded null on both surfaces",
      "detail": "The plan's Expected Function \u00a79 requires 'Employer/HR Name' on the employer-consent block, and the printed form has the box. app/payroll/transactions/tp1/[year]/[month]/page.tsx passes `approvedByName: null` with the comment 'Not yet joined here'; the pdf route passes `name: null` with the same note. db/schema.ts deliberately does not store the name (`approved_by` FK only) and nothing joins app_user to resolve it, so the Name box prints its blank rule on every approved declaration and the screen shows an em dash. The approver's identity \u2014 the one fact Section F exists to record besides the month \u2014 is captured in the database and shown nowhere. Both comments acknowledge the gap rather than closing it."
    }
  ]
};

const WORK = [
  { slug: 'tp1', ns: 'r201tp1', id: '7ad37961', reverify: true,
    head: `TWO BLOCKERS AND BOTH MOVE MONEY SILENTLY. Fix both or return testsPass=false.\n` +
          `  · The payroll feed still takes ONE annual figure per person (latest wins) while this round made ` +
          `declarations ADDITIVE across months and teaches the user to enter only the increment. A second ` +
          `TP1 in June therefore REDUCES the relief fed to payroll instead of adding to it, with no error ` +
          `anywhere. Your own fixture builds that state and never runs the prefill afterwards.\n` +
          `  · A correction to an already-approved month is refused BY ITS OWN PRIOR FIGURE, because ` +
          `approval is an UPDATE and a correction is a NEW row, so the superseded row is still counted. The ` +
          `HR screen passes excludeRowId and the server does not, so the strip and the server disagree — ` +
          `which falsifies the header's own claim that both sides call the same function. /me passes no ` +
          `excludeRowId at all. Make the two sides genuinely one answer.` },
  { slug: 'bora', ns: 'r201bora', id: 'cc9f9420', reverify: true,
    head: `ONE BLOCKER, on a SIGNED STATUTORY FORM. Every authorised-representative value is now drawn ` +
          `through a 98pt clip that silently truncates mid-word — 'NURUL HUDA BINTI ISMAIL' prints as ` +
          `'NURUL HUDA BINTI ISM' with no ellipsis and no marker, so the page reads as if that is the ` +
          `person's name. On main these were drawn UNCLIPPED. The only rep values any test exercises happen ` +
          `to sit just under the budget, so a green suite proves nothing here, and an overprint guard ` +
          `cannot see it because clipping is exactly how you hide an overprint. The width is forced by the ` +
          `stamp box, so widening alone is not available: shrink to fit, wrap, or reposition — but a name ` +
          `on a statutory form must never be silently cut.` },
  { slug: 'b8a', ns: 'r201b8a', id: '16f2aac1', reverify: false,
    head: `No blockers — two should-fix. This branch did unusually careful work (it rasterised the output ` +
          `and found two defects only rasterising could see). Keep that standard and change nothing else.` },
];

const preamble = (w) =>
  `You are FIXING verify findings on an existing branch. The work is committed and green; do not regress it.\n\n` +
  `🔒 WORKTREE: ${WT}/r201-${w.slug} (branch build/r201-${w.slug}). \`cd\` there FIRST, confirm with \`pwd\` ` +
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
      `Second look at a fix for a REGRESSION. Branch build/r201-${w.slug} in ${WT}/r201-${w.slug}; read it ` +
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
