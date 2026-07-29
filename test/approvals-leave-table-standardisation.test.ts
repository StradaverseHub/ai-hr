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

  it('BOTH tables consume the shared cells (the anti-drift seam)', () => {
    for (const [file, src] of [
      [APPROVALS, approvals],
      [MY_LEAVE, myLeave],
    ] as const) {
      expect(src, `${file} must import the shared cells`).toMatch(
        /from '@\/components\/leave\/leave-request-cells'/,
      );
      for (const name of ['LeaveEmployeeCell', 'LeaveTypeCell', 'LeaveDaysCell']) {
        expect(src, `${file} must render <${name}>`).toContain(`<${name}`);
      }
    }
  });

  it('neither table hand-writes the cell markup any more', () => {
    // The type chip is built from styleFor(...).chip. If either page destructures it again, someone has
    // copied the chip back inline and the two tables are free to drift apart a second time.
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
    // NB: `data-tour="leave-requests"` appears twice in app/leave/page.tsx (the self-service history card
    // uses it too), so anchor on the Requests table's own heading instead.
    const start = myLeave.indexOf("{t('requestsTitle')}");
    expect(start, "My Leave → Requests table heading").toBeGreaterThan(-1);
    const leaveRequestsTable = myLeave.slice(start);
    expect(leaveRequestsTable, 'My Leave requests table must not render an Avatar directly').not.toContain(
      '<Avatar',
    );
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
