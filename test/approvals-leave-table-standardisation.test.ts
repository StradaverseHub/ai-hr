/**
 * Approval Items leave table standardised on the My Leave → Requests style (feedback 33bf1a2d),
 * plus the multi-day action rename (feedback d6429eb4).
 *
 * WHAT WENT WRONG BEFORE: the two surfaces that list leave requests — My Leave → Requests
 * (app/leave/page.tsx) and the Approval Items leave table (app/approvals/page.tsx) — were two hand-written
 * copies of the same table. My Leave had grown avatars, colour-coded type chips and the ADR-0048 duration
 * label; Approval Items still rendered a bare name link, plain type text and no duration label. The fix is
 * NOT to copy the newer markup across (that guarantees a third divergence) but to extract the cells into
 * components/leave/leave-request-cells.tsx and have both tables consume them.
 *
 * r80 (the reporter's follow-up on both items): the Days column shows JUST the days — the "13.5d left"
 * balance sub-line is gone from every surface — and the leave-CANCELLATION queue, which r77 left one card
 * below on the old bare-text look, now renders the same shared cells. Plus the confirm button inside the
 * Review dates pop-out, held back by r77 as outside the approved plan, now reads "Submit".
 *
 * These are STATIC SOURCE guards: DB-free, deterministic, and — crucially — they read the component source
 * rather than rendered HTML. Next embeds the whole i18n catalog in the page payload, so grepping a rendered
 * page for a column heading finds it whether or not the column rendered.
 *
 * The behavioural half is guarded too: this round was presentation only, so the decide path (which action,
 * which decision values, the required reject reason, the per-date modal for multi-date requests) must be
 * exactly what it was, and /approvals must stay unpaginated (r75 — paging a bulk-decision surface makes
 * "approve all" mean "approve all on this page").
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

/** Every .ts/.tsx under app/ and components/, as repo-relative paths. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(root + rel, { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk('app');
  walk('components');
  return out.sort();
}

const CELLS = 'components/leave/leave-request-cells.tsx';
const APPROVALS = 'app/approvals/page.tsx';
const MY_LEAVE = 'app/leave/page.tsx';
const cells = read(CELLS);
const approvals = read(APPROVALS);
const myLeave = read(MY_LEAVE);

/** The Approval Items leave section only — from its Card marker to the leave-CANCELLATION section that
 *  follows it, so a `<th>` in a neighbouring queue can never satisfy (or break) a column assertion. */
function approvalsLeaveSection(): string {
  const from = approvals.indexOf('data-tour="approvals-leave"');
  const to = approvals.indexOf('APPROVAL_SECTION_ID.leaveCancellation');
  expect(from, 'approvals leave section start marker').toBeGreaterThan(-1);
  expect(to, 'approvals leave-cancellation section marker').toBeGreaterThan(from);
  return approvals.slice(from, to);
}

/** The Approval Items leave-CANCELLATION section only — from its Card marker to the START OF WHATEVER
 *  SECTION FOLLOWS IT. r80 brought this queue onto the same shared cells; before that it was still
 *  rendering the pre-r77 bare name + plain type text directly beneath the restyled request table.
 *
 *  5ff7daff: the end marker used to be the literal `t('claims')`, which quietly assumed the claims section
 *  came next. When the replacement-leave queue was inserted between them this slice swallowed it whole and
 *  the column guard below failed with SIX extra headings — a red test reporting a defect that did not
 *  exist, in a table nothing had touched. Ending at the next `<SectionHeader` instead asks the real
 *  question ("where does this section stop?") and survives the next insertion too. */
function approvalsCancellationSection(): string {
  const from = approvals.indexOf('APPROVAL_SECTION_ID.leaveCancellation');
  expect(from, 'approvals leave-cancellation section start marker').toBeGreaterThan(-1);
  const ownHeader = approvals.indexOf('<SectionHeader', from);
  expect(ownHeader, 'the cancellation section renders a SectionHeader').toBeGreaterThan(from);
  const to = approvals.indexOf('<SectionHeader', ownHeader + 1);
  expect(to, 'a section follows the cancellation queue (its end marker)').toBeGreaterThan(ownHeader);
  return approvals.slice(from, to);
}

/** `<th …>{expr}</th>` heading expressions, in document order. */
function headings(section: string): string[] {
  return [...section.matchAll(/<th\b[^>]*>\s*\{([^}]+)\}\s*<\/th>/g)].map((m) => m[1].trim());
}

describe('33bf1a2d — the leave-request cells are SHARED, not copied', () => {
  it('the shared module exports one cell per column the two tables have in common', () => {
    for (const name of ['LeaveEmployeeCell', 'LeaveTypeCell', 'LeaveDaysCell', 'LeaveAttachmentCell']) {
      expect(cells, `${CELLS} must export ${name}`).toContain(`export function ${name}(`);
    }
  });

  it('the surviving table consumes the shared cells, and the seam is still extracted', () => {
    // afd0a87c — there is only ONE leave-request table left. My Leave's org-wide Requests table was
    // removed at the reporter's request, so "BOTH tables" no longer has two sides.
    //
    // The seam is asserted MORE firmly rather than less: the whole point of extracting these cells was
    // that the next surface to list leave requests reuses them instead of hand-writing a third copy.
    // The reporter has said they will redesign Employee Leave Record separately — that is exactly the
    // surface most likely to grow a table, and it must consume these.
    expect(approvals, `${APPROVALS} must import the shared cells`).toMatch(
      /from '@\/components\/leave\/leave-request-cells'/,
    );
    for (const name of ['LeaveEmployeeCell', 'LeaveTypeCell', 'LeaveDaysCell']) {
      expect(approvals, `${APPROVALS} must render <${name}>`).toContain(`<${name}`);
    }
    // The extracted module survives with all four cells exported, ready for that second consumer.
    for (const name of ['LeaveEmployeeCell', 'LeaveTypeCell', 'LeaveDaysCell', 'LeaveAttachmentCell']) {
      expect(cells, `${CELLS} must still export ${name}`).toContain(`export function ${name}(`);
    }
    // And My Leave must not quietly grow a hand-written replacement.
    expect(myLeave.includes('<LeaveEmployeeCell'), 'My Leave has no leave-request table any more').toBe(false);
  });

  it('the surviving table does not hand-write the cell markup', () => {
    // The type chip is built from styleFor(...).chip. If the page destructures it again, someone has
    // copied the chip back inline and a future second table is free to drift from it.
    // afd0a87c — MY_LEAVE is still scanned deliberately: it has no table now, so it must not acquire
    // inline cell markup either.
    for (const [file, src] of [
      [APPROVALS, approvals],
      [MY_LEAVE, myLeave],
    ] as const) {
      expect(src, `${file} must not rebuild the leave-type chip inline — use <LeaveTypeCell>`).not.toContain(
        'styleFor(',
      );
    }
    // Same for the employee avatar: the ONLY <Avatar name={…}> left in the two request tables is the one
    // inside the shared cell. (app/leave/page.tsx keeps a separate Employee Details listing with its own
    // avatar, so this is asserted per-table, not per-file.)
    // afd0a87c — My Leave's requests table is REMOVED, so there is no slice to scan. The promise it made
    // is kept in a stronger form: My Leave must not render a request-table avatar ANYWHERE. Its Employee
    // Details listing has its own avatar and is a different component, so anchor on the shared cell's own
    // markup rather than on <Avatar in general.
    expect(myLeave.includes("{t('requestsTitle')}"), 'the requests table is gone').toBe(false);
    expect(myLeave, 'My Leave must not hand-write a leave-request cell').not.toContain('<LeaveEmployeeCell');
    expect(approvalsLeaveSection(), 'Approval Items leave table must not render an Avatar directly').not.toContain(
      '<Avatar',
    );
    expect(cells, 'the shared employee cell owns the avatar').toContain('<Avatar');
  });

  it('the shared cells stay presentational — no translation, no data access', () => {
    // Translated strings are passed IN by the page that owns the namespace. If the cells started calling
    // getTranslations they would bind to one surface's namespace and the seam would rot.
    expect(cells).not.toContain('getTranslations');
    expect(cells).not.toContain('useTranslations');
    expect(cells).not.toContain('@/core/');
  });
});

describe('33bf1a2d — Approval Items leave columns', () => {
  const expected = [
    "t('code')",
    "t('employee')",
    "t('type')",
    "t('dates')",
    "t('days')",
    "t('attachment')",
    "t('action')",
  ];

  it('are Code, Employee, Leave Type, Dates, Days, Attachment, Action — in that order', () => {
    // The bulk-select-all <th> carries a component, not a {t(...)} expression, so it is not in this list.
    expect(headings(approvalsLeaveSection())).toEqual(expected);
  });

  it('every body row has one <td> per <th>', () => {
    const section = approvalsLeaveSection();
    const row = section.slice(section.indexOf('<tbody'), section.indexOf('</tbody>'));
    const tds = (row.match(/<td\b/g) ?? []).length;
    // +1 for the bulk-selection checkbox column.
    expect(tds, 'a missing/extra <td> silently shifts every column right of it').toBe(expected.length + 1);
  });
});

describe('33bf1a2d — the Attachment column costs no extra query', () => {
  it('presence comes from hasDocument, already in the SHARED leave-request projection', () => {
    const readTs = read('core/read.ts');
    const sel = readTs.slice(
      readTs.indexOf('const leaveRequestSelection'),
      readTs.indexOf('} as const;', readTs.indexOf('const leaveRequestSelection')),
    );
    expect(sel, 'hasDocument must live in leaveRequestSelection').toContain('hasDocument:');
    expect(sel).toContain('leave_request_attachment');
  });

  it('the approvals page reads it off the row it already has (no per-row fetch)', () => {
    expect(approvals).toContain('r.hasDocument ? `/me/leave/attachment/${r.id}?inline=1` : null');
    // An N+1 would look like a per-row loader. The ONE eager per-row await on this page is the ADR-0068
    // date breakdown, which predates this round; nothing else may join it.
    const perRowAwaits = [...approvals.matchAll(/pendingLeave\.map\(async/g)];
    expect(perRowAwaits, 'no NEW per-row async map may be added for the attachment column').toHaveLength(1);
  });

  it('the icon links at the existing RLS-scoped attachment route, opened in a new tab', () => {
    expect(cells).toContain('<Paperclip');
    expect(cells).toContain("target=\"_blank\"");
    expect(read('app/me/leave/attachment/[id]/route.ts')).toContain('getLeaveAttachment');
  });

  it('is the LEAVE attachment, not the feedback attachment feature (r76 / migration 0321)', () => {
    // Two unrelated features. The column must resolve against leave_request_attachment via the leave
    // attachment route — never the feedback board's own attachment table/route.
    expect(cells).toContain('leave_request_attachment');
    expect(approvals).toContain('/me/leave/attachment/');
    expect(approvals).not.toMatch(/feedback[-/]attachment/i);
    expect(cells).not.toMatch(/feedbackAttachment|feedback_attachment/i);
  });
});

describe('33bf1a2d r80 — the Days column shows JUST the days', () => {
  // The reporter's words: "remove the 13.5d left under days column". That sub-line existed on Approval
  // Items only — My Leave never rendered it — so the balance line now shows on NO surface, and the shared
  // cell needed no prop and no fork. If a future round wants it back on one surface only, it must arrive
  // as a prop on this cell; re-inlining a second Days markup is what these guards exist to stop.
  it('the approvals Days cell renders the shared cell with nothing inside it', () => {
    const section = approvalsLeaveSection();
    expect(section, 'the Days cell must be self-closing — no child riding under the day count').toMatch(
      /<LeaveDaysCell\b[^>]*\/>/,
    );
    expect(section, 'no <LeaveDaysCell> … </LeaveDaysCell> wrapper may return').not.toContain(
      '</LeaveDaysCell>',
    );
  });

  it('NOTHING in app/ or components/ renders the applicant balance any more', () => {
    // A source sweep, not a rendered-HTML grep: Next embeds the whole i18n catalog in the page payload,
    // so the old string could be found in the HTML of a page that never printed it.
    expect(sourceFiles().filter((f) => read(f).includes('applicantBalance'))).toEqual([]);
  });

  it('the shared cell cannot take a Days-column child at all', () => {
    // Stronger than "the approvals page passes none": with no `children` in the signature, tsc rejects a
    // second thing in that column on EVERY surface, so the line cannot creep back onto one table only.
    const sig = cells.slice(cells.indexOf('export function LeaveDaysCell('), cells.indexOf('return (', cells.indexOf('export function LeaveDaysCell(')));
    expect(sig, 'LeaveDaysCell must not accept children').not.toContain('children');
  });

  it('the orphaned label is gone from all six catalogs, not just English', () => {
    // Deleting it from en.json alone would leave five locales carrying a string nothing can render —
    // i18n check A only walks en → locale, so it would never notice.
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const cat = JSON.parse(read(`messages/${loc}.json`)) as { approvals: Record<string, string> };
      expect(cat.approvals.applicantBalance, `${loc}: approvals.applicantBalance must be gone`).toBeUndefined();
    }
  });

  it('the balance itself is untouched — computed as before, and still one click away', () => {
    // Presentation only. The value stays in the SHARED leave-request projection (dropping it would change
    // what the flat and paginated reads return), and the approver reaches it from the same row: the
    // employee name links to the personnel record, whose leave summary carries the balance.
    expect(read('core/read.ts')).toContain('applicantBalance: sql<string>');
    expect(approvalsLeaveSection()).toContain('href={`/personnel/${r.employmentId}`}');
    expect(read('app/personnel/[employmentId]/page.tsx')).toContain('leaveSummary.days');
  });
});

describe('33bf1a2d r80 — the leave CANCELLATION queue uses the SAME cells', () => {
  // r77 restyled the leave-request table and left the cancellation table directly beneath it on the old
  // bare-text look — the drift the shared cells exist to prevent, reappearing one card lower.
  const section = approvalsCancellationSection();

  it('renders the shared employee, type and days cells', () => {
    for (const name of ['LeaveEmployeeCell', 'LeaveTypeCell', 'LeaveDaysCell']) {
      expect(section, `the cancellation table must render <${name}>`).toContain(`<${name}`);
    }
  });

  it('no longer hand-writes the bare name / plain type / raw day count', () => {
    expect(section, 'bare bold employee name — use <LeaveEmployeeCell>').not.toMatch(
      /<td\b[^>]*>\{c\.employee\}<\/td>/,
    );
    expect(section, 'plain leave-type text — use <LeaveTypeCell>').not.toMatch(
      /<td\b[^>]*>\{c\.leaveType\}<\/td>/,
    );
    expect(section, 'raw day count — use <LeaveDaysCell>').not.toMatch(
      /<td\b[^>]*>\{Number\(c\.requestedDays\)\}<\/td>/,
    );
    expect(section, 'the shared employee cell owns the avatar').not.toContain('<Avatar');
  });

  it('the shared cells get the data this row actually carries', () => {
    // typeCode drives the colour palette (styleFor); passing the NAME would silently fall back to the
    // default chip for every row. employmentId is what /personnel is keyed by — personId would 404.
    expect(section).toContain('typeCode={c.typeCode}');
    expect(section).toContain('href={`/personnel/${c.employmentId}`}');
    expect(section).toContain('days={c.requestedDays}');
  });

  it('the columns are unchanged and every body row still has one <td> per <th>', () => {
    // The restyle moved markup INSIDE existing cells. A dropped or added <td> would silently shift every
    // column right of it — the Days figure would land under Remaining dates.
    expect(headings(section)).toEqual([
      "t('code')",
      "t('employee')",
      "t('type')",
      "t('originalDates')",
      "t('datesToCancel')",
      "t('remainingDates')",
      "t('days')",
      "t('action')",
    ]);
    const body = section.slice(section.indexOf('<tbody'), section.indexOf('</tbody>'));
    // +1 for the bulk-selection checkbox column, whose <th> holds a component, not a {t(...)}.
    expect((body.match(/<td\b/g) ?? []).length).toBe(9);
  });

  it('the cancellation decide path is byte-identical (presentation only)', () => {
    expect(section).toContain('action={decideLeaveCancellationAction}');
    expect(section).toContain('<BulkRowCheckbox id={c.id} type="leaveCancellation" />');
    // The self-approval ban is upstream of the table and stays there.
    expect(approvals).toContain('const pendingCancellations = leaveCancellations.filter((c) => !mine(c.personId))');
  });
});

describe('33bf1a2d — approval behaviour is unchanged (presentation only)', () => {
  const controls = read('app/approvals/leave-decide-controls.tsx');

  it('the whole-request control posts the same action with the same decision values', () => {
    expect(controls).toContain("import { approveLeaveAction } from './actions'");
    expect(controls).toContain('name="decision" value="approved"');
    expect(controls).toContain('name="decision" value="rejected"');
    expect(controls).toContain('name="id"');
  });

  it('rejecting still REQUIRES a reason on the client, with the server still the authority', () => {
    expect(controls).toMatch(/name="rejectReason"\s*\n\s*required/);
    // Revealing the box is presentation. The server guard is what actually enforces it — decideLeave
    // throws MissingRejectReasonError on a rejection with no reason, whatever the browser sent.
    expect(read('core/leave.ts')).toContain(
      "if (p.decision === 'rejected' && !rejectReason) throw new MissingRejectReasonError();",
    );
  });

  it('the reject form is conditionally mounted, so a hidden required field is never submitted', () => {
    // A CSS-hidden `required` textarea makes the browser refuse to submit ("not focusable"), which would
    // look like a broken Reject button.
    expect(controls).toContain('{rejecting && (');
    expect(controls).not.toMatch(/className=\{[^}]*hidden[^}]*\}[\s\S]{0,200}name="rejectReason"/);
  });

  it('the category + sort return params still ride on every decide form', () => {
    expect(controls).toContain('name="category"');
    expect(controls).toContain('name="sort"');
  });

  it('a MULTI-DATE request still routes to the per-date modal, chosen the same way', () => {
    const section = approvalsLeaveSection();
    expect(section).toContain('(breakdowns.get(r.id)?.length ?? 0) > 0');
    expect(section).toContain('<LeaveDateBreakdown');
    expect(read('app/approvals/leave-date-breakdown.tsx')).toContain('decideLeaveDatesAction');
  });

  it('who may act on a row is decided exactly as before', () => {
    const section = approvalsLeaveSection();
    expect(section, 'the viewer\'s own request stays non-actionable').toContain('mine(r.personId)');
    expect(section, 'a non-manager step still gates a plain manager out').toContain(
      "r.currentStepKind !== 'direct_manager' && !admin",
    );
    // The bulk-selection eligibility rule is untouched.
    expect(approvals).toContain('const leaveBulkActionable');
  });

  it('/approvals is still NOT paginated (r75 deliberately excluded it)', () => {
    expect(approvals, 'paging a bulk-decision surface makes "approve all" mean "this page"').not.toContain(
      '@/components/pager',
    );
    expect(approvals).not.toContain('parsePageQuery');
  });
});

describe('d6429eb4 — the multi-day action reads "Review dates"', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const catalog = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as { approvals: Record<string, string> };

  it('the English label is the new wording', () => {
    expect(catalog('en').approvals.viewDateBreakdown).toBe('Review dates');
  });

  it('the KEY is unchanged — only the string moved', () => {
    // Renaming the key would blank the label at runtime on any surface still asking for it; tsc cannot see
    // a missing translation key.
    expect(read('app/approvals/leave-date-breakdown.tsx')).toContain('labels.viewDateBreakdown');
    expect(approvals).toContain("viewDateBreakdown: t('viewDateBreakdown')");
  });

  it('every locale carries the key, non-empty, with no trace of the old wording', () => {
    for (const loc of LOCALES) {
      const v = catalog(loc).approvals.viewDateBreakdown;
      expect(v, `${loc}: approvals.viewDateBreakdown`).toBeTruthy();
      expect(v, `${loc} still shows the retired English wording`).not.toMatch(/decide each date/i);
    }
    expect(catalog('ms').approvals.viewDateBreakdown).not.toBe('Putuskan setiap tarikh');
    expect(catalog('zh').approvals.viewDateBreakdown).not.toBe('逐日审批');
  });

  it('the new Attachment heading exists in every locale', () => {
    for (const loc of LOCALES) {
      expect(catalog(loc).approvals.attachment, `${loc}: approvals.attachment`).toBeTruthy();
    }
  });

  it('nothing else renders the renamed key', () => {
    // If a second surface expected the old words, the rename would silently reword that one too. Sweep
    // app/ + components/ for the key and check the only RENDERER is the per-date modal.
    const renderers = sourceFiles().filter((f) => read(f).includes('labels.viewDateBreakdown'));
    expect(renderers).toEqual(['app/approvals/leave-date-breakdown.tsx']);
    // The only place the key is resolved from the catalog is the approvals page's label set.
    const resolvers = sourceFiles().filter((f) => read(f).includes("t('viewDateBreakdown')"));
    expect(resolvers).toEqual([APPROVALS]);
  });
});

describe('d6429eb4 r80 — the confirm button inside the Review dates pop-out reads "Submit"', () => {
  // r77 renamed the ACTION ("Decide each date" → "Review dates") and deliberately held the button back as
  // outside the approved plan. The reporter then asked for it directly, so r80 shortens the button too.
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const catalog = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as { approvals: Record<string, string> };

  it('the English string is the new wording', () => {
    expect(catalog('en').approvals.submitDecisions).toBe('Submit');
  });

  it('the KEY is unchanged — only the string moved', () => {
    // Renaming submitDecisions → submit would blank the button at runtime; tsc cannot see a missing
    // translation key, and a blank <Button> still submits, so the modal would look broken but work.
    expect(read('app/approvals/leave-date-breakdown.tsx')).toContain('labels.submitDecisions');
    expect(approvals).toContain("submitDecisions: t('submitDecisions')");
  });

  it('every locale is shortened too, with no trace of the old wording', () => {
    // The point of the change is a SHORT button. A locale left on "Hantar keputusan" would keep the long
    // button for that language — the exact half-migration this file exists to catch.
    const shortened: Record<(typeof LOCALES)[number], string> = {
      en: 'Submit',
      ms: 'Hantar',
      ta: 'சமர்ப்பி',
      th: 'ส่ง',
      vi: 'Gửi',
      zh: '提交',
    };
    for (const loc of LOCALES) {
      expect(catalog(loc).approvals.submitDecisions, `${loc}: approvals.submitDecisions`).toBe(shortened[loc]);
    }
    // The retired long forms, explicitly.
    expect(catalog('en').approvals.submitDecisions).not.toMatch(/decisions/i);
    expect(catalog('ms').approvals.submitDecisions).not.toBe('Hantar keputusan');
    expect(catalog('zh').approvals.submitDecisions).not.toBe('提交决定');
  });

  it('the button is the ONLY renderer, and it still posts the same batch action', () => {
    // Same sweep r77 ran for viewDateBreakdown: a second surface reading this key would have been
    // silently reworded too.
    expect(sourceFiles().filter((f) => read(f).includes('labels.submitDecisions'))).toEqual([
      'app/approvals/leave-date-breakdown.tsx',
    ]);
    expect(sourceFiles().filter((f) => read(f).includes("t('submitDecisions')"))).toEqual([APPROVALS]);
    // Wording only: the one batch submit, the same action, the same missing-reason guard.
    const modal = read('app/approvals/leave-date-breakdown.tsx');
    expect(modal).toContain('<form action={decideLeaveDatesAction}');
    expect(modal).toContain('disabled={missingReason}');
  });
});
