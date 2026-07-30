/**
 * My Absence layout restoration (feedback 56a0deb9) + Leave History card redesign (feedback 657962ec)
 * — static-source guard.
 *
 * 56a0deb9 pinned the restored /leave layout; 657962ec re-pins the SELF-SERVICE history half of it:
 *   1. the detailed Current Balance card folds behind its header (CollapsibleCardSection — CLOSED by
 *      default, cookie-persisted, SSR-read so the first paint is correct);
 *   2. the pre-R54 secondary-type "Other leave" grouped panels (Family & Personal / Education / Other)
 *      are restored, each row keeping its View Breakdown side-sheet link;
 *   3. for the SELF-SERVICE view the breakdown card and the leave history sit side by side
 *      (grid lg:grid-cols-2, stacking on small screens) — the history now a COMPACT CARD list
 *      (657962ec): each record a card with type / date range / duration / status badge and a
 *      "View details" trigger opening a slide-out panel that carries the session, stage, per-date
 *      outcomes, document link and the Edit / Cancel / Cancel-dates actions. Cards order newest first
 *      by leave start date; both columns share an equal-height lg cap and scroll within themselves.
 *      HR admins keep the full-width sortable/paginated table.
 * NO leave business logic changes: balances, breakdown calculations, history records, filters, search
 * and permissions all flow from the same reads/actions as before.
 *
 * DB-free source guard (precedent: test/my-absence-nav.test.ts): the RSC page can't render in this
 * suite, so the fold wiring, the restored section, the card/panel split and the i18n keys are asserted
 * statically.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const leavePage = read('app/leave/page.tsx');
const groupsCmp = read('components/leave/secondary-leave-groups.tsx');
const section = read('components/collapsible-card-section.tsx');
const historyCmp = read('components/leave/leave-history-cards.tsx');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** Where the admin history table begins — everything after it is the admin branch. 8ec63139 removed the
 *  admin's own `{admin && secondaryBreakdownCard()}` card, which used to be this boundary. */
const ADMIN_MARKER = '{/* Admin request history';
/** The self-service render branch: breakdown + history columns. */
const selfBranch = () => leavePage.slice(leavePage.indexOf('{!admin && ('), leavePage.indexOf(ADMIN_MARKER));
/** The RSC entries builder that feeds LeaveHistoryCards (pre-translated data + action/outcome nodes). */
const entriesBuilder = () =>
  leavePage.slice(leavePage.indexOf('const historyEntries'), leavePage.indexOf('{!admin && ('));

describe('56a0deb9 §1: the Current Balance card is collapsible, closed by default, cookie-persisted', () => {
  it('wraps the balance card body in CollapsibleCardSection with the leave_balance_open cookie', () => {
    expect(leavePage.includes("const BALANCE_OPEN_COOKIE = 'leave_balance_open'")).toBe(true);
    const card = leavePage.slice(
      leavePage.indexOf('data-tour="leave-balance"'),
      leavePage.indexOf('</CollapsibleCardSection>'),
    );
    expect(card).toContain('<CollapsibleCardSection');
    expect(card).toContain("title={t('myBalancesTitle')}");
    expect(card).toContain("subtitle={t('balancesSubtitle')}");
    expect(card).toContain("toggleLabel={t('balancesToggle')}");
    expect(card).toContain('cookieKey={BALANCE_OPEN_COOKIE}');
    expect(card).toContain('defaultOpen={balanceOpen}');
    // The body it folds is the unchanged detailed view: as-at form + LeaveBalanceTable.
    expect(card).toContain('name="asOf"');
    expect(card).toContain('<LeaveBalanceTable');
  });

  it('starts CLOSED: cookie absent resolves defaultOpen false, read SSR-side (no flash)', () => {
    expect(leavePage).toMatch(/await cookies\(\)/);
    expect(leavePage).toMatch(/BALANCE_OPEN_COOKIE\)\?\.value === '1'/);
  });

  it('keeps the leave-balance tour anchor on the Card (summary bar stays visible when closed)', () => {
    expect(leavePage.includes('data-tour="leave-balance"')).toBe(true);
    // The shared fold component persists the choice per browser (cookie write on toggle).
    expect(section).toMatch(/document\.cookie/);
    expect(section).toMatch(/path=\/; max-age=31536000; samesite=lax/);
  });

  it('ships the toggle label in every locale', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`)) as Record<string, Record<string, unknown>>;
      expect(msgs.leave.balancesToggle, `${loc} leave.balancesToggle`).toBeTruthy();
    }
  });
});

describe('56a0deb9 §2: the secondary-type "Other leave" breakdown section is restored', () => {
  it('/leave buckets SECONDARY-placement balances via lib/leave-groups, as the old /me tab did', () => {
    expect(leavePage).toMatch(
      /import \{ PRIMARY_CODES, SECONDARY_GROUPS, resolveSecondaryGroup \} from '@\/lib\/leave-groups'/,
    );
    expect(leavePage).toMatch(/b\.placement === 'secondary' && resolveSecondaryGroup\(b\.code\) === group/);
    // Empty groups (and an all-primary catalog) are omitted.
    expect(leavePage).toMatch(/\.filter\(\(g\) => g\.types\.length > 0\)/);
  });

  it('renders SecondaryLeaveGroups with the pre-translated me-namespace labels', () => {
    expect(leavePage.includes('<SecondaryLeaveGroups')).toBe(true);
    expect(leavePage.includes("heading={tMe('otherLeaveHeading')}")).toBe(true);
    expect(leavePage.includes('label: tMe(`leaveGroups.${group}`)')).toBe(true);
  });

  it('each row keeps the ESS-gated remaining figure + the View Breakdown side-sheet on /leave', () => {
    const start = leavePage.indexOf('const secondaryBreakdownCard');
    const card = leavePage.slice(start, leavePage.indexOf(') : null;', start));
    expect(card).toContain('deriveBalanceRow(b, bd ?? null).available');
    // 1f6fd6d8: the gate is no longer the `entitlementCalcBreakdown` key — that named a section the panel no
    // longer has. The question the call site was really asking is "does HR still show this employee ANY line
    // of the Leave Summary", which is what essViewHasAnyVisibleRow answers. The PROPERTY this test pins —
    // that the side-sheet is ESS-gated at all — is unchanged.
    expect(card).toContain('essViewHasAnyVisibleRow(b.essView)');
    expect(card).toContain('<EntitlementBreakdown');
    expect(card).toContain('action="/leave"');
    expect(card).toContain('applyEssConfig');
  });

  it('the component reproduces the old grouped-panel markup (open details per group, visual chip, dash for hidden)', () => {
    expect(groupsCmp).toMatch(/<details key=\{group\}[^>]*open>/);
    expect(groupsCmp).toMatch(/<summary/);
    expect(groupsCmp).toContain('leaveVisual({ color: b.color, icon: b.icon, code: b.code })');
    expect(groupsCmp).toContain("b.remaining == null ? '—' : b.remaining.toFixed(2)");
    // Server-safe: no 'use client' (the RSC passes the side-sheet link in as a node).
    expect(groupsCmp.trimStart().startsWith("'use client'")).toBe(false);
  });

  it('the me-namespace keys it reuses still ship in every locale', () => {
    for (const loc of LOCALES) {
      const me = (JSON.parse(read(`messages/${loc}.json`)) as { me: Record<string, unknown> }).me;
      expect(me.otherLeaveHeading, `${loc} me.otherLeaveHeading`).toBeTruthy();
      const groups = me.leaveGroups as Record<string, unknown>;
      for (const g of ['family_personal', 'education', 'other']) {
        expect(groups?.[g], `${loc} me.leaveGroups.${g}`).toBeTruthy();
      }
    }
  });
});

describe('56a0deb9 §3: breakdown + history side by side for self-service; admin keeps the table', () => {
  it('the self-service branch pairs the two cards in a responsive lg:grid-cols-2 grid', () => {
    const self = selfBranch();
    expect(self).toContain('lg:grid-cols-2');
    expect(self).toContain('{secondaryBreakdownCard(');
    expect(self).toContain('data-tour="leave-requests"');
  });

  it('the self-service history keeps every ported affordance — now via the card entries builder', () => {
    const builder = entriesBuilder();
    for (const kept of [
      "tMe('leaveStatus.partiallyApproved')", // partial badge
      "tMe('stageManager')", // pending stage line
      "tMe('viewDocument')", // own attachment link
      "t('cancelPendingBadge')", // ADR-0065 give-back pill
      '<EditLeaveDialog',
      '<CancelLeaveDialog',
      '<CancelDatesDialog',
      '<LeaveDateOutcome',
    ]) {
      expect(builder.includes(kept), kept).toBe(true);
    }
    expect(selfBranch().includes("t('requestsEmpty')")).toBe(true);
  });

  it('the admin path keeps the full-width sortable/paginated table', () => {
    const adminPart = leavePage.slice(leavePage.indexOf(ADMIN_MARKER));
    expect(adminPart).toContain('data-tour="leave-requests"');
    expect(adminPart).toContain("sortableTh('name'");
    expect(adminPart).toContain('<AdminCancelLeaveDialog');
    // fc776376 replaced this table's hand-rolled pager with the ONE shared <Pager>: it still shows a
    // position counter, and now also a rows-per-page control that rides in the address. The requirement
    // is that the admin table is still PAGINATED, not that it keeps its own copy of the chrome.
    expect(adminPart).toContain('<Pager');
    expect(adminPart).toContain('pageState(pq, total, history.length)');
    expect(adminPart).toContain('colSpan={7}');
  });

  it('8ec63139: the admin no longer gets their OWN breakdown card above that table', () => {
    // The self-service branch still calls it; the admin-side call is gone (it was the third face of My
    // Balances on a page that is now about employees).
    expect(leavePage.includes('{admin && secondaryBreakdownCard()')).toBe(false);
    expect(selfBranch()).toContain('{secondaryBreakdownCard(');
  });

  it('both branches carry the leave-requests tour anchor (one renders per role)', () => {
    expect(leavePage.split('data-tour="leave-requests"').length - 1).toBe(2);
  });
});

describe('657962ec §1: the self-service history renders as compact cards, newest first, with a count heading', () => {
  it('replaces the dense list with the LeaveHistoryCards island fed by pre-built entries', () => {
    const self = selfBranch();
    expect(self).toContain('<LeaveHistoryCards entries={historyEntries} locale={locale} />');
    // The count heading ("My leave history (N)") — i18n with {count}.
    expect(self).toContain("t('historyCount', { count: total })");
    // The old heading pair is gone.
    expect(leavePage.includes("t('myRequestsTitle')")).toBe(false);
  });

  it('orders cards newest first by leave START date, explicitly (not the read’s createdAt order)', () => {
    expect(leavePage).toMatch(
      /const selfHistory = admin \? \[\] : \[\.\.\.history\]\.sort\(\(a, b\) => b\.startDate\.localeCompare\(a\.startDate\)\)/,
    );
    // The per-date outcome window follows the card order (5 newest by start date).
    expect(leavePage).toMatch(/selfHistory\.slice\(0, 5\)\.map/);
    expect(leavePage.includes('leaveRequestDateBreakdown(session, r.id)')).toBe(true);
  });

  it('the card face carries ONLY the essentials — actions, document link and outcomes are panel-only', () => {
    const cardPart = historyCmp.slice(
      historyCmp.indexOf('── Card list'),
      historyCmp.indexOf('── Slide-out detail panel'),
    );
    expect(cardPart).toContain("t('viewDetails')");
    expect(cardPart).toContain('statusLabel'); // status badge
    expect(cardPart).toContain('durationLine'); // duration line
    for (const absent of ['.actions', '.dateOutcome', '.documentHref', '.stageLabel', '.cancelPendingLabel']) {
      expect(cardPart.includes(absent), `on card face: ${absent}`).toBe(false);
    }
  });

  it('the detail panel is a slide-out side-sheet carrying the full record + the relocated actions', () => {
    const panelPart = historyCmp.slice(historyCmp.indexOf('── Slide-out detail panel'));
    // LeaveDetailsPanel pattern: right-anchored Radix side sheet.
    expect(panelPart).toContain('inset-y-0 right-0');
    expect(panelPart).toContain('<Dialog.Portal>');
    for (const kept of [
      "t('details.title')",
      "t('details.leaveType')",
      "t('details.duration')",
      "t('details.session')",
      "t('details.status')",
      "t('details.attachment')",
      'selected.stageLabel',
      'selected.cancelPendingLabel',
      'selected.documentHref',
      'selected.dateOutcome',
      'selected.actions',
    ]) {
      expect(panelPart.includes(kept), `in panel: ${kept}`).toBe(true);
    }
    // The RSC hands the panel the SAME action dialogs the old list rendered inline (same server actions).
    const builder = entriesBuilder();
    expect(builder).toContain('submitAction={editLeaveAction}');
    expect(builder).toContain('submitAction={cancelOwnLeaveAction}');
    expect(builder).toContain('submitAction={requestLeaveCancellationAction}');
  });

  it('both columns share the equal-height lg cap and scroll within themselves', () => {
    expect(leavePage).toContain("const COLUMN_CAP = 'lg:max-h-[42rem]'");
    const self = selfBranch();
    // Breakdown column: capped card scrolling as one body.
    expect(self).toContain('{secondaryBreakdownCard(`${COLUMN_CAP} lg:overflow-y-auto`)}');
    // History column: capped flex card, header fixed, body scrolling.
    expect(self).toContain('${COLUMN_CAP}`} data-tour="leave-requests"');
    expect(self).toContain('min-h-0 flex-1 overflow-y-auto');
  });

  it('ships the card + detail-view keys in every locale', () => {
    for (const loc of LOCALES) {
      const leave = (JSON.parse(read(`messages/${loc}.json`)) as { leave: Record<string, unknown> }).leave;
      expect(leave.historyCount, `${loc} leave.historyCount`).toContain('{count}');
      expect(leave.viewDetails, `${loc} leave.viewDetails`).toBeTruthy();
      expect(leave.durationLine, `${loc} leave.durationLine`).toContain('{count');
      const details = leave.details as Record<string, unknown>;
      for (const k of ['title', 'leaveType', 'duration', 'session', 'status', 'attachment']) {
        expect(details?.[k], `${loc} leave.details.${k}`).toBeTruthy();
      }
      // The superseded heading key is gone everywhere (replaced by historyCount).
      expect(leave.myRequestsTitle, `${loc} leave.myRequestsTitle removed`).toBeUndefined();
    }
  });
});
