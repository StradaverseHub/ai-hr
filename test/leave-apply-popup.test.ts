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
    // UPDATED BY ad965821 (AGENTS rule 18). The comparison is unchanged — it was EXTRACTED to a name,
    // because the page now holds TWO arrays that must be ordered identically: the full catalogue (still
    // needed for the unpaid-leave name and the Edit box) and the eligibility-filtered apply source. Two
    // inline copies of one comparator is exactly how they would have drifted.
    expect(page).toContain("a.name.localeCompare(b.name, locale, { sensitivity: 'base' })");
    expect(page).toContain('leaveTypes.sort(byName);');
    expect(page).toContain('eligibleLeaveTypes.sort(byName);');
  });

  it('sorts BEFORE every consumer maps off the array (one sort fixes all four)', () => {
    const sortAt = page.indexOf('leaveTypes.sort(');
    expect(sortAt).toBeGreaterThan(-1);
    // Every `.map(` that builds options off either array must come after the sorts.
    // afd0a87c — was >= 4. Two of the four consumers were the retired request table's leave-type filter
    // options; removing the table removed them. ad965821 then moved the apply dropdown onto the
    // eligibility-filtered array, so BOTH names are scanned. The PROPERTY this test defends is unchanged
    // and is the line below: whatever the count, every consumer reads its array AFTER the single sort.
    const consumers = [...page.matchAll(/(?:leaveTypes|eligibleLeaveTypes)\r?\n?\s*\.?(?:map|filter)\(/g)].map(
      (m) => m.index ?? -1,
    );
    expect(consumers.length).toBeGreaterThanOrEqual(2);
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
    // UPDATED for cdf9ca48 (Balance Deduction Source). The call now passes the SOURCE type rather than
    // the applied type, because a leave type may borrow another type's balance — that is the item. The
    // property this test exists to protect is unchanged and still asserted: the summary reads the ONE
    // shared balance function, and invents no second way of computing a balance.
    const fn = core.slice(core.indexOf('export async function leaveTypeApplySummary'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.includes('leaveBalance(tx, p.employmentId, sourceTypeId)')).toBe(true);
    expect(body.includes('leaveEntitlementBreakdown')).toBe(false);
    expect(body.includes('deriveSummaryBalance')).toBe(false);
  });

  it('Pending is the SAME aggregate the submit-time guard reserves', () => {
    // The invariant, restated rather than re-pinned: the popup's Pending figure and the submit-time
    // guard must count the same days, or an employee is shown a number that does not match what blocks
    // them. Both now resolve the source type and aggregate pending across every type that SPENDS that
    // balance (the borrowers), so an Emergency Leave request in flight reduces the Annual figure the
    // popup shows. Asserting the shared helpers rather than one literal argument list, so the next
    // legitimate signature change does not fail a test whose subject is agreement, not spelling.
    expect(core.includes('async function pendingLeaveDays(')).toBe(true);
    expect(core.includes('async function balanceSpenderTypeIds(')).toBe(true);
    const avail = core.slice(core.indexOf('export async function availableLeaveBalance'));
    const availBody = avail.slice(0, avail.indexOf('\n}\n'));
    const summary = core.slice(core.indexOf('export async function leaveTypeApplySummary'));
    const summaryBody = summary.slice(0, summary.indexOf('\n}\n'));
    for (const body of [availBody, summaryBody]) {
      expect(body.includes('resolveBalanceSourceTypeId')).toBe(true);
      expect(body.includes('balanceSpenderTypeIds')).toBe(true);
      expect(body.includes('pendingLeaveDays(')).toBe(true);
    }
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

  it('renders exactly TWO summary figures — Pending approval then Available (082fa566, r76)', () => {
    // History of this table, because the column set has moved twice and the reasons must not be lost:
    //   r74 renamed the third column Balance → Available WITHOUT changing the value, so the word Available
    //        sat over the GROSS ledger figure and the reporter read 13.5 where their Leave Summary said 8.5;
    //   r75 pointed Available at the net figure and put Balance back BESIDE it, so the popup showed the whole
    //        subtraction (Taken / Pending approval / Balance / Available) and the number was checkable;
    //   r76 (this) takes the derivation back off the apply form. With Available finally correct, the reporter
    //        asked for only the two decisions-relevant figures while applying: what is already spoken for
    //        (Pending approval) and what can still be applied for (Available). Taken is history, Balance an
    //        intermediate — both stay in full on the balance screens.
    for (const k of ['breakdown.field.pendingApproval', 'breakdown.field.available']) {
      expect(fields.includes(`t('${k}')`), k).toBe(true);
    }
    // Taken and Balance are no longer RENDERED here. Regression this catches: someone re-adding a column to
    // the apply popup (or reverting to the r75 four-column table).
    for (const k of ['breakdown.field.taken', 'breakdown.field.balance']) {
      expect(fields.includes(`t('${k}')`), `${k} must not be rendered on the apply popup`).toBe(false);
    }
    // Order: Pending approval first, Available last.
    expect(fields.indexOf("t('breakdown.field.pendingApproval')")).toBeLessThan(
      fields.indexOf("t('breakdown.field.available')"),
    );
    // The body row is the same two figures, PICKED from the server action — Available reads summary.available
    // (never summary.balance, the r74 defect), and no taken/balance cell survives.
    expect(fields.includes('{daysValue(summary.pending)}')).toBe(true);
    expect(fields.includes('{daysValue(summary.available)}')).toBe(true);
    expect(fields.includes('{daysValue(summary.taken)}')).toBe(false);
    expect(fields.includes('{daysValue(summary.balance)}')).toBe(false);
    // The "{value} Days" format the mock-up asks for — reused, not re-invented.
    expect(fields.includes("tMe('leaveBalanceTable.daysValue'")).toBe(true);
    expect(fields.includes('tabular-nums')).toBe(true);
  });

  it('is DISPLAY-only: the action and the summary type still carry taken and balance', () => {
    // The contract for 082fa566/r76 is explicit that nothing is recalculated — two lines are simply no longer
    // displayed. This catches the tempting follow-up "cleanup" that prunes the now-unread fields out of the
    // server action or the type: that would change what leaveApplySummaryAction computes, and the ESS-gating
    // assertions above (view.taken, balance: s.balance) plus the balance screens depend on it.
    expect(fields.includes('taken: number | null;')).toBe(true);
    expect(fields.includes('balance: number | null;')).toBe(true);
    const fn = actions.slice(actions.indexOf('export async function leaveApplySummaryAction'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.includes('view.taken ? s.taken : null')).toBe(true);
    expect(body.includes('balance: s.balance')).toBe(true);
    // The r72 (cdf9ca48) invariant: Available on the popup is derived exactly as availableLeaveBalance
    // derives the submit-time guard's figure — same pendingLeaveDays over the same balanceSpenderTypeIds,
    // same unclamped subtraction. (The end-to-end equality is asserted against a real DB in
    // test/r75-leave-apply-available.test.ts: popup.available === availableLeaveBalance. Removing two
    // columns must not have gone near either.)
    const core = read('core/leave.ts');
    const summaryFn = core.slice(core.indexOf('export async function leaveTypeApplySummary'));
    const summaryBody = summaryFn.slice(0, summaryFn.indexOf('\n}\n'));
    expect(summaryBody.includes('pendingLeaveDays(')).toBe(true);
    expect(summaryBody.includes('balanceSpenderTypeIds(')).toBe(true);
    expect(summaryBody.includes('available: round2(balance - pending),')).toBe(true);
  });

  it('keeps the Taken/Balance label keys — the entitlement side panel still renders them', () => {
    // The likeliest way to break this build: deleting leave.breakdown.field.taken / .balance as "orphans"
    // because the popup stopped using them. components/leave/entitlement-panel-config.ts still points the
    // summary section's rows at them, and there is no static guard that would catch the missing key — a
    // deleted key type-checks and fails at runtime, in all six locales.
    // DERIVED FROM THE CONFIG, not a hand-written list. The original spelled out
    // taken / balance / pendingApproval / available, and r86b's summary rebuild (1f6fd6d8) renamed
    // `balance` to `availableBalance` to match the layout the reporter specified — so a hardcoded list
    // failed while the thing it protects was perfectly healthy. Reading the keys out of the config keeps
    // the real invariant (every row the panel renders resolves in every locale) and cannot go stale when
    // the row set legitimately changes.
    const panelConfig = read('components/leave/entitlement-panel-config.ts');
    const keys = [...panelConfig.matchAll(/labelKey: 'field\.([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(keys.length, 'no labelKeys found — the config shape changed').toBeGreaterThanOrEqual(4);
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as {
        leave: { breakdown: { field: Record<string, string> } };
      };
      for (const k of keys) {
        expect(m.leave.breakdown.field[k], `${loc}.leave.breakdown.field.${k}`).toBeTruthy();
      }
    }
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

/**
 * 5570c6a2 — the Leave Type option is the leave type's NAME, and nothing else.
 *
 * The option used to carry a "· document required" badge for any type HR had marked as needing a
 * supporting file. It read as part of the type's name ("Caregiver Leave - document required"), and it put
 * an internal HR setting in front of the employee. This lives here because one expression feeds BOTH
 * employee dropdowns — Request Leave and Replacement Leave Request read the same `requestLeaveTypeOptions`
 * array — so a single silent re-add would put the badge back on both.
 *
 * The other half of the pin is what must NOT move: the submit-time refusal, its two error sentences and
 * the general attach-a-file hint all stay, or an employee whose request is refused has no way to know why.
 */
describe('5570c6a2: no document-required badge in the employee leave-type dropdown', () => {
  const optionsBlock = (): string => {
    const at = page.indexOf('const requestLeaveTypeOptions =');
    expect(at, 'requestLeaveTypeOptions still builds the shared option list').toBeGreaterThan(-1);
    return page.slice(at, page.indexOf('}));', at));
  };

  it('the option label is a bare lt.name', () => {
    expect(optionsBlock()).toContain('label: lt.name,');
  });

  it('the label expression names neither the badge key nor the document flag', () => {
    // Comments are prose and may name either; the CODE may not. Strip line + block comments first.
    const code = optionsBlock().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('documentRequiredBadge');
    expect(code).not.toContain('requiresDocument');
  });

  it('EditLeaveDialog’s own options were already bare names and are unchanged', () => {
    // app/leave/page.tsx builds a second, separate option list for the edit dialog; both now agree.
    //
    // UPDATED BY ad965821 (AGENTS rule 18). The property under test — the option LABEL is the type's name
    // and nothing else — is untouched and still asserted. What changed is which rows reach the list: it is
    // now the eligible set UNION the request's own type, so the hiding holds in the Edit box too without
    // ever taking a request's own type out of its own editor. Pinning `types={leaveTypes.map(` would have
    // pinned the unfiltered catalogue, which is the thing this round removed.
    const at = page.indexOf('types={leaveTypes');
    expect(at).toBeGreaterThan(-1);
    const list = page.slice(at, page.indexOf('}))}', at));
    expect(list).toContain('label: lt.name,');
    expect(list).toContain('eligibleTypeIds.has(lt.id) || lt.id === r.leaveTypeId');
  });

  it('the badge key survives in all six catalogs (parity, and nothing checks for unused keys)', () => {
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as { leave: Record<string, string> };
      expect(m.leave.documentRequiredBadge, `${loc}.leave.documentRequiredBadge`).toBeTruthy();
    }
  });

  it('ENFORCEMENT IS UNTOUCHED: the submit-time refusal and its two sentences stay', () => {
    // The badge was presentation. A request that genuinely needs a document is still refused on submit,
    // and the employee is still told which type needs one — remove these and the removal above becomes a
    // silent failure instead of a tidier list.
    const core = read('core/leave.ts');
    expect(core.includes('requiresDocument')).toBe(true);
    const en = JSON.parse(read('messages/en.json')) as {
      leave: { documentHint: string; errors: Record<string, string> };
    };
    // The two SENTENCES (leave.errors.*) are raised from app/me/actions.ts on a refused submission — they
    // are not the badge, and they name the leave type on purpose.
    expect(en.leave.errors.documentRequired).toBeTruthy();
    expect(en.leave.errors.documentRequiredAfter).toBeTruthy();
    expect(meActions.includes("t('documentRequired'")).toBe(true);
    // …and the general "you may need to attach something" hint under the upload box, which names no type.
    expect(en.leave.documentHint).toBeTruthy();
    expect(fields.includes('documentHint')).toBe(true);
  });
});
