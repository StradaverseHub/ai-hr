/**
 * Header command-bar guard (centred top-bar search).
 *
 * The shared top-bar search (CommandBar trigger) was moved from the right-hand cluster into a
 * dedicated CENTRE zone of a three-zone grid header (app/layout.tsx), and the trigger enlarged
 * into a search-field-looking control (components/command-bar.tsx). Nothing else renders the
 * header, and test/rsc-boundary-guard.test.ts only walks page.tsx files — so without this guard
 * a refactor could silently drop the centred search (or the minmax grid that keeps it centred
 * and fillable) with every other gate still green. Cheap source assertions, no render harness.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const layoutSrc = readFileSync(root + 'app/layout.tsx', 'utf8');
const commandBarSrc = readFileSync(root + 'components/command-bar.tsx', 'utf8');

describe('top-bar centred search (app/layout.tsx + components/command-bar.tsx)', () => {
  it('renders CommandBar exactly once, inside the header', () => {
    const header = layoutSrc.slice(layoutSrc.indexOf('<header'), layoutSrc.indexOf('</header>'));
    expect(header, 'app/layout.tsx must contain a <header> element').not.toBe('');
    expect(header.match(/<CommandBar\s*\/>/g) ?? []).toHaveLength(1);
    // ... and nowhere else in the layout.
    expect(layoutSrc.match(/<CommandBar\s*\/>/g) ?? []).toHaveLength(1);
  });

  it('header uses the three-zone minmax grid (centre track can shrink AND be filled)', () => {
    const header = layoutSrc.slice(layoutSrc.indexOf('<header'), layoutSrc.indexOf('</header>'));
    // Mobile: auto centre track (icon-only trigger); side tracks minmax(0,1fr) so they can shrink.
    expect(header).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
    // sm+: a real BOUNDED centre track — a bare `auto` track would size to content and the w-full
    // trigger would never widen, silently defeating the feature.
    //
    // r256 made the max a two-step: the centre's ceiling is taken straight off BOTH side tracks, and at
    // 28rem everywhere the account corner's name and Employee ID measured 0px at 1280 and 1440. It is
    // 20rem below 2xl and 28rem from 2xl up. So what is pinned here is the PROPERTY this test exists
    // for — bounded, not `auto`, and wide enough to be a real track — while the exact ceilings, which
    // are a measured budget, are pinned by test/topbar-overlap-guard.test.ts.
    const centre = header.match(/sm:grid-cols-\[minmax\(0,1fr\)_minmax\(0,(\d+)rem\)_minmax\(0,1fr\)\]/);
    expect(centre, 'sm+ must keep a bounded minmax centre track').not.toBeNull();
    expect(Number(centre![1])).toBeGreaterThanOrEqual(18);
    expect(header).toContain('2xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)]');
  });

  it("trigger carries aria-label={t('placeholder')} (WCAG 2.5.3 label-in-name)", () => {
    const trigger = commandBarSrc.slice(
      commandBarSrc.indexOf('<Dialog.Trigger'),
      commandBarSrc.indexOf('</Dialog.Trigger>'),
    );
    expect(trigger, 'components/command-bar.tsx must contain a Dialog.Trigger').not.toBe('');
    expect(trigger).toContain("aria-label={t('placeholder')}");
  });

  // min-w-0/flex-1 is a defensive shrink guard, not the overlap fix - the r69 horizontal theory was measured false.
  it('modal search input can shrink inside the popup (min-w-0 + flex-1)', () => {
    // Exactly one <input> in the file, so the bounded slice below is unambiguous.
    expect(commandBarSrc.match(/<input\b/g) ?? []).toHaveLength(1);
    const start = commandBarSrc.indexOf('<input');
    const end = commandBarSrc.indexOf('/>', start);
    expect(end, 'the search <input> must be self-closing').toBeGreaterThan(start);
    const input = commandBarSrc.slice(start, end + 2);
    expect(input, 'search input needs min-w-0 to shrink below its intrinsic width').toContain('min-w-0');
    expect(input, 'search input needs flex-1 to fill the track left beside the icon').toContain('flex-1');
  });

  /**
   * Feedback 7fe7e1ae (the vertical fix) — the autofocused search field's focus ring collided with the
   * popup's top edge and rounded corners because the search row carried no vertical padding; a result row
   * (one Tab away) had the same problem at the bottom corners; and on Enter the Radix focus scope could
   * paint a stray ring on the dialog container itself, across all four corners. The fix adds the house
   * py-3 / p-3 spacing and an inline outline:none on the container.
   *
   * KNOWN GAP (same shape as the min-w-0 guard above): these prove the SPACE is declared in source, they
   * cannot prove rendered pixels — the repo has no render harness. The recorded on-screen browser
   * measurement, not these assertions, is the proof of the fix.
   */
  it('search row, results wrapper and dialog container carry the overlap-fix spacing', () => {
    // Search row: the only "border-b border-border px-4" in the file — must now also carry py-3.
    const rowStart = commandBarSrc.indexOf('flex items-center gap-2 border-b border-border px-4');
    expect(rowStart, 'search row div must exist').toBeGreaterThan(-1);
    const row = commandBarSrc.slice(rowStart, commandBarSrc.indexOf('>', rowStart));
    expect(row, 'search row needs py-3 so the input ring clears the popup top edge').toContain('py-3');

    // Results wrapper: p-2 -> p-3 so a result-row ring clears the popup bottom corners.
    expect(commandBarSrc, 'results wrapper needs p-3').toContain('<div className="p-3">');

    // Dialog.Content: inline outline:none suppresses the stray container ring across all four corners.
    const contentStart = commandBarSrc.indexOf('<Dialog.Content');
    const content = commandBarSrc.slice(contentStart, commandBarSrc.indexOf('>', contentStart));
    expect(content, "Dialog.Content needs an inline outline:none").toContain("outline: 'none'");
  });
});
