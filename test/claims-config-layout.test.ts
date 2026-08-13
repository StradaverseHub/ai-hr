/**
 * e7eb5d83 rev 6 — the claim configuration module is full width, and the Per Block row does not stack.
 *
 * WHY ONE FILE FOR TWO COMPLAINTS. The reporter raised them separately — "the claim config screens are
 * narrow" and "Per Block stacks onto another line" — and they are one fault seen from two ends. Pinning
 * them apart would let either half be reverted on its own and leave the other looking arbitrary, which is
 * roughly how rev 5 shipped a mockup promising a row the real screen had no room to draw.
 *
 * Source-static guard in the house style of test/attendance-screens-layout.test.ts and
 * test/leave-config-full-width.test.ts, plus ONE assertion that is not source-static: section D compiles
 * Tailwind and reads the order it emits utilities in. That one is here because the Per Block bug was a
 * CASCADE bug, and no amount of reading the JSX reveals it — see below.
 *
 * Limits, inherited from the precedent: a className composed through cn() or a variable escapes a source
 * check. Every class this file cares about is a string literal or a named const in the same file, and
 * section D covers the one that is neither.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** All string-literal className values in a source file (double-quoted or template literal). */
const classNameLiterals = (source: string): string[] =>
  [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);

/** A PAGE-level cap: ONE className carrying BOTH `mx-auto` AND a `max-w-...xl`. Requiring the pair keeps
 *  legitimate inner caps (a dialog, a single field) out of scope — they cap themselves without centering
 *  the page. Identical predicate to the attendance and leave guards, on purpose. */
const capsPage = (cls: string) => /\bmx-auto\b/.test(cls) && /\bmax-w-\d*xl\b/.test(cls);

// ─────────────────────── A. the four claim config screens that RENDER ───────────────────────

/**
 * The tabs behind components/claims-tabs.tsx. `forms/page.tsx` is deliberately NOT here and section B
 * says why — it is not an omission.
 */
const WIDE_SCREENS = [
  'app/admin/claims/page.tsx',
  'app/admin/claims/limits/page.tsx',
  'app/admin/claims/mileage/page.tsx',
  'app/admin/claims/reimbursements/page.tsx',
];

describe('e7eb5d83 rev 6 · A — the claim config module is full width', () => {
  it.each(WIDE_SCREENS)('%s uses pageWideCls', (file) => {
    // The APPLICATION, not the import. Checking only for the identifier (which is what the attendance and
    // leave guards do) passes on a file that imports it and then hand-writes a width anyway — verified by
    // reverting one page and watching this case stay green while the next one went red.
    expect(read(file), `${file} must APPLY the named pageWideCls constant, not merely import it`).toContain(
      '<div className={pageWideCls}>',
    );
  });

  it.each(WIDE_SCREENS)('%s has no centered max-width cap', (file) => {
    const offending = classNameLiterals(read(file)).filter(capsPage);
    expect(offending, `${file} re-introduces a page-level width cap: ${offending.join(' | ')}`).toEqual([]);
  });

  it('all four moved together — a tab strip whose content changes width as you click it is its own defect', () => {
    // Stated as its own case so that widening three of four reads as a failure rather than as progress.
    for (const f of WIDE_SCREENS) expect(classNameLiterals(read(f)).some(capsPage), f).toBe(false);
  });

  it('DOES NOT reach outside the claims module — Fixed Transaction stays as it is', () => {
    // The panel round-trip (HANDOFF): a layout changed adjacent to what was asked gets reversed later.
    // Fixed Transaction is also narrow, was named in the plan as explicitly OUT of scope, and must not be
    // swept in by a future "make the config screens wide" pass reading this file as licence. Its cap is
    // `max-w-[100rem]`, an arbitrary value, so capsPage above does not see it — hence the wider predicate
    // here. Widening it is a decision for whoever is asked to, not a side effect of this round.
    const fixed = 'app/payroll/transactions/fixed/page.tsx';
    const src = read(fixed);
    const capped = classNameLiterals(src).some((c) => /\bmx-auto\b/.test(c) && /\bmax-w-/.test(c));
    expect(capped, `${fixed} was NOT in scope for e7eb5d83`).toBe(true);
    expect(src).not.toContain('pageWideCls');
  });
});

// ─────────────────────── B. the fifth "screen" is not a screen ───────────────────────

describe('e7eb5d83 rev 6 · B — /admin/claims/forms is a redirect, not a narrow page', () => {
  it('renders no markup at all, so it has nothing to widen', () => {
    // The plan counted five claim config pages with zero uses of pageWideCls and asked for all five to be
    // widened. Four of those zeroes mean "capped"; this one means "renders nothing" — the file is a
    // guarded permanent redirect kept alive for bookmarks and for lib/permissions.ts. Adding pageWideCls
    // here would be a class on a component that never returns an element.
    const src = read('app/admin/claims/forms/page.tsx');
    expect(src).toMatch(/permanentRedirect\('\/admin\/claims'\)/);
    expect(src).toMatch(/requireAdmin/);
    expect(classNameLiterals(src)).toEqual([]);
    expect(src).not.toContain('pageWideCls');
  });
});

// ─────────────────────── C. the Per Block cell ───────────────────────

const GRID = 'components/claim-limits-grid.tsx';

/** The Per Block <td>'s markup: from the flex container to the end of the cell. */
function blockCellSource(): string {
  const src = read(GRID);
  const start = src.indexOf('<div className={blockCellCls}>');
  expect(start, 'the Per Block cell no longer uses the named blockCellCls const').toBeGreaterThan(-1);
  const end = src.indexOf('</td>', start);
  return src.slice(start, end);
}

describe('e7eb5d83 rev 6 · C — Per Block reads as one row', () => {
  it('wraps only below a breakpoint — it is not unconditionally flex-wrap', () => {
    const src = read(GRID);
    const decl = /const blockCellCls = '([^']*)'/.exec(src);
    expect(decl, 'blockCellCls must stay a single string literal this guard can read').not.toBeNull();
    const cls = (decl as RegExpExecArray)[1];
    // Mobile-first: wrap is the base rule (a tablet has no room for ~350px in one column), nowrap from md
    // up. What must never come back is a wrap with no escape at any width.
    expect(cls, 'the row must stop wrapping at a breakpoint').toContain('md:flex-nowrap');
    expect(cls).toContain('flex-wrap');
  });

  it('sizes its controls with basis-*, NEVER w-* — the cascade trap that caused the stacking', () => {
    // ⚠️ READ SECTION D BEFORE RELAXING THIS. inputCls already contains `w-full`, and Tailwind emits
    // `.w-full` AFTER `.w-24`, so `${inputCls} w-24` computed to width:100% and each control claimed a
    // whole line of a flex-wrap row. `basis-*` wins because flex-basis, not width, sizes a flex item.
    const cell = blockCellSource();
    expect(cell).toContain('basis-24'); // the per-block amount
    expect(cell).toContain('basis-14'); // how many
    expect(cell).toContain('basis-28'); // month(s) / year(s)
    const widths = [...cell.matchAll(/\bw-\d+(?:\.\d+)?\b/g)].map((m) => m[0]);
    expect(
      widths,
      `w-* here silently loses to inputCls's w-full — use basis-* instead (found: ${widths.join(', ')})`,
    ).toEqual([]);
    // shrink-0 is the other half: sized but shrinkable is the same illegible row by another route.
    expect(cell).toContain('shrink-0');
  });

  it('the grid still scrolls the TABLE, not the page', () => {
    // Widening the page must not remove the horizontal scroll container: without it a narrow viewport
    // scrolls the whole document sideways, and at md+ this table is deliberately allowed to exceed its
    // frame.
    expect(read(GRID)).toContain('<div className="overflow-x-auto">');
  });

  it('nothing about the payload changed — this is width, not behaviour', () => {
    // The reporter was promised "nothing about claim limits, blocks or any calculation changes".
    const src = read(GRID);
    for (const key of ['blockEnabled', 'blockLimit', 'blockLength', 'blockUnit']) {
      expect(src, `${key} must still be posted`).toContain(`${key}: v.${key}`);
    }
    // And still no rate, anywhere (test/claims-configurable.test.ts owns the full version of this rule).
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/rateKind|ratePerKm|rateConfig/);
  });
});

// ─────────────────────── D. why C's "never w-*" rule exists ───────────────────────

describe('e7eb5d83 rev 6 · D — w-* cannot override inputCls, and this is how we know', () => {
  it('Tailwind emits .w-full AFTER .w-24 / .w-14 / .w-28, so the later rule wins', async () => {
    // This is the assertion that turns section C from a style preference into a fact. Both selectors are
    // a single class, so specificity ties and DOCUMENT ORDER decides; class order inside the attribute is
    // irrelevant. Compiling costs ~50ms and needs no browser.
    //
    // If a future Tailwind reverses this order the test fails LOUDLY, which is the correct outcome: the
    // rule in section C would then be unnecessary and somebody should be told, not left guessing.
    const { compile } = await import('tailwindcss');
    const TW = path.join(ROOT, 'node_modules/tailwindcss');
    const compiler = await compile('@import "tailwindcss";', {
      base: TW,
      loadStylesheet: async (id: string, base: string) => {
        const file = id === 'tailwindcss' ? path.join(TW, 'index.css') : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf8') };
      },
    });
    const css = compiler.build([
      'w-full', 'w-14', 'w-24', 'w-28',
      'basis-14', 'basis-24', 'basis-28',
      'shrink-0', 'flex-wrap', 'md:flex-nowrap',
    ]);

    const at = (sel: string) => {
      const i = css.indexOf(sel);
      expect(i, `${sel} was not emitted`).toBeGreaterThan(-1);
      return i;
    };
    for (const w of ['.w-14 ', '.w-24 ', '.w-28 ']) {
      expect(at('.w-full '), `${w.trim()} would lose to w-full`).toBeGreaterThan(at(w));
    }
    // basis-* is on a different property, so it is not in that race at all. All THREE are checked, not
    // just one: an unrecognised `basis-*` emits NOTHING rather than erroring, and a control that silently
    // loses its width is the exact failure this whole round is about. Their values must also still be the
    // sizes the old w-* asked for — swapping the utility must not quietly resize the row.
    for (const [cls, steps] of [['basis-14', 14], ['basis-24', 24], ['basis-28', 28]] as const) {
      const rule = new RegExp(`\\.${cls}\\s*\\{\\s*flex-basis:\\s*calc\\(var\\(--spacing\\) \\* ${steps}\\)`);
      expect(css, `${cls} must emit a real flex-basis of ${steps} spacing steps`).toMatch(rule);
    }
    // shrink-0 is the other half of the sizing and is equally silent if it ever stops existing.
    expect(css).toMatch(/\.shrink-0\s*\{\s*flex-shrink:\s*0/);
    // And the breakpoint override must come after the base rule for the same reason.
    expect(at('.md\\:flex-nowrap')).toBeGreaterThan(at('.flex-wrap '));
  });
});
