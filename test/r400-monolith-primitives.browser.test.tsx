/**
 * r400 — Monolith primitives in a REAL engine (Chromium, the app's compiled Tailwind from app/globals.css).
 * jsdom applies no stylesheet, so the two claims that matter most can only be settled here:
 *
 *  1. CLASSIC IS INERT TO THE NEW CLASSES. Under data-ui-theme="classic", each retuned component's computed
 *     style — every property getComputedStyle reports — equals that of the same element carrying only its
 *     non-`monolith:` classes. test/r400-monolith-primitives.test.ts proves those remaining classes are exactly
 *     main's, so together: Classic paints what main paints.
 *  2. MONOLITH REALLY PAINTS THE README'S LOOK — the pill, the text button, the status word, the underlined
 *     field, the hairline section — including in dark mode, where `dark:` tints must lose to `monolith:`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '../app/globals.css';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { HairlineTable, Ruler, Section, Steps, Switch, LiveDot } from '../components/monolith';

const html = document.documentElement;
const setTheme = (theme: 'monolith' | 'classic', dark = false) => {
  html.setAttribute('data-ui-theme', theme);
  html.classList.toggle('dark', dark);
};
const stripMonolith = (cls: string) =>
  cls
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('monolith:'))
    .join(' ');
const cs = (el: Element, pseudo?: string) => getComputedStyle(el, pseudo);
/** Every computed property, as a plain object (so a failure names the property that differs). */
const allStyles = (el: Element) => {
  const s = cs(el);
  const out: Record<string, string> = {};
  for (let i = 0; i < s.length; i++) out[s[i]] = s.getPropertyValue(s[i]);
  return out;
};

/** Tailwind v4 composes box-shadow from five layers; "no shadow" is `none` or every layer transparent. */
const noShadow = (v: string) => v === 'none' || v.split(/,(?![^(]*\))/).every((l) => /^\s*rgba\(0, 0, 0, 0\)/.test(l));
const INK = 'rgb(17, 17, 17)';
const BONE = 'rgb(242, 240, 235)';
const MID = 'rgb(99, 98, 93)';
const SIGNAL_TEXT = 'rgb(189, 56, 0)';
const SIGNAL = 'rgb(255, 77, 0)';
const CLEAR = 'rgba(0, 0, 0, 0)';

beforeAll(() => {
  document.body.style.width = '1000px';
});
afterEach(() => {
  cleanup();
  html.removeAttribute('data-ui-theme');
  html.classList.remove('dark');
});

describe('harness', () => {
  it('the real stylesheet is compiled and the theme scope is live', () => {
    setTheme('monolith');
    render(<div data-testid="x" className="bg-ink monolith:h-[37px]" />);
    expect(cs(screen.getByTestId('x')).backgroundColor).toBe(INK);
    expect(cs(screen.getByTestId('x')).height).toBe('37px');
    setTheme('classic');
    // The monolith: variant does not match in Classic at all.
    expect(cs(screen.getByTestId('x')).height).toBe('0px');
  });
});

describe('1. Classic: every computed property equals the element without its monolith: classes', () => {
  const cases: [string, () => React.ReactElement, (cls: string) => React.ReactElement][] = [];
  for (const variant of ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const)
    for (const size of ['default', 'sm', 'lg', 'icon'] as const)
      cases.push([
        `Button ${variant}/${size}`,
        () => <Button data-testid="now" variant={variant} size={size}>Go</Button>,
        (cls) => <button data-testid="ref" className={cls}>Go</button>,
      ]);
  for (const variant of ['default', 'success', 'warning', 'danger', 'info', 'accent'] as const)
    cases.push([
      `Badge ${variant}`,
      () => <Badge data-testid="now" variant={variant}>Pending</Badge>,
      (cls) => <span data-testid="ref" className={cls}>Pending</span>,
    ]);
  cases.push([
    'Input',
    () => <Input data-testid="now" defaultValue="Aisyah" />,
    (cls) => <input data-testid="ref" className={cls} defaultValue="Aisyah" />,
  ]);
  cases.push([
    'Card',
    () => <Card data-testid="now">Body</Card>,
    (cls) => <div data-testid="ref" className={cls}>Body</div>,
  ]);
  cases.push([
    'CardHeader',
    () => <CardHeader data-testid="now">Head</CardHeader>,
    (cls) => <div data-testid="ref" className={cls}>Head</div>,
  ]);
  cases.push([
    'CardTitle',
    () => <CardTitle data-testid="now">Title</CardTitle>,
    (cls) => <h3 data-testid="ref" className={cls}>Title</h3>,
  ]);

  for (const dark of [false, true])
    it(`all ${cases.length} cases, ${dark ? 'dark' : 'light'}`, () => {
      setTheme('classic', dark);
      let props = 0;
      for (const [name, now, ref] of cases) {
        const a = render(now());
        const el = screen.getByTestId('now');
        expect(el.className, name).toContain('monolith:');
        const b = render(ref(stripMonolith(el.className)));
        const want = allStyles(screen.getByTestId('ref'));
        const got = allStyles(el);
        expect(Object.keys(want).length, name).toBeGreaterThan(200);
        for (const k of Object.keys(want)) {
          expect(got[k], `${name} · ${k}`).toBe(want[k]);
          props++;
        }
        a.unmount();
        b.unmount();
      }
      expect(props).toBeGreaterThan(cases.length * 200);
    });
});

describe('2. Monolith paints the README look', () => {
  it('Button: default is the 44px ink pill; outline/ghost/link the underlined text button; destructive no orange fill', () => {
    setTheme('monolith');
    render(
      <>
        <Button>Pill</Button>
        <Button variant="secondary">Ghost pill</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
        <Button variant="destructive">Delete</Button>
        <Button size="sm">Small</Button>
      </>,
    );
    const pill = cs(screen.getByRole('button', { name: 'Pill' }));
    expect(pill.height).toBe('44px');
    expect(Number.parseFloat(pill.borderTopLeftRadius)).toBeGreaterThan(400);
    expect(pill.backgroundColor).toBe(INK);
    expect(pill.color).toBe(BONE);
    expect(pill.fontWeight).toBe('600');
    const gp = cs(screen.getByRole('button', { name: 'Ghost pill' }));
    expect(gp.backgroundColor).toBe(CLEAR);
    expect(gp.borderTopColor).toBe(INK);
    expect(gp.borderTopWidth).toBe('1px');
    for (const name of ['Outline', 'Ghost', 'Link']) {
      const t = cs(screen.getByRole('button', { name }));
      expect(t.borderBottomWidth, name).toBe('1px');
      expect(t.borderBottomColor, name).toBe(INK);
      expect(t.borderTopWidth, name).toBe('0px');
      expect(t.borderLeftWidth, name).toBe('0px');
      expect(t.backgroundColor, name).toBe(CLEAR);
      expect(t.borderTopLeftRadius, name).toBe('0px');
      expect(t.minHeight, name).toBe('44px');
      expect(t.fontSize, name).toBe('15px');
      expect(t.textDecorationLine, name).toBe('none');
    }
    const del = cs(screen.getByRole('button', { name: 'Delete' }));
    expect(del.backgroundColor).toBe(CLEAR);
    expect(del.color).toBe(SIGNAL_TEXT);
    expect(cs(screen.getByRole('button', { name: 'Small' })).height).toBe('36px');
  });

  for (const dark of [false, true])
    it(`Badge is a status word with no fill, coloured by tone (${dark ? 'dark: the dark: tints lose' : 'light'})`, () => {
      setTheme('monolith', dark);
      render(
        <>
          <Badge variant="success">Approved</Badge>
          <Badge variant="warning">Pending</Badge>
          <Badge variant="danger">Overdue</Badge>
          <Badge variant="default">Cancelled</Badge>
          <Badge variant="info">Upcoming</Badge>
        </>,
      );
      const ink = dark ? BONE : INK;
      const signal = dark ? 'rgb(255, 106, 43)' : SIGNAL_TEXT;
      const mid = dark ? 'rgb(168, 166, 158)' : MID;
      const want: Record<string, string> = { Approved: ink, Pending: signal, Overdue: signal, Cancelled: mid, Upcoming: mid };
      for (const [word, colour] of Object.entries(want)) {
        const s = cs(screen.getByText(word));
        expect(s.backgroundColor, word).toBe(CLEAR);
        expect(s.color, word).toBe(colour);
        expect(s.textTransform, word).toBe('uppercase');
        expect(s.fontSize, word).toBe('11px');
        expect(s.letterSpacing, word).toBe('1.32px');
        expect(s.borderTopLeftRadius, word).toBe('0px');
        expect(s.paddingLeft, word).toBe('0px');
      }
    });

  it('Input is underlined: 40px, 1px ink bottom rule only, no fill, no shadow', () => {
    setTheme('monolith');
    render(<Input aria-label="Name" />);
    const s = cs(screen.getByLabelText('Name'));
    expect(s.height).toBe('40px');
    expect(s.borderBottomWidth).toBe('1px');
    expect(s.borderBottomColor).toBe(INK);
    expect(s.borderTopWidth).toBe('0px');
    expect(s.borderLeftWidth).toBe('0px');
    expect(s.backgroundColor).toBe(CLEAR);
    expect(noShadow(s.boxShadow), s.boxShadow).toBe(true);
    expect(s.borderTopLeftRadius).toBe('0px');
    expect(s.paddingLeft).toBe('0px');
  });

  it('Card and Section are hairline sections; in Classic a Section paints exactly as a Card', () => {
    setTheme('monolith');
    render(
      <>
        <Card data-testid="card">
          <CardHeader>
            <CardTitle>Period</CardTitle>
          </CardHeader>
        </Card>
        <Section label="Runs">x</Section>
      </>,
    );
    for (const el of [screen.getByTestId('card'), screen.getByRole('region', { name: 'Runs' })]) {
      const s = cs(el);
      expect(s.borderTopWidth).toBe('1px');
      expect(s.borderTopColor).toBe(INK);
      expect(s.borderLeftWidth).toBe('0px');
      expect(s.borderBottomWidth).toBe('0px');
      expect(s.borderTopLeftRadius).toBe('0px');
      expect(noShadow(s.boxShadow), s.boxShadow).toBe(true);
      expect(s.backgroundColor).toBe(CLEAR);
    }
    expect(cs(screen.getByRole('heading', { name: 'Period' })).textTransform).toBe('uppercase');
    setTheme('classic');
    const card = cs(screen.getByTestId('card'));
    const sec = cs(screen.getByRole('region', { name: 'Runs' }));
    for (const k of ['borderTopLeftRadius', 'borderTopWidth', 'borderLeftWidth', 'borderTopColor', 'backgroundColor', 'boxShadow', 'color'] as const)
      expect(sec[k], k).toBe(card[k]);
    expect(card.borderTopLeftRadius).toBe('20px');
  });

  it('Steps, Ruler, Switch and the live dot paint their marks', () => {
    setTheme('monolith');
    render(
      <>
        <Steps label="Run" steps={[{ key: 'a', label: 'Prepare', state: 'done' }, { key: 'b', label: 'Review', state: 'cur' }, { key: 'c', label: 'Release', state: 'todo' }]} />
        <Ruler label="Period" on="b" ticks={[{ key: 'a', label: 'Aug' }, { key: 'b', label: 'Sep' }]} />
        <Switch label="On switch" defaultChecked />
        <Switch label="Off switch" />
        <LiveDot />
      </>,
    );
    const lines = [...document.querySelectorAll('[data-steps] i')].map((i) => cs(i));
    expect(lines.map((l) => l.backgroundColor)).toEqual([INK, SIGNAL, 'rgb(217, 214, 207)']);
    expect(lines[1].boxShadow).not.toBe('none');
    expect(lines.map((l) => l.height)).toEqual(['1px', '1px', '1px']);
    const sep = screen.getByRole('button', { name: 'Sep' });
    expect(cs(sep).color).toBe(SIGNAL_TEXT);
    expect(cs(sep, '::before').height).toBe('24px');
    expect(cs(sep, '::before').backgroundColor).toBe(SIGNAL);
    expect(cs(screen.getByRole('button', { name: 'Aug' }), '::before').height).toBe('10px');
    const track = (name: string) => screen.getByRole('switch', { name }).nextElementSibling!;
    expect(cs(track('On switch')).width).toBe('40px');
    expect(cs(track('On switch')).height).toBe('22px');
    expect(cs(track('On switch'), '::after').left).toBe('3px');
    expect(cs(track('On switch'), '::after').backgroundColor).toBe(INK);
    expect(cs(track('Off switch'), '::after').left).toBe('21px');
    expect(cs(track('Off switch'), '::after').backgroundColor).toBe(CLEAR);
    const dot = cs(document.querySelector('[data-live-dot]')!);
    expect(dot.backgroundColor).toBe(SIGNAL);
    expect(dot.animationName).toBe('monolith-beat');
    setTheme('classic');
    expect(cs(document.querySelector('[data-live-dot]')!).animationName).toBe('none');
  });

  it('a selectable row’s spoken name carries each column name, with the spaces a browser adds between cells', () => {
    setTheme('monolith');
    render(
      <HairlineTable
        label="Leave requests"
        cols={['Code', 'Employee', 'Status']}
        rows={[{ key: 'e1', cells: ['E-001', 'Aisyah Rahman', 'Pending'], tone: 'signal', selected: true }]}
        statusCol={2}
        onSelect={() => {}}
      />,
    );
    // getByRole's name match is Testing Library's accname computation, here with real CSS.
    const row = screen.getByRole('button', { name: 'Code, E-001 Employee, Aisyah Rahman Status, Pending' });
    // Selected is ink with bone text, and the status word turns bone on it.
    expect(cs(row).backgroundColor).toBe(INK);
    expect(cs(row).color).toBe(BONE);
    expect(cs(screen.getByText('Pending')).color).toBe(BONE);
    expect(cs(row).minHeight).toBe('50px');
  });
});
