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
// c6bb5f5a — the three screens the shared My Attendance page was split into. Each is read for the same
// reason PLAN_OT_APPLY_PAGE is: a relocation must be provable as a MOVE, never as a disappearance.
const PLAN_OT_LIST_SRC = fs.readFileSync(path.resolve(__dirname, '../app/attendance/plan-ot/page.tsx'), 'utf8');
const TRAVEL_SRC = fs.readFileSync(path.resolve(__dirname, '../app/attendance/travel/page.tsx'), 'utf8');
const REQUEST_STATUS_SRC = fs.readFileSync(
  path.resolve(__dirname, '../app/attendance/request-status/page.tsx'),
  'utf8',
);
// The ONE correction form, mounted twice (the pop-up every Request opens + the kept `?fix=` inline panel).
const CORRECTION_FORM = fs.readFileSync(
  path.resolve(__dirname, '../app/attendance/requests/correction-form.tsx'),
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
  // 1e9145d4 SPLIT this list, and c6bb5f5a SPLIT IT AGAIN — each time the same way, and each time because
  // the reporter asked for a function to have a screen of its own. All three forms left /me together;
  // where each one lives NOW is what this list records, so "the capability vanished" still fails:
  //   • myRequestCorrection — /attendance/requests, the Attendance Irregularity screen (a pop-up from
  //     every flagged row AND from "Correct another day"; the inline panel survives only for a legacy
  //     `?fix=` link. ONE form component serves every face — r227).
  //   • myRequestTravel — /attendance/travel, its own screen since c6bb5f5a.
  //   • myRequestOvertime — /attendance/plan-ot/apply, its own screen since 1e9145d4.
  const MOVED_ACTIONS = ['myRequestCorrection', 'myRequestTravel'];

  /**
   * Where each moved action is BOUND today, and how. `myRequestCorrection` is not bound with a literal
   * `action={…}` any more: c6bb5f5a made the correction form one shared component with two faces (the
   * inline panel and the "Correct another day" pop-up), so the page hands the action to that component
   * and the component binds it. Both halves are asserted below — a page that stopped mounting the form,
   * and a form that stopped binding what it was given, are the same lost capability.
   *
   * r227 RENAMED the pop-up `CorrectAnotherDayDialog` → `CorrectionDialog`, because it is what every
   * row's Request opens now and not only the free-date face. The assertion follows the rename rather than
   * being dropped: the property it pins — the page mounts the pop-up, and the pop-up is where the action
   * lands — is unchanged.
   */
  const BINDINGS: [string, string, string][] = [
    ['myRequestCorrection', 'app/attendance/requests/page.tsx', 'submitAction={myRequestCorrection}'],
    ['myRequestTravel', 'app/attendance/travel/page.tsx', 'action={myRequestTravel}'],
  ];
  const SRC_OF: Record<string, string> = {
    'app/attendance/requests/page.tsx': REQUESTS_PAGE,
    'app/attendance/travel/page.tsx': TRAVEL_SRC,
  };

  it('binds each moved request action on the page that now carries it', () => {
    for (const [a, file, marker] of BINDINGS) {
      expect(SRC_OF[file].includes(marker), `missing ${marker} on ${file}`).toBe(true);
    }
    expect(REQUESTS_PAGE).toContain('<CorrectionForm');
    expect(REQUESTS_PAGE).toContain('<CorrectionDialog');
    expect(CORRECTION_FORM).toContain('export function CorrectionDialog');
    expect(CORRECTION_FORM.includes('action={submitAction}'), 'the shared form binds the action it is given').toBe(
      true,
    );
    // The CANCEL control travelled with the list it belongs to (c6bb5f5a) and must not be left behind on
    // a screen that no longer shows the rows it acts on.
    expect(REQUEST_STATUS_SRC.includes('action={myCancelAttendanceRequest}'), 'cancel is on the list').toBe(true);
    expect(REQUESTS_PAGE.includes('myCancelAttendanceRequest'), 'and only there').toBe(false);
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
    // …and the route staff already know is where the LIST is, not a forward into somebody else's tab.
    //
    // ⚠️ THIS HALF IS THE REVERSAL, so read the history before flipping it back. 2166ef79 moved the Self
    // Overtime list ONTO /attendance/requests and left /attendance/plan-ot as a one-line redirect, which
    // is what this assertion used to pin (the requests page merely mentioning the plan-ot address).
    // c6bb5f5a is the reporter asking for the opposite, confirmed in writing: Self Overtime is a screen
    // of its own. So the property asserted is the one that survives both arrangements — the route resolves
    // to the overtime list — and it is now asserted where the list actually is.
    expect(PLAN_OT_LIST_SRC.includes('myOvertimePlans'), 'plan-ot renders the overtime list itself').toBe(true);
    expect(PLAN_OT_LIST_SRC.includes('redirect('), 'plan-ot no longer forwards into a tab').toBe(false);
    // The old tab address still resolves — a bookmark or a stale link must not 404 — and the irregularity
    // screen is what forwards it.
    expect(REQUESTS_PAGE).toContain("redirect('/attendance/plan-ot')");
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
    for (const a of [...MOVED_ACTIONS, 'myRequestOvertime']) {
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
    // Travel LEFT this list at c6bb5f5a — it has its own screen now, and is asserted against it below.
    // The correction form did not move, so it still answers to the requests page.
    for (const marker of ['Attendance+request+submitted']) {
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
    // c6bb5f5a — two more pages, two more homes. The RULE is unchanged and is the reason these lines are
    // read one by one rather than trusted to a variable name: an action must return the employee to the
    // screen they posted from. Travel and the request list are no longer on /attendance/requests, so an
    // untouched redirect would have bounced them off the screen they were reading onto one that no longer
    // shows what they just did.
    expect(actions).toContain("const TRAVEL_PAGE = '/attendance/travel'");
    expect(actions).toContain("const REQUEST_STATUS_PAGE = '/attendance/request-status'");
    for (const [marker, target] of [
      ['Travel+requested', '${TRAVEL_PAGE}'],
      ['Attendance+request+cancelled', '${REQUEST_STATUS_PAGE}'],
    ] as const) {
      const line = actions.split('\n').find((l) => l.includes(marker));
      expect(line, `redirect for ${marker}`).toBeDefined();
      expect(line, `${marker} must return to its own screen`).toContain(target);
    }
  });
});

/**
 * r227 — the Fix panel became a pop-up, and THREE things had to travel with it.
 *
 * Same rule as the describe above, one level down: this is a MOVE, and a move that drops part of what it
 * moved is a capability quietly deleted. None of these three had a guard before, which is precisely why
 * the plan had to name them; each one is invisible to types and to a 200.
 */
describe('r227 — Request opens the existing pop-up, and nothing is left behind', () => {
  it('the per-row Request is the pop-up, not a ?fix= link', () => {
    // The row used to render `<Link href={fixHref(d.date)}>`; it now mounts the dialog in the cell.
    expect(REQUESTS_PAGE).toContain("triggerLabel={t('maFixThis')}");
    expect(REQUESTS_PAGE.includes('fixHref'), 'the row no longer navigates to open the form').toBe(false);
  });

  it('1. the ?fix= address is no longer GENERATED, but still OPENS', () => {
    // Nothing writes the param…
    expect(REQUESTS_PAGE.includes("q.set('fix'"), 'the href helper may still carry a fix it was given').toBe(true);
    expect(REQUESTS_PAGE.includes('href({ fix:'), 'nothing links to a fix address any more').toBe(false);
    // …and the branch that renders it is kept, so an already-sent link still opens the form.
    expect(REQUESTS_PAGE).toContain('const fixDay =');
    expect(REQUESTS_PAGE).toContain('{fixDay && (');
  });

  it('2. a row files under ITS OWN section and kind, not the open tab’s', () => {
    // The "Also waiting for you" rows come from a different section. The old link switched section on the
    // way in; the pop-up is handed the row's own section instead. Reading `section` (the open tab) here
    // would file a cross-section request under the wrong request_kind — silently, and only visibly later
    // on the request list.
    expect(REQUESTS_PAGE).toContain('section={d.section}');
    expect(REQUESTS_PAGE).toContain('requestKind={KIND_OF_SECTION[d.section]}');
  });

  it('3. the absent day keeps BOTH routes — the form and “request leave instead”', () => {
    // maAbsentTwoRoutes says out loud, under the list, that an absent day has two answers. The second one
    // lived in the Card BELOW the inline form; moving the form without it deletes a route the screen
    // promises in words.
    expect(REQUESTS_PAGE).toContain("t('maAbsentTwoRoutes')");
    expect(CORRECTION_FORM).toContain('export function LeaveInsteadNote');
    expect(CORRECTION_FORM).toContain('/leave?apply=1&start=');
    expect(REQUESTS_PAGE).toContain('/leave?apply=1&start=');
    // Both faces render the SAME note rather than two copies that can drift.
    expect(REQUESTS_PAGE).toContain('<LeaveInsteadNote');
    expect(CORRECTION_FORM).toContain('<LeaveInsteadNote');
  });

  it('ONE confirm button beside Cancel — there is no draft state to save to', () => {
    // attendance_correction_status is pending|approved|rejected|cancelled. A "Save" that did not submit
    // would be a new lifecycle, not a second button, and the plan said so before it was approved.
    expect(CORRECTION_FORM).toContain('cancelLabel');
    expect(CORRECTION_FORM).toContain('<Dialog.Close asChild>');
    expect(CORRECTION_FORM.match(/type="submit"/g)?.length, 'exactly one submit control').toBe(1);
    expect(/draft/i.test(CORRECTION_FORM), 'no draft state was invented').toBe(false);
  });

  it('the table stays SERVER-side — the client dialog is mounted inside the cell', () => {
    // The r123 shape: ExceptionTable takes `t`, so making this file 'use client' to reach the dialog
    // would push a closure across the boundary — clean tsc, clean build, 500 at render.
    expect(REQUESTS_PAGE.trimStart().startsWith("'use client'")).toBe(false);
    expect(REQUESTS_PAGE).toContain('function ExceptionTable(');
    // The per-row TITLE is resolved server-side; `t` itself never crosses.
    expect(REQUESTS_PAGE).toContain("title={t('maFixHeading', { date: d.date })}");
  });
});

