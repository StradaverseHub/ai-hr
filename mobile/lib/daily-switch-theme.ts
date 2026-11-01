/** Native presentation only. Published schema-2 compositions keep their own theme. */
import { mobilePalette, type MobileDesign } from '../../lib/mobile-design';

export const DAILY_SWITCH = {
  face: '#c7f51c', ink: '#111600', lcd: '#101313', edge: '#30362a',
  space: { xs: 4, sm: 8, md: 12, row: 16, gutter: 20, section: 24, wide: 32 },
  radius: { control: 14, panel: 22, dock: 30 },
} as const;

export function nativeMobilePalette(design: MobileDesign, appearance: 'dark' | 'light') {
  const prior = mobilePalette(design, appearance);
  if (design.schemaVersion === 2) return prior;
  const dark = appearance === 'dark';
  return {
    ...prior,
    bg: dark ? '#111315' : '#fafbfc', card: dark ? '#202426' : '#ffffff',
    text: dark ? '#f6f7fa' : '#101214', muted: dark ? '#bcc4d3' : '#5d6472',
    border: dark ? '#3b4146' : '#d8dce2',
    // Preserve an explicitly chosen cobalt/coral company accent; jade is the former default.
    ...(design.accent === 'jade' ? { accent: dark ? DAILY_SWITCH.face : '#405400', button: DAILY_SWITCH.face, onButton: DAILY_SWITCH.ink } : {}),
  };
}
