/**
 * r398 — the Monolith shell's WIRING, which the DOM test cannot see because app/(app)/layout.tsx is a server
 * component that reads a session (see test/r398-monolith-shell.dom.test.tsx for the rendered half).
 *
 *  • The `monolith:` variant is keyed on the same attribute as the Monolith tokens.
 *  • The intent bar sits between the top line and <main>; the status line after <main>.
 *  • <CommandBar /> stays MOUNTED in Monolith (its centre track is hidden, not removed), because the intent
 *    bar opens that dialog and ⌘K lives in it.
 *  • Classic keeps its baseline class strings except the finite approved mobile repairs below.
 *    Every other baseline class remains pinned to the original immutable source.
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
// The baseline predates the (auth)/(app) root-layout split: its single app/(app)/layout.tsx held both shells.
const BASELINE_PATH: Record<string, string> = { 'app/(app)/layout.tsx': 'app/(app)/layout.tsx' };
const onMain = (p: string) => execFileSync('git', ['show', `${CLASSIC_BASE}:${BASELINE_PATH[p] ?? p}`], { cwd: ROOT, encoding: 'utf8' });
/** The current source a baseline file's classes must survive in: the old layout's login branch moved to app/(auth). */
const current = (p: string) => p === 'app/(app)/layout.tsx' ? read(p) + read('app/(auth)/layout.tsx') : read(p);

const LAYOUT = read('app/(app)/layout.tsx');
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
// The Kingdee mark was removed and the app is branded "AIHR" alone (owner decision 2026-10-20): the sidebar
// badge goes back to a plain primary lettered tile. An approved Classic change, mapped like the notification
// panel above. Same mapping as the branding branch (claude/app-branding-ai-hr-802edd), which spelled it "AI HR".
// Phone controls retain the verified 44px targets; every other Classic class remains pinned.
// ea0fba3de also permits the phone content column to shrink into its main scroller.
// This exact old-to-new mapping adds only max-sm:min-h-0; desktop classes stay identical.
const CLASSIC_APPROVED_MOBILE_REPAIRS:Record<string,Record<string,string>> = {
  "app/(app)/layout.tsx": {
    "flex min-w-0 flex-1 flex-col gap-3 lg:gap-4": "flex min-w-0 max-sm:min-h-0 flex-1 flex-col gap-3 lg:gap-4"
  },
  "components/company-switcher.tsx": {
    "flex min-w-0 max-w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition duration-150 ease-snappy hover:bg-muted active:scale-[0.98]": "flex min-w-0 max-w-full items-center min-h-11 gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition duration-150 ease-snappy hover:bg-muted active:scale-[0.98]"
  },
  "components/notification-center.tsx": {
    "relative inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground": "relative inline-flex size-9 items-center justify-center min-h-11 max-sm:min-w-11 rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
  }
};

const KINGDEE_BRAND_BADGE = 'grid size-10 shrink-0 place-items-center rounded-2xl bg-white p-1.5 ring-1 ring-border shadow-[var(--shadow-sm)]';
const KINGDEE_MARK_SIZE = 'size-full';
const HR_BRAND_BADGE = 'grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-[13px] font-bold text-primary-foreground shadow-[var(--shadow-sm)]';

describe('Monolith shell wiring', () => {
  it('the monolith: variant keys on <html data-ui-theme="monolith">, like the tokens', () => {
    // D-P1-32 D3: updated, not replaced — the variant still keys on the same attribute, and an area theme
    // (<div data-area-theme>, app/(app)/performance/area-theme.css) is excluded at zero specificity.
    expect(CSS).toContain("@custom-variant monolith (&:where([data-ui-theme='monolith'] *):not(:where([data-area-theme], [data-area-theme] *)));");
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
    // Monolith never collapses; Classic follows the preference, except in the D-P1-28 phone drawer (labels shown).
    expect(SIDEBAR).toContain('const collapsed = monolith ? false : collapsedPref && !(mobileNavigationOpen && !atelier);');
  });
});

describe('Classic shell baseline, with the approved mobile notification positioning repair', () => {
  for (const file of ['app/(app)/layout.tsx', 'components/sidebar.tsx', 'components/company-switcher.tsx', 'components/notification-center.tsx']) {
    it(file, () => {
      const before = classNames(onMain(file));
      // Non-vacuity: a file whose classes could not be read would pass the loop below on nothing.
      expect(before.length).toBeGreaterThan(5);
      if (file === 'components/sidebar.tsx') {
        // The rail's own panel classes are cn() strings, not attributes — prove they are in the sweep.
        expect(cnStrings(onMain(file)).some((c) => c.includes('rounded-[1.25rem]'))).toBe(true);
      }
      const now = current(file);
      for(const oldClass of Object.keys(CLASSIC_APPROVED_MOBILE_REPAIRS[file]??{}))expect(before.filter(cls=>cls===oldClass)).toHaveLength(1);
      if (file === 'components/notification-center.tsx') {
        expect(before.filter(cls => cls === CLASSIC_NOTIFICATION_PANEL)).toHaveLength(1);
        expect(classNames(now).filter(cls => cls === RESPONSIVE_NOTIFICATION_PANEL)).toHaveLength(1);
      }
      if (file === 'components/sidebar.tsx') {
        expect(before.filter(cls => cls === KINGDEE_BRAND_BADGE)).toHaveLength(1);
        expect(classNames(now).filter(cls => cls === HR_BRAND_BADGE)).toHaveLength(1);
        expect(classNames(now)).not.toContain(KINGDEE_BRAND_BADGE);
        expect(before.filter(cls => cls === KINGDEE_MARK_SIZE)).toHaveLength(1);
        expect(now).not.toContain('KingdeeMark');
      }
      const quoted = cnStrings(onMain(file));
      for (const cls of quoted) {
        const kept = now.includes(`'${cls}'`) || now.includes(`'${cls} monolith:`);
        expect(kept, `Classic cn() class string changed in ${file}: '${cls}'`).toBe(true);
      }
      for (const cls of before) {
        // The mark's own `size-full` went with the mark; nothing replaces it.
        if (file === 'components/sidebar.tsx' && cls === KINGDEE_MARK_SIZE) continue;
        const expected = file === 'components/notification-center.tsx' && cls === CLASSIC_NOTIFICATION_PANEL
          ? RESPONSIVE_NOTIFICATION_PANEL
          : file === 'components/sidebar.tsx' && cls === KINGDEE_BRAND_BADGE ? HR_BRAND_BADGE : CLASSIC_APPROVED_MOBILE_REPAIRS[file]?.[cls]??cls;
        // Either the exact attribute is still there, or the same string with `monolith:` utilities appended.
        const kept = now.includes(`className="${expected}"`) || now.includes(`className="${expected} monolith:`);
        expect(kept, `Classic class string changed in ${file}: "${cls}"`).toBe(true);
      }
    });
  }
});
