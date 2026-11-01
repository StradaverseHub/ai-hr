/** REVIEW (independent UI review) — drafted as test/review/clockwork-figure-contrast.dom.test.tsx.
 *
 * components/ai-centre/clockwork-figure.tsx paints its own dark panel (bg-[#0c0d0f], line 150) in every theme
 * and prints real text on it: the caption and maker's mark (#6f747c, 10.5px, line 151-152), and the layer
 * names/parts, which are dimmed to opacity-45 whenever a step is active (line 177-181). Computed WCAG ratios
 * against #0c0d0f: caption 4.13:1, dimmed name 3.90:1, dimmed part (#7b8089 @45%) 1.89:1 — all small text,
 * all below 4.5:1 (WCAG 1.4.3). The figure is role="img" but the text is visible and is the only on-figure
 * key to which part is which; the CI screenshots (ta/vi/th how-desktop) show the dimmed parts as barely
 * legible. Expected: caption >= #8a9099-ish, and dim by colour (e.g. #a0a5ad) rather than 45% opacity.
 *
 * Reads only the colours the component itself declares; no CSS build needed. FAILS on 7d57fc6a4. */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ClockworkFigure, type ClockworkLabels } from '../../components/ai-centre/clockwork-figure';

const hex = (h: string) => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const PANEL = hex('0c0d0f');

const label = (name: string) => ({ name, part: `${name} part` });
const labels: ClockworkLabels = { interfaces: label('Interfaces'), harness: label('Harness'), context: label('Context'), capabilities: label('Capabilities'), record: label('Record'), model: label('Model'), foundation: label('Foundation'), guard: label('Guard'), outcome: label('Outcome') };

describe('Clockwork figure text contrast', () => {
  it('REVIEW low: every text the figure prints reaches 4.5:1 on its own panel, dimmed or not', () => {
    const view = render(<ClockworkFigure active="harness" labels={labels} reduced title="Fictional title" caption="Fictional caption" mark="NOVERI" label="Fictional figure" faceLabel="Noveri OS" />);
    const texts = [...view.container.querySelectorAll('p, text')].filter(node => node.textContent?.trim());
    expect(texts.length).toBeGreaterThan(10); // labels render (reduced motion opens the watch at once)
    const failures: string[] = [];
    for (const node of texts) {
      const cls = node.getAttribute('class') ?? '';
      const colour = /(?:^|\s)(?:text|fill)-\[#([0-9a-f]{6})\]/i.exec(cls)?.[1];
      if (!colour) continue;
      const alpha = /(?:^|\s)opacity-(\d+)/.exec(cls) ? Number(/(?:^|\s)opacity-(\d+)/.exec(cls)![1]) / 100 : 1;
      const fg = hex(colour).map((c, i) => c * alpha + PANEL[i] * (1 - alpha));
      const r = ratio(fg, PANEL);
      if (r < 4.5) failures.push(`${node.textContent!.trim()} #${colour}@${alpha} = ${r.toFixed(2)}:1`);
    }
    expect(failures).toEqual([]);
  });
});
