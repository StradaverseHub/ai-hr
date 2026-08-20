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
 * root, `@xl` / `@3xl` / `@5xl` below it), and section B below pins that — a later round reaching for
 * `sm:`/`lg:` on this component would silently break the surface it was not looking at.
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
    saveDraftAction: noop,
    submitAction: noop,
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
    saveDraftAction: noop,
    submitAction: noop,
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
    const classes = classesIn(await renderAdminForm(SUBMITTED_ROW));
    const grids = classes.filter((c) => /\bgrid-cols-/.test(c));
    expect(grids.length, 'the relief sections are laid out on grids').toBeGreaterThan(0);

    // Two-up and three-up both present — the reporter asked for the fields "across the width", and one
    // extra column on a 27" monitor is not that.
    expect(grids.some((c) => /@\w+:grid-cols-2\b/.test(c)), 'a two-up step').toBe(true);
    expect(grids.some((c) => /@\w+:grid-cols-3\b/.test(c)), 'a three-up step').toBe(true);

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
    for (const [surface, tree] of [
      ['admin', await renderAdminForm(null)],
      ['employee', await renderEmployeeForm(null)],
    ] as const) {
      const amounts = fields(tree).filter((f) => f.name?.startsWith('tp1_'));
      expect(amounts.length, `${surface}: Section C/D render their amount boxes`).toBeGreaterThan(10);
      for (const f of amounts) {
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
    const tree = await renderAdminForm(null);
    const form = walk(tree).find((e) => e.type === 'form' && e.props?.id === 'tp1-form');
    expect(form, 'the editable form is rendered').toBeTruthy();
    const inside = new Set(
      walk(form.props.children)
        .filter((e) => e.type === 'input' || e.type === 'textarea')
        .map((e) => e.props?.name),
    );
    for (const name of ['declarationAccepted', 'remarks', 'assessmentYear', 'tp1Form']) {
      expect(inside.has(name), `${name} escaped the form element it is submitted with`).toBe(true);
    }
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
