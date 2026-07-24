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
    // sm+: a real minmax(0,28rem) centre track — a bare `auto` track would size to content and the
    // w-full trigger would never widen, silently defeating the feature.
    expect(header).toContain('sm:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)]');
  });

  it("trigger carries aria-label={t('placeholder')} (WCAG 2.5.3 label-in-name)", () => {
    const trigger = commandBarSrc.slice(
      commandBarSrc.indexOf('<Dialog.Trigger'),
      commandBarSrc.indexOf('</Dialog.Trigger>'),
    );
    expect(trigger, 'components/command-bar.tsx must contain a Dialog.Trigger').not.toBe('');
    expect(trigger).toContain("aria-label={t('placeholder')}");
  });

  /**
   * Feedback 7fe7e1ae — the modal search field spilled past the popup's edge at narrow viewports.
   * Mechanism: the input is a flex item next to a `shrink-0` icon, so it carries the implicit
   * `min-width: auto` floor; a text input's intrinsic min-content width (the `size` attribute's
   * default of ~20 chars) stops it shrinking once the track left after icon + gap falls under that,
   * and the overflow lands on the modal border. `min-w-0` removes the floor, `flex-1` sizes it to
   * exactly the remaining track.
   *
   * KNOWN GAP (same shape as the delegation-popup-parity width guard): this is a SOURCE-STRING
   * guard, not a render assertion — the repo has no render harness and every command-bar guard is
   * source-static. It cannot prove the field actually fits; a later `size={40}` attribute or a
   * `w-[600px]` could reintroduce overflow while still passing. The narrowed claim is only that
   * `min-w-0` (the load-bearing token) is not silently dropped. On-screen verification at a narrow
   * viewport, not this assertion, is the real proof.
   */
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
});
