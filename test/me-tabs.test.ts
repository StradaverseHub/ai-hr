/**
 * 311ad7ba — ESS "My Workspace" (/me) became a real tabbed page (Overview / Profile / Pay / Performance
 * / Documents) via the client-state `ClientTabs` shell, replacing the old anchor jump-nav. This is a
 * pure JSX relocation: every server-action <form> that worked on the long-scroll page must still be
 * bound after the move, the native GET reloads must carry a `tab` param so a full-document round-trip
 * lands back on the right tab, and the retired SectionJumpNav must be gone. A source-static test
 * (precedent: test/ea-pdf-i18n-keys.test.ts) is the cheapest guard against a future refactor silently
 * dropping one of these.
 *
 * a7cbd895 (My Absence): the Leave tab moved wholesale to /leave — /me no longer wires a leave tab or
 * binds the leave actions, and ?tab=leave redirects to /leave (guarded by test/my-absence-nav.test.ts).
 *
 * 0bb0e303 rev2: the three attendance/overtime/travel request forms moved to /attendance/requests. Same
 * treatment as the Leave tab — the actions leave ACTIONS but do NOT stop being checked; they are checked
 * at their new page, below, so "the capability vanished" still fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE = fs.readFileSync(path.resolve(__dirname, '../app/me/page.tsx'), 'utf8');
const REQUESTS_PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/attendance/requests/page.tsx'),
  'utf8',
);
// 1e9145d4 — overtime's new home. Read here so the assertion below can prove the form did not vanish
// when it left the Attendance Request screen, only moved.
const PLAN_OT_APPLY_PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/attendance/plan-ot/apply/page.tsx'),
  'utf8',
);

// Every server action the page bound on the long-scroll layout. Losing any of these = an ESS capability
// silently disappears from the UI, which the tab restructure must never do.
const ACTIONS = [
  'myCheckIn',
  'myCheckOut',
  // myRequestCorrection / myRequestOvertime / myRequestTravel left this list with the request forms
  // (0bb0e303 rev2) — they are bound on /attendance/requests, asserted in the describe at the foot.
  // myRequestLeave / myPreviewLeaveDeduction left this list with the Leave tab (a7cbd895) — the apply
  // capability lives on /leave (RequestLeaveDialog → requestLeaveAction), guarded by
  // test/leave-request-relocation.test.ts.
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

  it('wires the five profile tab keys and no Leave tab (moved to /leave · a7cbd895)', () => {
    for (const key of ['overview', 'profile', 'pay', 'performance', 'documents']) {
      expect(PAGE.includes(`key: '${key}'`), `missing tab key '${key}'`).toBe(true);
    }
    // The Leave tab is gone — leave self-service lives on /leave ("My Absence").
    expect(PAGE.includes("key: 'leave'")).toBe(false);
    expect(PAGE.includes('leave: (')).toBe(false);
    expect(PAGE.includes('action={myRequestLeave}')).toBe(false);
  });

  it('deep-links reloads back to their tab (native GET forms carry ?tab=)', () => {
    // Payslip month/cycle selector — a GET <form> that reloads the whole document.
    expect(PAGE.includes('name="tab" value="pay"')).toBe(true);
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

/**
 * 0bb0e303 rev2 — the three request forms moved off /me, and this is the repair of the ACTIONS list above
 * rather than a hole in it. Three facts, the same three the Leave relocation had to prove: the forms exist
 * on the new page, /me reaches that page, and the ONE implementation is shared rather than forked.
 */
describe('/me → /attendance/requests: the request forms moved, they did not disappear (0bb0e303 rev2)', () => {
  // 1e9145d4 SPLIT this list. All three forms left /me together, and two of them are still on
  // /attendance/requests. Overtime moved ON, to My Attendance > Plan OT, because pre-approval needed a
  // screen of its own — so it is asserted at ITS new page (PLAN_OT_APPLY_PAGE) rather than dropped, which
  // is the same treatment the Leave tab and these three forms each got when they moved.
  const MOVED = ['myRequestCorrection', 'myRequestTravel'];

  it('binds the two remaining request actions on the new page', () => {
    for (const a of MOVED) {
      expect(REQUESTS_PAGE.includes(`action={${a}}`), `missing form action={${a}} on /attendance/requests`).toBe(true);
    }
  });

  it('overtime moved on to Plan OT — the form is bound there, and only there', () => {
    expect(
      PLAN_OT_APPLY_PAGE.includes('action={myRequestOvertime}'),
      'the overtime form must be bound on Apply OT Plan',
    ).toBe(true);
    // Not left behind as a second copy: two overtime forms would drift, and the whole point of the move
    // is that overtime is filed in ONE place.
    expect(
      REQUESTS_PAGE.includes('action={myRequestOvertime}'),
      'the overtime form must not still be on Attendance Request',
    ).toBe(false);
    // …but the route staff already know still gets them there.
    expect(REQUESTS_PAGE).toContain('/attendance/plan-ot');
  });

  it('reuses /me’s actions rather than forking a second copy', () => {
    // A fork is the failure mode that matters here: two implementations of "file an attendance request"
    // drift, and the second one skips whatever the first learns. One import, one approval route.
    expect(REQUESTS_PAGE).toContain("from '@/app/me/actions'");
    expect(
      fs.existsSync(path.resolve(__dirname, '../app/attendance/requests/actions.ts')),
      'no second copy of the request actions beside the new page',
    ).toBe(false);
  });

  it('/me no longer binds them, and links across instead', () => {
    for (const a of [...MOVED, 'myRequestOvertime']) {
      expect(PAGE.includes(`action={${a}}`), `${a} is still bound on /me — the forms are in two places`).toBe(false);
    }
    expect(PAGE.includes('href="/attendance/requests"')).toBe(true);
    expect(PAGE.includes("t('fileAttendanceRequest')")).toBe(true);
  });

  it('keeps the geofenced punch on /me (311ad7ba) — only the request forms travelled', () => {
    // /me is one of only two places a punch can be made. A relocation that took the clock control with the
    // forms would remove that, quietly, on a change nobody read as touching clocking.
    expect(PAGE.includes('action={myCheckIn}')).toBe(true);
    expect(PAGE.includes('action={myCheckOut}')).toBe(true);
    expect(PAGE.includes('<LocationNotice />')).toBe(true);
  });

  it('lands the employee back on the page they posted from', () => {
    // The actions used to redirect to /me because that is where the forms were. Left unchanged, every
    // submission would have bounced the employee off the request page — and an error would have shown its
    // banner on a screen with no form on it.
    const actions = fs.readFileSync(path.resolve(__dirname, '../app/me/actions.ts'), 'utf8');
    expect(actions).toContain("const REQUESTS_PAGE = '/attendance/requests'");
    for (const marker of ['Attendance+request+submitted', 'Travel+requested']) {
      const line = actions.split('\n').find((l) => l.includes(marker));
      expect(line, `redirect for ${marker}`).toBeDefined();
      expect(line, `${marker} must return to the requests page`).toContain('${REQUESTS_PAGE}');
    }
    // 1e9145d4 — the overtime action answers to Plan OT now, for exactly the reason this block exists:
    // it must land the employee back on the page they posted from, and that page moved.
    expect(actions).toContain("const PLAN_OT_PAGE = '/attendance/plan-ot'");
    const otLine = actions.split('\n').find((l) => l.includes('Overtime+plan+submitted'));
    expect(otLine, 'redirect for Overtime+plan+submitted').toBeDefined();
    expect(otLine, 'overtime must return to Plan OT').toContain('${PLAN_OT_PAGE}');
    expect(actions.includes("redirect('/me?toast=Attendance+request+submitted')")).toBe(false);
  });
});
