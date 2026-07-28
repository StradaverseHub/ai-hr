/**
 * Employee Request-Leave popup enhancement — static-source + i18n guard (DB-free, jsdom-free).
 *
 * The behavioural half lives in test/leave-apply-day-breakdown.test.ts. This file pins the wiring a future
 * edit could silently half-revert:
 *   - /leave fetches leave types WITH the viewer's locale and sorts them ONCE, before all four consumers, so
 *     the request popup and the edit dialogs can never disagree on the order;
 *   - previewLeaveDeductionAction keeps its myEmployment fallback (without it the deduction line is dead for
 *     every plain employee — the exact defect this item fixed);
 *   - app/me/actions.ts myPreviewLeaveDeduction does NOT pass includeDayRows, so /me's preview is untouched;
 *   - LeaveDurationFields renders the summary + the collapsed details disclosure with the fixed-height
 *     scroll container, suppresses the summary for EMERGENCY, and puts sm:col-span-2 on all three blocks
 *     (the dialog form is a 2-column grid and these are direct grid items);
 *   - both the dialog and the page bind summaryAction;
 *   - the new i18n keys exist — including the four applyDayStatus values, which are reached through a
 *     dynamic t(`applyDayStatus.${status}`) that test/i18n-coverage.test.ts documents as unreachable by its
 *     own static check.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const page = read('app/leave/page.tsx');
const actions = read('app/leave/actions.ts');
const fields = read('components/leave-duration-fields.tsx');
const dialog = read('components/leave/request-leave-dialog.tsx');
const meActions = read('app/me/actions.ts');

describe('/leave: leave types are localized and sorted ONCE at the source', () => {
  it('passes the viewer locale to listLeaveTypes', () => {
    expect(page.includes('listLeaveTypes(session, { locale })')).toBe(true);
  });

  it('sorts the array alphabetically with a locale-aware, case-insensitive comparison', () => {
    expect(
      page.includes("leaveTypes.sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' }))"),
    ).toBe(true);
  });

  it('sorts BEFORE every consumer maps off the array (one sort fixes all four)', () => {
    const sortAt = page.indexOf('leaveTypes.sort(');
    expect(sortAt).toBeGreaterThan(-1);
    // Every `leaveTypes.map(` / `leaveTypes` read that builds options must come after the sort.
    const consumers = [...page.matchAll(/leaveTypes\.map\(/g)].map((m) => m.index ?? -1);
    expect(consumers.length).toBeGreaterThanOrEqual(4);
    for (const at of consumers) expect(at).toBeGreaterThan(sortAt);
  });

  it('does NOT push an order-by into core/read.ts listLeaveTypes (the admin master has its own order)', () => {
    const readTs = read('core/read.ts');
    const fn = readTs.slice(readTs.indexOf('export function listLeaveTypes'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.includes('orderBy')).toBe(false);
  });
});

describe('app/leave/actions.ts: the preview is alive for self-service + one new summary action', () => {
  it('previewLeaveDeductionAction falls back to the caller\'s own employment', () => {
    const fn = actions.slice(
      actions.indexOf('export async function previewLeaveDeductionAction'),
      actions.indexOf('export async function requestLeaveAction'),
    );
    expect(fn.includes('await myEmployment(session)')).toBe(true);
    // The old dead guard (return null on an empty employmentId) must be gone.
    expect(fn.includes('if (!p.employmentId ||')).toBe(false);
    // Day rows ride along on this same call — no second action, no stale-response race.
    expect(fn.includes('includeDayRows: true')).toBe(true);
  });

  it('exposes exactly ONE new read-only action, leaveApplySummaryAction', () => {
    expect(actions.includes('export async function leaveApplySummaryAction')).toBe(true);
    expect(actions.includes('leaveTypeApplySummary')).toBe(true);
  });

  it('applies ESS gating in the action (Pending/Taken gated, Balance never, on-behalf never)', () => {
    const fn = actions.slice(actions.indexOf('export async function leaveApplySummaryAction'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.includes('resolveEssView')).toBe(true);
    expect(body.includes('view.pendingApproval ? s.pending : null')).toBe(true);
    expect(body.includes('view.taken ? s.taken : null')).toBe(true);
    // Balance is passed through untouched on BOTH branches.
    expect(body.includes('balance: s.balance')).toBe(true);
    // The on-behalf escape hatch: no gating when the resolved employment is not the caller's own.
    expect(body.includes('employmentId !== me.employmentId')).toBe(true);
  });
});

describe('core/leave.ts: the new read-only exports', () => {
  const core = read('core/leave.ts');

  it('leaveTypeApplySummary is exported and marked as a read-only substrate skip', () => {
    expect(core.includes('export async function leaveTypeApplySummary')).toBe(true);
    const doc = core.slice(0, core.indexOf('export async function leaveTypeApplySummary'));
    expect(doc.lastIndexOf('substrate: read-only, no event')).toBeGreaterThan(doc.lastIndexOf('appendEvent'));
  });

  it('reuses leaveBalance for Balance — no third balance formula', () => {
    const fn = core.slice(core.indexOf('export async function leaveTypeApplySummary'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.includes('leaveBalance(tx, p.employmentId, p.leaveTypeId)')).toBe(true);
    expect(body.includes('leaveEntitlementBreakdown')).toBe(false);
    expect(body.includes('deriveSummaryBalance')).toBe(false);
  });

  it('Pending is the SAME aggregate the submit-time guard reserves', () => {
    // availableLeaveBalance now delegates to the extracted helper the summary also calls.
    expect(core.includes('async function pendingLeaveDays(')).toBe(true);
    const avail = core.slice(core.indexOf('export async function availableLeaveBalance'));
    expect(avail.slice(0, avail.indexOf('\n}\n')).includes('pendingLeaveDays(tx, employmentId, leaveTypeId, excludeRequestId)')).toBe(true);
  });

  it('rest and off day stay ONE bucket — no roster_assignment dependency creeps in', () => {
    expect(core.includes("'rest_day'")).toBe(true);
    expect(core.includes('off_day')).toBe(false);
    expect(core.includes('rosterAssignment')).toBe(false);
  });

  it('the day-rows path guards the span and the RLS-invisible employment', () => {
    const fn = core.slice(core.indexOf('async function resolveApplyDayRows'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.includes('if (p.endDate < p.startDate) return undefined;')).toBe(true);
    expect(body.includes('APPLY_DAY_ROWS_MAX_SPAN')).toBe(true);
    expect(body.includes('if (!emp) return undefined;')).toBe(true);
  });
});

describe('app/me: the /me preview is untouched', () => {
  it('myPreviewLeaveDeduction does not ask for day rows', () => {
    const fn = meActions.slice(meActions.indexOf('export async function myPreviewLeaveDeduction'));
    expect(fn.slice(0, fn.indexOf('\n}\n')).includes('includeDayRows')).toBe(false);
  });
});

describe('LeaveDurationFields: summary + day-by-day disclosure', () => {
  it('takes a REQUIRED summaryAction prop (no speculative optionality)', () => {
    expect(fields.includes('summaryAction: (p: { employmentId: string; leaveTypeId: string }) =>')).toBe(true);
    expect(fields.includes('summaryAction?:')).toBe(false);
  });

  it('renders the three summary figures from the reused breakdown keys', () => {
    // `available`, not `balance`, since feedback 082fa566: the third figure is the same number the leave
    // type's own summary calls Available, and showing it under two different words reads as two different
    // numbers. Pinned here so a revert to `balance` re-opens exactly the inconsistency that was reported.
    for (const k of ['breakdown.field.pendingApproval', 'breakdown.field.taken', 'breakdown.field.available']) {
      expect(fields.includes(`t('${k}')`), k).toBe(true);
    }
    expect(fields.includes("t('breakdown.field.balance')"), 'the old Balance label must be gone').toBe(false);
    // The "{value} Days" format the mock-up asks for — reused, not re-invented.
    expect(fields.includes("tMe('leaveBalanceTable.daysValue'")).toBe(true);
    expect(fields.includes('tabular-nums')).toBe(true);
  });

  it('suppresses the summary for EMERGENCY (EL keeps no ledger of its own)', () => {
    expect(fields.includes('{!isEmergency && (summary || isSummarizing) && (')).toBe(true);
    // The existing emergency split note stays where it was.
    expect(fields.includes("t('emergency.splitNotice')")).toBe(true);
  });

  it('the summary effect is keyed on (employmentId, typeId) and reuses employmentReady', () => {
    const at = fields.indexOf('const r = await summaryAction(');
    expect(at).toBeGreaterThan(-1);
    const effect = fields.slice(fields.lastIndexOf('useEffect(', at), fields.indexOf('}, [summaryAction'));
    expect(effect.includes('const employmentReady = !employeeOptions || !!employmentId;')).toBe(true);
    expect(fields.includes('}, [summaryAction, employeeOptions, employmentId, typeId]);')).toBe(true);
  });

  it('guards stale responses with a monotonic request id in BOTH effects', () => {
    expect(fields.includes('const previewReq = useRef(0);')).toBe(true);
    expect(fields.includes('const summaryReq = useRef(0);')).toBe(true);
    expect(fields.includes('if (req !== previewReq.current) return;')).toBe(true);
    expect(fields.includes('if (req !== summaryReq.current) return;')).toBe(true);
  });

  it('uses a native <details> disclosure — collapsed by default, no useState', () => {
    expect(fields.includes("t('applyDetails.toggle')")).toBe(true);
    expect(fields.includes('<details className="sm:col-span-2">')).toBe(true);
    expect(fields.includes('<summary')).toBe(true);
    // No `open` attribute anywhere: the panel must NOT start expanded.
    expect(/<details[^>]*\sopen\b/.test(fields)).toBe(false);
  });

  it('the panel body has a fixed max height with its own vertical scrollbar + sticky header', () => {
    expect(fields.includes('max-h-56 overflow-y-auto')).toBe(true);
    expect(fields.includes('sticky top-0')).toBe(true);
  });

  it('renders four columns and a total line that must equal the preview days', () => {
    expect(fields.includes("tAtt('colDate')")).toBe(true);
    expect(fields.includes("tAtt('colDay')")).toBe(true);
    expect(fields.includes("t('applyDetails.colStatus')")).toBe(true);
    expect(fields.includes("t('applyDetails.colApplied')")).toBe(true);
    expect(fields.includes('t(`applyDayStatus.${r.status}`)')).toBe(true);
    expect(fields.includes("t('applyDetails.total', { days: preview.days })")).toBe(true);
  });

  it('formats the date and weekday client-side via Intl (ONE source for the weekday)', () => {
    expect(fields.includes("day: '2-digit', month: 'short', year: 'numeric'")).toBe(true);
    expect(fields.includes("weekday: 'long'")).toBe(true);
    // The server therefore never ships an isoWeekday field.
    expect(read('core/leave.ts').includes('isoWeekday: ')).toBe(false);
  });

  it('puts sm:col-span-2 on ALL THREE blocks (summary, details, and the date+Total wrapper)', () => {
    expect(fields.includes('px-3 py-2 text-xs sm:col-span-2')).toBe(true);
    expect(fields.includes('<details className="sm:col-span-2">')).toBe(true);
    expect(
      fields.includes('<div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-end sm:gap-3">'),
    ).toBe(true);
    expect((fields.match(/sm:col-span-2/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * Request-Leave popup redesign: the wordy deduction box is replaced by a compact Total badge sitting beside
 * the Start/End date fields. Static-source only — placement, live refresh, and the 0.5 half-day figure are
 * provable only in the browser; what is pinned here is that the badge exists, reuses the day-by-day panel's
 * OWN string (so the two can never disagree), and that the old box and its now-dead keys are truly gone.
 */
describe('LeaveDurationFields: compact Total badge beside the dates', () => {
  it('wraps the date grid so the badge sits beside it on sm+ and stacks under it on mobile', () => {
    // The date grid keeps grid-cols-2 with NO sm prefix (two-up even on a phone) and becomes a flex-1 child.
    expect(fields.includes('<div className="grid flex-1 grid-cols-2 gap-2">')).toBe(true);
    expect(fields.includes('sm:flex-row sm:items-end')).toBe(true);
  });

  it('renders the badge from preview.days, reusing applyDetails.total — footer + badge, exactly twice', () => {
    const uses = fields.split("t('applyDetails.total', { days: preview.days })").length - 1;
    expect(uses).toBe(2); // the day-by-day panel footer AND the new badge — never the footer alone
    // The badge lives INSIDE the date wrapper, not in a block of its own further down the form.
    const wrapAt = fields.indexOf('sm:flex-row sm:items-end');
    const summaryAt = fields.indexOf('{!isEmergency && (summary || isSummarizing) && (');
    const badgeAt = fields.lastIndexOf("t('applyDetails.total', { days: preview.days })", summaryAt);
    expect(badgeAt).toBeGreaterThan(wrapAt);
    // Still day-based only: hourly keeps its own live hours line and never shows a day Total.
    expect(fields.includes("previewAction && effectiveDuration !== 'hourly' && (preview || isPreviewing)")).toBe(
      true,
    );
    // preview.loading is retained and reused while the debounced preview is in flight.
    expect(fields.includes("t('preview.loading')")).toBe(true);
  });

  it('the old deduction box and its five keys are gone from the component AND all six locales', () => {
    const DEAD = ['willDeduct', 'willDeductEmergency', 'balanceLine', 'halfScheduleDayNote', 'emergencySplitNote'];
    for (const k of DEAD) expect(fields.includes(`preview.${k}`), `component still uses preview.${k}`).toBe(false);
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as {
        leave: { preview: Record<string, string> };
      };
      for (const k of DEAD) expect(m.leave.preview[k], `${loc}.leave.preview.${k} is an orphan`).toBeUndefined();
      // loading survives — the badge reuses it.
      expect(m.leave.preview.loading, `${loc}.leave.preview.loading`).toBeTruthy();
    }
  });
});

describe('summaryAction is bound end to end', () => {
  it('request-leave-dialog.tsx forwards it to LeaveDurationFields', () => {
    expect(dialog.includes('summaryAction: SummaryAction;')).toBe(true);
    expect(dialog.includes('summaryAction={summaryAction}')).toBe(true);
  });

  it('app/leave/page.tsx binds the server action next to previewAction', () => {
    expect(page.includes('summaryAction={leaveApplySummaryAction}')).toBe(true);
    expect(page.includes('previewAction={previewLeaveDeductionAction}')).toBe(true);
    expect(page.includes('leaveApplySummaryAction,')).toBe(true);
  });
});

describe('i18n: the new apply-popup keys in all six locales', () => {
  const locales = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  const NEW_DETAIL_KEYS = ['toggle', 'colStatus', 'colApplied', 'yes', 'no', 'total'] as const;
  const DAY_STATUSES = ['working_day', 'half_working_day', 'rest_day', 'public_holiday'] as const;

  type Catalog = { leave: { applyDetails: Record<string, string>; applyDayStatus: Record<string, string> } };

  it('every locale carries a real translation for each key', () => {
    const byLocale = locales.map((loc) => [loc, JSON.parse(read(`messages/${loc}.json`)) as Catalog] as const);
    for (const [loc, m] of byLocale) {
      for (const k of NEW_DETAIL_KEYS) expect(m.leave.applyDetails?.[k], `${loc}.applyDetails.${k}`).toBeTruthy();
      for (const s of DAY_STATUSES) expect(m.leave.applyDayStatus?.[s], `${loc}.applyDayStatus.${s}`).toBeTruthy();
    }
    // Not English placeholders: every non-en locale differs from en on the four day-status labels.
    const en = byLocale[0][1];
    for (const [loc, m] of byLocale.slice(1)) {
      for (const s of DAY_STATUSES) {
        expect(m.leave.applyDayStatus[s], `${loc}.applyDayStatus.${s} is still English`).not.toBe(
          en.leave.applyDayStatus[s],
        );
      }
    }
  });

  it('all four dynamic applyDayStatus values resolve in en.json (i18n-coverage cannot check these)', () => {
    const en = JSON.parse(read('messages/en.json')) as Catalog;
    // These are the EXACT four LeaveApplyDayStatus values core/leave.ts can emit.
    const core = read('core/leave.ts');
    const union = core.slice(core.indexOf('export type LeaveApplyDayStatus ='));
    for (const s of DAY_STATUSES) {
      expect(union.includes(`'${s}'`), `core emits ${s}`).toBe(true);
      expect(en.leave.applyDayStatus[s], `en.applyDayStatus.${s}`).toBeTruthy();
    }
    // …and nothing else: an added status without a key would render a raw key in the panel.
    expect(Object.keys(en.leave.applyDayStatus).sort()).toEqual([...DAY_STATUSES].sort());
  });

  it('the total string interpolates {days}', () => {
    const en = JSON.parse(read('messages/en.json')) as Catalog;
    expect(en.leave.applyDetails.total).toContain('{days}');
  });
});
