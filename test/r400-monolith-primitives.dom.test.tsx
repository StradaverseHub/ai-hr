/**
 * r400 — Monolith rollout STEP 3, the primitives (docs/design/monolith/README.md §4, components.md), rendered
 * in jsdom. Pinned here, by role, name and aria state (what a screen reader gets):
 *
 *  • The retuned components/ui pieces carry their Monolith look as `monolith:` utilities on the SAME markup:
 *    the markup is byte-identical under data-ui-theme="monolith" and "classic" (no structural branch), each
 *    variant maps to the README's look (pill / pill ghost / txt; status word by tone; underlined field;
 *    hairline section), and nothing maps to an orange FILL (README §8).
 *  • Each new primitive renders real semantics: <section> named by its heading, <dl> term/definition pairs,
 *    <ol> with aria-current="step", a named group of aria-pressed ticks, role="note", a named <aside>, a real
 *    <table> with a caption and column headers, selectable rows as <button aria-current> whose names carry
 *    the column names, a real checkbox with role="switch".
 *  • No primitive owns a string: every word on screen is the caller's, so the six locales need nothing new.
 *  • Figures are static: no transition or animation class on any figure.
 *
 * jsdom applies no stylesheet, so COMPUTED styles (that the Monolith classes really paint, and that Classic
 * paints exactly what main paints) are proven in a real engine: test/r400-monolith-primitives.browser.test.tsx.
 * The Classic class strings vs main are proven in test/r400-monolith-primitives.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Cells,
  Empty,
  Field,
  HairlineList,
  HairlineTable,
  Kv,
  LiveDot,
  Note,
  Panel,
  Ruler,
  Section,
  Status,
  StatusLine,
  Steps,
  Switch,
} from '../components/monolith';

const ROOT = path.resolve(__dirname, '..');
const setTheme = (theme: 'monolith' | 'classic' | null) => {
  if (theme === null) document.documentElement.removeAttribute('data-ui-theme');
  else document.documentElement.setAttribute('data-ui-theme', theme);
};
const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const mono = (el: Element) => tokens(el).filter((t) => t.startsWith('monolith:'));

afterEach(() => {
  cleanup();
  setTheme(null);
});

/** Render the same element under both themes and return both outerHTMLs. */
function bothThemes(ui: React.ReactElement) {
  const out: Record<string, string> = {};
  for (const theme of ['monolith', 'classic'] as const) {
    setTheme(theme);
    const { container, unmount } = render(ui);
    out[theme] = container.innerHTML;
    unmount();
  }
  return out;
}

describe('retuned components/ui: the Monolith look is CSS on the same markup', () => {
  it('Button, Badge, Input and Card render identical markup in both themes (no structural branch)', () => {
    for (const ui of [
      <Button key="b">Save</Button>,
      <Button key="o" variant="outline" size="sm">
        Edit
      </Button>,
      <Badge key="g" variant="warning">
        Pending
      </Badge>,
      <Input key="i" aria-label="Name" />,
      <Card key="c">
        <CardHeader>
          <CardTitle>Period</CardTitle>
        </CardHeader>
        <CardContent>Body</CardContent>
      </Card>,
    ]) {
      const html = bothThemes(ui);
      expect(html.monolith.length).toBeGreaterThan(20);
      expect(html.classic).toBe(html.monolith);
      expect(html.monolith).toContain('monolith:');
    }
  });

  it('Button default is the pill: ink fill, bone text, 44px, radius 999px', () => {
    setTheme('monolith');
    render(<Button>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    for (const t of ['monolith:rounded-full', 'monolith:bg-ink', 'monolith:text-bone', 'monolith:border-ink', 'monolith:h-11'])
      expect(mono(b), t).toContain(t);
    // Classic's own classes are still on it, untouched.
    for (const t of ['bg-primary', 'text-primary-foreground', 'rounded-md', 'h-9', 'px-4']) expect(tokens(b), t).toContain(t);
  });

  it('outline, ghost and link are the .txt underlined text button; secondary is the ink-outline pill', () => {
    setTheme('monolith');
    render(
      <>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
        <Button variant="secondary">Secondary</Button>
      </>,
    );
    for (const name of ['Outline', 'Ghost', 'Link']) {
      const b = screen.getByRole('button', { name });
      for (const t of ['monolith:rounded-none', 'monolith:border-0', 'monolith:border-b', 'monolith:border-ink', 'monolith:bg-transparent', 'monolith:min-h-11'])
        expect(mono(b), `${name} ${t}`).toContain(t);
    }
    const s = screen.getByRole('button', { name: 'Secondary' });
    for (const t of ['monolith:rounded-full', 'monolith:border-ink', 'monolith:bg-transparent', 'monolith:text-ink']) expect(mono(s), t).toContain(t);
  });

  it('sizes: sm pills are 36px, sm text buttons 32px; an icon text button has no underline', () => {
    setTheme('monolith');
    render(
      <>
        <Button size="sm">Small pill</Button>
        <Button size="sm" variant="ghost">
          Small txt
        </Button>
        <Button size="icon" variant="ghost" aria-label="Close" />
      </>,
    );
    expect(mono(screen.getByRole('button', { name: 'Small pill' }))).toContain('monolith:h-9');
    expect(mono(screen.getByRole('button', { name: 'Small txt' }))).toContain('monolith:min-h-8');
    const icon = mono(screen.getByRole('button', { name: 'Close' }));
    expect(icon).toContain('monolith:border-b-0');
    expect(icon).not.toContain('monolith:border-b');
  });

  it('NO variant is an orange fill behind text (README §8): destructive is a signal-text outline pill', () => {
    setTheme('monolith');
    render(
      <>
        {(['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const).map((v) => (
          <Button key={v} variant={v}>
            {v}
          </Button>
        ))}
      </>,
    );
    for (const b of screen.getAllByRole('button')) {
      const fills = mono(b).filter((t) => /^monolith:(hover:)?bg-(signal|destructive|primary|orange|red|amber)/.test(t));
      expect(fills, b.textContent ?? '').toEqual([]);
    }
    const d = mono(screen.getByRole('button', { name: 'destructive' }));
    for (const t of ['monolith:bg-transparent', 'monolith:text-signal-text', 'monolith:border-signal-text', 'monolith:rounded-full']) expect(d).toContain(t);
  });

  it('Badge is a status word: mono uppercase, no fill, colour by tone (components.md)', () => {
    setTheme('monolith');
    const tone = { default: 'mid', success: 'ink', warning: 'signal-text', danger: 'signal-text', info: 'mid', accent: 'ink' } as const;
    render(
      <>
        {(Object.keys(tone) as (keyof typeof tone)[]).map((v) => (
          <Badge key={v} variant={v}>
            {v}
          </Badge>
        ))}
      </>,
    );
    for (const [v, colour] of Object.entries(tone)) {
      const el = screen.getByText(v);
      const m = mono(el);
      for (const t of ['monolith:bg-transparent', 'monolith:rounded-none', 'monolith:uppercase', 'monolith:font-mono', 'monolith:text-[11px]', 'monolith:px-0'])
        expect(m, `${v} ${t}`).toContain(t);
      expect(m, v).toContain(`monolith:text-${colour}`);
      // Exactly one tone colour, so a word can never be painted two ways.
      expect(m.filter((t) => /^monolith:text-(ink|mid|signal-text)$/.test(t)), v).toHaveLength(1);
    }
  });

  it('Input is the underlined field; Field gives it a label above, associated by containment', () => {
    setTheme('monolith');
    render(
      <Field label="Employee name" hint="As on the IC">
        <Input defaultValue="Aisyah" />
      </Field>,
    );
    const input = screen.getByLabelText(/Employee name/);
    expect(input).toHaveValue('Aisyah');
    for (const t of ['monolith:h-10', 'monolith:border-0', 'monolith:border-b', 'monolith:border-input', 'monolith:bg-transparent', 'monolith:rounded-none', 'monolith:shadow-none', 'monolith:px-0'])
      expect(mono(input), t).toContain(t);
    expect(screen.getByText('Employee name').className).toContain('monolith:uppercase');
  });

  it('Card is a section: 1px ink top, no radius, fill, side borders or shadow; the title is a mono label', () => {
    setTheme('monolith');
    render(
      <Card data-testid="card">
        <CardHeader data-testid="head">
          <CardTitle>Period</CardTitle>
        </CardHeader>
        <CardContent data-testid="body">Body</CardContent>
      </Card>,
    );
    const card = mono(screen.getByTestId('card'));
    for (const t of ['monolith:border-0', 'monolith:border-t', 'monolith:border-ink', 'monolith:rounded-none', 'monolith:bg-transparent', 'monolith:shadow-none'])
      expect(card, t).toContain(t);
    expect(mono(screen.getByTestId('head'))).toContain('monolith:border-b-0');
    expect(mono(screen.getByTestId('body'))).toContain('monolith:px-0');
    const title = screen.getByRole('heading', { name: 'Period' });
    for (const t of ['monolith:font-mono', 'monolith:uppercase', 'monolith:text-mid']) expect(mono(title)).toContain(t);
  });
});

describe('new primitives: real semantics', () => {
  it('Section is a region named by its index and label; filter tabs are aria-pressed buttons; route tabs are aria-current links', () => {
    const pick = vi.fn();
    setTheme('monolith');
    render(
      <>
        <Section
          index={1}
          label="Period"
          right="3 runs"
          tabs={[
            { key: 'all', label: 'All', current: true, onSelect: () => pick('all') },
            { key: 'open', label: 'Open', onSelect: () => pick('open') },
          ]}
        >
          <p>Body text</p>
        </Section>
        <Section label="Routes" tabs={[{ key: 'a', label: 'Here', href: '/here', current: true }, { key: 'b', label: 'There', href: '/there' }]}>
          x
        </Section>
      </>,
    );
    const region = screen.getByRole('region', { name: '01 · Period' });
    expect(within(region).getByRole('heading', { level: 2, name: '01 · Period' })).toBeInTheDocument();
    expect(within(region).getByText('Body text')).toBeInTheDocument();
    expect(within(region).getByText('3 runs')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    const open = within(region).getByRole('button', { name: 'Open' });
    expect(open).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(open);
    expect(pick).toHaveBeenCalledWith('open');
    const routes = screen.getByRole('region', { name: 'Routes' });
    expect(within(routes).getByRole('link', { name: 'Here' })).toHaveAttribute('aria-current', 'page');
    expect(within(routes).getByRole('link', { name: 'There' })).not.toHaveAttribute('aria-current');
    // Monolith: the hairline section. Classic: card.tsx's Card string, verbatim, so adoption keeps Classic.
    const el = region as HTMLElement;
    for (const t of ['monolith:border-t', 'monolith:border-ink', 'monolith:rounded-none', 'monolith:bg-transparent']) expect(mono(el)).toContain(t);
    expect(el.className).toContain('rounded-[1.25rem] border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]');
  });

  it('Cells and Kv are description lists; every figure is tabular and static', () => {
    render(
      <>
        <Cells
          items={[
            { label: 'Pending', value: '4', signal: true },
            { label: 'Approved', value: '2', unit: 'items', sub: 'this month' },
          ]}
        />
        <Kv items={[{ label: 'Net pay', value: 'RM 4,250.00', big: true }, { label: 'Grade', value: 'E5', tone: 'mid' }]} cols={2} />
      </>,
    );
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    expect(terms).toEqual(['Pending', 'Approved', 'Net pay', 'Grade']);
    expect(screen.getAllByRole('definition').length).toBeGreaterThanOrEqual(4);
    const four = screen.getByText('4');
    expect(tokens(four)).toEqual(expect.arrayContaining(['num', 'tabular-nums', 'monolith:font-mono', 'monolith:text-signal-text']));
    expect(screen.getByText('Pending').className).toContain('monolith:text-signal-text');
    const net = screen.getByText('RM 4,250.00');
    expect(tokens(net)).toEqual(expect.arrayContaining(['num', 'tabular-nums', 'monolith:text-[28px]']));
    for (const fig of [four, net, screen.getByText('2').closest('b')!]) {
      expect(fig.className, 'a figure never animates').not.toMatch(/\b(transition|animate-|duration-)/);
    }
  });

  it('Steps is an ordered list with exactly one aria-current="step"', () => {
    render(
      <Steps
        label="Payroll run"
        steps={[
          { key: 'a', label: 'Prepare', state: 'done' },
          { key: 'b', label: 'Review', sub: '3 issues', state: 'cur' },
          { key: 'c', label: 'Release', state: 'todo' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Payroll run' });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items.filter((i) => i.getAttribute('aria-current') === 'step').map((i) => i.textContent)).toEqual(['Review3 issues']);
  });

  it('Ruler is a named group of ticks: the picked one aria-pressed, a click reports the key', () => {
    const onPick = vi.fn();
    render(<Ruler label="Pay period" on="2026-09" onPick={onPick} ticks={[{ key: '2026-08', label: 'Aug', past: true }, { key: '2026-09', label: 'Sep' }, { key: '2026-10', label: 'Oct' }]} />);
    const group = screen.getByRole('group', { name: 'Pay period' });
    const ticks = within(group).getAllByRole('button');
    expect(ticks.map((t) => t.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    fireEvent.click(within(group).getByRole('button', { name: 'Oct' }));
    expect(onPick).toHaveBeenCalledWith('2026-10');
  });

  it('Note is role="note" (signal-text label when it warns); Empty and Panel carry their text; Panel is a named <aside>', () => {
    render(
      <>
        <Note warn label="Needs you" title="Two payslips are blocked." body="Bank details are missing." action={<a href="/fix">Fix</a>} />
        <Empty label="Nothing yet" title="No claims this month." />
        <Panel kicker="Selected" title="Aisyah Rahman" body="Engineering" kv={[{ label: 'Code', value: 'E-001' }]} actions={<Button>Open</Button>} />
      </>,
    );
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Two payslips are blocked.');
    expect(within(note).getByRole('link', { name: 'Fix' })).toHaveAttribute('href', '/fix');
    expect(within(note).getByText('Needs you').className).toContain('monolith:text-signal-text');
    expect(note.className).toContain('monolith:bg-transparent');
    expect(screen.getByText('No claims this month.').closest('[data-empty]')).not.toBeNull();
    const panel = screen.getByRole('complementary', { name: 'Aisyah Rahman' });
    expect(within(panel).getByRole('term')).toHaveTextContent('Code');
    expect(within(panel).getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('Status is a word with a tone; LiveDot is decorative; StatusLine is one line of the caller’s facts', () => {
    render(
      <>
        <Status word="Pending" tone="signal" />
        <Status word="Approved" tone="ink" />
        <LiveDot />
        <StatusLine items={['Scope · All companies', 'Last run 09:12']} />
      </>,
    );
    const pending = screen.getByText('Pending');
    expect(pending).toHaveAttribute('data-tone', 'signal');
    expect(pending.className).toContain('monolith:text-signal-text');
    expect(screen.getByText('Approved').className).toContain('monolith:text-ink');
    const dot = document.querySelector('[data-live-dot]')!;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(tokens(dot)).toContain('monolith-dot');
    expect(document.querySelector('[data-status-line]')!.textContent).toBe('Scope · All companiesLast run 09:12');
  });

  const COLS = ['Code', 'Employee', 'Status'];
  const ROWS = [
    { key: 'e1', cells: ['E-001', 'Aisyah Rahman', 'Pending'], tone: 'signal' as const },
    { key: 'e2', cells: ['E-002', 'Daniel Tan', 'Approved'], tone: 'ink' as const, selected: true },
  ];

  it('HairlineTable, read-only: a real table with a caption, column headers and the status column as a word', () => {
    render(<HairlineTable label="Leave requests" cols={COLS} widths={['90px', '1fr', '120px']} rows={ROWS} statusCol={2} />);
    const table = screen.getByRole('table', { name: 'Leave requests' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(COLS);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['E-001', 'Aisyah Rahman', 'Pending']);
    expect(within(rows[1]).getByText('Pending')).toHaveAttribute('data-tone', 'signal');
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
  });

  it('HairlineTable, selectable: rows are <button>s named with their column names, aria-current on the selected one', () => {
    const onSelect = vi.fn();
    render(<HairlineTable label="Leave requests" cols={COLS} rows={ROWS} statusCol={2} onSelect={onSelect} />);
    const group = screen.getByRole('group', { name: 'Leave requests' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    // jsdom has no CSS, so it joins the grid cells without the spaces a browser adds between block-level grid
    // items; the exact spoken name is asserted in Chromium (test/r400-monolith-primitives.browser.test.tsx).
    expect(buttons[0]).toHaveAccessibleName(/^Code,\s*E-001\s*Employee,\s*Aisyah Rahman\s*Status,\s*Pending$/);
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'true']);
    fireEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith('e1');
    // Selected is ink with bone text, and the status word turns bone on it so it never vanishes.
    expect(mono(buttons[1])).toEqual(expect.arrayContaining(['monolith:aria-[current=true]:bg-ink', 'monolith:aria-[current=true]:text-bone']));
    expect(within(buttons[1]).getByText('Approved').className).toContain('monolith:group-aria-[current=true]:text-bone');
  });

  it('HairlineTable shows the caller’s empty state when there are no rows', () => {
    render(<HairlineTable label="Claims" cols={COLS} rows={[]} empty={<Empty title="No claims awaiting your decision." />} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No claims awaiting your decision.')).toBeInTheDocument();
  });

  it('HairlineList is a list of hairline rows with a status word', () => {
    render(<HairlineList label="Activity" items={[{ key: 'a', lead: '09:12', title: 'Payroll released', sub: 'September', right: 'Done', tone: 'ink' }]} />);
    const list = screen.getByRole('list', { name: 'Activity' });
    const item = within(list).getByRole('listitem');
    expect(item).toHaveTextContent('09:12Payroll released · SeptemberDone');
    expect(within(item).getByText('Done')).toHaveAttribute('data-tone', 'ink');
  });

  it('Switch is a real checkbox with role="switch", named by its label, reporting changes', () => {
    const onCheckedChange = vi.fn();
    render(<Switch label="Email the employee" name="notify" defaultChecked onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole('switch', { name: 'Email the employee' });
    expect(sw).toBeChecked();
    expect(sw).toHaveAttribute('name', 'notify');
    fireEvent.click(sw);
    expect(sw).not.toBeChecked();
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });
});

describe('strings and motion', () => {
  const FILES = fs.readdirSync(path.join(ROOT, 'components/monolith')).filter((f) => /\.tsx?$/.test(f));

  it('no primitive owns a string: no translator, no literal words between JSX tags', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(7);
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(ROOT, 'components/monolith', f), 'utf8');
      expect(src, f).not.toMatch(/useTranslations|getTranslations|next-intl/);
      // JSX text: `>Word<`. Comments are stripped first; the only literal text allowed is punctuation.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code.match(/>\s*[A-Za-z][A-Za-z ]+\s*</g), f).toBeNull();
    }
  });

  it('a non-Latin caller’s words pass through untouched (the six locales need no new keys)', () => {
    render(<Section index={2} label="期间"><Status word="待审批" tone="signal" /></Section>);
    expect(screen.getByRole('region', { name: '02 · 期间' })).toHaveTextContent('待审批');
  });

  it('motion: only the live dot moves, and the global reduced-motion rule stops it', () => {
    const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,\s*::before,\s*::after\s*\{[^}]*animation[^}]*!important/);
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(ROOT, 'components/monolith', f), 'utf8');
      expect(src.match(/\banimate-[a-z]/g), f).toBeNull();
    }
  });
});
