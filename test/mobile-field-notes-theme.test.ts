import { describe, expect, it } from 'vitest';
import { colorContrast } from '../lib/mobile-composition';
import { DEFAULT_MOBILE_DESIGN } from '../lib/mobile-design';
import { FIELD_NOTES } from '../mobile/lib/field-notes';
import { nativeMobilePalette } from '../mobile/lib/daily-switch-theme';

describe('Field Notes native themes', () => {
  it.each(['light', 'dark'] as const)('keeps reading text, links, actions and input rules legible in %s', appearance => {
    const palette = nativeMobilePalette(DEFAULT_MOBILE_DESIGN, appearance);
    expect(palette).toEqual(FIELD_NOTES[appearance]);
    for (const foreground of [palette.text, palette.muted, palette.accent]) {
      expect(colorContrast(foreground, palette.bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(colorContrast(palette.onButton, palette.button)).toBeGreaterThanOrEqual(4.5);
    expect(colorContrast(palette.border, palette.bg)).toBeGreaterThanOrEqual(3);
  });
  it('retains an explicit company accent while applying the native reading surface', () => {
    const palette = nativeMobilePalette({ ...DEFAULT_MOBILE_DESIGN, accent: 'cobalt' }, 'light');
    expect(palette.bg).toBe(FIELD_NOTES.light.bg);
    expect(palette.text).toBe(FIELD_NOTES.light.text);
    expect(palette.accent).toBe('#174bb5');
    expect(colorContrast(palette.onButton, palette.button)).toBeGreaterThanOrEqual(4.5);
  });
});
