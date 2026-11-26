/**
 * Feedback 1ebba97e — THE NET PAY BAND WAS ON THE PAGE AND COULD NOT BE SEEN.
 *
 * Both payslip screens (Payroll → Individual Payslip, and the employee's own My Payslip) drew Net Pay as
 * `<Card className="bg-primary text-primary-foreground">`. Card stamps `data-ui-card`, and Atelier — the
 * default theme — repaints every `main [data-ui-card]` with `background: var(--card)` from an unlayered rule
 * that beats the utility class: white writing on a white card. Monolith's Card appends
 * `monolith:bg-transparent` and its primary-foreground is the page colour, so the clash recurred there.
 *
 * jsdom applies no stylesheet, so this file cannot measure a rendered colour. It pins the three facts the
 * fix rests on instead, each of which fails on the old markup:
 *   1. the band carries NO theme hook — neither it nor any ancestor is a `[data-ui-card]`;
 *   2. it is painted with the foreground/background token pair, and every theme (Atelier, Monolith,
 *      Classic; light and dark) defines that pair at a strong contrast — read from the real CSS files;
 *   3. both screens render the one shared component, so they cannot drift apart again. (The admin screen
 *      is a server component with a database behind it; test/individual-payslip-selection.test.ts asserts
 *      its rendered tree holds the band with the payslip's own net figure.)
 * A rendered-screen check in a real browser is not part of this file.
 */
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NetPayBand } from '../components/payslip-sections';
import { PersonalPayslipStatement } from '../app/me/payslip/statement';
import { data, labels } from './fixtures/payslip-pdf-fixture';
import { formatMoney } from '../lib/money';

const band = () => {
  const el = document.querySelector('[data-payslip-net-pay]');
  expect(el, 'the Net pay band must render').not.toBeNull();
  return el as HTMLElement;
};
const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('1ebba97e — the Net pay band carries no theme hook', () => {
  it('the shared band: label and figure, foreground/background tokens, no Card', () => {
    render(<NetPayBand label="Net pay" value="RM 4,349.25" />);
    const el = band();
    expect(el.textContent).toContain('Net pay');
    expect(el.textContent).toContain('RM 4,349.25');
    expect(el.closest('[data-ui-card]'), 'a [data-ui-card] is what Atelier repaints white').toBeNull();
    expect(classes(el)).toEqual(expect.arrayContaining(['bg-foreground', 'text-background']));
    expect(classes(el), 'the primary pair is the one the themes clashed on').not.toContain('bg-primary');
    expect(classes(el)).not.toContain('text-primary-foreground');
    // Printed: an outlined row in black ink, because a browser drops the fill and would leave light text
    // on white paper.
    expect(classes(el)).toEqual(expect.arrayContaining(['print:bg-transparent', 'print:text-black', 'print:border']));
  });

  it('My Payslip renders that band, with the recorded net figure unchanged and outside any Card', () => {
    render(<PersonalPayslipStatement data={data} labels={labels} actions={null} />);
    const el = band();
    expect(document.querySelectorAll('[data-payslip-net-pay]'), 'exactly one band').toHaveLength(1);
    expect(el.textContent).toContain(labels.netPay);
    expect(el.textContent, 'the figure is data.net, formatted as before').toContain(formatMoney(data.net, data.currency));
    expect(el.closest('[data-ui-card]')).toBeNull();
    expect(screen.getAllByText(labels.netPay).some((node) => el.contains(node))).toBe(true);
  });
});

describe('1ebba97e — both payslip screens use the one shared band', () => {
  const code = (rel: string) =>
    readFileSync(rel, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const rel of ['app/payroll/individual-payslip/page.tsx', 'app/me/payslip/statement.tsx']) {
    it(rel, () => {
      const src = code(rel);
      expect(src.length).toBeGreaterThan(0);
      expect(src, 'imports the shared band').toMatch(/import \{[^}]*\bNetPayBand\b[^}]*\} from '@\/components\/payslip-sections'/);
      expect(src.match(/<NetPayBand\b/g) ?? [], 'renders it once').toHaveLength(1);
      expect(src, 'the old Card band is gone').not.toMatch(/<Card[^>]*bg-primary[^>]*px-6 py-5/);
    });
  }
});

describe('1ebba97e — every theme keeps the band readable', () => {
  /** The custom properties declared directly in the first block whose selector is exactly `selector`. */
  function tokens(file: string, selector: string): Record<string, string> {
    const css = readFileSync(file, 'utf8');
    const at = css.split(/\n/).findIndex((line) => line.trim() === `${selector} {`);
    expect(at, `${file} declares ${selector}`).toBeGreaterThanOrEqual(0);
    const body = css.split(/\n/).slice(at + 1);
    const end = body.findIndex((line) => line.trim() === '}');
    const out: Record<string, string> = {};
    for (const line of body.slice(0, end)) {
      const m = /^\s*(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/.exec(line);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  // Classic is the unscoped :root / .dark pair; Monolith and Atelier override both tokens in both modes.
  const THEMES: [string, string, string][] = [
    ['classic light', 'app/globals.css', ':root'],
    ['classic dark', 'app/globals.css', '.dark'],
    ['monolith light', 'app/globals.css', ":root[data-ui-theme='monolith']"],
    ['monolith dark', 'app/globals.css', ":root[data-ui-theme='monolith'].dark"],
    ['atelier light', 'app/atelier.css', ":root[data-ui-theme='atelier']"],
    ['atelier dark', 'app/atelier.css', ":root[data-ui-theme='atelier'].dark"],
  ];

  it.each(THEMES)('%s: band text against band fill is at least 7:1', (_name, file, selector) => {
    const t = tokens(file, selector);
    expect(t['--foreground'], 'the band fill token is declared').toMatch(/^#/);
    expect(t['--background'], 'the band text token is declared').toMatch(/^#/);
    expect(contrast(t['--foreground'], t['--background'])).toBeGreaterThanOrEqual(7);
  });

  it('no stylesheet restyles the band or its two utilities', () => {
    for (const file of ['app/globals.css', 'app/atelier.css', 'app/operational-layout.css', 'app/action-feedback.css', 'app/atelier-action-feedback.css', 'app/onboarding-workspace.css']) {
      const css = readFileSync(file, 'utf8');
      expect(css, `${file} must not target the band`).not.toContain('data-payslip-net-pay');
      expect(css, `${file} must not override bg-foreground`).not.toMatch(/bg-foreground/);
      expect(css, `${file} must not override text-background`).not.toMatch(/text-background/);
    }
  });
});
