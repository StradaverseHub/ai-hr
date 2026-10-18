/**
 * r398 — the Monolith shell's WIRING, which the DOM test cannot see because app/layout.tsx is a server
 * component that reads a session (see test/r398-monolith-shell.dom.test.tsx for the rendered half).
 *
 *  • The `monolith:` variant is keyed on the same attribute as the Monolith tokens.
 *  • The intent bar sits between the top line and <main>; the status line after <main>.
 *  • <CommandBar /> stays MOUNTED in Monolith (its centre track is hidden, not removed), because the intent
 *    bar opens that dialog and ⌘K lives in it.
 *  • Classic keeps its baseline class strings except the explicit mobile notification-panel repair
 *    below. That repair keeps the panel within the viewport; every other baseline class remains pinned.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Classic's baseline: main as last merged into build/r398-shell, i.e. main without r398. Pinned to a commit
 * (r401): once r398 merged, `main:` WAS this branch, so the sweep compared the shell with itself and passed on
 * nothing. A ref that moves cannot be a baseline. */
const CLASSIC_BASE = 'f79f0259f529dfafd1426fbf70389c8555495858';
const onMain = (p: string) => execFileSync('git', ['show', `${CLASSIC_BASE}:${p}`], { cwd: ROOT, encoding: 'utf8' });

const LAYOUT = read('app/layout.tsx');
const SIDEBAR = read('components/sidebar.tsx');
const CSS = read('app/globals.css');

/** Every literal className="…" in a source file. */
const classNames = (src: string) => [...src.matchAll(/className="([^"]+)"/g)].map((m) => m[1]);
/** Every single-quoted class list handed to cn() — three or more utilities, so prose and paths are skipped. */
const cnStrings = (src: string) =>
  [...src.matchAll(/'([a-z0-9!:[\]().%_/&>*=,-]+(?: [a-z0-9!:[\]().%_/&>*=,-]+){2,})'/g)].map((m) => m[1]);

// The original right-aligned absolute panel clipped outside the 390px viewport. The bounded fixed
// mobile panel and desktop absolute anchor were verified at 390px and 1280px on candidate fc3f41d7.
// This is one exact replacement, not permission to change other Classic shell styling.
const CLASSIC_NOTIFICATION_PANEL = 'absolute right-0 z-50 mt-2 w-[22rem] overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-card)]';
const RESPONSIVE_NOTIFICATION_PANEL = 'fixed right-3 z-50 mt-2 w-[22rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-card)] lg:absolute lg:right-0';

describe('Monolith shell wiring', () => {
  it('the monolith: variant keys on <html data-ui-theme="monolith">, like the tokens', () => {
    expect(CSS).toContain("@custom-variant monolith (&:where([data-ui-theme='monolith'] *));");
    expect(CSS).toContain(":root[data-ui-theme='monolith'] {");
  });

  it('the layout hands the resolved theme to the shell and mounts the Monolith-only pieces in order', () => {
    expect(LAYOUT).toContain('<UiThemeProvider theme={uiTheme}>');
    const header = LAYOUT.indexOf('</header>');
    const intent = LAYOUT.indexOf('<IntentBar />');
    const main = LAYOUT.indexOf('<main ');
    const status = LAYOUT.indexOf('<ShellStatusLine ');
    for (const i of [header, intent, main, status]) expect(i).toBeGreaterThan(-1);
    expect(header).toBeLessThan(intent);
    expect(intent).toBeLessThan(main);
    expect(main).toBeLessThan(status);
    expect(LAYOUT.match(/<IntentBar \/>/g)).toHaveLength(1);
  });

  it('the command bar stays mounted in Monolith: its track is hidden by CSS, not removed', () => {
    const at = LAYOUT.indexOf('<CommandBar />');
    expect(at).toBeGreaterThan(-1);
    const opening = LAYOUT.lastIndexOf('<div className="', at);
    expect(LAYOUT.slice(opening, at)).toContain('monolith:hidden');
    expect(LAYOUT.slice(opening, at)).not.toMatch(/\{monolith|uiTheme ===/);
  });

  it('the Monolith rail opens no flyout panel and offers no collapse (README §3: always open on desktop)', () => {
    expect(SIDEBAR).toContain('const openNode = openKey && !monolith');
    expect(SIDEBAR).toContain('const collapsed = monolith ? false : collapsedPref;');
  });
});

describe('Classic shell baseline, with the approved mobile notification positioning repair', () => {
  for (const file of ['app/layout.tsx', 'components/sidebar.tsx', 'components/company-switcher.tsx', 'components/notification-center.tsx']) {
    it(file, () => {
      const before = classNames(onMain(file));
      // Non-vacuity: a file whose classes could not be read would pass the loop below on nothing.
      expect(before.length).toBeGreaterThan(5);
      if (file === 'components/sidebar.tsx') {
        // The rail's own panel classes are cn() strings, not attributes — prove they are in the sweep.
        expect(cnStrings(onMain(file)).some((c) => c.includes('rounded-[1.25rem]'))).toBe(true);
      }
      const now = read(file);
      if (file === 'components/notification-center.tsx') {
        expect(before.filter(cls => cls === CLASSIC_NOTIFICATION_PANEL)).toHaveLength(1);
        expect(classNames(now).filter(cls => cls === RESPONSIVE_NOTIFICATION_PANEL)).toHaveLength(1);
      }
      const quoted = cnStrings(onMain(file));
      for (const cls of quoted) {
        const kept = now.includes(`'${cls}'`) || now.includes(`'${cls} monolith:`);
        expect(kept, `Classic cn() class string changed in ${file}: '${cls}'`).toBe(true);
      }
      for (const cls of before) {
        const expected = file === 'components/notification-center.tsx' && cls === CLASSIC_NOTIFICATION_PANEL
          ? RESPONSIVE_NOTIFICATION_PANEL : cls;
        // Either the exact attribute is still there, or the same string with `monolith:` utilities appended.
        const kept = now.includes(`className="${expected}"`) || now.includes(`className="${expected} monolith:`);
        expect(kept, `Classic class string changed in ${file}: "${cls}"`).toBe(true);
      }
    });
  }
});
