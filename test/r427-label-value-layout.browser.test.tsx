/**
 * r427 (50ed39e1 contest) — the label-and-value primitives, measured in a REAL engine (Chromium with the app's
 * compiled Tailwind). jsdom computes no layout and applies no container query, and every promise this round
 * makes to the reporter is a layout promise: nothing scrolls sideways, long labels wrap rather than clip,
 * values line up, a table becomes labelled blocks on a phone, and the fixed-width ruler wraps.
 *
 * Each case renders the shared primitives (and the real fixed-width ruler) inside a page column of the given
 * width with the shell's 16px gutters — 390px leaves the 358px content width the plan names — in both themes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '../app/globals.css';
import { FormRow, LabelValue, LabelValueList, SectionCard, SubHeading } from '../components/ui/section-card';
import { StackedBody, StackedHead, StackedRow, StackedTable, StackedTd, StackedTh, stackedSplitNoteCls, stackedSplitWordCls } from '../components/ui/stacked-table';
import { StatCells } from '../components/ui/stat-cells';
import { StatusWord } from '../components/ui/status-word';
import { Segmented } from '../components/ui/segmented';
import { FixedWidthRuler } from '../app/admin/attendance/file-mappings/fixed-width-ruler';
import { inputCls } from '../components/ui';

const html = document.documentElement;
const setTheme = (theme: 'monolith' | 'classic') => html.setAttribute('data-ui-theme', theme);
afterEach(() => {
  cleanup();
  html.removeAttribute('data-ui-theme');
});

// A Tamil label is the longest the six locales produce for these screens; a single 60-character token
// cannot break at a space, so only overflow-wrap:anywhere keeps it inside its column.
const LONG_LABEL = 'தோல்வியடைந்த பதிவுகள் இவற்றால் ஆனவை — மற்ற சரிபார்ப்புப் பிழைகள்';
const UNBROKEN = 'X'.repeat(60);
const COLS = ['Mapping Name', 'File Type', 'Layout', 'Device', 'Status', 'Last Used', 'Actions'];
const PILL = 'inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-800';
const LINES = ['001234    DEV010210202608 15IN ', '001234    DEV010210202617 32OUT', '001235    DEV010210202608 20IN '];
const OWNER = (pos: number) => (pos <= 10 ? 'card' : pos <= 15 ? 'device' : pos <= 23 ? 'date' : pos <= 27 ? 'time' : 'code');

function Screen({ rulerLen = 30 }: { rulerLen?: number }) {
  return (
    <div data-testid="page" style={{ boxSizing: 'border-box', padding: '0 16px' }} className="space-y-6">
      <SectionCard index={1} title="Import details">
        <LabelValueList columns={2}>
          <LabelValue label="Import Date/Time" value="08-Oct-2026 10:41" />
          <LabelValue label={LONG_LABEL} value="2" />
          <LabelValue label={UNBROKEN} value={UNBROKEN} />
          <LabelValue label="File Name" value="zk-attlog-oct-wk1.txt" />
        </LabelValueList>
        <SubHeading>Failed records are made up of</SubHeading>
      </SectionCard>
      <SectionCard index={2} title="Details">
        <FormRow label="Mapping Name" htmlFor="name" required>
          <input id="name" className={inputCls} defaultValue="ZKTeco Standard" />
        </FormRow>
        <FormRow label={LONG_LABEL} htmlFor="long">
          <input id="long" className={inputCls} />
        </FormRow>
        <FormRow label="Delimiter">
          <Segmented
            label="Delimiter"
            value="comma"
            onChange={() => {}}
            options={[
              { value: 'comma', label: 'Koma (pemisah standard)' },
              { value: 'tab', label: 'Tab' },
              { value: 'semicolon', label: 'Koma bertitik' },
              { value: 'other', label: 'Lain-lain aksara pemisah' },
            ]}
          />
        </FormRow>
      </SectionCard>
      <SectionCard index={3} title="Mappings">
        <StackedTable label="Mappings">
          <StackedHead>
            {COLS.map((c) => (
              <StackedTh key={c}>{c}</StackedTh>
            ))}
          </StackedHead>
          <StackedBody>
            {[1, 2].map((r) => (
              <StackedRow key={r}>
                <StackedTd label="Mapping Name" role="title">
                  Factory Clocking (Shah Alam plant, night shift) {r}
                </StackedTd>
                <StackedTd label="File Type">TXT</StackedTd>
                <StackedTd label="Layout">Separated by a character</StackedTd>
                <StackedTd label="Device">Factory Device</StackedTd>
                <StackedTd label="Status" role="split" hideLabel>
                  <span className={`block ${stackedSplitWordCls}`}>
                    <StatusWord tone="signal" className={PILL}>
                      Completed with errors
                    </StatusWord>
                  </span>
                  <div className={stackedSplitNoteCls}>Duplicate clocking record (already recorded 01-Oct-2026 17:32 OUT)</div>
                </StackedTd>
                <StackedTd label="Last Used">07-Oct-2026</StackedTd>
                <StackedTd label="Actions" role="full" hideLabel>
                  View Edit Duplicate Deactivate Delete
                </StackedTd>
              </StackedRow>
            ))}
          </StackedBody>
        </StackedTable>
      </SectionCard>
      <SectionCard index={4} title="Line counts">
        <StatCells
          cells={[
            { label: 'Total lines', value: '1,250' },
            { label: 'Valid', value: '1,231' },
            { label: 'Card ID not found', value: '6', warn: true },
            { label: 'Invalid date / time', value: '3', warn: true },
            { label: 'Duplicate', value: '8', warn: true },
            { label: 'Other errors', value: '2', warn: true },
            { label: 'Employees', value: '48' },
            { label: 'Dates in file', value: '01-Oct-2026 – 07-Oct-2026', text: true },
          ]}
        />
      </SectionCard>
      <SectionCard index={5} title="Field positions">
        <FixedWidthRuler
          lines={LINES}
          maxLen={rulerLen}
          hasHeader={false}
          ownerOf={OWNER}
          shadeOf={(o) => (o === 'card' ? 'bg-foreground text-background' : 'bg-muted-foreground/25')}
          titleOf={(o, p) => `${o} · ${p}`}
          focused="time"
        />
      </SectionCard>
    </div>
  );
}

const rect = (el: Element) => el.getBoundingClientRect();
const fits = (el: Element, msg: string) => expect(el.scrollWidth, msg).toBeLessThanOrEqual(el.clientWidth + 1);

for (const theme of ['monolith', 'classic'] as const) {
  for (const width of [390, 1280]) {
    const narrow = width === 390;
    describe(`${theme} at ${width}px`, () => {
      const mount = (rulerLen?: number) => {
        setTheme(theme);
        document.body.style.margin = '0';
        document.body.style.width = `${width}px`;
        render(<Screen rulerLen={rulerLen} />);
        const page = screen.getByTestId('page');
        expect(rect(page).width).toBe(width);
        return page;
      };

      it('nothing is wider than the page: no section, table, cell or ruler block passes the content edge', () => {
        const page = mount();
        const right = rect(page).right - 16 + 0.5;
        fits(page, 'page');
        // The test iframe is narrower than 1280, so the page is measured against its own width, not the frame's.
        expect(document.body.scrollWidth, 'document').toBeLessThanOrEqual(width);
        const boxes = page.querySelectorAll('[data-section-card], [data-stacked-table], [data-stat-cells], [data-ruler-block], [data-segmented] button, td, dt, dd');
        expect(boxes.length).toBeGreaterThan(40);
        for (const el of boxes) if (rect(el).width > 0) expect(rect(el).right, `${el.tagName} ${el.textContent?.slice(0, 20)}`).toBeLessThanOrEqual(right);
      });

      it('labels are never clipped: long labels wrap onto further lines inside their column', () => {
        const page = mount();
        const labels = [...page.querySelectorAll('[data-label-value] > dt, [data-form-row] > label, [data-form-row] > span, [data-stat-cells] dt, h2, h3')];
        expect(labels.length).toBeGreaterThan(12);
        for (const el of labels) {
          fits(el, `label ${el.textContent?.slice(0, 20)}`);
          const cs = getComputedStyle(el);
          expect(cs.textOverflow, el.textContent ?? '').not.toBe('ellipsis');
          expect(cs.webkitLineClamp === 'none' || cs.webkitLineClamp === '', el.textContent ?? '').toBe(true);
        }
        const long = [...page.querySelectorAll('[data-label-value] > dt')].find((d) => d.textContent === UNBROKEN)!;
        expect(rect(long).height, 'the 60-character token wraps').toBeGreaterThan(30);
      });

      it(narrow ? 'a label sits above its value' : 'every value starts at the same place, right of an 11rem label column', () => {
        const page = mount();
        const rows = [...page.querySelectorAll('[data-form-row]')];
        expect(rows.length).toBe(3);
        const lefts = rows.map((r) => Math.round(rect(r.children[1]).left));
        for (const r of rows) {
          const [label, control] = [rect(r.children[0]), rect(r.children[1])];
          if (narrow) expect(label.bottom).toBeLessThanOrEqual(control.top + 1);
          else expect(label.right).toBeLessThanOrEqual(control.left);
        }
        if (!narrow) {
          expect(new Set(lefts).size, 'one value column').toBe(1);
          expect(lefts[0] - Math.round(rect(rows[0]).left)).toBeGreaterThanOrEqual(176);
        }
      });

      it(narrow ? 'the table becomes labelled blocks: header hidden, every cell prints its column name' : 'the table is a table', () => {
        const page = mount();
        const table = page.querySelector('[data-stacked-table] table')!;
        const row = table.querySelector('tbody tr')!;
        const cells = [...row.querySelectorAll('td')];
        expect(table.getAttribute('role')).toBe('table');
        expect(row.getAttribute('role')).toBe('row');
        expect(cells.every((c) => c.getAttribute('role') === 'cell')).toBe(true);
        const labelled = cells.filter((c) => getComputedStyle(c, '::before').content === `"${c.dataset.label}"`);
        if (narrow) {
          expect(getComputedStyle(row).display).toBe('grid');
          expect(rect(table.querySelector('thead')!).width).toBeLessThanOrEqual(1);
          // Title, status (split) and actions print no label; the four plain cells do.
          expect(labelled.map((c) => c.dataset.label)).toEqual(['File Type', 'Layout', 'Device', 'Last Used']);
          // The status word is top-right, beside the title; the reason spans the foot of the block.
          const word = rect(row.querySelector('[data-status-word]')!);
          const title = rect(cells[0]);
          expect(Math.abs(word.top - title.top)).toBeLessThan(6);
          expect(word.left).toBeGreaterThan(title.left + 100);
          const note = rect(row.querySelector(`div.${CSS.escape('@max-3xl:col-span-2')}`)!);
          expect(note.width).toBeGreaterThan(rect(row).width * 0.9);
        } else {
          expect(getComputedStyle(row).display).toBe('table-row');
          expect(rect(table.querySelector('thead')!).height).toBeGreaterThan(20);
          expect(labelled).toEqual([]);
        }
      });

      it(narrow ? 'the figures sit two to a row, divided by lines, not boxed' : 'the figures sit four to a row, divided by lines, not boxed', () => {
        const page = mount();
        const cells = [...page.querySelectorAll('[data-stat-cells] > div')];
        expect(cells.length).toBe(8);
        const rows = new Set(cells.map((c) => Math.round(rect(c).top)));
        expect(rows.size).toBe(narrow ? 4 : 2);
        // The first cell of each row has no left line, the others do; nothing has a radius or a fill.
        const perRow = narrow ? 2 : 4;
        cells.forEach((c, i) => {
          const cs = getComputedStyle(c);
          expect(cs.borderLeftWidth, `cell ${i}`).toBe(i % perRow === 0 ? '0px' : '1px');
          expect(cs.borderTopLeftRadius).toBe('0px');
          expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
        });
      });

      it('the fixed-width ruler wraps every ten positions inside the content width', () => {
        const page = mount(200);
        const blocks = [...page.querySelectorAll('[data-ruler-block]')];
        expect(blocks.length).toBe(20);
        const right = rect(page).right - 16 + 0.5;
        for (const b of blocks) expect(rect(b).right).toBeLessThanOrEqual(right);
        const rows = new Set(blocks.map((b) => Math.round(rect(b).top))).size;
        expect(rows).toBeGreaterThan(narrow ? 6 : 1);
        // No field names on the ruler: the first row of each block is only digits and dots.
        for (const b of blocks) expect(b.firstElementChild!.textContent).toMatch(/^[\d·]+$/);
        // The focused field's positions are underlined.
        const marked = page.querySelectorAll('[data-focused]');
        expect(marked.length).toBe(4 * LINES.length);
        expect(getComputedStyle(marked[0]).boxShadow).toContain('inset');
      });

      it('a status keeps its words; Classic is the caller’s pill verbatim, Monolith a mono word with no fill', () => {
        mount();
        const word = document.querySelector('[data-status-word]') as HTMLElement;
        expect(word.className.startsWith(`${PILL} `)).toBe(true);
        const cs = getComputedStyle(word);
        if (theme === 'classic') {
          const ref = document.createElement('span');
          ref.className = PILL;
          ref.textContent = word.textContent;
          word.parentElement!.appendChild(ref);
          const want = getComputedStyle(ref);
          for (const k of ['backgroundColor', 'color', 'borderTopLeftRadius', 'paddingLeft', 'fontSize', 'textTransform'] as const)
            expect(cs[k], k).toBe(want[k]);
          expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
        } else {
          expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
          expect(cs.textTransform).toBe('uppercase');
          expect(cs.fontSize).toBe('11px');
          expect(cs.color).toBe('rgb(189, 56, 0)');
        }
      });
    });
  }
}
