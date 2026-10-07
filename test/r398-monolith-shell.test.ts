/**
 * r398 — the Monolith shell's WIRING, which the DOM test cannot see because app/layout.tsx is a server
 * component that reads a session (see test/r398-monolith-shell.dom.test.tsx for the rendered half).
 *
 *  • The `monolith:` variant is keyed on the same attribute as the Monolith tokens.
 *  • The intent bar sits between the top line and <main>; the status line after <main>.
 *  • <CommandBar /> stays MOUNTED in Monolith (its centre track is hidden, not removed), because the intent
 *    bar opens that dialog and ⌘K lives in it.
 *  • CLASSIC IS UNTOUCHED: every class string of the shell elements as main ships them is still present
 *    verbatim, so the Monolith look can only have been ADDED as `monolith:` utilities, never edited in.
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

describe('Classic is untouched: main’s shell class strings are all still here, verbatim', () => {
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
      const quoted = cnStrings(onMain(file));
      for (const cls of quoted) {
        const kept = now.includes(`'${cls}'`) || now.includes(`'${cls} monolith:`);
        expect(kept, `Classic cn() class string changed in ${file}: '${cls}'`).toBe(true);
      }
      for (const cls of before) {
        // Either the exact attribute is still there, or the same string with `monolith:` utilities appended.
        const kept = now.includes(`className="${cls}"`) || now.includes(`className="${cls} monolith:`);
        expect(kept, `Classic class string changed in ${file}: "${cls}"`).toBe(true);
      }
    });
  }
});
