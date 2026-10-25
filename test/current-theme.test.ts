import { describe, expect, it } from 'vitest';
import { isUiTheme, resolveUiTheme, UI_THEMES } from '../lib/ui-theme';

// An existing browser can retain the retired cookie across a deployment. It must
// enter a supported shell rather than paint unstyled Current-only markup.
describe('retired Current theme compatibility', () => {
  it.each(['current', 'Current', 'CURRENT'])('resolves old preference %s to Atelier', value => {
    expect(resolveUiTheme(value)).toBe('atelier');
    expect(isUiTheme(value)).toBe(false);
  });
  it.each(['monolith', 'classic', 'atelier'])('retains saved preference %s', value => {
    expect(resolveUiTheme(value)).toBe(value);
    expect(isUiTheme(value)).toBe(true);
  });
  it('offers only the three supported shells', () => {
    expect(UI_THEMES).toEqual(['monolith', 'classic', 'atelier']);
  });
});
