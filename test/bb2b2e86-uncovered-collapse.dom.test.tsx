/**
 * bb2b2e86 (r338) — "Employees no entitlement table reaches" IS SHUT WHEN THE PAGE LOADS.
 *
 * The card opened with up to fifty rows and pushed the rest of the Entitlement Tables screen off the
 * fold. What the reporter approved: the section stays shut; its title, its count and the job-grade
 * warning stay visible while shut; one control says how many rows it is hiding and opens them IN PLACE.
 *
 * ── WHY THIS FILE RENDERS THE COMPONENT INSTEAD OF GREPPING IT ───────────────────────────────────────
 * Three of the six properties are only true of MARKUP. "Shut on load" is the ABSENCE of an `open`
 * attribute; "the rows are still in the initial response" is about where they sit relative to
 * `</details>`; "the count and the warning are outside the toggle" is about where they sit relative to
 * `<summary>`. A source scan can see none of those, and `<details>` open state is not in the server HTML
 * at all — hence the jsdom half below.
 *
 * ── NON-VACUITY (each claim, and the assertion that catches its reversal) ────────────────────────────
 *   (a) delete `open`-less-ness — i.e. add `open` to the <details> — and "§1 … renders SHUT" fails on
 *       `expect(html).not.toMatch(/<details[^>]*\sopen[\s>=]/)`.
 *   (b) replace the <details> with a plain <div> and "§2 … opening it reveals the table" fails: there is
 *       no <details> element to open.
 *   (c) move the job-grade line inside the <summary> and "§3 … outside the summary" fails on
 *       `expect(noGradeAt).toBeLessThan(summaryAt)`.
 *   (d) drop the `total === 0` branch and "§4 … the empty card grows no toggle" fails on
 *       `expect(html).not.toContain('<details')`.
 *   (e) pass a `limit` from the card, or stop rendering `uncoveredMore`, and §5 fails.
 *   (f) add `'use client'` and §6 fails.
 *
 * The 50-row DEFAULT itself is a core fact, not a markup one: test/r269-grade-change-record.test.ts §C
 * pins it against a real database, because mutating `p.limit ?? 50` must turn something red.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

// jsdom rewrites `import.meta.url` to a non-file URL, so the node suite's `new URL('..', import.meta.url)`
// idiom throws here. Vitest's cwd is the project root (precedent: test/personnel-row-click.dom.test.tsx).
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

const DICT = en.admin.entitlementTemplates as unknown as Record<string, string>;
/**
 * The REAL English catalogue, formatted the way next-intl formats it, so every assertion below quotes a
 * sentence the screen actually says. A `t` that echoed its key would let a renamed key pass.
 */
const translate = (key: string, values?: Record<string, unknown>) => {
  const raw = DICT[key];
  if (typeof raw !== 'string') throw new Error(`MISSING_MESSAGE: admin.entitlementTemplates.${key}`);
  return raw.replace(/\{(\w+)\}/g, (_m, name: string) =>
    values && name in values ? String(values[name]) : `{${name}}`,
  );
};

vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    if (ns !== 'admin.entitlementTemplates') throw new Error(`unexpected namespace ${ns}`);
    return translate;
  },
}));

// Mocked as a whole module, so the leave pack's barrel (and the database behind it) never loads here.
const listEmploymentsWithoutEntitlementTable = vi.fn();
vi.mock('@/packs/leave/service', () => ({
  listEmploymentsWithoutEntitlementTable: (...a: unknown[]) => listEmploymentsWithoutEntitlementTable(...a),
}));

const { UncoveredEmployeesCard } = await import('../app/admin/leave/entitlements/templates/uncovered-employees');

const SOURCE = read('app/admin/leave/entitlements/templates/uncovered-employees.tsx');
/**
 * The file's own header explains, at length, that it is a `<details>` and NOT a `useState` island — so a
 * guard for "no useState here" has to read the CODE, or the explanation trips it. (CLAUDE.md §8 names
 * this class of trap for the pack ratchet: a guard that reads comments is a guard you have to reword
 * around.) Block comments cover the JSX `{/* … *\/}` form too.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ASOF = '2026-09-25';
const SESSION = { tenantId: 't', userId: 'u' } as never;

/** The reporter's own figures: 70 unreached out of 74 active, 47 of them with no job grade at all. */
const TOTAL = 70;
const ACTIVE = 74;
const UNGRADED = 47;

const row = (n: number, gradeName: string | null) => ({
  employmentId: `emp-${String(n).padStart(3, '0')}`,
  employeeName: `EMPLOYEE ${n}`,
  employeeCode: `X${String(n).padStart(3, '0')}`,
  gradeId: gradeName ? `g-${n}` : null,
  gradeName,
  leaveTypeNames: ['Annual Leave', 'Hospitalization Leave'],
});

/** Fifty rows out of seventy — the capped shape the screen really receives. */
const POPULATED = {
  rows: Array.from({ length: 50 }, (_, i) => row(i + 1, i % 3 === 0 ? null : 'GRADE 16 (PERMANENT)')),
  total: TOTAL,
  withoutJobGrade: UNGRADED,
  activeTotal: ACTIVE,
};
const EMPTY = { rows: [], total: 0, withoutJobGrade: 0, activeTotal: ACTIVE };

const renderCard = async (data: unknown) => {
  listEmploymentsWithoutEntitlementTable.mockReset();
  listEmploymentsWithoutEntitlementTable.mockResolvedValue(data);
  return UncoveredEmployeesCard({ s: SESSION, asOf: ASOF });
};
const markup = async (data: unknown) => renderToStaticMarkup(await renderCard(data));

const SHOW = translate('uncoveredShow', { total: TOTAL });
const HIDE = translate('uncoveredHide');
const NO_GRADE = translate('uncoveredNoGrade', { count: UNGRADED, total: ACTIVE });
const MORE = translate('uncoveredMore', { shown: 50, total: TOTAL });

// ── §1 · SHUT, WITH THE ROWS STILL IN THE RESPONSE ───────────────────────────────────────────────────
describe('§1 · the section renders SHUT, and the toggle says how much it is hiding', () => {
  it('the server HTML carries a <details> with NO open attribute', async () => {
    const html = await markup(POPULATED);
    expect(html).toContain('<details');
    // The reversal this catches: `<details open>`, which renders every row on load again.
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>=]/);
  });

  it('the toggle carries the TOTAL, not the number of rows it will show', async () => {
    const html = await markup(POPULATED);
    expect(SHOW).toBe('View full list (70)');
    expect(html).toContain(SHOW);
    expect(html).toContain(HIDE);
    // 70, never 50: the control answers "how many are unreached", which is the count worth opening for.
    expect(html).not.toContain('View full list (50)');
  });

  it('EVERY ROW IS STILL IN THE INITIAL RESPONSE, inside the closed <details>', async () => {
    const html = await markup(POPULATED);
    const open = html.indexOf('<details');
    const close = html.indexOf('</details>');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const inside = html.slice(open, close);
    // This is what a <details> buys over a client island: the browser's own Find still reaches an
    // employee while the section is shut, because nothing was unmounted or deferred.
    expect(inside).toContain('EMPLOYEE 1<');
    expect(inside).toContain('EMPLOYEE 50<');
    expect(inside).toContain('<table');
    expect(inside).toContain('/admin/personnel/emp-050?tab=leave');
    // …and the summary opens the section before the table, not after it.
    expect(inside.indexOf('<summary')).toBeLessThan(inside.indexOf('<table'));
  });

  it('nothing navigates away: the only links are still the per-employee ones', async () => {
    const html = await markup(POPULATED);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBe(50);
    for (const h of hrefs) expect(h).toMatch(/^\/admin\/personnel\/emp-\d{3}\?tab=leave$/);
  });
});

// ── §2 · OPENING IT (the part the server HTML cannot say) ────────────────────────────────────────────
describe('§2 · opening the section reveals the table, in place', () => {
  it('the table is hidden while shut and shown once the <details> is open', async () => {
    const { container } = render(await renderCard(POPULATED));
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);

    const table = screen.getByRole('table', { hidden: true });
    expect(table).not.toBeVisible();

    // jsdom implements no default summary-activation behaviour, so the open state is set the way a
    // browser sets it on a click. What is under test is the component's structure, not jsdom's UA sheet.
    details!.open = true;
    expect(table).toBeVisible();
    expect(screen.getByText('EMPLOYEE 1')).toBeVisible();
  });

  it('the summary is a real <summary> — the toggle needs no JavaScript to work', async () => {
    const { container } = render(await renderCard(POPULATED));
    const details = container.querySelector('details')!;
    expect(details.firstElementChild?.tagName).toBe('SUMMARY');
    // No button, no input, no checkbox hack: the native element IS the control.
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });
});

// ── §3 · WHAT STAYS VISIBLE WHILE SHUT ───────────────────────────────────────────────────────────────
describe('§3 · the count and the job-grade line are OUTSIDE the summary', () => {
  it('both sit before the <details> in the markup, so neither can be collapsed with the table', async () => {
    const html = await markup(POPULATED);
    const detailsAt = html.indexOf('<details');
    const summaryAt = html.indexOf('<summary');
    const countAt = html.indexOf(`(${TOTAL})</span>`); // SectionHeader's own count
    const noGradeAt = html.indexOf(NO_GRADE);
    expect(NO_GRADE).toContain('47 of these have no job grade recorded at all, out of 74');
    expect(countAt).toBeGreaterThan(-1);
    expect(noGradeAt).toBeGreaterThan(-1);
    // The reversal this catches: either line moved inside the <summary> — the card's own header calls
    // the job-grade line "THE COUNT THE REPORTER NEEDS MOST", and no configuration change fixes it.
    expect(countAt).toBeLessThan(detailsAt);
    expect(noGradeAt).toBeLessThan(detailsAt);
    expect(noGradeAt).toBeLessThan(summaryAt);
    const summary = html.slice(summaryAt, html.indexOf('</summary>'));
    expect(summary).not.toContain(NO_GRADE);
    expect(summary).not.toContain('no job grade recorded at all');
  });

  it('and they are both VISIBLE in a browser while the section is shut', async () => {
    const { container } = render(await renderCard(POPULATED));
    expect(container.querySelector('details')!.open).toBe(false);
    expect(screen.getByText(translate('uncoveredTitle'), { exact: false })).toBeVisible();
    expect(screen.getByText(`(${TOTAL})`)).toBeVisible();
    expect(screen.getByText(NO_GRADE)).toBeVisible();
    expect(screen.getByText(SHOW)).toBeVisible();
  });

  it('the title and help text are unchanged — only the table moved', async () => {
    const html = await markup(POPULATED);
    expect(html).toContain(translate('uncoveredTitle'));
    expect(html).toContain(translate('uncoveredHelp').slice(0, 60));
  });
});

// ── §4 · THE EMPTY CASE ──────────────────────────────────────────────────────────────────────────────
describe('§4 · total = 0 renders the sentence and NO toggle', () => {
  it('"every active employee is reached" grows no "View full list (0)"', async () => {
    const html = await markup(EMPTY);
    expect(html).toContain(translate('uncoveredNone'));
    // A control that opens nothing is noise, so the branch exists rather than the toggle rendering (0).
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
    expect(html).not.toContain('View full list');
    expect(html).not.toContain(HIDE);
    expect(html).not.toContain('<table');
  });

  it('and in the DOM there is no details element at all', async () => {
    const { container } = render(await renderCard(EMPTY));
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText(translate('uncoveredNone'))).toBeVisible();
  });
});

// ── §5 · THE CAP IS UNCHANGED ────────────────────────────────────────────────────────────────────────
describe('§5 · the 50-row cap and its "Showing 50 of 70." line survive the collapse', () => {
  it('the card asks for NO limit, so the core default (50) is what bounds the page', async () => {
    await markup(POPULATED);
    expect(listEmploymentsWithoutEntitlementTable).toHaveBeenCalledTimes(1);
    const [, params] = listEmploymentsWithoutEntitlementTable.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(params).toEqual({ asOf: ASOF });
    expect(params).not.toHaveProperty('limit');
    // The plan DECLINED pagination in writing: the cap already bounds the page, and a pager would be a
    // second control to learn on a list meant to be scanned once and fixed at source.
    expect(CODE).not.toMatch(/page(Size|Index)|offset|loadMore|searchParams/i);
  });

  it('"Showing 50 of 70." renders inside the opened section, and only when the cap bit', async () => {
    const html = await markup(POPULATED);
    expect(MORE).toBe('Showing 50 of 70.');
    expect(html).toContain(MORE);
    // Inside the <details>: it describes the table, so it belongs with the table.
    expect(html.indexOf(MORE)).toBeGreaterThan(html.indexOf('<details'));
    expect(html.indexOf(MORE)).toBeLessThan(html.indexOf('</details>'));

    const short = { rows: POPULATED.rows.slice(0, 3), total: 3, withoutJobGrade: 1, activeTotal: ACTIVE };
    const shortHtml = await markup(short);
    expect(shortHtml).not.toContain('Showing 3 of 3');
    expect(shortHtml).toContain(translate('uncoveredShow', { total: 3 }));
  });
});

// ── §6 · IT IS STILL A SERVER COMPONENT ──────────────────────────────────────────────────────────────
describe('§6 · the card is still a server component', () => {
  it("no 'use client', no state, no event handler — the collapse is the browser's", () => {
    // The stripper must not be what makes this pass: the code survives it, the prose does not.
    expect(CODE).toContain('export async function UncoveredEmployeesCard');
    expect(CODE).not.toContain('SERVER COMPONENT');

    expect(SOURCE).not.toMatch(/['"]use client['"]/);
    expect(CODE).not.toMatch(/\buseState\b|\buseReducer\b|\buseEffect\b|\buseTransition\b/);
    expect(CODE).not.toMatch(/\bonClick\b|\bonToggle\b|\bonChange\b/);
    // And it is still the one read it was: no second call snuck in beside the collapse.
    expect((CODE.match(/listEmploymentsWithoutEntitlementTable\(/g) ?? []).length).toBe(1);
    // The promise the file makes about itself is still written down.
    expect(SOURCE).toContain('SERVER COMPONENT');
  });

  it('the native element is what does the work', () => {
    expect(CODE).toContain('<details');
    expect(CODE).toContain('<summary');
    // The label swap is a CSS variant, which is the precedent in app/admin/organization/page.tsx.
    expect(CODE).toContain('group-open:hidden');
    expect(CODE).toContain('hidden group-open:inline');
  });
});

// ── §7 · SIX LOCALES ─────────────────────────────────────────────────────────────────────────────────
describe('§7 · both new labels exist in all six catalogues, and the six differ', () => {
  const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;

  for (const key of ['uncoveredShow', 'uncoveredHide'] as const) {
    it(`${key} is present, non-empty and translated in en/ms/ta/th/vi/zh`, () => {
      const values: string[] = [];
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = (cat as { admin: { entitlementTemplates: Record<string, string> } }).admin
          .entitlementTemplates[key];
        expect(typeof v, `${loc} ${key}`).toBe('string');
        expect(v.trim().length, `${loc} ${key}`).toBeGreaterThan(0);
        values.push(v);
      }
      expect(values.length).toBe(6);
      // i18n/request.ts DEEP-MERGES onto English, so a key missing from a locale renders the English
      // string and looks present. Six DISTINCT values is the assertion that cannot be satisfied that way.
      expect(new Set(values).size, `${key} not distinct across six locales: ${values.join(' | ')}`).toBe(6);
    });
  }

  it('every locale keeps the {total} placeholder on the shut label, and none on the open one', () => {
    for (const [loc, cat] of Object.entries(CATALOGUES)) {
      const d = (cat as { admin: { entitlementTemplates: Record<string, string> } }).admin.entitlementTemplates;
      // A locale that dropped {total} would render a control that does not say how much it hides.
      expect(d.uncoveredShow, `${loc} uncoveredShow`).toContain('{total}');
      // …and one that INVENTED a placeholder on the open label would throw FORMATTING_ERROR at runtime,
      // because the card passes no values to it.
      expect(d.uncoveredHide, `${loc} uncoveredHide`).not.toMatch(/\{\w+\}/);
    }
  });
});
