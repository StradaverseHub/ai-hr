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
});
