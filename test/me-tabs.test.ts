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
 *
 * r259 (board item 9583deac) — THE TABS THEMSELVES CHANGED, and this file follows the change rather than
 * being deleted around it. My Profile was rebuilt in the shape of the Personnel record: six tabs —
 * Profile, Employment, Bank & Statutory, Payroll, Family, Documents — carrying Personnel Management's own
 * catalogue keys, because "an employee and the HR team are looking at two different shapes of the same
 * person" was the reported fault. Two of the five tabs it replaced had no Personnel counterpart, so their
 * contents MOVED and the move is asserted below exactly the way the Leave tab's was:
 *   • Performance (goals / 360 feedback / 1:1 check-ins) → /me/performance, a screen of its own, because
 *     /performance redirects a plain employee away and this was their only route to their own goals;
 *   • Overview → its clock in/out control stayed on /me ABOVE the tab strip (one of only two places a
 *     geofenced punch can be made), and its concurrent-positions list moved onto the Employment tab.
 * The tab NAMES are no longer asserted here — they are Personnel's keys now, and
 * test/me-profile-visibility.test.ts is where that relationship is pinned.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE = fs.readFileSync(path.resolve(__dirname, '../app/me/page.tsx'), 'utf8');
// r260 (9583deac stage two) — the "request a change" FORM and the Bank & Statutory tour anchor left
// page.tsx for this component, which /me renders once per tab that offers requestable fields. Same
// document, same server actions, one file further down; so the bindings and the tour anchors below are
// searched across BOTH files. That is not a relaxation: an action or an anchor still has to be provably
// present on the /me surface, it is simply no longer required to sit in one particular file of it.
const REQUEST_CARD = fs.readFileSync(path.resolve(__dirname, '../app/me/request-change-card.tsx'), 'utf8');
const ME_SURFACE = `${PAGE}\n${REQUEST_CARD}`;
// afc29d75 — all six catalogues, so "the retired string is gone" is checked where it can actually still
// be hiding. An unused key removed from en.json alone is the shape the unused-key check carries forever.
const MESSAGES: Record<string, { me: Record<string, unknown> }> = Object.fromEntries(
  ['en', 'ms', 'zh', 'ta', 'th', 'vi'].map((l) => [
    l,
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${l}.json`), 'utf8')) as { me: Record<string, unknown> },
  ]),
);
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
// b833a077 (r362) — MY TRAVEL WAS REMOVED, and this read is kept deliberately, now pointed at the
// redirect stub. The reporter asked for the feature to go, so this file no longer proves a MOVE; it
// proves the opposite, at the foot of this file: the screen is gone, the form is gone, and the address
// still forwards rather than 404-ing a bookmark. Keeping the readFileSync at module scope is also what
// makes a future deletion of that file a visible failure here instead of a whole-suite import error with
// zero AssertionErrors — the signature CLAUDE.md §4 warns reads as an environment fault.
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
  // myUpdateGoalProgress / myCreateGoal / mySubmitPeerFeedback / myDeclinePeerFeedback left this list at
  // r259 with the Performance tab — they are bound on /me/performance, asserted in the describe at the
  // foot of this file, so "the capability vanished" still fails.
  'mySubmitResignation',
  'myWithdrawResignation',
];
const PERFORMANCE_PAGE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../app/me/performance/page.tsx'),
  'utf8',
);

describe('/me — tabbed My Workspace (311ad7ba)', () => {
  it('keeps every server-action binding present after the tab restructure', () => {
    for (const a of ACTIONS) {
      expect(ME_SURFACE.includes(`action={${a}}`), `missing form action={${a}}`).toBe(true);
    }
  });

  it('wires the six Personnel-shaped tabs, and no Leave tab (moved to /leave · a7cbd895)', () => {
    // r259 REPLACED the five-key list that used to be here, and the replacement is not a weaker check:
    // the tab set now comes from ME_TABS (app/me/visible-fields.ts), so asserting the panel wiring is
    // asserting the whole strip. The five retired keys are asserted GONE below, which the old case could
    // not do because they were what it required.
    for (const key of ['profile', 'job', 'bankStatutory', 'payroll', 'family', 'documents']) {
      expect(new RegExp(`^\\s+${key}: `, 'm').test(PAGE), `missing panel for tab '${key}'`).toBe(true);
    }
    for (const dead of ["key: 'overview'", "key: 'pay'", "key: 'performance'"]) {
      expect(PAGE.includes(dead), `${dead} belongs to the arrangement r259 replaced`).toBe(false);
    }
    // The Leave tab is gone — leave self-service lives on /leave ("My Absence").
    expect(PAGE.includes("key: 'leave'")).toBe(false);
    expect(PAGE.includes('leave: (')).toBe(false);
    expect(PAGE.includes('action={myRequestLeave}')).toBe(false);
  });

  it('deep-links reloads back to their tab (native GET forms carry ?tab=)', () => {
    // Payslip month/cycle selector — a GET <form> that reloads the whole document. r259 renamed the tab
    // it lands on (`pay` → Personnel's `payroll`); the property is unchanged and the OLD address still
    // resolves, which the legacy map below is for.
    expect(PAGE.includes('name="tab" value="payroll"')).toBe(true);
    expect(PAGE, 'an old ?tab=pay bookmark must still land somewhere real').toContain(
      "const LEGACY_TAB: Record<string, MeTabKey> = { overview: 'profile', pay: 'payroll' };",
    );
    // The server validates ?tab= and feeds it to the shell as defaultTab.
    expect(PAGE.includes('defaultTab={activeTab}')).toBe(true);
  });

  it('drops the retired anchor jump-nav', () => {
    expect(PAGE.includes('SectionJumpNav')).toBe(false);
    expect(fs.existsSync(path.resolve(__dirname, '../components/section-jump-nav.tsx'))).toBe(false);
  });

  it('keeps the link to the Attendance page after the Overview tab was retired (r259)', () => {
    // The link outlived the tab it was on. It now sits beside the clock control above the tab strip.
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
  //   • myRequestOvertime — /attendance/plan-ot/apply, its own screen since 1e9145d4.
  //   • myRequestTravel — WAS /attendance/travel, its own screen since c6bb5f5a, and is GONE. b833a077
  //     (r362) removed My Travel completely at the reporter's request: the action, the form and the
  //     approvals section went with the screen, so there is no capability left to prove a home for. It is
  //     the one entry that left this list by REMOVAL rather than by relocation, and the case at the foot
  //     of this describe asserts that removal positively rather than simply dropping the coverage.
  const MOVED_ACTIONS = ['myRequestCorrection'];

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
    // b833a077 (r362) — ['myRequestTravel', 'app/attendance/travel/page.tsx', 'action={myRequestTravel}']
    // stood here. The action and the form are removed, not moved, so the binding is asserted ABSENT below.
  ];
  const SRC_OF: Record<string, string> = {
    'app/attendance/requests/page.tsx': REQUESTS_PAGE,
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

  /**
   * b833a077 (r362) — TRAVEL DID NOT MOVE, IT WAS REMOVED, and this case is what keeps that from being a
   * silent loss of coverage. Every other entry in this describe proves a relocation. This one proves the
   * opposite, in the three places the capability used to live, and one thing that must still be true:
   *
   *   • no page binds `myRequestTravel` — the action does not exist;
   *   • the old address still ANSWERS, as a redirect to Clock in/out, because travel bookmarks are in the
   *     wild and a 404 on a shipped URL is worse than a useful screen. It deliberately does not go to
   *     /attendance/my-records, which item 2aef3cd8 empties;
   *   • the screen renders no form and reads no travel service.
   *
   * The reporter kept every travel_request row for audit. This case says nothing about the data, only
   * about reachability — which is exactly the line the approved plan drew.
   */
  it('b833a077: My Travel was REMOVED — no form anywhere, and the old address forwards', () => {
    // Comments stripped: the stub's header explains what was removed, and why the destination is Clock
    // in/out rather than the emptied Attendance Overview, so it necessarily names both. Judging the
    // source text would let a comment stand in for a redirect — the same trap test/function-access.test.ts
    // closed in r362.
    const code = TRAVEL_SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code, 'the travel screen forwards to Clock in/out').toContain("redirect('/attendance/clock')");
    expect(code, 'and deliberately not to the emptied Attendance Overview').not.toContain(
      '/attendance/my-records',
    );
    expect(code, 'no travel form survives on that screen').not.toContain('myRequestTravel');
    expect(code, 'the travel service is not imported there').not.toContain('travel-request');
    // …and nowhere else either. The three pages that carried ESS request forms are the places a rebuilt
    // travel form would plausibly land.
    for (const [name, src] of [
      ['app/attendance/requests/page.tsx', REQUESTS_PAGE],
      ['app/attendance/plan-ot/apply/page.tsx', PLAN_OT_APPLY_PAGE],
      ['app/attendance/request-status/page.tsx', REQUEST_STATUS_SRC],
    ] as const) {
      expect(src.includes('myRequestTravel'), `${name} must not have picked up the removed travel form`).toBe(
        false,
      );
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
      // Searched over the WHOLE /me surface, so a moved form cannot come back by hiding in the request
      // card rather than in page.tsx.
      expect(ME_SURFACE.includes(`action={${a}}`), `${a} is still bound on /me — the forms are in two places`).toBe(
        false,
      );
    }
    expect(PAGE.includes('href="/attendance/requests"')).toBe(true);
    expect(PAGE.includes("t('fileAttendanceRequest')")).toBe(true);
  });

  it('keeps every guided-tour anchor the /me walkthrough targets (r259)', () => {
    // lib/module-tours.json drives the My Profile walkthrough by CSS selector. A rebuilt page that drops
    // an anchor does not error and does not fail to render — the tour simply has nothing to spotlight and
    // the step is silently skipped, which is invisible to types, to a 200 and to every other test here.
    // Four of the five moved card in this round, so this is the case that proves they moved WITH it.
    const tours = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../lib/module-tours.json'), 'utf8')) as {
      me: { steps: { target: string | null; route: string }[] };
    };
    const onThisPage = tours.me.steps.filter((st) => st.route === '/me' && st.target);
    expect(onThisPage.length, 'the /me walkthrough has steps').toBeGreaterThan(3);
    for (const st of onThisPage) {
      const attr = st.target!.replace(/^\[|\]$/g, '').replace(/"/g, '"');
      // r260 — one anchor is now written as a CONDITIONAL JSX prop on the shared request card
      // (`data-tour={tab === 'bankStatutory' ? 'me-bank' : undefined}`), so the literal
      // `data-tour="me-bank"` never appears in source even though it renders. Accept that form too, but
      // only in its strict shape: the attribute must be bound AND its exact value must still be written
      // somewhere on the surface, so deleting the anchor still fails this case.
      const asProp = /^([\w-]+)="(.+)"$/.exec(attr);
      const present =
        ME_SURFACE.includes(attr) ||
        (asProp !== null &&
          ME_SURFACE.includes(`${asProp[1]}={`) &&
          new RegExp(`['"]${asProp[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(ME_SURFACE));
      expect(present, `the /me walkthrough targets ${st.target} and the page no longer has it`).toBe(true);
    }
  });

  it('keeps the geofenced punch on /me (311ad7ba) — only the request forms travelled', () => {
    // /me is one of only two places a punch can be made. A relocation that took the clock control with the
    // forms would remove that, quietly, on a change nobody read as touching clocking.
    //
    // r259 is precisely such a change and this is what stopped it: the six Personnel-shaped tabs have no
    // clocking card, so the control moved ABOVE the strip rather than into a tab. Same page, same actions.
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
    // Travel LEFT this list at c6bb5f5a for a screen of its own, and b833a077 (r362) then removed that
    // screen and the action with it — so there is no travel redirect to check here or anywhere.
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
    // b833a077 (r362) — THIS LINE USED TO READ
    //   expect(actions).toContain("const TRAVEL_PAGE = '/attendance/travel'");
    // and the loop below led with ['Travel+requested', '${TRAVEL_PAGE}']. My Travel was removed
    // completely, so the constant, the action and the redirect are gone. The claim is INVERTED rather
    // than dropped: a TRAVEL_PAGE reappearing in this file would mean the form had been rebuilt.
    expect(actions, 'TRAVEL_PAGE went with the removed My Travel screen').not.toContain('TRAVEL_PAGE');
    expect(actions, 'no travel redirect survives').not.toContain('Travel+requested');
    expect(actions, 'the travel service is not imported any more').not.toContain('core/travel-request');
    expect(actions).toContain("const REQUEST_STATUS_PAGE = '/attendance/request-status'");
    // r363 — THIS MARKER USED TO READ 'Attendance+request+cancelled'. The screen it lands on calls the
    // act "Withdraw" for a correction as well as for an overtime plan now, so the toast says withdrawn.
    // What this case pins is unchanged and is the reason the marker is read literally: the action must
    // return the employee to the screen they posted from. The string is HARDCODED ENGLISH, not a message
    // key — a pre-existing gap shared by every `?toast=` in that file, recorded here rather than fixed.
    for (const [marker, target] of [
      ['Attendance+request+withdrawn', '${REQUEST_STATUS_PAGE}'],
    ] as const) {
      const line = actions.split('\n').find((l) => l.includes(marker));
      expect(line, `redirect for ${marker}`).toBeDefined();
      expect(line, `${marker} must return to its own screen`).toContain(target);
    }
  });
});

/**
 * afc29d75 (r241) — ONE list of every day that needs the employee, with the kind on the row.
 *
 * The reporter's complaint was that the same days rearranged themselves into a different set of boxes
 * depending on which tab you were on: the open section's table, plus an "Also waiting for you" card per
 * OTHER section showing three rows of it. Those cards are gone and the three tabs became FILTERS over one
 * date-ordered list, with "All" leading.
 *
 * Every case here pins something that types, a 200 and the rest of the suite are all blind to — a second
 * table creeping back, the kind falling off the row, or the absent day's second route quietly ceasing to
 * be named because it was keyed on the tab rather than on what is actually on screen.
 */
describe('afc29d75 — one consolidated Attendance Irregularity list', () => {
  const code = REQUESTS_PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('renders the list ONCE — the "also waiting for you" cards and their machinery are gone', () => {
    expect(code.match(/<ExceptionTable/g) ?? [], 'one table, not one per section').toHaveLength(1);
    for (const dead of ['OTHER_SECTIONS', 'ALSO_ROWS', 'maAlsoWaiting', 'maSeeAllInSection']) {
      expect(code.includes(dead), `${dead} belongs to the arrangement that was replaced`).toBe(false);
    }
  });

  it('the one list is all three kinds, in date order', () => {
    expect(code).toContain('const allDays: ExceptionDay[] = [...found.incomplete, ...found.short, ...found.absent]');
    expect(code, 'date order, not section order — the whole point of consolidating').toContain(
      'a.date.localeCompare(b.date)',
    );
  });

  it('"All" is the default and the first tab, and its count is the sum', () => {
    expect(code, 'no section in the address means all of them').toContain("? parsed : 'all'");
    const tabs = code.slice(code.indexOf('const TABS'), code.indexOf('];', code.indexOf('const TABS')));
    expect(tabs.indexOf("key: 'all'"), 'All leads the strip').toBeGreaterThan(-1);
    expect(tabs.indexOf("key: 'all'")).toBeLessThan(tabs.indexOf("key: 'short'"));
    expect(tabs, 'its count is every day, not a section total').toContain('count: allDays.length');
  });

  it('the kind is ON THE ROW, named by the tabs’ own labels', () => {
    // With one mixed list nothing about a day's kind is carried by which box it sits in, so the row has
    // to say it. Read through ONE mapping: a badge and a tab that name the same section differently is
    // the drift this repo keeps paying for.
    expect(code).toContain("<th className={thCls}>{t('maColType')}</th>");
    expect(code).toContain('{t(SECTION_LABEL[d.section])}');
    expect(code).toContain('SECTION_TONE[d.section]');
    const map = code.slice(code.indexOf('const SECTION_LABEL'), code.indexOf('} as const satisfies'));
    for (const key of ['maSectionShort', 'maSectionIncomplete', 'maSectionAbsent']) {
      expect(map, `the badge reuses ${key} rather than a second string for the same word`).toContain(key);
    }
  });

  it('the absent day’s second route is named while an absent day is ON SCREEN, not while a tab is open', () => {
    // maAbsentTwoRoutes promises two answers out loud. On the All filter an absent row is visible while
    // the open tab is not "Absent", so a note keyed on the tab would stop naming a route the row still
    // offers — a capability deleted by a condition, which is invisible to everything but this.
    expect(code).toContain("sectionDays.some((d) => d.section === 'absent')");
    expect(code.includes("{section === 'absent' && sectionDays.length > 0"), 'not keyed on the tab').toBe(false);
  });

  it('a legacy ?fix= link resolves against the WHOLE list, not the open filter', () => {
    // The address named a DAY, not a tab. Resolving it against the filtered list would make an
    // already-circulated link open nothing whenever the filter happened to exclude its day.
    expect(code).toContain('const fixDay = sp.fix ? allDays.find');
    // …and that panel files under the DAY's own kind now, because the open filter may be `all`, which is
    // not a section at all.
    expect(code).toContain('section={fixDay.section}');
    expect(code).toContain('requestKind={KIND_OF_SECTION[fixDay.section]}');
  });

  it('the filter is an address, not client state', () => {
    expect(code.includes("'use client'"), 'this page renders on the server').toBe(false);
    expect(code, 'the tabs are links, the same way section always was').toContain('href={href({ section: tab.key');
    expect(code).not.toMatch(/\buseState\b|\buseEffect\b/);
  });

  it('the retired strings are gone from ALL SIX catalogues, not just English', () => {
    for (const [locale, m] of Object.entries(MESSAGES)) {
      for (const dead of ['maAlsoWaiting', 'maSeeAllInSection']) {
        expect((m.me as Record<string, unknown>)[dead], `${locale}.me.${dead}`).toBeUndefined();
      }
      for (const added of ['maSectionAll', 'maSectionAllHelp', 'maFoundForYouAll', 'maEmptyAll']) {
        expect((m.me as Record<string, unknown>)[added], `${locale}.me.${added}`).toBeTruthy();
      }
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


/**
 * r259 — the Performance tab moved off /me, and it did not disappear.
 *
 * Same three facts the Leave and attendance-request relocations had to prove, and for the same reason:
 * the forms exist on the new page, /me reaches it, and there is ONE implementation rather than a fork.
 * The stakes are higher here than for the earlier moves. /performance redirects anyone who is neither an
 * administrator nor a manager back to the dashboard, so for a plain employee /me was the ONLY route to
 * their own goals, their peer-feedback requests and their check-in history. A tab deleted without its
 * contents would have removed four live self-service capabilities on a change nobody read as touching
 * performance — invisible to types, to a 200 and to the rest of the suite.
 */
describe('r259 — /me → /me/performance: the goals and feedback moved, they did not disappear', () => {
  const MOVED_ACTIONS = ['myCreateGoal', 'myUpdateGoalProgress', 'mySubmitPeerFeedback', 'myDeclinePeerFeedback'];

  it('binds every moved action on the page that now carries it', () => {
    for (const a of MOVED_ACTIONS) {
      expect(PERFORMANCE_PAGE_SRC.includes(`action={${a}}`), `missing action={${a}} on /me/performance`).toBe(true);
    }
    // The reads travelled too — a page that binds the forms but lists nothing is the same lost capability.
    for (const readFn of ['myGoals', 'myFeedbackRequests', 'myCheckIns', 'myReviews']) {
      expect(PERFORMANCE_PAGE_SRC.includes(readFn), `/me/performance no longer reads ${readFn}`).toBe(true);
    }
  });

  it('reuses /me’s actions rather than forking a second copy', () => {
    // A fork is the failure mode that matters: two implementations of "record my goal progress" drift, and
    // the second one skips whatever the first learns.
    expect(PERFORMANCE_PAGE_SRC).toContain("from '../actions'");
    expect(
      fs.existsSync(path.resolve(__dirname, '../app/me/performance/actions.ts')),
      'no second copy of the performance actions beside the new page',
    ).toBe(false);
  });

  it('/me no longer binds them, and links across instead', () => {
    for (const a of MOVED_ACTIONS) {
      expect(PAGE.includes(`action={${a}}`), `${a} is still bound on /me — the forms are in two places`).toBe(false);
    }
    expect(PAGE.includes('href="/me/performance"')).toBe(true);
    expect(PAGE.includes("t('myPerformanceLink')")).toBe(true);
    // An existing /me?tab=performance bookmark or notification link must still arrive.
    expect(PAGE).toContain("if (spTab === 'performance') redirect('/me/performance');");
  });

  it('lands the employee back on the page they posted from', () => {
    // The actions used to redirect to /me because that is where the forms were. Left unchanged, every
    // submission would have bounced the employee off the performance page — and an error would have shown
    // its banner on a screen with no form on it. The same rule 1e9145d4 and c6bb5f5a wrote down.
    const actions = fs.readFileSync(path.resolve(__dirname, '../app/me/actions.ts'), 'utf8');
    expect(actions).toContain("const PERFORMANCE_PAGE = '/me/performance'");
    for (const marker of ['Goal+added', 'Goal+updated', 'Feedback+submitted', 'Declined']) {
      const line = actions.split('\n').find((l) => l.includes(`toast=${marker}`));
      expect(line, `redirect for ${marker}`).toBeDefined();
      expect(line, `${marker} must return to the performance page`).toContain('${PERFORMANCE_PAGE}');
    }
    expect(actions.includes("redirect('/me?toast=Goal+added')"), 'the old /me redirect is gone').toBe(false);
  });

  it('the new page carries the six new locale-safe strings it needs', () => {
    for (const [locale, m] of Object.entries(MESSAGES)) {
      for (const added of ['myPerformanceLink', 'performancePageDescription', 'complianceFieldsNeedApproval']) {
        expect((m.me as Record<string, unknown>)[added], `${locale}.me.${added}`).toBeTruthy();
      }
    }
  });
});
