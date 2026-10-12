import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveUiTheme } from '@/lib/ui-theme';

const css = readFileSync(new URL('../app/current.css', import.meta.url), 'utf8');
const root = css.match(/:root\[data-ui-theme='current'\] \{([\s\S]*?)\n\}/)?.[1];
const tokens = Object.fromEntries([...String(root).matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map((s) => parseInt(s, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
describe('Current Plum shared theme', () => {
  it('resolves Current without changing existing preferences', () => {
    for (const name of ['classic', 'monolith', 'current']) expect(resolveUiTheme(name)).toBe(name);
    expect(resolveUiTheme('current;dark')).toBe('monolith');
  });
  it.each([
    ['--foreground', '--background'], ['--card-foreground', '--card'],
    ['--popover-foreground', '--popover'], ['--muted-foreground', '--muted'],
    ['--primary-foreground', '--primary'], ['--current-band-ink', '--current-band'],
    ['--current-selected-ink', '--current-selected'], ['--destructive', '--card'],
  ])('%s is readable against %s', (fg, bg) => {
    expect(root).toBeTruthy();
    expect(tokens[fg]).toMatch(/^#[0-9a-f]{6}$/);
    expect(tokens[bg]).toMatch(/^#[0-9a-f]{6}$/);
    const a = luminance(tokens[fg]), b = luminance(tokens[bg]);
    expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(4.5);
  });
});
