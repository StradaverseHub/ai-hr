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
    // A slice is only evidence if it is really the header. `indexOf` returns −1 on a miss and
    // slice(−1, −1) is '', which would make every assertion below pass against nothing.
    expect(layoutSrc.indexOf('<header')).toBeGreaterThanOrEqual(0);
    expect(header.length).toBeGreaterThan(400);

    // Mobile: auto centre track (icon-only trigger); the left track minmax(0,1fr) so it can shrink.
    // r374 made the RIGHT track minmax(0,max-content) below md — see below.
    expect(header).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,max-content)]');

    // sm+: a real BOUNDED centre track — a bare `auto` track would size to content and the w-full
    // trigger would never widen, silently defeating the feature.
    //
    // r256 made the max a two-step: the centre's ceiling is taken straight off BOTH side tracks, and at
    // 28rem everywhere the account corner's name and Employee ID measured 0px at 1280 and 1440. It is
    // 20rem below 2xl and 28rem from 2xl up. So what is pinned here is the PROPERTY this test exists
    // for — bounded, not `auto`, and wide enough to be a real track — while the exact ceilings, which
    // are a measured budget, are pinned by test/topbar-overlap-guard.test.ts.
    //
    // r374 UPDATED the shape without relaxing that property. A FIXED ceiling is sized BEFORE the fr
    // side tracks get anything, so from sm — the breakpoint that also brings in the 232px rail — the
    // side tracks collapsed and the account control left the viewport by 36px at an 820px window. The
    // ceiling is now `min(<ceiling>, 100% − <reserve>)`: still bounded, still ≥ 18rem of ambition, but
    // it can no longer eat the side clusters' floor. The reserve's arithmetic lives in
    // test/topbar-overlap-guard.test.ts; here we only pin that a reserve EXISTS on every bounded
    // variant, which is the property that stops the search box pushing the account control off-screen.
    const bounded = [
      ...header.matchAll(
        /(sm|md|2xl):grid-cols-\[minmax\(0,1fr\)_minmax\(0,min\((\d+)rem,max\(0px,100%_-_([\d.]+)rem\)\)\)_minmax\(0,(?:1fr|max-content)\)\]/g,
      ),
    ];
    // Three variants, or this matched nothing and asserted nothing.
    expect(bounded.map((m) => m[1])).toEqual(['sm', 'md', '2xl']);
    for (const m of bounded) {
      expect(Number(m[2]), `${m[1]} centre ceiling must stay a real track`).toBeGreaterThanOrEqual(18);
      expect(Number(m[3]), `${m[1]} must reserve room for both side clusters`).toBeGreaterThan(20);
    }
    // 2xl still widens the centre, as r256 decided.
    expect(Number(bounded[2][2])).toBe(28);
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
