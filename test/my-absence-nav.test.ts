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
// Since ADR-0080 rung 6 the My Absence / leave-config rows live on the leave PACK
// (packs/leave/index.ts, LEAVE_NAV_LINKS) and mount into components/sidebar.tsx through the pack
// registry, so the row-location assertions read the rail's COMBINED sources. The guarantee (row
// labelled myAbsence at /leave, config row present exactly once, /me tab removed + forwarded) is
// unchanged; only where the row's source text lives moved. Row content parity is
// test/leave-pack.test.ts.
const leavePack = read('packs/leave/index.ts');
const SRC = sidebar + leavePack;
const permissions = read('lib/permissions.ts');
const leavePage = read('app/leave/page.tsx');
const mePage = read('app/me/page.tsx');
const meActions = read('app/me/actions.ts');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('My Absence: first-level nav rename (label-only, same href)', () => {
  it("nav row is labelKey 'myAbsence' with href '/leave' unchanged (now on the leave pack)", () => {
    // The row literal moved verbatim onto the pack's LEAVE_NAV_LINKS (with its group tag).
    // 388e53c2 appended `exactHref: true` to this row — HIGHLIGHTING ONLY, never a gate (see the comment
    // above LEAVE_NAV_LINKS) — so the literal no longer closes at the icon. The match is deliberately
    // NOT anchored on the closing brace any more: this guard exists to hold the group, the href and the
    // labelKey, all three of which are unchanged, and row-content parity is test/leave-pack.test.ts.
    // Anchoring on `}` would fail again for the next legitimate field and teaches people to delete it.
    expect(
      leavePack.includes("{ group: 'main', href: '/leave', labelKey: 'myAbsence', icon: CalendarDays"),
    ).toBe(true);
    // The old top-level `labelKey: 'leave'` is gone (renamed to myAbsence; leaveConfig — the ADMIN
    // config row — is unaffected). Asserted on the labelKey form directly: since rung 6 the sidebar's
    // only bare `'leave'` token is the `modulePackById('leave')` registry lookup, not a nav labelKey.
    expect(sidebar.includes("labelKey: 'leave'")).toBe(false);
    // leaveConfig appears exactly once across the rail's combined sources (moved, not duplicated).
    expect(countQuoted(SRC, 'leaveConfig')).toBe(1);
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
      // Feedback 421d7551 — "My Absence" is renamed to "My Leave" everywhere a person can see it.
      // The keys keep their names (source asserts them below); only the VALUES changed, so this is a
      // negative guard against the pre-rename wording coming back — a legitimate future re-word stays
      // free. zh/ta/th/vi already carried the in-language "leave" term and were not touched.
      for (const stale of ['My Absence', 'Ketidakhadiran Saya']) {
        expect(msgs.nav.myAbsence, `${loc} nav.myAbsence`).not.toBe(stale);
        expect((msgs.leave as Record<string, unknown>).myAbsenceTitle, `${loc} leave.myAbsenceTitle`).not.toBe(
          stale,
        );
      }
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
    // UPDATED BY r302 (6c9802c9): the primary tiles became the leave balance dashboard (every type that
    // applies, Primary first, with shared groups as tiles). The me-leave tour anchor stays on its Card, which
    // is what this case defends: the My Profile walkthrough still lands on the employee's balances.
    expect(leavePage).toMatch(/<MyLeaveDashboard\s+cards=\{dashboardCards\}/);
    expect(leavePage.includes('data-tour="me-leave"')).toBe(true);
    expect(leavePage.split('data-tour="me-leave"').length - 1).toBe(1);
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
    // r302 (6c9802c9): the stage line ("Manager review" / "HR review") is replaced by the approver line — who
    // it is waiting for and at which level, labelled by the step's KIND — and the step-by-step progress.
    expect(leavePage.includes("tMe('stageManager')")).toBe(false);
    expect(leavePage.includes('approverLine: approverLineFor(r)')).toBe(true);
    expect(leavePage.includes("t('myLeave.waitingForRole', { role, level: line.level, of: line.of })")).toBe(true);
  });

  it('keeps the pre-existing /leave capabilities intact (balances, apply, edit/cancel history)', () => {
    for (const kept of [
      // r302: balances are the dashboard now (the My balances table is removed by the approved plan).
      '<MyLeaveDashboard',
      '<RequestLeaveDialog',
      '<EditLeaveDialog',
      '<CancelLeaveDialog',
      '<CancelDatesDialog',
    ]) {
      expect(leavePage.includes(kept), kept).toBe(true);
    }
    // afd0a87c — AdminCancelLeaveDialog went with the org-wide request table and is NOT a lost
    // capability: cancelling someone else's leave lives on Employee Leave Record (where fe3eb141 moved
    // it) and on the dashboard calendar. Asserted at both surviving homes so it cannot go homeless later.
    expect(leavePage.includes('<AdminCancelLeaveDialog')).toBe(false);
    expect(read('app/leave/employee-records/page.tsx')).toContain('<AdminCancelLeaveDialog');
    expect(read('components/planned-absences-grid.tsx')).toContain('<AdminCancelLeaveDialog');
  });
});
