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
 *     compiled Tailwind, at 1280 / 1440 / 1512.
 * A source scan cannot see a zero-width element. A measurement cannot see a control added to a cluster
 * it does not know about. Neither is redundant.
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
  it('header keeps the three-lane grid template (bounded centre track, minmax(0,1fr) sides)', () => {
    expect(LAYOUT).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
    // r256 narrowed the centre below 2xl: its max comes straight off BOTH side tracks, and at 28rem
    // everywhere the right cluster was 243px at 1280 / 323px at 1440 — too little for the account
    // corner to show a name at all. Equal 1fr sides at every step keep the search box centred.
    expect(LAYOUT).toContain('sm:grid-cols-[minmax(0,1fr)_minmax(0,20rem)_minmax(0,1fr)]');
    expect(LAYOUT).toContain('2xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)]');
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
    // The rail is the other half of `header width = viewport − 280`.
    expect(SIDEBAR).toContain(replicaConst('RAIL_WIDTH_CLS'));
  });
});
