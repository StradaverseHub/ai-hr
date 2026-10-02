/**
 * DOES THE CORNER ACTUALLY SAY WHO YOU ARE, AT THE WIDTH YOU ARE SITTING AT? (r256, feedback fbf6abd0)
 *
 * ═══ THE MEASUREMENT THAT CAUSED THIS FILE ═══
 *
 * fbf6abd0 shipped a name + Employee ID in the topbar and shipped it INVISIBLE on laptop screens. In
 * real Chromium against the app's own dev server, signed in as the seeded employee, the name span's
 * getBoundingClientRect().width vs its scrollWidth was:
 *
 *      1280 → 0 of 87 needed      1440 → 0 of 87      1512 → 11 of 87
 *      1600 → 32 of 87            1920 → 87 of 87  ← whole ONLY here
 *
 * The Employee ID was 0 of 57 at 1280 and 1440 too. The corner rendered an initials circle and a
 * chevron and nothing else on the two most common desktop widths there are. Nothing caught it: the
 * markup is correct, so tsc, the suite, `next build` and a 200 all passed, and the source-static guard
 * in test/topbar-overlap-guard.test.ts asserted exactly the `min-w-0` / `truncate` classes that LET it
 * shrink to zero — it was green in precisely the broken state.
 *
 * jsdom cannot see this class of bug at all (it applies no CSS and computes no layout), which is why
 * this joins the real-browser project — real Chromium, real compiled Tailwind, real getBoundingClientRect
 * — rather than test/r256-account-identity.dom.test.tsx, which pins behaviour and says so itself.
 *
 * ═══ WHAT IS REAL HERE AND WHAT IS A STAND-IN ═══
 *
 * The app's header is inside a server component that reads a session and a database, so it cannot be
 * imported. This reproduces its GEOMETRY instead, and every number that matters is either the real
 * class string or checked against one:
 *
 *  • The header grid, the right cluster, the shell and the rail width are copied VERBATIM from
 *    app/layout.tsx / components/sidebar.tsx. test/topbar-overlap-guard.test.ts fails if the copies
 *    and the sources ever differ, so this file cannot quietly measure a header the app no longer has.
 *  • The UserMenu is THE REAL COMPONENT — it is the thing under test.
 *  • The bell / language / theme controls are stand-ins carrying `inline-flex size-9 …`, the same
 *    36px footprint their real components use; the same guard pins that they still do. They are
 *    fixed-size chrome, so their footprint is all that the layout depends on.
 *
 * Verified against reality: the header width this replica produces at 1280 and 1440 (1000px / 1160px)
 * is exactly what the running app produced at those viewports, and so is the account trigger's width.
 *
 * ═══ WHY THE BUDGET ASSERTION IS IN PIXELS AND USES A DELIBERATELY LONG NAME ═══
 *
 * A test browser has no Plus Jakarta Sans, so "how wide is this name" is not reproducible here. The
 * property being guarded is not the glyphs, it is the ROOM: the cluster must leave the identity at
 * least as many pixels as the real name needed. So one case feeds in a name long enough to saturate
 * whatever room exists and asserts the room is >= IDENTITY_BUDGET_PX, and a second case feeds a
 * realistic name and asserts nothing is truncated. Both fail on the shipped layout.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '../messages/en.json';
import '../app/globals.css';

// The logout server action, stubbed: importing it for real pulls lib/session → db/client, which opens a
// database connection at module load. Nothing here submits the form (same reasoning as the DOM test).
vi.mock('@/app/auth-actions', () => ({ logoutAction: async () => {} }));

const { UserMenu } = await import('../components/user-menu');

/* ── Copied VERBATIM from the sources. Pinned by test/topbar-overlap-guard.test.ts. ─────────────── */

/** app/layout.tsx — <body>. */
export const SHELL_BODY_CLS = 'h-dvh overflow-hidden bg-canvas p-3 font-sans lg:p-4';
/** app/layout.tsx — the rail/content row. */
export const SHELL_ROW_CLS = 'flex h-full gap-3 lg:gap-4';
/** app/layout.tsx — the content column that the header sits at the top of. */
export const SHELL_COL_CLS = 'flex min-w-0 flex-1 flex-col gap-3 lg:gap-4';
/** components/sidebar.tsx — the expanded rail. The collapsed state (w-[66px]) only gives MORE room. */
export const RAIL_WIDTH_CLS = 'w-[232px]';
/**
 * components/sidebar.tsx — ordinary routes hide the rail below sm; My Team hides it below 900px.
 * The original sm breakpoint was half of why the overflow band r374
 * found starts exactly at 640: that breakpoint takes 232px away from the header and, before r374,
 * handed 278px of it to the centre search in the same step.
 */
export const RAIL_VISIBILITY_CLS = 'hidden h-full shrink-0';
export const RAIL_DEFAULT_BREAKPOINT_CLS = 'sm:block';
export const RAIL_TEAM_BREAKPOINT_CLS = 'min-[900px]:block';
/** app/layout.tsx — the three-lane header grid. */
export const HEADER_CLS =
  'grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,max-content)] items-center gap-4 rounded-[1.25rem] border border-border bg-card px-4 shadow-[var(--shadow-card)] sm:grid-cols-[minmax(0,1fr)_minmax(0,min(20rem,max(0px,100%_-_27.75rem)))_minmax(0,max-content)] md:grid-cols-[minmax(0,1fr)_minmax(0,min(20rem,max(0px,100%_-_27.75rem)))_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,min(28rem,max(0px,100%_-_27.75rem)))_minmax(0,1fr)]';
/** app/layout.tsx — the right cluster the account control lives in. */
export const RIGHT_CLUSTER_CLS = 'flex min-w-0 items-center justify-end gap-2 2xl:gap-2.5';
/** app/layout.tsx — the divider that drops below md. */
export const DIVIDER_CLS = 'hidden h-5 w-px shrink-0 bg-border md:block';
/** The 36px footprint every icon control in the cluster carries (theme / language / bell). */
export const ICON_CLS = 'inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground';

/**
 * The room the identity must be left, in CSS px. This is the width the seeded employee's name
 * ("Aisyah Rahman", text-xs/600 in Plus Jakarta Sans) actually occupied in the running app — i.e. the
 * exact number the shipped header rendered ZERO of at 1280 and at 1440.
 */
const IDENTITY_BUDGET_PX = 87;

/** The two viewports the feature was invisible at. 1512 is a MacBook Pro 14"; it was 11px of 87 there. */
const WIDTHS = [1280, 1440, 1512] as const;

/**
 * body p-4 (16 each side) + the 232px rail + gap-4 (16) — so the header is `viewport − 280` at lg and
 * up, which is where every number in the r256 block above was measured.
 *
 * r374 widened this to the whole range, because the overflow it chased lives below lg: the shell pads
 * p-3 / gap-3 (12px) below lg. Ordinary routes show the rail from sm (640px); My Team from
 * 900px. The header is `viewport − 268` below lg when that route's rail is visible, and
 * `viewport − 24` when it is hidden. At the three laptop widths both variants still return
 * 1000 at 1280, 1160 at 1440, 1232 at 1512.
 */
const headerWidthFor = (viewport: number, myTeam = false) => {
  const pad = viewport >= 1024 ? 16 : 12; // body p-3 lg:p-4
  const gap = viewport >= 1024 ? 16 : 12; // the rail/content row gap-3 lg:gap-4
  const rail = viewport >= (myTeam ? 900 : 640) ? 232 + gap : 0; // team rail starts at 900; ordinary rail at sm
  return viewport - 2 * pad - rail;
};

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={en as never}
      onError={(e: unknown) => {
        throw e;
      }}
    >
      {ui}
    </NextIntlClientProvider>,
  );

/** The app shell around the header, at the real rail width, so the header gets its real width. */
function Shell({ account, myTeam = false }: { account: ReactNode; myTeam?: boolean }) {
  return (
    <div className={SHELL_BODY_CLS} data-testid="shell">
      <div className={SHELL_ROW_CLS}>
        {/* Copy both real route-specific breakpoints; the measurement must not invent a phone rail. */}
        <div className={`${RAIL_WIDTH_CLS} ${RAIL_VISIBILITY_CLS} ${myTeam ? RAIL_TEAM_BREAKPOINT_CLS : RAIL_DEFAULT_BREAKPOINT_CLS}`} />
        <div className={SHELL_COL_CLS}>
          <header className={HEADER_CLS} data-testid="topbar">
            <div className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
              <span className="shrink-0 font-medium text-foreground/80">Demo Group</span>
            </div>
            <div className="flex min-w-0 items-center justify-center">
              <span className="inline-flex h-10 w-auto min-w-0 items-center gap-2 rounded-md border border-input bg-card px-3 text-sm sm:w-full" />
            </div>
            <div className={RIGHT_CLUSTER_CLS} data-testid="right-cluster">
              <div className={DIVIDER_CLS} />
              {/* bell / language / theme: fixed 36px chrome, stood in by their own footprint class. */}
              <span className={ICON_CLS} />
              <span className={ICON_CLS} />
              <span className={ICON_CLS} />
              {account}
            </div>
          </header>
        </div>
      </div>
    </div>
  );
}

const box = (el: Element) => el.getBoundingClientRect().width;
/** The account trigger's stacked name/ID column — the flex item that was collapsing to zero. */
const identityColumn = () =>
  document.querySelector<HTMLElement>('[data-tour="account"] > span:nth-of-type(2)')!;
const lineWithText = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-tour="account"] span')].find(
    (s) => s.textContent === text,
  )!;

describe('topbar identity is actually visible at laptop widths', () => {
  beforeAll(() => {
    document.body.style.margin = '0';
  });
  afterEach(() => cleanup());

  it('compiles the real stylesheet (guards the harness, not the app)', async () => {
    await page.viewport(1440, 900);
    // Deliberately OUTSIDE the cluster: a probe inside it is a flex item and reports whatever the
    // layout squeezed it to, which would make this pass or fail for the reason under test rather
    // than for the reason it is asking about.
    wrap(<span className={ICON_CLS} data-testid="probe" />);
    // size-9 is 2.25rem = 36px. If this is not 36, Tailwind never reached the page and every
    // measurement below would be meaningless rather than false.
    expect(box(document.querySelector('[data-testid="probe"]')!)).toBeCloseTo(36, 0);
  });

  it('reproduces the running app’s header width (replica is not a fiction)', async () => {
    for (const width of WIDTHS) {
      await page.viewport(width, 900);
      const { unmount } = wrap(<Shell account={null} />);
      // 1000px at 1280 and 1160px at 1440 — the same numbers the dev server produced at those
      // viewports. A shell or rail change that moves this makes every budget below stale.
      expect(box(document.querySelector('[data-testid="topbar"]')!)).toBeCloseTo(
        headerWidthFor(width),
        0,
      );
      unmount();
    }
  });

  for (const width of WIDTHS) {
    it(`leaves the identity at least ${IDENTITY_BUDGET_PX}px at ${width}`, async () => {
      await page.viewport(width, 900);
      // A name long enough to want more room than exists, so the column reports the room it was GIVEN
      // rather than the width of these particular glyphs in whatever font this browser has.
      wrap(
        <Shell
          account={
            <UserMenu
              name="Nurulhuda binti Abdul Rahman Al-Hafiz"
              employeeCode="EMP-0001"
              employed
            />
          }
        />,
      );
      expect(box(identityColumn())).toBeGreaterThanOrEqual(IDENTITY_BUDGET_PX);
    });

    it(`renders the name and the Employee ID whole at ${width}`, async () => {
      await page.viewport(width, 900);
      wrap(<UserMenuShell name="Aisyah Rahman" code="EMP-0001" />);
      const name = lineWithText('Aisyah Rahman');
      const code = lineWithText('EMP-0001');
      // The reported defect, in the form it was measured: width 0, scrollWidth 87.
      expect(box(name)).toBeGreaterThan(0);
      expect(box(code)).toBeGreaterThan(0);
      // …and not merely non-zero — nothing ellipsised away.
      expect(Math.round(box(name))).toBe(name.scrollWidth);
      expect(Math.round(box(code))).toBe(code.scrollWidth);
    });

    it(`renders the name of an account with NO Employee ID whole at ${width}`, async () => {
      // The persona this item was raised for: the seeded HR administrator is a named person with no
      // employment, so the corner has a name and no code. It was 0px wide too.
      await page.viewport(width, 900);
      wrap(<Shell account={<UserMenu name="HR Admin" employeeCode={null} employed={false} />} />);
      const name = lineWithText('HR Admin');
      expect(box(name)).toBeGreaterThan(0);
      expect(Math.round(box(name))).toBe(name.scrollWidth);
    });
  }
});

function UserMenuShell({ name, code }: { name: string; code: string }) {
  return <Shell account={<UserMenu name={name} employeeCode={code} employed />} />;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * r374 — DOES THE TOPBAR FIT THE WINDOW? (feedback 371708bb)
 *
 * The other half of the same geometry, and the same reason this file is in a real browser: the
 * reported fault was "content runs off the right edge at narrow desktop widths (around 820 pixels),
 * forcing sideways scrolling", and it was NOT one page — measured on the dev server at an 820px
 * viewport, documentElement.scrollWidth was 856 against a clientWidth of 820 on all 13 routes swept,
 * identically, with and without the dev-only chrome. The element that escaped was the account
 * trigger's avatar and chevron: the right cluster needs 206px and the header's three-lane grid, which
 * took a fixed 20rem for the centre search before the fr side tracks got anything, had left it 83px.
 *
 * The invariant pinned here is "no horizontal overflow", NOT a pixel count — the numbers in the
 * r256 block above drift with fonts and chrome, this does not. Two assertions with deliberately
 * different scopes, because they are different claims:
 *
 *   • EVERY width, 320 → 1920: the shell's own scrollWidth does not exceed its clientWidth. That is
 *     the reported symptom exactly — nothing is reachable only by scrolling sideways.
 *   • FROM 640 UP: the right cluster's content also fits its grid TRACK. Below 640 it does not quite
 *     (188px of track for 197px of content at a 320px viewport) and the remainder is absorbed by the
 *     header's px-4 and the shell's p-3; asserting it there would be asserting something this round
 *     did not achieve. 640 is where the rail arrives and where the reported band began.
 *
 * jsdom cannot see any of this: it computes no layout, so every assertion here would be vacuously
 * true there. That is why this is a .browser test — and why it is NOT in `scripts/gate-chunked.sh`
 * (see vitest.browser.config.ts). test/topbar-overlap-guard.test.ts carries the gate-visible half.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Phone, the band the fault was reported in, both sides of every Tailwind breakpoint, and wide. */
const OVERFLOW_WIDTHS = [
  320, 360, 414, 480, 560, 600, 639, 640, 672, 700, 767, 768, 820, 899, 900, 901, 960, 1023, 1024, 1120, 1280,
  1440, 1512, 1535, 1536, 1600, 1920,
] as const;

/**
 * The first descendant whose right edge is outside `root`'s padding box — i.e. the element that is
 * making the box scrollable. Returned rather than asserted so the failure message names it; a bare
 * scrollWidth comparison says a number and not which control moved.
 */
const firstOverflowing = (root: HTMLElement): HTMLElement | null => {
  const limit = root.getBoundingClientRect().left + root.clientWidth;
  return (
    [...root.querySelectorAll<HTMLElement>('*')].find((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && b.right > limit + 0.5;
    }) ?? null
  );
};

const describeEl = (el: HTMLElement | null) =>
  el === null
    ? null
    : `<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> right=${Math.round(
        el.getBoundingClientRect().right,
      )}`;

describe('topbar fits the window at every width (r374)', () => {
  beforeAll(() => {
    document.body.style.margin = '0';
  });
  afterEach(() => cleanup());

  for (const myTeam of [false, true]) {
  for (const width of OVERFLOW_WIDTHS) {
    it(`needs no sideways scrolling at ${width} (${myTeam ? 'My Team' : 'ordinary'})`, async () => {
      await page.viewport(width, 900);
      // A name far longer than any seeded one, so the account control asks for every pixel it can and
      // the layout is measured under pressure rather than under slack.
      wrap(
        <Shell
          myTeam={myTeam}
          account={
            <UserMenu name="Nurulhuda binti Abdul Rahman Al-Hafiz" employeeCode="EMP-0001" employed />
          }
        />,
      );
      const shell = document.querySelector<HTMLElement>('[data-testid="shell"]')!;
      const header = document.querySelector<HTMLElement>('[data-testid="topbar"]')!;
      const cluster = document.querySelector<HTMLElement>('[data-testid="right-cluster"]')!;

      // ── NON-VACUITY. Every assertion below is "x is not bigger than y"; all of them pass on an
      // empty box. So first prove there IS a populated header of the app's real width here.
      expect(cluster.children).toHaveLength(5); // divider + bell + language + theme + account
      expect(header.querySelectorAll('*').length).toBeGreaterThan(10);
      expect(Math.round(header.getBoundingClientRect().width)).toBe(headerWidthFor(width, myTeam));
      expect(shell.clientWidth).toBe(width);

      // ── THE REPORTED SYMPTOM. 856 vs 820 at an 820px viewport before this round.
      expect(describeEl(firstOverflowing(shell))).toBe(null);
      expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);

      // ── AND THE LOCUS, from the breakpoint the rail arrives at: the cluster fits its own track, so
      // the account control is not being handed a zero-width box to spill out of.
      if (width >= 640) {
        expect(describeEl(firstOverflowing(header))).toBe(null);
        expect(cluster.scrollWidth).toBeLessThanOrEqual(cluster.clientWidth);
        expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
      }
    });
  }
  }
});
