import { afterEach, describe, expect, it } from 'vitest';
import '../app/globals.css';

// Actual compiled CSS: a jsdom test cannot establish a scroll boundary.
// The source guard separately pins these wrappers around EVERY approval table.
afterEach(() => { document.body.innerHTML = ''; document.documentElement.classList.remove('dark'); });
describe('wide task table scroll boundary', () => {
  for (const width of [360, 900]) {
    for (const dark of [false, true]) {
      it(`keeps every column reachable at container width ${width}, dark=${dark}`, () => {
        document.documentElement.classList.toggle('dark', dark);
        document.body.innerHTML = `<div style="width:${width}px" class="overflow-hidden rounded-xl border bg-card"><div class="overflow-x-auto"><table class="w-full text-sm"><tbody><tr>${Array.from({ length: 8 }, (_, i) => `<td class="whitespace-nowrap px-4 py-3">Column ${i} with a long value</td>`).join('')}</tr></tbody></table></div></div>`;
        const card = document.body.firstElementChild as HTMLElement;
        const scroll = card.firstElementChild as HTMLElement;
        const table = scroll.firstElementChild as HTMLElement;
        expect(getComputedStyle(scroll).overflowX).toBe('auto');
        expect(card.scrollWidth).toBe(card.clientWidth);
        expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
        scroll.scrollLeft = scroll.scrollWidth;
        expect(scroll.scrollLeft).toBeGreaterThan(0);
        // At the end of the scroll range the final cell is INSIDE the boundary,
        // permitting subpixel layout rounding but no inaccessible right edge.
        expect(table.getBoundingClientRect().right).toBeLessThanOrEqual(scroll.getBoundingClientRect().right + 1);
      });
    }
  }
});
