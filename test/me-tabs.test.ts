/**
 * 311ad7ba — ESS "My Workspace" (/me) became a real tabbed page (Overview / Profile / Pay / Performance
 * / Documents / Leave) via the client-state `ClientTabs` shell, replacing the old anchor jump-nav. This
 * is a pure JSX relocation: every server-action <form> that worked on the long-scroll page must still be
 * bound after the move, the new Leave tab must be wired, the native GET reloads must carry a `tab` param
 * so a full-document round-trip lands back on the right tab, and the retired SectionJumpNav must be gone.
 * A source-static test (precedent: test/ea-pdf-i18n-keys.test.ts) is the cheapest guard against a future
 * refactor silently dropping one of these.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE = fs.readFileSync(path.resolve(__dirname, '../app/me/page.tsx'), 'utf8');

// Every server action the page bound on the long-scroll layout. Losing any of these = an ESS capability
// silently disappears from the UI, which the tab restructure must never do.
const ACTIONS = [
  'myCheckIn',
  'myCheckOut',
  'myRequestCorrection',
  'myRequestOvertime',
  'myRequestTravel',
  'myRequestLeave',
  'myPreviewLeaveDeduction',
  'myUpdateContact',
  'myRequestProfileChange',
  'myUpdateGoalProgress',
  'myCreateGoal',
  'mySubmitPeerFeedback',
  'myDeclinePeerFeedback',
  'mySubmitResignation',
  'myWithdrawResignation',
];

describe('/me — tabbed My Workspace (311ad7ba)', () => {
  it('keeps every server-action binding present after the tab restructure', () => {
    for (const a of ACTIONS) {
      expect(PAGE.includes(`action={${a}}`), `missing form action={${a}}`).toBe(true);
    }
  });

  it('wires all six tab keys including the new Leave tab', () => {
    for (const key of ['overview', 'profile', 'pay', 'performance', 'documents', 'leave']) {
      expect(PAGE.includes(`key: '${key}'`), `missing tab key '${key}'`).toBe(true);
    }
    // The Leave tab must actually render leave content (application form lives there now).
    expect(PAGE.includes('leave: (')).toBe(true);
    expect(PAGE.includes('action={myRequestLeave}')).toBe(true);
  });

  it('deep-links reloads back to their tab (native GET forms carry ?tab=)', () => {
    // Payslip month/cycle selector — a GET <form> that reloads the whole document.
    expect(PAGE.includes('name="tab" value="pay"')).toBe(true);
    // Leave entitlement as-at date form re-renders via the breakdown component with tab preserved.
    expect(PAGE.includes("hiddenParams={{ tab: 'leave' }}")).toBe(true);
    // The server validates ?tab= and feeds it to the shell as defaultTab.
    expect(PAGE.includes('defaultTab={activeTab}')).toBe(true);
  });

  it('drops the retired anchor jump-nav', () => {
    expect(PAGE.includes('SectionJumpNav')).toBe(false);
    expect(fs.existsSync(path.resolve(__dirname, '../components/section-jump-nav.tsx'))).toBe(false);
  });

  it('replaces the Overview recent-days list with a link to the Attendance page', () => {
    expect(PAGE.includes("href=\"/attendance\"")).toBe(true);
    expect(PAGE.includes("t('viewAttendanceHistory')")).toBe(true);
  });
});
