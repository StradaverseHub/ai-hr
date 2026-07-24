/**
 * 95aafb3c — CompanySwitcher bulk Select all / Deselect all.
 *
 * The suite has no jsdom/RTL harness (vitest.config.ts runs the node environment and every test in
 * test/ is a source-static guard), so the click behaviour itself is browser-verified; this file
 * locks the two pieces of NEW wiring a regression would silently undo:
 *
 *   (a) the toggle button carries type="button". A bare <button> inside the <form action=…> would
 *       default to type=submit and fire a native submit of the PRE-change set alongside our own.
 *   (b) the checkbox list resyncs from the server-resolved `selected` prop after every revalidation
 *       via an effect keyed on the joined ids — NOT a one-time useState snapshot, which would drift
 *       out of step with the active scope, and NOT a remount key, which would close the popover
 *       mid-pick.
 *
 * Deliberately NOT re-asserted here: the three pinned layout class strings (owned by
 * test/topbar-overlap-guard.test.ts) and the resolution of the two new t() keys (owned by
 * test/i18n-coverage.test.ts check C). Assertions run on comment-stripped source so this prose can
 * neither satisfy nor trip them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Strip block comments so markup-shaped prose in doc comments can't satisfy (or trip) assertions. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const SWITCHER = stripComments(readFileSync(root + 'components/company-switcher.tsx', 'utf8'));

describe('95aafb3c · company switcher select-all toggle', () => {
  it('(a) the bulk toggle is a type="button" inside the form, labelled from the pending selection', () => {
    // The label flips live with the pending picks, so it must read off `allSelected`.
    expect(SWITCHER).toMatch(/allSelected \? t\('deselectAll'\) : t\('selectAll'\)/);
    // …and `allSelected` must be an every() over the rendered companies, not a size compare (a size
    // compare misfires if the pending set ever holds an id that is not in the listed companies).
    expect(SWITCHER).toMatch(/companies\.every\(\(c\) => sel\.has\(c\.id\)\)/);
    // The toggle button opens before the company rows and declares type="button".
    const toggleAt = SWITCHER.indexOf("t('deselectAll')");
    const buttonAt = SWITCHER.lastIndexOf('<button', toggleAt);
    expect(buttonAt).toBeGreaterThan(-1);
    expect(
      SWITCHER.slice(buttonAt, toggleAt),
      'the bulk toggle must be type="button" — a bare button in the form submits the pre-change set',
    ).toContain('type="button"');
  });

  it('(b) the checkbox list is controlled and resyncs from `selected` via an effect on the joined key', () => {
    // Controlled, not defaultChecked — the live button label needs a re-render on every tick.
    expect(SWITCHER).not.toContain('defaultChecked');
    expect(SWITCHER).toContain('checked={sel.has(c.id)}');
    // Resync effect: keyed on the joined ids so a revalidation refreshes the boxes without a remount.
    expect(SWITCHER).toContain("const selectedKey = selected.join(',')");
    expect(SWITCHER).toMatch(/useEffect\(\(\) => \{\s*setSel\(new Set\(selectedKey[^]*?\}, \[selectedKey\]\);/);
  });
});
