/**
 * My Absence layout restoration (feedback 56a0deb9) — static-source guard.
 *
 * "Complete Migration of Leave Components from My Profile to My Absence." Layout-only change on /leave:
 *   1. the detailed Current Balance card folds behind its header (CollapsibleCardSection — CLOSED by
 *      default, cookie-persisted, SSR-read so the first paint is correct);
 *   2. the pre-R54 secondary-type "Other leave" grouped panels (Family & Personal / Education / Other)
 *      are restored, each row keeping its View Breakdown side-sheet link;
 *   3. for the SELF-SERVICE view that breakdown card and the request history sit side by side
 *      (grid lg:grid-cols-2, stacking on small screens), the history reusing the old /me compact list
 *      style; HR admins keep the full-width sortable/paginated table.
 * NO leave business logic changes: balances, breakdown calculations, history records, filters, search
 * and permissions all flow from the same reads/actions as before.
 *
 * DB-free source guard (precedent: test/my-absence-nav.test.ts): the RSC page can't render in this
 * suite, so the fold wiring, the restored section, the grid split and the i18n keys are asserted
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
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

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
    expect(card).toContain("b.essView.entitlementCalcBreakdown !== false");
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
    const self = leavePage.slice(leavePage.indexOf('{!admin && ('), leavePage.indexOf('{admin && secondaryBreakdownCard}'));
    expect(self).toContain('lg:grid-cols-2');
    expect(self).toContain('{secondaryBreakdownCard}');
    expect(self).toContain('data-tour="leave-requests"');
  });

  it('the self-service history is the old compact list, keeping every ported affordance', () => {
    const self = leavePage.slice(leavePage.indexOf('{!admin && ('), leavePage.indexOf('{admin && secondaryBreakdownCard}'));
    for (const kept of [
      "t('myRequestsTitle')",
      "tMe('leaveStatus.partiallyApproved')", // partial badge
      "tMe('stageManager')", // pending stage line
      "tMe('viewDocument')", // own attachment link
      "t('cancelPendingBadge')", // ADR-0065 give-back pill
      '<EditLeaveDialog',
      '<CancelLeaveDialog',
      '<CancelDatesDialog',
      '<LeaveDateOutcome',
      "t('requestsEmpty')",
    ]) {
      expect(self.includes(kept), kept).toBe(true);
    }
  });

  it('the admin path keeps the full-width sortable/paginated table below its own breakdown card', () => {
    const adminPart = leavePage.slice(leavePage.indexOf('{admin && secondaryBreakdownCard}'));
    expect(adminPart).toContain('data-tour="leave-requests"');
    expect(adminPart).toContain("sortableTh('name'");
    expect(adminPart).toContain('<AdminCancelLeaveDialog');
    expect(adminPart).toContain("t('filters.rangeOf'"); // pager untouched
    expect(adminPart).toContain('colSpan={7}');
  });

  it('both branches carry the leave-requests tour anchor (one renders per role)', () => {
    expect(leavePage.split('data-tour="leave-requests"').length - 1).toBe(2);
  });
});
