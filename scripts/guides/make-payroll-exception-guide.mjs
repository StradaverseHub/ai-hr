// Regenerate: node --import tsx scripts/guides/make-payroll-exception-guide.mjs docs/guides/payroll-exception-checking.pdf
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'node:fs';

const OUT = process.argv[2];
const A4 = [595.28, 841.89];
const M = { l: 56, r: 56, t: 58, b: 58 };
const W = A4[0] - M.l - M.r;

const INK = rgb(0.11, 0.12, 0.14);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);
const ACCENT = rgb(0.05, 0.32, 0.55);
const WARN = rgb(0.62, 0.21, 0.05);
const OKBG = rgb(0.93, 0.97, 0.93);
const CODEBG = rgb(0.96, 0.965, 0.975);
const WARNBG = rgb(0.99, 0.955, 0.92);
const BLOCKBG = rgb(0.99, 0.93, 0.93);
const REVIEWBG = rgb(0.999, 0.97, 0.88);

const doc = await PDFDocument.create();
doc.setTitle('AI-HR — Payroll exception checking: how to use it');
doc.setAuthor('AI-HR');
doc.setSubject('Operator guide to the payroll control tower (ADR-0076)');

const F = await doc.embedFont(StandardFonts.Helvetica);
const FB = await doc.embedFont(StandardFonts.HelveticaBold);
const FO = await doc.embedFont(StandardFonts.HelveticaOblique);
const FM = await doc.embedFont(StandardFonts.Courier);
const FMB = await doc.embedFont(StandardFonts.CourierBold);

let page, y, pageNo = 0;

function newPage() {
  page = doc.addPage(A4);
  pageNo += 1;
  y = A4[1] - M.t;
  page.drawText(`AI-HR  ·  Payroll exception checking  ·  page ${pageNo}`, {
    x: M.l, y: 32, size: 7.5, font: F, color: MUTED,
  });
}
function space(n) { y -= n; if (y < M.b + 40) newPage(); }

function wrap(text, font, size, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const probe = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(probe, size) > width && line) { out.push(line); line = word; }
      else line = probe;
    }
    out.push(line);
  }
  return out;
}
function text(str, { size = 9.6, font = F, color = INK, gap = 3.2, indent = 0 } = {}) {
  for (const line of wrap(str, font, size, W - indent)) {
    if (y < M.b + 24) newPage();
    page.drawText(line, { x: M.l + indent, y, size, font, color });
    y -= size + gap;
  }
}
function h1(str) {
  space(16);
  if (y < M.b + 110) newPage();
  page.drawText(str, { x: M.l, y, size: 15, font: FB, color: INK });
  y -= 20;
  page.drawLine({ start: { x: M.l, y: y + 6 }, end: { x: M.l + W, y: y + 6 }, thickness: 0.8, color: RULE });
  y -= 8;
}
/** Force a break when the next block would be split across pages — keeps a heading with its content. */
function needSpace(n) { if (y - n < M.b + 24) newPage(); }

function h2(str) {
  space(9);
  if (y < M.b + 70) newPage();
  page.drawText(str, { x: M.l, y, size: 11, font: FB, color: ACCENT });
  y -= 16;
}
function bullet(str, indent = 0) {
  const lines = wrap(str, F, 9.6, W - 14 - indent);
  lines.forEach((line, i) => {
    if (y < M.b + 24) newPage();
    if (i === 0) page.drawText('•', { x: M.l + indent, y, size: 9.6, font: F, color: MUTED });
    page.drawText(line, { x: M.l + indent + 14, y, size: 9.6, font: F, color: INK });
    y -= 12.8;
  });
}
function code(lines, label = null) {
  const arr = Array.isArray(lines) ? lines : [lines];
  const flat = arr.flatMap((l) => wrap(l, FM, 8.6, W - 24));
  const h = flat.length * 12 + 16 + (label ? 13 : 0);
  if (y - h < M.b + 20) newPage();
  page.drawRectangle({ x: M.l, y: y - h + 8, width: W, height: h, color: CODEBG });
  page.drawRectangle({ x: M.l, y: y - h + 8, width: 2.5, height: h, color: ACCENT });
  let yy = y - 6;
  if (label) { page.drawText(label, { x: M.l + 12, y: yy, size: 7.5, font: FB, color: MUTED }); yy -= 13; }
  for (const line of flat) {
    const c = line.trimStart().startsWith('#');
    page.drawText(line, { x: M.l + 12, y: yy, size: 8.6, font: c ? FM : FMB, color: c ? MUTED : INK });
    yy -= 12;
  }
  y = y - h - 4;
}
function panel(title, body, tone = 'ok') {
  const bg = tone === 'warn' ? WARNBG : tone === 'block' ? BLOCKBG : OKBG;
  const edge = tone === 'warn' ? WARN : tone === 'block' ? rgb(0.6, 0.12, 0.15) : rgb(0.16, 0.45, 0.24);
  const bodyLines = wrap(body, F, 9.2, W - 26);
  const h = bodyLines.length * 12.4 + 30;
  if (y - h < M.b + 20) newPage();
  page.drawRectangle({ x: M.l, y: y - h + 8, width: W, height: h, color: bg });
  page.drawRectangle({ x: M.l, y: y - h + 8, width: 3, height: h, color: edge });
  let yy = y - 6;
  page.drawText(title, { x: M.l + 13, y: yy, size: 9.4, font: FB, color: edge });
  yy -= 15;
  for (const line of bodyLines) { page.drawText(line, { x: M.l + 13, y: yy, size: 9.2, font: F, color: INK }); yy -= 12.4; }
  y = y - h - 4;
}
/** A check description: name, severity chip, what it means, what to do. */
function check(name, severity, meaning, todo) {
  const sevBg = severity === 'Blocks the close' ? BLOCKBG : REVIEWBG;
  const sevInk = severity === 'Blocks the close' ? rgb(0.6, 0.12, 0.15) : rgb(0.55, 0.35, 0.02);
  const meaningLines = wrap(meaning, F, 9.2, W - 24);
  const todoLines = wrap(`What to do: ${todo}`, F, 9.2, W - 24);
  const h = 18 + meaningLines.length * 12.2 + todoLines.length * 12.2 + 16;
  if (y - h < M.b + 20) newPage();
  page.drawRectangle({ x: M.l, y: y - h + 8, width: W, height: h, color: rgb(0.985, 0.985, 0.99) });
  page.drawRectangle({ x: M.l, y: y - h + 8, width: 2.5, height: h, color: RULE });
  let yy = y - 5;
  page.drawText(name, { x: M.l + 12, y: yy, size: 9.8, font: FB, color: INK });
  const chipW = FB.widthOfTextAtSize(severity, 7.4) + 12;
  page.drawRectangle({ x: M.l + W - chipW - 10, y: yy - 3, width: chipW, height: 13, color: sevBg });
  page.drawText(severity, { x: M.l + W - chipW - 4, y: yy, size: 7.4, font: FB, color: sevInk });
  yy -= 16;
  for (const l of meaningLines) { page.drawText(l, { x: M.l + 12, y: yy, size: 9.2, font: F, color: INK }); yy -= 12.2; }
  for (const l of todoLines) { page.drawText(l, { x: M.l + 12, y: yy, size: 9.2, font: FO, color: MUTED }); yy -= 12.2; }
  y = y - h - 4;
}

// ───────────────────────────── COVER ─────────────────────────────
newPage();
page.drawRectangle({ x: 0, y: A4[1] - 142, width: A4[0], height: 142, color: rgb(0.055, 0.13, 0.22) });
page.drawText('AI-HR', { x: M.l, y: A4[1] - 54, size: 21, font: FB, color: rgb(1, 1, 1) });
page.drawText('Payroll exception checking', { x: M.l, y: A4[1] - 84, size: 16, font: FB, color: rgb(0.88, 0.93, 0.98) });
page.drawText('How to use it', { x: M.l, y: A4[1] - 105, size: 12, font: F, color: rgb(0.72, 0.79, 0.88) });
page.drawText('For the person who runs payroll', { x: M.l, y: A4[1] - 126, size: 9.5, font: F, color: rgb(0.58, 0.67, 0.79) });
y = A4[1] - 142 - 26;

h1('1.  What this is, and the problem it solves');

text('Checking a payroll run by hand does not scale. At a few dozen people you can eyeball every payslip. At a few hundred you spot-check and hope. At a few thousand, nobody reads them at all — and the mistakes that reach a bank file or a statutory submission are the ones nobody looked at.');
space(3);
text('So the system reads every payslip in a run, every night, and sorts people into three piles: fine, worth a look, and stop. You work the second and third piles. That is the whole idea — you are not checking payroll, you are deciding on the handful of cases the checks could not settle by themselves.');
space(3);

panel(
  'Nothing here changes anyone\'s pay',
  'The checks only READ payslips. They cannot alter a figure, a total, or a statutory contribution — the payroll calculation is untouched and runs exactly as it always has. The only thing a check can do is refuse to let a run be closed until you have looked at something. Running the checks, re-running them, or running them ten times, is always safe.',
);

h1('2.  The daily rhythm');

bullet('Overnight, at 02:30, the system checks every payroll run that has been processed but not yet closed.');
bullet('In the morning, the run has an exceptions list waiting. You do not have to start the check yourself.');
bullet('You open Payroll, choose the run, and click Payroll exceptions.');
bullet('You work down the list. Anything marked Blocked has to be dealt with before the run can be closed; anything marked Needs review is for your judgement and does not hold the run up.');
space(3);
text('You can also check a run yourself at any time, from the same screen. Do that after you fix something, so the list catches up — it takes seconds and it replaces the previous result rather than piling up beside it.');

h1('3.  Reading the four numbers at the top');

text('The strip across the top of the exceptions screen is the run in four figures. The first two belong together and should always be read as a pair.');
space(4);

h2('Cleared without a human');
text('The share of people the checks settled on their own. This is the number the whole approach lives or dies by — the higher it is, the fewer people you have to look at.');

// Keep this heading, its paragraph and its panel on one page — split across a page break, the caveat
// lands away from the number it is about, which is the one thing this section exists to prevent.
needSpace(190);
h2('Checks that could run  —  read this one FIRST');
text('Some checks need history. Comparing this month against last month is impossible in a customer\'s very first cycle, and that check is honestly reported as "could not run" rather than quietly passing.');
space(2);

panel(
  'A high clear rate on low coverage is not good news',
  'If coverage is 70%, then "100% cleared" means every check that COULD run found nothing — not that everything is fine. Three of the eleven checks simply had nothing to compare against. Coverage climbs on its own as cycles accumulate, and once a run has a previous cycle to compare with, it reaches 100%. Until then, treat a clean result as provisional.',
  'warn',
);

h2('Flagged per 1,000');
text('How many people out of every thousand needed a human. It is the workload number: it tells you what a bigger headcount would actually cost you in attention.');

h2('Waiting on you');
text('Flagged people nobody has decided on yet. This is your to-do count.');

h1('4.  The checks, and what each one means');

text('Eleven checks run today. Eight of them work from the very first cycle because they need no history at all; three compare against the previous cycle and switch themselves on once there is one.');
space(4);

h2('Work from the first cycle');

check('Take-home pay is below zero', 'Blocks the close',
  'Deductions have exceeded the salary and the payslip shows a negative amount. Nobody can be paid a negative number.',
  'Review the deductions on that payslip. Usually a loan repayment or an advance recovery set too high.');

check('Statutory contribution above its legal maximum', 'Blocks the close',
  'An EPF, SOCSO or EIS figure is higher than the law allows. This almost always means a rate table is wrong rather than one person being wrong.',
  'Do not submit the statutory file. Check the contribution settings before anything is filed with the agency, because an over-contribution has to be unwound with them rather than just corrected internally.');

check('No bank account to pay into', 'Blocks the close',
  'Someone is due money by bank transfer and has no bank details on file, so the payment file would carry a line that cannot land.',
  'Add the bank details. Employees paid in cash or by cheque are deliberately NOT flagged here — the check only applies to people actually being paid by transfer.');

check('Paid twice in the same period', 'Blocks the close',
  'The same person is being paid under more than one employment in the same period. This is legal and sometimes intended — shared-services staff across group companies — but it is also what a duplicate salary looks like.',
  'If it is intended, mark it "correct as it stands" once and move on. If not, you have caught a double payment before it left the building.');

check('Nothing left to pay', 'Needs review',
  'Gross pay is positive but take-home is exactly zero — deductions consumed the entire salary.',
  'It can be genuine, such as a full month of unpaid leave. Confirm that is what happened.');

check('No tax profile on file', 'Needs review',
  'There is no tax record for this person, so PCB may be calculated on defaults.',
  'Add the tax profile, or confirm none is needed. It does not block, so a new customer still mid-onboarding is not stopped from paying people.');

check('Paid with no attendance and no leave', 'Needs review',
  'Someone was paid, but there is no attendance record and no approved leave for the whole period.',
  'Confirm the person actually worked. Approved leave counts as attendance for this check, so a month of annual leave is not flagged.');

check('Days paid do not match the period', 'Needs review',
  'The number of days paid contradicts the joining or leaving date — a full month paid to someone who started halfway through, or a partial month for someone employed throughout.',
  'Check the hire and termination dates against the payslip.');

h2('Switch on once there is a previous cycle');

check('Pay moved sharply against last cycle', 'Needs review',
  'This person\'s take-home moved more than the configured percentage — 30% unless you change it — against the previous cycle.',
  'Find out what changed. Overtime, a bonus, unpaid leave, or a rate that was keyed wrong.');

check('A new pay item appeared', 'Needs review',
  'A pay component this person did not have last cycle now has a value.',
  'Confirm the new item is correct.');

check('A pay item disappeared', 'Needs review',
  'A pay component present last cycle is gone this cycle.',
  'Confirm it was meant to stop. This catches an allowance that was accidentally removed.');

h1('5.  The whole-run check');

text('One check looks at the run as a whole rather than at individuals, and it exists because of a failure the per-person checks cannot see.');
space(3);
text('If something is applied to everyone by mistake — the wrong rate table, the wrong period, a change pushed to the whole company — then everybody moves together. Each individual movement can sit comfortably inside the per-person threshold while the total moves by a quarter. Only the total shows it.');
space(3);
text('So the screen also reports how the run\'s total pay moved against the previous cycle. Beyond the limit — 15% unless you change it — the whole run is held.');
space(2);

panel(
  'A real bonus month will trip this, and that is expected',
  'A genuine group-wide increment or a bonus run legitimately moves the total. When that happens, raise the limit for that company (see the next section) rather than looking for a fault that is not there. The check is doing its job: it asked, and you answered.',
);

h1('6.  Deciding on an exception');

text('Every flagged person has three buttons, and which one you pick matters beyond that one case.');
space(4);
bullet('Correct as it stands — the figure is right; you have looked and you are satisfied. Use this for intended concurrent employment, a genuine bonus, a real month of unpaid leave.');
bullet('Fixed at the source — the underlying data was wrong and you have corrected it. Re-run the check afterwards so the list reflects the fix.');
bullet('Not a real problem — the check itself was wrong to flag this. This is the most valuable of the three.');
space(4);

panel(
  'Why "not a real problem" matters more than it looks',
  'It is how the checks get better. Every time a check flags something that turns out to be fine, that is recorded against the check itself — and a check that is frequently wrong gets its threshold adjusted or gets switched off. If you mark everything "correct as it stands" out of habit, nothing improves, and you keep being shown the same false alarm every month.',
);

space(2);
text('The screen also lists everyone who was CLEARED. That is deliberate. If you find a mistake in someone the checks passed, that is the single most useful thing you can tell the system — it is the only way anyone learns what the checks are failing to catch, and it cannot be reconstructed later.');

h1('7.  Changing a threshold, without waiting for a release');

text('The percentages are settings, not code. They can be changed per company, they are recorded with who changed them and when, and they take effect immediately — no deployment, no release.');
space(3);
text('The two you are most likely to touch:');
space(2);
bullet('The individual movement limit, 30% by default, on "Pay moved sharply against last cycle".');
bullet('The whole-run movement limit, 15% by default.');
space(3);

panel(
  'The shipped numbers are placeholders and are labelled as such',
  '30% and 15% were not derived from your payroll. Nobody\'s payroll has been measured yet, so they are deliberately conservative starting points. Expect to adjust them over the first few cycles. That is the intended way to use them, not a sign anything is wrong.',
  'warn',
);

h1('8.  What this does NOT do');

text('Being straight about the limits, because the gap between what this does and what it will eventually do is where false confidence would come from.');
space(4);
bullet('It does not decide anything on its own. Every flagged case waits for a person. There is no setting that lets it approve or dismiss without you.');
bullet('It does not calculate pay, and it never will. The payroll engine computes every figure; these checks only read the result. No part of the checking is done by a language model.');
bullet('It does not yet know what YOUR payroll normally looks like. The statistical checks — comparing a person against their own history, or against colleagues on the same grade — need six to twelve cycles of real data and are not switched on. What runs today are the checks that need no history.');
bullet('It cannot promise a clear rate. Any figure quoted before your own payroll has been measured over several real cycles would be invented.');
space(3);

panel(
  'The one thing that would undermine all of it',
  'These checks are only as good as what feeds them. If attendance is re-keyed by hand from paper, the "paid with no attendance" check is measuring the typing, not the workforce. Getting attendance captured at source matters more to the accuracy of this than any threshold you could set.',
  'warn',
);

h1('9.  Where it goes from here');

text('The route to running a much larger headcount with the same team is earned, not switched on:');
space(4);
bullet('First — the checks run, you review everything, and the system records how often it agreed with you.');
bullet('Then — once there is enough history, the statistical checks switch on and coverage reaches 100%.');
bullet('Later — cases the checks are demonstrably reliable about stop needing a human at all, and that decision is made from your measured agreement rate, not from a promise.');
space(3);
text('Every number needed for that decision is being recorded from today. That is the main reason this exists now rather than later.');

space(8);
page.drawLine({ start: { x: M.l, y: y + 6 }, end: { x: M.l + W, y: y + 6 }, thickness: 0.8, color: RULE });
space(6);
text('Questions worth asking after your first few cycles: which check flags the most people, how often is it right, and what is our coverage? All three are on the screen.', { size: 9, font: FO, color: MUTED });

fs.writeFileSync(OUT, await doc.save());
console.log(`wrote ${OUT} (${pageNo} pages)`);
