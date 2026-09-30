/**
 * Item 3783fd87, part three — THE GREY.
 *
 * The reporter's words: "The overall Organization interface should also reduce the excessive grey
 * background and use a cleaner white card-based UI design." The approved plan's answer: "White cards on
 * a light page, with lines rather than filled grey blocks separating things."
 *
 * ── WHERE THE GREY ACTUALLY WAS (measured, not guessed) ───────────────────────────────────────────
 * `--background` is #f5f6fa and `--card` is #ffffff (app/globals.css). The company MAINTENANCE screen
 * put `<CompanyPanel>` straight onto the page — no <Card> at all, unlike the listing, which wraps every
 * one of its sections in one. Inside the panel the tab shell then washed itself in `bg-muted/20` and
 * each section drew itself as a `bg-background` block, i.e. a PAGE-GREY rectangle on a page-grey page.
 * That is the "large areas of grey background" of the request, and it is what this file pins gone.
 *
 * ── WHY A STATIC SOURCE GUARD ─────────────────────────────────────────────────────────────────────
 * Colour is the one thing a rendered-markup test cannot check: Tailwind class names survive into the
 * markup either way and nothing here computes a pixel. The decision being protected is therefore a
 * SOURCE decision — "these screens do not paint filled grey blocks" — and it is checked where it lives.
 * The same style as test/company-panel-bank-statutory-layout.test.ts, for the same reason.
 *
 * ⚠️ THIS IS NOT A BAN ON `bg-muted` EVERYWHERE, and the exceptions are deliberate:
 *   • a HOVER state (`hover:bg-muted/40` on a listing row) is feedback, not a background;
 *   • the shared constants in components/ui.tsx are NOT edited — every other admin table in the product
 *     keeps the house look, and these screens override them at the call site. Editing the constant is
 *     how one module's redesign silently restyles forty screens.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const PANEL = read('components/company-panel.tsx');
const DETAIL = read('app/admin/organization/[companyId]/page.tsx');
const LISTING = read('app/admin/organization/page.tsx');
const ROWS = read('app/admin/organization/company-rows.tsx');

/**
 * COMMENTS ARE STRIPPED FIRST (the r331 aec53564 lesson: a guard that reads its own explanation finds
 * the very thing it is banning). Every removal this file protects is recorded in a source comment that
 * NAMES the class it removed, and that record has to survive — so it must not be scanned. JSX comments
 * and block comments share one token, and line comments are dropped only when they start a line, so a
 * protocol-relative URL inside a string is untouched.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

/** A FILLED background, as opposed to a hover or focus STATE. */
const filled = (raw: string): string[] => {
  const src = stripComments(raw);
  return [...src.matchAll(/(?<![\w:-])bg-(?:background|muted)(?:\/\d+)?(?![\w-])/g)]
    .filter((m) => {
      const before = src.slice(Math.max(0, m.index - 24), m.index);
      // `hover:bg-muted/40` and friends are feedback, not a ground.
      return !/(hover|group-hover|focus|focus-visible|active|aria-selected|data-\[[^\]]*\]):$/.test(before);
    })
    .map((m) => m[0]);
};

describe('3783fd87 — the Organization screens paint white cards, not grey blocks', () => {
  it('the company panel paints no grey grounds at all', () => {
    expect(filled(PANEL), 'a filled grey ground came back into components/company-panel.tsx').toEqual([]);
  });

  /**
   * 15e5bd93 REVISION 2 (r353) — AND NEITHER DOES THE SCREEN THE STATUTORY EDITORS MOVED TO.
   *
   * 3783fd87's complaint was the "excessive grey background" on the Organization screens. Half of that
   * screen is now a route of its own (/admin/organization/[companyId]/statutory), and a new file is exactly
   * where the old habit comes back: nothing in this file was watching it. Extended rather than re-pointed,
   * because the panel still has grounds of its own to keep clean.
   */
  it('and the dedicated statutory setup screen paints none either', () => {
    // ⚠️ ONE FILE AGAIN (15e5bd93 rev 4, r371). r355 split the statutory surface into a list and a
    // one-body screen and this loop named both. The reporter contested the per-body page as "an
    // unnecessary intermediate page"; it is deleted and its editor is folded back into the screen as the
    // per-body CARD, so there is one file to watch. Named as a list rather than inlined, because the
    // next round that splits this surface again should have to add its file here.
    for (const rel of ['components/statutory-setup-screen.tsx']) {
      expect(filled(read(rel)), `a filled grey ground appeared in ${rel}`).toEqual([]);
    }
  });

  it('…and its sections are white cards with a LINE, which is what replaced each grey block', () => {
    // The section blocks. `bg-card` is #ffffff; the border is the separation the fill used to provide.
    expect(PANEL).toContain('rounded-lg border border-border bg-card p-3');
    expect(PANEL, 'the old filled block must not come back').not.toContain('rounded-lg bg-background p-3');
    /**
     * The three sub-blocks inside a statutory editor: a line, no fill. ⚠️ RE-POINTED BY r353 — the editor
     * is on the dedicated setup screen now, so the claim reads that file. The negative half is asserted on
     * BOTH: the filled block must not come back anywhere.
     */
    /**
     * ⚠️ RE-POINTED A THIRD TIME BY r371, AND ONE HALF IS REVERSED FOR A MEASURED REASON.
     *
     * r353 moved the three sub-blocks (Filing identity / Payment setup / Correspondence address) onto the
     * dedicated screen as `rounded-md border border-border/60 p-2.5`; r355 moved them to the per-body
     * page and this case followed. That page is deleted and the editor is a CARD on the one screen.
     *
     * The three group BORDERS are gone with it, and that is not a regression against 3783fd87: each body
     * is now its own bordered white card, so a border around every group INSIDE it was three boxes deep
     * — "individual large boxes" is the complaint efe424b0 raised in the first place. The groups keep a
     * heading and spacing, which is the "lines rather than filled grey blocks" this item asked for. What
     * is asserted unchanged, and is the whole point of the file, is that NO group grew a grey FILL.
     */
    const SETUP = read('components/statutory-setup-screen.tsx');
    expect(SETUP, 'no filled grey block came back in any group').not.toContain('rounded-md bg-muted/40 p-2.5');
    expect(SETUP, 'nor a page-grey ground').not.toContain('bg-background');
    // Every body is a white card with a LINE, the same treatment as every other section on this module.
    expect(SETUP, 'the body cards are lined white cards').toContain('rounded-lg border border-border bg-card p-4');
    expect(SETUP, 'and so is the identity card').toContain(
      '<section data-statutory-identity className="rounded-lg border border-border bg-card p-4">',
    );
    expect(PANEL).not.toContain('rounded-md bg-muted/40 p-2.5');
    // The tab shell keeps its separator and loses its wash.
    expect(PANEL).toContain('border-t border-border px-4 py-4');
    expect(PANEL).not.toContain('bg-muted/20 px-4 py-4');
  });

  it('the maintenance screen wraps the panel in the same Card the listing uses for its sections', () => {
    // Without this the panel sits on the raw page ground — the one Organization screen with no card.
    expect(DETAIL).toContain("import { Card, ErrorBanner, PageHeader, pageWideCls } from '@/components/ui';");
    expect(DETAIL).toMatch(/<Card>\s*\n\s*<CompanyPanel/);
    expect(DETAIL).toContain('</Card>');
  });

  it('the listing separates its table header with a line instead of a grey fill', () => {
    expect(LISTING).toContain("cn(theadCls, 'border-y border-border bg-transparent')");
    // The shared constants themselves are untouched, so every other admin table keeps the house look.
    const ui = read('components/ui.tsx');
    expect(ui, 'theadCls is the house standard and is not restyled for one module').toContain(
      "export const theadCls = 'bg-muted/50",
    );
  });

  it('a row HOVER is still allowed — it is feedback, not a background', () => {
    expect(ROWS).toContain('hover:bg-muted/40');
    expect(filled(ROWS), 'but nothing in the listing rows paints a static grey').toEqual([]);
  });
});
