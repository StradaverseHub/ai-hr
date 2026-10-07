/**
 * Topbar overlap + capacity drift-guard.
 *
 * ═══ TWO USER-REPORTED FAULTS, ONE HEADER ═══
 *
 * d9b81f8d: "The search bar and company drop down overlaps". The header is a three-lane grid — left
 * cluster / centre search / right cluster — with minmax(0,1fr) side tracks. The right cluster uses
 * justify-end, so when its content is WIDER than its track the excess spills LEFTWARD over the centre
 * search box (observed on ~1280–1440px viewports after the bell became visible to every role). The fix
 * is not an overflow clip (that would cut the company control) but shrink-capability down the chain.
 *
 * fbf6abd0 / r256: the OPPOSITE failure, in the same cluster and caused by the same crowding. Shrinking
 * instead of spilling means a control can compress to NOTHING and nothing looks wrong. The account
 * corner's name and Employee ID measured 0px of the 87 and 57 they needed at 1280 and 1440 — the
 * identity feature was invisible on laptop screens while every static check was green, because the
 * classes asserted below are exactly the ones that let it shrink away.
 *
 * ═══ SO THIS FILE GUARDS THE BUDGET, NOT ONLY THE CLASSES ═══
 *
 * Shrink-capability keeps the cluster from colliding; ROOM is what keeps it from vanishing. The two
 * halves are:
 *   • here — the shrink chain, AND the cluster's child list, AND that the replica the browser test
 *     measures is still a copy of this header;
 *   • test/topbar-identity-width.browser.test.tsx — the measurement itself, in real Chromium with real
 *     compiled Tailwind, at 1280 / 1440 / 1512, plus r374's no-overflow sweep from 320 to 1920.
 * A source scan cannot see a zero-width element. A measurement cannot see a control added to a cluster
 * it does not know about. Neither is redundant.
 *
 * ⚠️ AND THE BROWSER HALF IS NOT IN THE GATE. vitest.browser.config.ts is a separate project run by
 * `pnpm test:browser`, deliberately outside scripts/gate-chunked.sh — so a green gate says nothing
 * about either measurement. Everything the gate can see about this header is in THIS file.
 *
 * r374 (feedback 371708bb) added the grid-template and reserve assertions below after the header was
 * found to overflow the VIEWPORT by 36px on every route between 640 and ~1000px wide.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

const LAYOUT = read('../app/layout.tsx');
const SWITCHER = read('../components/company-switcher.tsx');
const COMMAND_BAR = read('../components/command-bar.tsx');
const USER_MENU = read('../components/user-menu.tsx');
const SIDEBAR = read('../components/sidebar.tsx');
const DEV_SWITCHER = read('../components/dev-identity-switcher.tsx');
const BELL = read('../components/notification-center.tsx');
const THEME = read('../components/theme-toggle.tsx');
const LANGUAGE = read('../components/language-switcher.tsx');
/** The real-browser replica. Its class strings are copies of this header; that is checked below. */
const REPLICA = read('./topbar-identity-width.browser.test.tsx');

/** One of the replica's `export const NAME = '…'` class strings. */
const replicaConst = (name: string): string => {
  const m = REPLICA.match(new RegExp(`export const ${name} =[\\s\\S]*?'([^']*)'`));
  if (!m) throw new Error(`the browser replica no longer exports ${name}`);
  return m[1];
};

describe('topbar — search box and company switcher keep to their own lanes', () => {
  it('header keeps the three-lane grid template (bounded centre track, equal sides from md up)', () => {
    // r374 UPDATED THESE, it did not relax them. Before: a FIXED `minmax(0,20rem)` centre from sm up,
    // with minmax(0,1fr) sides at every step. A fixed track is taken before the fr tracks get anything,
    // so from sm — the same breakpoint that brings in the 232px rail — the side tracks collapsed to
    // 83px at an 820px viewport against a 206px floor in the right cluster, and the account control's
    // avatar + chevron left the viewport by 36px. See the ⚠️⚠️ block in app/layout.tsx for the numbers
    // and r374's measured sweep; the r374 sweep at the foot of
    // test/topbar-identity-width.browser.test.tsx re-measures it in a real engine.
    //
    // r256's own rule survives unchanged where it was measured: equal 1fr sides from md up keep the
    // search box centred (its max comes straight off BOTH side tracks, and at 28rem everywhere the
    // right cluster was 243px at 1280 / 323px at 1440 — too little for the account corner to show a
    // name at all, hence 20rem below 2xl).
    expect(LAYOUT).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,max-content)]');
    expect(LAYOUT).toContain(
      'sm:grid-cols-[minmax(0,1fr)_minmax(0,min(20rem,max(0px,100%_-_27.75rem)))_minmax(0,max-content)]',
    );
    expect(LAYOUT).toContain(
      'md:grid-cols-[minmax(0,1fr)_minmax(0,min(20rem,max(0px,100%_-_27.75rem)))_minmax(0,1fr)]',
    );
    expect(LAYOUT).toContain(
      '2xl:grid-cols-[minmax(0,1fr)_minmax(0,min(28rem,max(0px,100%_-_27.75rem)))_minmax(0,1fr)]',
    );
  });

  /**
   * r374 — the reserve in those templates is DERIVED, not chosen, and this is the arithmetic. If a
   * control joins the right cluster the floor goes up and 27.75rem is stale, which is why the child
   * list below is pinned: that test fails first, and whoever adds the control re-derives this one.
   */
  it('the centre track reserves exactly the two side clusters’ floor (2 × 206 + 32 = 27.75rem)', () => {
    // The right cluster's irreducible width: the 1px divider + three 36px icon buttons + four 8px
    // gaps, plus the account trigger's avatar (28) + chevron (16) + pl-1/pr-2 padding (12) + border
    // (2) + its own gap-2 (8) = 66, measured at 65px on the dev server.
    const RIGHT_CLUSTER_FLOOR_PX = 1 + 3 * 36 + 4 * 8 + 65;
    expect(RIGHT_CLUSTER_FLOOR_PX).toBe(206);
    const reserveRem = (2 * RIGHT_CLUSTER_FLOOR_PX + 2 * 16) / 16;
    expect(reserveRem).toBe(27.75);
    // …and the header spells that number in EVERY variant that bounds the centre track. A matchAll
    // whose result is empty would assert nothing, so the count is pinned: three bounded variants.
    const bounded = [...LAYOUT.matchAll(/grid-cols-\[minmax\(0,1fr\)_minmax\(0,min\([^\]]+\]/g)].map(
      (m) => m[0],
    );
    expect(bounded).toHaveLength(3);
    for (const variant of bounded) {
      expect(variant).toContain(`max(0px,100%_-_${reserveRem}rem)`);
    }
  });

  /**
   * r374 — the left cluster is the compressible SIDE below md (the right track is served first there),
   * so every child of it has to be able to give way. The dev identity switcher could not: a <select>
   * is as wide as its longest <option>, measured at 216px, which put a 369px floor under the whole
   * track and pushed the overflow straight back out of the header in local dev and on the gated demo.
   */
  it('dev identity switcher can compress (a <select> is as wide as its longest option)', () => {
    expect(DEV_SWITCHER).toContain('<form action={actAs} className="flex min-w-0 items-center gap-1.5">');
    // min-w-0 and nothing else. A `w-28` BASE was tried and measured worse: it redistributed the
    // cluster's shrinkage so the select rendered ~30px wide with no text at all at 1280, against
    // 48px ("HI…") without it. The floor is 0 either way; only the base size differs.
    expect(DEV_SWITCHER).toContain('className="min-w-0 max-w-full rounded-md border border-input');
  });

  it('right cluster is track-constrained (min-w-0) with narrow-viewport spacing trim', () => {
    expect(LAYOUT).toContain('flex min-w-0 items-center justify-end gap-2 2xl:gap-2.5');
    // The divider drops below md so fixed chrome trims before anything collides.
    expect(LAYOUT).toContain('hidden h-5 w-px shrink-0 bg-border md:block');
  });

  it('company switcher flex item can compress below its label width', () => {
    // Wrapper: the actual flex item of its cluster — min-w-0 removes the min-width:auto floor.
    expect(SWITCHER).toContain('<div className="relative min-w-0">');
    // Trigger: capped to the wrapper so the label truncates instead of overflowing.
    expect(SWITCHER).toContain('flex min-w-0 max-w-full items-center');
  });

  it('company switcher label truncates with a ceiling, not a fixed floor', () => {
    expect(SWITCHER).toContain('min-w-0 max-w-[14rem] truncate');
  });

  /**
   * fbf6abd0 added a SECOND text-bearing child to the right cluster — the account menu, carrying a
   * person's name and their Employee ID, both of which are arbitrarily long. It is exactly the shape of
   * child this file exists to keep shrink-capable, so it carries the same chain as the company switcher:
   * min-w-0 wrapper (the flex item), max-w-full trigger, and truncating labels with a ceiling.
   *
   * ⚠️ AND THAT IS NOT ENOUGH ON ITS OWN — see the capacity block below. These classes were all present
   * and correct while the name rendered at zero pixels.
   */
  it('account menu flex item can compress below its name/ID width', () => {
    expect(USER_MENU).toContain('<div className="relative min-w-0">');
    expect(USER_MENU).toContain('flex min-w-0 max-w-full items-center');
    // Both labels: the name and the Employee ID each truncate to a CEILING (tighter below md, where
    // there is less of everything) rather than setting a width floor.
    expect(USER_MENU.match(/max-w-\[7rem\] truncate/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(USER_MENU.match(/md:max-w-\[10rem\]/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('command bar trigger tolerates a narrow centre track (icon + ellipsised placeholder)', () => {
    expect(COMMAND_BAR).toContain('min-w-0 items-center');
    expect(COMMAND_BAR).toContain('hidden truncate sm:inline');
  });
});

/**
 * ═══ THE CAPACITY HALF (r256) ═══
 *
 * Measured at a 1280 viewport: the right track is 307px, the divider + three 36px icon buttons + four
 * 8px gaps take 141px, and the account trigger gets the 166 that remain — against the 161 it needs to
 * show "Aisyah Rahman" over "EMP-0001". A fifth control in this cluster does not overflow it; it takes
 * the name away, silently. So the child list is pinned, and a change to it has to arrive with a fresh
 * measurement rather than instead of one.
 */
describe('topbar — the right cluster has a budget and it is full', () => {
  /** The right cluster's markup: from its own className to the end of the header. */
  const cluster = (() => {
    const start = LAYOUT.indexOf('flex min-w-0 items-center justify-end gap-2 2xl:gap-2.5');
    const end = LAYOUT.indexOf('</header>', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return LAYOUT.slice(start, end);
  })();

  it('holds exactly the controls the 1280px measurement was taken with', () => {
    const components = [...new Set([...cluster.matchAll(/<([A-Z][A-Za-z]*)/g)].map((m) => m[1]))];
    // Adding to this list is allowed — but only together with a re-measurement in
    // test/topbar-identity-width.browser.test.tsx, which is what proves the name still renders.
    expect(components).toEqual(['NotificationCenter', 'LanguageSwitcher', 'ThemeToggle', 'UserMenu']);
  });

  it('keeps the company switcher and the tour launcher OUT of it', () => {
    // Both moved in r256 to buy the account corner its 166px: the switcher to the left cluster (where
    // it now shows its full label instead of being crushed to 27px), the launcher into the account
    // menu. Putting either back reproduces the zero-width name exactly.
    expect(cluster).not.toContain('<CompanySwitcher');
    expect(cluster).not.toContain('<TourLauncher');
    expect(LAYOUT).toContain('<CompanySwitcher companies={allowed} selected={scopeIds} />');
    expect(USER_MENU).toContain('<TourLauncher variant="menu"');
  });

  it('keeps the fixed chrome at the 36px footprint the budget was computed from', () => {
    // The three icon controls the browser replica stands in for. `size-9` is 2.25rem = 36px; if one of
    // them grows, the 166px the account trigger is left with shrinks by the difference.
    const footprint = 'inline-flex size-9 items-center justify-center';
    expect(BELL).toContain(footprint);
    expect(THEME).toContain(footprint);
    expect(LANGUAGE).toContain(footprint);
    expect(replicaConst('ICON_CLS').startsWith(footprint)).toBe(true);
  });

  /**
   * The browser test cannot import the header — it lives in a server component that reads a session and
   * a database — so it reproduces the geometry from copies of these class strings. That makes the copies
   * load-bearing: if the header changes and they do not, the measurement keeps passing for a header the
   * app no longer has. This is the check that stops that.
   */
  it('the measured replica is still a copy of THIS header', () => {
    expect(LAYOUT).toContain(replicaConst('HEADER_CLS'));
    expect(LAYOUT).toContain(replicaConst('RIGHT_CLUSTER_CLS'));
    expect(LAYOUT).toContain(replicaConst('SHELL_BODY_CLS'));
    expect(LAYOUT).toContain(replicaConst('SHELL_ROW_CLS'));
    expect(LAYOUT).toContain(replicaConst('SHELL_COL_CLS'));
    expect(LAYOUT).toContain(replicaConst('DIVIDER_CLS'));
    // The rail is the other half of `header width = viewport − 280`…
    expect(SIDEBAR).toContain(replicaConst('RAIL_WIDTH_CLS'));
    // …and r374's sweep reaches below sm, where the rail is not there at all, so the replica copies
    // its visibility too. Without this the sweep would measure a 232px rail inside a 320px phone.
    expect(SIDEBAR).toContain(replicaConst('RAIL_VISIBILITY_CLS'));
    expect(SIDEBAR).toContain(replicaConst('RAIL_DEFAULT_BREAKPOINT_CLS'));
    expect(SIDEBAR).toContain(replicaConst('RAIL_TEAM_BREAKPOINT_CLS'));
    // r398 — the Monolith replica is the SAME elements with `monolith:` utilities appended, so each is pinned
    // as "Classic string + space + Monolith suffix": a Monolith change re-measures, and the Classic half of
    // each string stays exactly what the measurements above were taken with.
    expect(LAYOUT).toContain(`${replicaConst('SHELL_BODY_CLS')} ${replicaConst('MONO_BODY_CLS')}`);
    expect(LAYOUT).toContain(`${replicaConst('SHELL_ROW_CLS')} ${replicaConst('MONO_ROW_CLS')}`);
    expect(LAYOUT).toContain(`${replicaConst('SHELL_COL_CLS')} ${replicaConst('MONO_COL_CLS')}`);
    expect(LAYOUT).toContain(`${replicaConst('HEADER_CLS')} ${replicaConst('MONO_HEADER_CLS')}`);
    expect(LAYOUT).toContain(`${replicaConst('LEFT_CLUSTER_CLS')} ${replicaConst('MONO_LEFT_CLS')}`);
    // The Monolith rail is NOT hidden at tablet widths (nothing else opens navigation there): no Monolith-only hide.
    expect(SIDEBAR).not.toMatch(/monolith:max-\[\d+px\]:hidden/);
    expect(BELL).toContain(`className="${replicaConst('BELL_CLS')}"`);
    expect(SIDEBAR, 'the measured route-specific breakpoint must match the actual rail').toContain(
      `pathname === '/manage/my-team' ? '${replicaConst('RAIL_TEAM_BREAKPOINT_CLS')}' : '${replicaConst('RAIL_DEFAULT_BREAKPOINT_CLS')}'`,
    );
  });
});
