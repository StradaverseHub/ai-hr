/**
 * 7ad37961 (r210) — the TP1 declaration is laid out ACROSS the width it is given, on BOTH the screens
 * that render it, and the width it is given is no longer half a laptop.
 *
 * WHAT THE REPORTER CAME BACK ABOUT. The 2026 TP1 e-form shipped in r209 and works. It renders inside a
 * centred 48rem column on the HR "Edit TP1 Relief" page, so the seventeen numbered items of the official
 * Section C — most with lettered sub-lines, each with an annual limit, an accumulated figure and a
 * remaining figure — could only be drawn as ONE very tall list, with empty page either side of it and the
 * Save/Submit buttons a long scroll from the first field. Every sibling Payroll screen already fills the
 * window.
 *
 * WHY A TEST, AND WHY THIS SHAPE. A width is a string. tsc, the suite and `next build` are all indifferent
 * to it, so nothing FAILS when a screen quietly re-narrows — which is the lesson
 * test/payroll-screens-layout.test.ts was written to record after the Payroll module's width had been
 * decided four times in four places. This file is that guard's shape, aimed at the one page and the one
 * component this round changed. The page-level half also lives in the module-wide guard (that file's
 * WIDENED_LATER); it is repeated here because THIS is the file whose name a reader looking at the TP1
 * form will find, and the reasoning belongs where it will be read.
 *
 * ── THE PART THAT IS NOT ABOUT THE PAGE AT ALL ──────────────────────────────────────────────────────
 * `components/tp1-declaration-form.tsx` is SHARED. The HR month page renders it across the Payroll
 * content area; /me/tax-relief renders it inside a 42rem reading column that belongs to that page and
 * that this round deliberately did not touch. So the widening had to be written in a measure that is true
 * on both surfaces at once, and a VIEWPORT breakpoint is not one: `lg:grid-cols-3` reads the window, so
 * on a single laptop it would mean three roomy columns on one surface and three 200px columns on the
 * other, from the same class. The form is therefore laid out with CONTAINER queries (`@container` on its
 * root, `@xl` / `@3xl` / `@4xl` / `@5xl` below it, and `@max-xl` to undo the wide drawing under the
 * two-up step), and section B below pins that — a later round reaching for `sm:`/`lg:` on this component
 * would silently break the surface it was not looking at.
 *
 * Every assertion here is made on the RENDERED tree rather than on source text, so it survives however a
 * class comes to be composed (these grids are named consts, which a className-source scan would miss
 * entirely) — except the page's own wrapper, which is a `{pageWideCls}` expression and has to be read
 * from source exactly as the module-wide guard reads it.
 *
 * NOT ASSERTED, deliberately: pixels. jsdom applies no CSS and computes no layout; React's tree is the
 * classes, not the rendering. What this file proves is that the classes that produce the layout are on
 * the elements that need them, and that the ones that produced the old one are gone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The form resolves `taxRelief` through next-intl on the server. Keyed identity, like every other TP1
// test here — this file is about classes, not captions.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
}));

import { Tp1DeclarationForm } from '../components/tp1-declaration-form';
// r352 (item 0df7dd44) — the editable half of the form is now three CLIENT islands, so the guards below
// look through them by TYPE rather than for a bare `<input>`. Their MEANING is unchanged: every ringgit
// box still keeps its own measure, and the editable fields still belong to the one form the buttons
// submit. What changed is where the element lives, not what is asserted about it.
import {
  Tp1DeclarationTick,
  Tp1EditableForm,
  Tp1ItemBoxes,
  Tp1RemarksField,
} from '../components/tp1-form-client';
import { pageWideCls } from '../components/ui';
import type { Tp1Counted, Tp1Row } from '../core/tax-relief';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MONTH_PAGE = 'app/payroll/transactions/tp1/[year]/[month]/page.tsx';
const ESS_PAGE = 'app/me/tax-relief/page.tsx';

/** Every React element in a rendered tree, descending through EVERY element-valued prop. */
function walk(node: unknown, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, acc);
    return acc;
  }
  const el = node as any;
  if (el.type !== undefined) acc.push(el);
  for (const v of Object.values(el.props ?? {})) if (v && typeof v === 'object') walk(v, acc);
  return acc;
}

/** Every className string actually attached to an element in a rendered tree. */
const classesIn = (tree: unknown): string[] =>
  walk(tree)
    .map((e) => e.props?.className)
    .filter((c): c is string => typeof c === 'string');

/**
 * THE grid Section C's items are actually laid out on, identified by what it CONTAINS rather than by
 * the classes it happens to carry.
 *
 * This is the difference between a guard and a shape. r210's verify pass caught the earlier version
 * asking `grids.some(c => /@\w+:grid-cols-2/)` over the UNION of every grid className in the render —
 * which `factsGridCls` (`@xl:grid-cols-2`) and `cardPairCls` (`@3xl:grid-cols-2`) each satisfy on their
 * own. Dropping the two-up step from the RELIEF grid, which takes the employee screen straight back to
 * the single column this round widened, sailed through it. Asked of the one element that wraps the
 * items, the same assertion cannot be satisfied by a neighbouring grid.
 */
const reliefGridOf = (tree: unknown): any | undefined =>
  walk(tree).find(
    (e) =>
      typeof e.props?.className === 'string' &&
      /\bgrid-cols-/.test(e.props.className) &&
      // The EDITABLE grid holds `<Tp1ItemBoxes group="items" code="c…">` islands (r352); the READ-ONLY one
      // still renders its figures inline and has no island, so both spellings are accepted here and the
      // question asked is the same one: is this the grid the Section C items are laid out on?
      walk(e.props?.children).some(
        (d) =>
          /^tp1_items_c\d/.test(String(d.props?.name ?? '')) ||
          (d.type === Tp1ItemBoxes && d.props?.group === 'items' && /^c\d/.test(String(d.props?.code ?? ''))),
      ),
  );

/** All string-literal className values in a source file — the module-wide guard's own extractor. */
const classNameLiterals = (source: string): string[] =>
  [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);

/**
 * A PAGE-level cap: ONE class string carrying BOTH `mx-auto` AND a max-width, in the bracket form or the
 * named one. Copied from test/payroll-screens-layout.test.ts rather than narrowed, so the two files
 * cannot disagree about what "capped" means. `print:` tokens are dropped first: a rule for PAPER says
 * nothing about the screen.
 */
const capsPage = (raw: string) => {
  const cls = raw
    .split(/\s+/)
    .filter((t) => !t.startsWith('print:'))
    .join(' ');
  return /\bmx-auto\b/.test(cls) && /\bmax-w-(?:\d*xl\b|\[)/.test(cls);
};

// ─────────── fixtures: one declaration, rendered the way each surface asks for it ───────────

const EMPTY_COUNTED: Tp1Counted = { items: {}, subItems: {}, total: 0, unattributedTotal: 0, sources: [] };

const APPROVED_ROW: Tp1Row = {
  id: '11111111-1111-4111-8111-111111111111',
  assessmentYear: 2026,
  status: 'approved',
  tp1Amount: 4000,
  categories: { form: 'tp1-2026', items: { c2: { amount: 4000 } } } as any,
  submittedAt: new Date('2026-02-01T00:00:00Z'),
  createdAt: new Date('2026-02-01T00:00:00Z'),
  deductionMonth: 2,
  declaredAt: new Date('2026-02-01T00:00:00Z'),
  approvedBy: 'user-1',
  approvedAt: new Date('2026-02-02T00:00:00Z'),
  approvedMonth: 2,
  approvedYear: 2026,
  approverPosition: 'HR Manager',
  approvedByName: 'Halim Approver',
} as Tp1Row;

const SUBMITTED_ROW: Tp1Row = { ...APPROVED_ROW, status: 'submitted', approvedBy: null, approvedAt: null };

const noop = () => {};

/** The HR month page's call: a deduction month, Section F's controls, admin-on-behalf hidden fields. */
const renderAdminForm = (latest: Tp1Row | null, readOnly = false) =>
  Tp1DeclarationForm({
    selectedYear: 2026,
    deductionMonth: 2,
    latest,
    accumulated: EMPTY_COUNTED,
    readOnly,
    employer: { name: 'Acme Sdn Bhd', tin: 'C1234567890' },
    employee: { name: 'Aisha', idNumber: '900101-01-1234', tin: 'IG9999' },
    consent: latest
      ? {
          approveAction: noop,
          rejectAction: noop,
          cancelAction: noop,
          approvedByName: latest.approvedByName,
          hiddenFields: { employmentId: 'e1', tp1ReliefId: latest.id, assessmentYear: '2026' },
        }
      : undefined,
    formAction: noop,
    canSubmitApprove: true,
    hiddenFields: { employmentId: 'e1' },
  } as any);

/** /me/tax-relief's call: no deduction month, and NO `consent` — an employee never sees Section F's buttons. */
const renderEmployeeForm = (latest: Tp1Row | null, readOnly = false) =>
  Tp1DeclarationForm({
    selectedYear: 2026,
    deductionMonth: null,
    latest,
    accumulated: EMPTY_COUNTED,
    readOnly,
    employer: { name: 'Acme Sdn Bhd', tin: 'C1234567890' },
    employee: { name: 'Aisha', idNumber: '900101-01-1234', tin: 'IG9999' },
    formAction: noop,
  } as any);

// ─────────────────── A. the page is no longer a column down the middle ───────────────────

describe('7ad37961 · A — the Edit TP1 Relief page fills the width its siblings fill', () => {
  it('applies the named pageWideCls constant', () => {
    // The APPLICATION, not the import: e7eb5d83 rev 6 learned by reverting a page that an import-only
    // check stays green through.
    expect(
      read(MONTH_PAGE).includes(`<div className={pageWideCls}>`),
      `${MONTH_PAGE} must APPLY pageWideCls, not merely import it`,
    ).toBe(true);
    // …and the constant is still the full-width container, so this cannot be satisfied by re-capping it
    // at source in components/ui.tsx while every screen in the product narrows at once.
    expect(pageWideCls).toBe('w-full space-y-6');
  });

  it('carries no centred width cap anywhere in the page — the 48rem column is gone', () => {
    const offending = classNameLiterals(read(MONTH_PAGE)).filter(capsPage);
    expect(offending, `${MONTH_PAGE} re-introduces a page-level width cap: ${offending.join(' | ')}`).toEqual(
      [],
    );
  });

  it('the EMPLOYEE screen keeps the reading column that belongs to it', () => {
    // The other consumer of the shared form, asserted here because it is the reason section B exists and
    // NOT because this round touched it — it deliberately did not. /me/tax-relief is one person's own
    // form on a self-service page with no employee list beside it, and it keeps its 42rem measure; what
    // widens there is what the form itself does INSIDE that measure. If a later round does decide to
    // widen it, this case is the one to update — with a reason — rather than the form's grids.
    expect(classNameLiterals(read(ESS_PAGE)).some(capsPage), `${ESS_PAGE} lost its reading measure`).toBe(true);
  });
});

// ─────────────────── B. the form lays out on its CONTAINER, on both surfaces ───────────────────

describe('7ad37961 · B — the shared form is laid out by container width, not by window width', () => {
  it('declares a container on its root, or every @-variant below it is inert', async () => {
    // Without `container-type: inline-size` somewhere above them, `@xl:grid-cols-2` and friends resolve
    // against the nearest ancestor container — and with none in the tree they never match at all. The
    // whole layout would silently collapse to its one-column base on BOTH screens, which looks like
    // "nothing happened" rather than like a failure.
    const tree = walk(await renderAdminForm(SUBMITTED_ROW));
    const root = tree.find((e) => typeof e.props?.className === 'string' && e.props.className.includes('@container'));
    expect(root, 'the form root must declare @container').toBeTruthy();
  });

  it('takes the relief items two-up and then three-up, from a ONE-column base', async () => {
    const tree = await renderAdminForm(SUBMITTED_ROW);
    const grids = classesIn(tree).filter((c) => /\bgrid-cols-/.test(c));
    expect(grids.length, 'the relief sections are laid out on grids').toBeGreaterThan(0);

    // Two-up and three-up both present ON THE RELIEF GRID ITSELF — the reporter asked for the fields
    // "across the width", and one extra column on a 27" monitor is not that. Asked of that grid rather
    // than of the set of all grids, because the set is satisfied by cards and read-only `dl`s that have
    // nothing to do with the seventeen items (see `reliefGridOf`).
    const relief = reliefGridOf(tree);
    expect(relief, "Section C's items are laid out on a grid of their own").toBeTruthy();
    const reliefCls = String(relief.props.className);
    expect(reliefCls, 'the relief grid never reaches two-up — the EMPLOYEE screen stays one column').toMatch(
      /@\w+:grid-cols-2\b/,
    );
    expect(reliefCls, 'the relief grid never reaches three-up — the widened HR page gains one column').toMatch(
      /@\w+:grid-cols-3\b/,
    );

    // …and NO count is fixed. Every grid must start at one column and only ADD columns at a container
    // width, which is what makes the narrow case the default rather than an afterthought.
    for (const c of grids) {
      expect(c, `a grid without a single-column base: "${c}"`).toMatch(/\bgrid-cols-1\b/);
      const unconditional = c
        .split(/\s+/)
        .filter((t) => /^grid-cols-/.test(t) && t !== 'grid-cols-1');
      expect(unconditional, `a hard-coded column count outside a container query: "${c}"`).toEqual([]);
    }
  });

  it('uses NO viewport breakpoint for its columns — that is the bug the container queries avoid', async () => {
    // A `sm:`/`md:`/`lg:` grid reads the WINDOW, so one laptop gives the HR screen roomy columns and the
    // employee's 42rem column the same COUNT at a third of the width. Asserted over both renders,
    // because the mistake would only show on whichever surface nobody opened.
    for (const [name, tree] of [
      ['admin', await renderAdminForm(SUBMITTED_ROW)],
      ['employee', await renderEmployeeForm(SUBMITTED_ROW)],
    ] as const) {
      const viewportGrids = classesIn(tree).filter((c) => /(?:^|\s)(?:sm|md|lg|xl|2xl):grid-cols-/.test(c));
      expect(viewportGrids, `${name}: window-driven columns on a component with two container widths`).toEqual(
        [],
      );
    }
  });

  it('renders the SAME grid classes on both surfaces — one form, not two layouts', async () => {
    // The guarantee the component exists for. If a future change reaches for the page it is on to decide
    // its layout, these two sets diverge and the screens start to drift — which is what having one
    // component was meant to make impossible.
    const gridsOf = (tree: unknown) =>
      [...new Set(classesIn(tree).filter((c) => /\bgrid-cols-/.test(c)))].sort();
    expect(gridsOf(await renderEmployeeForm(SUBMITTED_ROW))).toEqual(gridsOf(await renderAdminForm(SUBMITTED_ROW)));
  });

  it('the form itself claims no width — it fills whatever container each page gives it', async () => {
    // A cap inside the component would re-narrow the HR page from underneath, and no assertion on the
    // page could see it.
    for (const tree of [await renderAdminForm(SUBMITTED_ROW), await renderEmployeeForm(SUBMITTED_ROW)]) {
      expect(classesIn(tree).filter(capsPage)).toEqual([]);
    }
  });
});

// ─────────────────── C. a wider page is not a wider box for a five-digit number ───────────────────

describe('7ad37961 · C — the amount boxes keep their own measure', () => {
  /** Every rendered <input>/<textarea>, with the className it carries. */
  const fields = (tree: unknown) =>
    walk(tree)
      .filter((e) => e.type === 'input' || e.type === 'textarea')
      .map((e) => ({ name: e.props?.name as string | undefined, cls: (e.props?.className as string) ?? '' }));

  it('every ringgit input is capped, on both surfaces', async () => {
    // This is the half of the request that a naive "make it full width" breaks: `w-full` on a number
    // field inside a 1600px container draws a box for 4 digits across half a monitor. The cap is on the
    // FIELD, so it survives the container getting wider.
    //
    // r352 — the Section C/D boxes are rendered INSIDE `Tp1ItemBoxes` (a client island) so that the
    // over-limit clamp can be shown before submit, which means the cap is applied one file further in.
    // The assertion is therefore split rather than dropped: the TREE still has to carry every amount
    // box the reader keys (by name, through the island), and the island's own source still has to cap
    // the `<input>` it draws. Asserting only the first would let the cap be deleted; asserting only the
    // second would let the boxes disappear.
    const island = read('components/tp1-form-client.tsx');
    const amountInput = island.slice(island.indexOf('const amountInput ='), island.indexOf('const single ='));
    expect(amountInput, 'the island no longer renders the amount box').toContain('type="number"');
    expect(amountInput, 'the amount box in the island lost its width cap').toContain('max-w-[14rem]');

    for (const [surface, tree] of [
      ['admin', await renderAdminForm(null)],
      ['employee', await renderEmployeeForm(null)],
    ] as const) {
      const boxes = walk(tree)
        .filter((e) => e.type === Tp1ItemBoxes)
        .flatMap((e) => (e.props?.boxes ?? []) as { name: string }[]);
      expect(boxes.length, `${surface}: Section C/D render their amount boxes`).toBeGreaterThan(10);
      for (const b of boxes) {
        expect(b.name, `${surface}: an amount box is not a tp1_ field`).toMatch(/^tp1_(items|rebates)_/);
      }
      // Nothing else on the surface may quietly go back to an uncapped ringgit box.
      for (const f of fields(tree).filter((f) => f.name?.startsWith('tp1_'))) {
        expect(f.cls, `${surface}: ${f.name} lost its width cap`).toContain('max-w-[14rem]');
      }
    }
  });

  it("Section F's month and year boxes stay narrow, and the position box stops growing", async () => {
    const tree = await renderAdminForm(SUBMITTED_ROW);
    const byName = new Map(fields(tree).map((f) => [f.name, f.cls]));
    expect(byName.get('approvedMonth'), 'a 1–12 box').toContain('max-w-[8rem]');
    expect(byName.get('approvedYear'), 'a four-digit box').toContain('max-w-[8rem]');
    // `flex-1` with nothing to stop it draws a job-title box the width of the container.
    const position = walk(tree).find(
      (e) => e.type === 'label' && typeof e.props?.className === 'string' && e.props.className.includes('flex-1'),
    );
    expect(position?.props?.className, 'the approver-position field grows without limit').toMatch(/max-w-\[/);
  });
});

// ─────────────────── D. what the layout must NOT have changed ───────────────────

describe('7ad37961 · D — a layout round changed the layout and nothing else', () => {
  it('Section F still renders its controls only where `consent` is passed', async () => {
    // The one rule that a re-shuffle of cards could break without any test of the layout noticing: an
    // employee must not be able to approve their own claim. Section E and the remarks card moved into a
    // shared row this round, and this is the assertion that says nothing ELSE moved across that line.
    const admin = walk(await renderAdminForm(SUBMITTED_ROW));
    const employee = walk(await renderEmployeeForm(SUBMITTED_ROW));
    const consentForm = (tree: any[]) => tree.filter((e) => e.type === 'form' && e.props?.id === 'tp1-consent');
    expect(consentForm(admin), 'the HR screen offers employer consent').toHaveLength(1);
    expect(consentForm(employee), 'the employee screen must never render the approve controls').toEqual([]);
  });

  it('the editable fields still belong to the ONE form the buttons submit', async () => {
    // Section E's card and the remarks card are now siblings inside a grid rather than of the <form>
    // itself. They are still INSIDE it — a card lifted out of the form element would submit a
    // declaration with no tick and no remarks, silently, with every test of the action still green.
    //
    // r352 — the <form> element itself is drawn by `Tp1EditableForm` (the island that owns the action, so
    // that a refusal returns a message instead of navigating away with forty keyed boxes), and the tick
    // and the remarks box are islands too, because React resets an UNCONTROLLED field once a form action
    // resolves and a refusal would otherwise blank them. So the shapes looked for changed; the question
    // did not: is every field the reader fills in inside the one element that submits them?
    const tree = await renderAdminForm(null);
    const form = walk(tree).find((e) => e.type === Tp1EditableForm && e.props?.formId === 'tp1-form');
    expect(form, 'the editable form is rendered').toBeTruthy();
    const inside = walk(form.props.children);
    const plain = new Set(
      inside.filter((e) => e.type === 'input' || e.type === 'textarea').map((e) => e.props?.name),
    );
    for (const name of ['assessmentYear', 'tp1Form']) {
      expect(plain.has(name), `${name} escaped the form element it is submitted with`).toBe(true);
    }
    expect(
      inside.some((e) => e.type === Tp1DeclarationTick),
      'the Section E tick escaped the form element it is submitted with',
    ).toBe(true);
    expect(
      inside.some((e) => e.type === Tp1RemarksField),
      'the remarks box escaped the form element it is submitted with',
    ).toBe(true);
    expect(
      inside.filter((e) => e.type === Tp1ItemBoxes).length,
      'the Section C/D amount boxes escaped the form element they are submitted with',
    ).toBeGreaterThan(10);
  });

  it('the read-only view renders the same items through the same block', async () => {
    // Both branches of the component render Section C through `itemBlock`, so the cell shape this round
    // introduced has to hold on a closed year too — where there are no inputs to give it away.
    const tree = await renderAdminForm(APPROVED_ROW, true);
    const grids = classesIn(tree).filter((c) => /\bgrid-cols-/.test(c));
    expect(grids.some((c) => /@\w+:grid-cols-3\b/.test(c)), 'the historical view is laid out too').toBe(true);
    expect(
      walk(tree).some((e) => e.type === 'input'),
      'a read-only declaration renders no editable field',
    ).toBe(false);
  });

});

// ────────── E. the widening is UNDONE below the two-up step, and the buttons are in reach ──────────

/**
 * THE PHONE IS NOT A SMALLER VERSION OF THE WIDE SCREEN, AND WIDENING ONE MUST NOT LENGTHEN THE OTHER.
 *
 * The first cut of this round drew every relief item as a bordered CELL at every width — right for a
 * two- or three-up row, wrong for a single column, and measured wrong: in headless Chromium with the
 * real `taxRelief` messages, en/ms/ta/zh at 300px and 342px containers came out 5–9% TALLER than before
 * the round, because 24px of cell padding off a 300px measure wraps captions an extra line and
 * seventeen 12px gaps add 204px on their own. Keying a month's reliefs on a phone would have taken MORE
 * scrolling than before, on the one surface the request said would be unchanged.
 *
 * So the cell, its horizontal padding and the grid's gap are all undone below the two-up step, and the
 * cases below pin the undo to that step rather than to a literal breakpoint: if a later round moves
 * two-up, the undo moves with it or these fail. Re-measured after the fix, 300px and 342px are
 * byte-for-byte the same height as before r210 in all four languages, and every width from 576px up is
 * 4–37% shorter.
 */
describe('7ad37961 · E — the narrow container keeps the list it had, and Save stays in reach', () => {
  it('drops the cell, its side padding and the grid gap below the width that earns them', async () => {
    const tree = await renderAdminForm(null);
    const relief = reliefGridOf(tree);
    expect(relief, "Section C's items are laid out on a grid of their own").toBeTruthy();
    const reliefCls = String(relief.props.className);

    // The step the undo has to mirror, read off the grid rather than hard-coded.
    const twoUp = /@(\w+):grid-cols-2\b/.exec(reliefCls)?.[1];
    expect(twoUp, 'the relief grid states no two-up step to undo below').toBeTruthy();

    expect(reliefCls, `the grid keeps its cell gap below @${twoUp}, where there is only one column`).toContain(
      `@max-${twoUp}:gap-0`,
    );

    // The grid's DIRECT children are the seventeen item blocks — one per numbered item.
    const cells = ([] as any[])
      .concat(relief.props.children)
      .filter((e) => e && typeof e === 'object' && e.type === 'div');
    expect(cells.length, 'Section C renders its numbered items as the grid cells').toBeGreaterThan(10);
    for (const cell of cells) {
      const cls = String(cell.props?.className ?? '');
      expect(cls, `an item keeps its box below @${twoUp}: "${cls}"`).toContain(`@max-${twoUp}:border-0`);
      expect(cls, `an item keeps 24px of side padding off a phone measure: "${cls}"`).toContain(
        `@max-${twoUp}:px-0`,
      );
      // …and the single rule BETWEEN stacked rows comes back, or the list loses its separators entirely.
      expect(cls, `no divider between stacked rows below @${twoUp}: "${cls}"`).toContain(
        `@max-${twoUp}:not-first:border-t`,
      );
    }
  });

  it('keeps Save and Submit inside the form, sticky only where a parked band is not in the way', async () => {
    // INSIDE the form on purpose: `position: sticky` resolves against the nearest block ancestor, so the
    // form is what ends the row's range with the fields it submits. Lifted out into the page's own
    // column, the row would stay parked over SECTION F — the employer-consent card — at the bottom of
    // the page. And the stick is container-gated: a bare `sticky` parks ~60px, about 9% of a phone
    // viewport, permanently on top of whatever field is being keyed.
    const tree = await renderAdminForm(null);
    const form = walk(tree).find((e) => e.type === Tp1EditableForm && e.props?.formId === 'tp1-form');
    expect(form, 'the editable form is rendered').toBeTruthy();

    const row = walk(form.props.children).find(
      (e) => typeof e.props?.className === 'string' && /\bsticky\b/.test(e.props.className),
    );
    expect(row, 'the Save/Submit row is not inside the form whose range it needs').toBeTruthy();
    const rowCls = String(row.props.className);
    expect(rowCls, 'the action row sticks at EVERY width, phone included').not.toMatch(/(?:^|\s)sticky\b/);
    expect(rowCls, 'the action row never sticks at all — the buttons are back at the foot').toMatch(
      /@\w+:sticky\b/,
    );

    // r352 — a button no longer carries its own `formAction`: one `useActionState` form has ONE action, so
    // the pressed button names the operation with `name="intent"` instead (the claims pattern, e7eb5d83).
    // Counted by intent rather than by formAction, and the values are pinned, because a button that lost
    // its intent would silently fall through to plain Submit and save nothing as a draft.
    const actions = walk(row.props.children).filter(
      (e) => e.props?.type === 'submit' && e.props?.name === 'intent',
    );
    expect(actions.map((a) => a.props.value), 'the action row lost a button or an intent').toEqual([
      'draft',
      'submit',
      'submitApprove',
    ]);
    // The move must not have changed WHICH form they submit — they are still explicitly owned.
    for (const a of actions) expect(a.props.form, 'an action button lost its form owner').toBe('tp1-form');
  });
});
