/**
 * My Absence relocation (feedback a7cbd895) — static-source guard.
 *
 * "Move Leave Tab from My Profile to New My Absence Main Navigation Tab." Nav-only change: the existing
 * first-level /leave item is RENAMED to "My Absence", the /me Leave tab is removed and everything it
 * carried that /leave didn't already have (primary summary cards, per-date outcome expander, view-document
 * link, pending-stage line, partial badge) is ported onto /leave. NO leave business logic changes:
 * entitlement calculation, type configuration, approval workflow/hierarchy, validation, attachments,
 * carry-forward, accrual and permissions are untouched (same core services, same reads, same actions).
 *
 * DB-free source guard (precedent: test/leave-balance-relocation.test.ts): the RSC pages can't render in
 * this suite, so the nav rename, the tab removal, the redirect back-compat and the port are asserted
 * statically.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countQuoted } from './helpers/sidebar-source';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const sidebar = read('components/sidebar.tsx');
const permissions = read('lib/permissions.ts');
const leavePage = read('app/leave/page.tsx');
const mePage = read('app/me/page.tsx');
const meActions = read('app/me/actions.ts');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('My Absence: first-level nav rename (label-only, same href)', () => {
  it("sidebar row is labelKey 'myAbsence' with href '/leave' unchanged", () => {
    expect(sidebar.includes("{ href: '/leave', labelKey: 'myAbsence', icon: CalendarDays }")).toBe(true);
    // The old top-level 'leave' labelKey is gone (leaveConfig — the ADMIN config row — is unaffected).
    expect(countQuoted(sidebar, 'leave')).toBe(0);
    expect(countQuoted(sidebar, 'leaveConfig')).toBe(1);
  });

  it('the Security & Permission matrix column follows the rename (screenKey stays leave)', () => {
    expect(countQuoted(permissions, 'nav.myAbsence')).toBe(1);
    expect(countQuoted(permissions, 'nav.leave')).toBe(0);
    expect(permissions.includes("screenKey: 'leave'")).toBe(true); // may key stored role configs
  });

  it('every locale carries nav.myAbsence + leave.myAbsenceTitle; en drops the dead keys', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`)) as Record<string, Record<string, unknown>>;
      expect(msgs.nav.myAbsence, `${loc} nav.myAbsence`).toBeTruthy();
      expect((msgs.leave as Record<string, unknown>).myAbsenceTitle, `${loc} leave.myAbsenceTitle`).toBeTruthy();
      // Renamed/removed keys must not linger (nav.leave → nav.myAbsence; the /me Leave tab is gone).
      expect(msgs.nav.leave, `${loc} nav.leave`).toBeUndefined();
      expect(msgs.me.secLeave, `${loc} me.secLeave`).toBeUndefined();
    }
  });

  it('/leave titles itself with the My Absence key', () => {
    expect(leavePage.includes("title={t('myAbsenceTitle')}")).toBe(true);
  });
});

describe('My Absence: /me is purely profile — Leave tab removed, deep-links forwarded', () => {
  it('no leave tab key, no leave panel, no leave reads or dialogs on /me', () => {
    expect(mePage.includes("key: 'leave'")).toBe(false);
    expect(mePage.includes('leave: (')).toBe(false);
    for (const gone of [
      'leaveBalances(',
      'leaveEntitlementBreakdown(',
      'leaveRequestsFor(',
      'leaveRequestDateBreakdown(',
      'EditLeaveDialog',
      'CancelLeaveDialog',
      'CancelDatesDialog',
      'LeaveCards',
      'LeaveDateOutcome',
      'action={myRequestLeave}',
    ]) {
      expect(mePage.includes(gone), `still on /me: ${gone}`).toBe(false);
    }
  });

  it('back-compat: /me?tab=leave redirects straight to /leave', () => {
    expect(mePage.includes("if (spTab === 'leave')")).toBe(true);
    expect(mePage).toMatch(/redirect\(`\/leave\$\{/);
    expect(mePage.includes("import { redirect } from 'next/navigation'")).toBe(true);
  });

  it('the self-service leave actions land on /leave — no /me?tab=leave target remains', () => {
    expect(meActions.includes('/me?tab=leave')).toBe(false);
    // Same toast keys the equivalent /leave actions use (services themselves unchanged).
    expect(meActions.includes("redirect('/leave?toast=leaveUpdated')")).toBe(true);
    expect(meActions.includes("redirect('/leave?toast=leaveCancelled')")).toBe(true);
    expect(meActions.includes("redirect('/leave?toast=cancellationRequested')")).toBe(true);
    // The unchanged core services are still the ones called (no rebuild).
    for (const svc of ['editLeaveRequest(', 'cancelOwnLeave(', 'requestLeaveCancellation(']) {
      expect(meActions.includes(svc), svc).toBe(true);
    }
  });
});

describe('My Absence: everything the /me Leave tab had now lives on /leave', () => {
  it('hosts the primary "My Leave" summary cards (with the relocated me-leave tour anchor)', () => {
    expect(leavePage.includes('<LeaveCards entries={primaryCards} />')).toBe(true);
    expect(leavePage.includes('data-tour="me-leave"')).toBe(true);
    // The me-tour step follows the cards to /leave.
    const tours = JSON.parse(read('lib/module-tours.json')) as {
      me: { steps: { target: string | null; route: string | null }[] };
    };
    const step = tours.me.steps.find((s) => s.target === '[data-tour="me-leave"]');
    expect(step?.route).toBe('/leave');
  });

  it('ports the per-date outcome expander, document link, stage line and partial badge', () => {
    expect(leavePage.includes('<LeaveDateOutcome')).toBe(true);
    expect(leavePage.includes('leaveRequestDateBreakdown(session, r.id)')).toBe(true);
    // Own uploaded attachment — served by the UNCHANGED route under /me/leave/attachment.
    expect(leavePage.includes('/me/leave/attachment/${r.id}?inline=1')).toBe(true);
    expect(existsSync(root + 'app/me/leave/attachment/[id]/route.ts')).toBe(true);
    expect(leavePage.includes("tMe('leaveStatus.partiallyApproved')")).toBe(true);
    expect(leavePage.includes("tMe('stageManager')")).toBe(true);
  });

  it('keeps the pre-existing /leave capabilities intact (balances, apply, edit/cancel history)', () => {
    for (const kept of [
      '<LeaveBalanceTable',
      '<RequestLeaveDialog',
      '<EditLeaveDialog',
      '<CancelLeaveDialog',
      '<CancelDatesDialog',
      '<AdminCancelLeaveDialog',
    ]) {
      expect(leavePage.includes(kept), kept).toBe(true);
    }
  });
});
