/**
 * Topbar overlap drift-guard (user-reported: "The search bar and company drop down overlaps").
 *
 * Source-static guard (precedent: test/layout-scroll-containment.test.ts). The header is a
 * three-lane grid — left cluster / centre search / right cluster — with minmax(0,1fr) side
 * tracks. The right cluster uses justify-end, so when its content is WIDER than its track the
 * excess spills LEFTWARD over the centre search box (observed on ~1280–1440px viewports after
 * the bell became visible to every role). The fix is not an overflow clip (that would cut the
 * company control) but shrink-capability down the chain: the cluster has min-w-0 so the grid
 * track constrains it, and the CompanySwitcher — the one compressible child — has a min-w-0
 * wrapper + max-w-full trigger so its label truncates with an ellipsis before anything can
 * collide. These assertions pin that chain so a future class tweak can't silently
 * re-introduce a nowrap/fixed-width floor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LAYOUT = fs.readFileSync(path.resolve(__dirname, '../app/layout.tsx'), 'utf8');
const SWITCHER = fs.readFileSync(
  path.resolve(__dirname, '../components/company-switcher.tsx'),
  'utf8',
);
const COMMAND_BAR = fs.readFileSync(path.resolve(__dirname, '../components/command-bar.tsx'), 'utf8');

describe('topbar — search box and company switcher keep to their own lanes', () => {
  it('header keeps the three-lane grid template (bounded centre track, minmax(0,1fr) sides)', () => {
    expect(LAYOUT).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
    expect(LAYOUT).toContain('sm:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)]');
  });

  it('right cluster is track-constrained (min-w-0) with narrow-viewport spacing trim', () => {
    expect(LAYOUT).toContain('flex min-w-0 items-center justify-end gap-2 xl:gap-2.5');
    // The divider drops below md so fixed chrome trims before anything collides.
    expect(LAYOUT).toContain('hidden h-5 w-px shrink-0 bg-border md:block');
  });

  it('company switcher flex item can compress below its label width', () => {
    // Wrapper: the actual flex item of the right cluster — min-w-0 removes the min-width:auto floor.
    expect(SWITCHER).toContain('<div className="relative min-w-0">');
    // Trigger: capped to the wrapper so the label truncates instead of overflowing.
    expect(SWITCHER).toContain('flex min-w-0 max-w-full items-center');
  });

  it('company switcher label truncates with a ceiling, not a fixed floor', () => {
    expect(SWITCHER).toContain('min-w-0 max-w-[14rem] truncate');
  });

  it('command bar trigger tolerates a narrow centre track (icon + ellipsised placeholder)', () => {
    expect(COMMAND_BAR).toContain('min-w-0 items-center');
    expect(COMMAND_BAR).toContain('hidden truncate sm:inline');
  });
});
